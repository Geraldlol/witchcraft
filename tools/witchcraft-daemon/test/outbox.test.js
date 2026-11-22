import test from 'node:test';
import assert from 'node:assert/strict';
import { Outbox, parseSavedVariables } from '../src/outbox.js';
import { serializeLua } from '../src/lua.js';

const message = (id = 1, tab = 'claude', text = 'Hello') => ({ id, tab, text, epoch: '0123abcd', action: 'text' });
test('literal recovery preserves Unicode, escaped bytes, order and per-tab routing', () => {
  const messages = [message(1, 'claude', 'Привіт ||'), message(2, 'codex', 'Review this')];
  const source = 'WitchcraftDB = ' + serializeLua({ global: { schema: 1, outbox: messages, view: { x: -23 } } });
  const parsed = parseSavedVariables(Buffer.from(source));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.messages)), messages);
  assert.equal(parseSavedVariables('WitchcraftDB={global={schema=1,outbox={}}}').messages.length, 0);
  assert.equal(parseSavedVariables('WitchcraftDB={global={outbox={{id=1,tab="claude",action="text",epoch="0123abcd",text="\\208\\146"}}}}').messages[0].text, 'В');
});
test('recovery rejects expressions, wrong roots, future schema, gaps and duplicate keys', () => {
  for (const source of ['WitchcraftDB=os.execute("whoami")', 'WitchcraftDB={}; print("bad")', 'Other={}',
    'WitchcraftDB={global={schema=2}}', 'WitchcraftDB={global={outbox={[2]={}}}}', 'WitchcraftDB={global={},global={}}',
    'WitchcraftDB={__proto__={}}', 'WitchcraftDB={global={outbox="bad"}}']) assert.throws(() => parseSavedVariables(source));
  assert.throws(() => parseSavedVariables(' '.repeat(2 * 1024 * 1024 + 1)), /byte budget/u);
});
test('accepted input is routed once and stale-epoch input is never sent', () => {
  const writes = [], outbox = new Outbox({ epoch: '0123abcd', write: (...args) => writes.push(args) });
  assert.equal(outbox.accept(message()).accepted, true);
  assert.equal(outbox.accept(message()).duplicate, true);
  assert.equal(outbox.accept(message(2, 'codex')).accepted, true);
  assert.deepEqual(writes, [['claude', 'Hello\r', 'text'], ['codex', 'Hello\r', 'text']]);
  assert.equal(outbox.accept({ ...message(3), epoch: '9876abcd' }).accepted, false);
  assert.equal(outbox.ack, 2);
});
test('failed PTY write does not ack; control characters require explicit allowed actions', () => {
  let fails = true;
  const writes = [], outbox = new Outbox({ epoch: '0123abcd', write: (...args) => { if (fails) throw Error('closed'); writes.push(args); } });
  assert.throws(() => outbox.accept(message()), /closed/u); assert.equal(outbox.ack, 0);
  fails = false;
  assert.equal(outbox.accept(message(1, 'claude', 'a\ncommand')).accepted, false);
  outbox.accept({ ...message(), action: 'interrupt', text: '' });
  outbox.accept({ ...message(2, 'codex'), action: 'up', text: '' });
  assert.deepEqual(writes, [['claude', '\x03', 'interrupt'], ['codex', '\x1b[A', 'up']]);
});

test('a write is told which action it carries, so a mirrored console can type it', () => {
  const writes = [], outbox = new Outbox({ epoch: '0123abcd', write: (...args) => writes.push(args) });
  outbox.accept(message());
  outbox.accept({ ...message(2), action: 'up', text: '' });
  // A console takes typing and named keys, not a byte stream, and cannot recover the name from
  // the bytes without parsing escape sequences back into keys.
  assert.deepEqual(writes, [['claude', 'Hello\r', 'text'], ['claude', '\x1b[A', 'up']]);
});

test('input for a tab that is not running is consumed as dropped so it cannot block later input', () => {
  const writes = [];
  const outbox = new Outbox({ epoch: '0123abcd', write: (tab, ...rest) => {
    if (tab === 'codex') throw Object.assign(new Error('codex terminal is not running'), { code: 'TAB_NOT_RUNNING' });
    writes.push([tab, ...rest]);
  } });
  const dropped = outbox.accept(message(1, 'codex'));
  assert.equal(dropped.accepted, true); assert.equal(dropped.dropped, true); assert.equal(outbox.ack, 1);
  assert.equal(outbox.accept(message(2, 'claude')).accepted, true); assert.equal(outbox.ack, 2);
  assert.equal(writes.length, 1);
});

test('multi-line parts are joined per tab and delivered as one bracketed paste, then Enter', async () => {
  const { MORE, LINE } = await import('../src/outbox.js');
  const writes = [], outbox = new Outbox({ epoch: '0123abcd', write: (...args) => writes.push(args) });
  const message = (id, tab, text) => ({ epoch: '0123abcd', id, tab, action: 'text', text });
  assert.deepEqual(outbox.accept(message(1, 'claude', `${MORE}first line${LINE}sec`)), { accepted: true, ack: 1, buffered: true });
  outbox.accept(message(2, 'codex', 'plain codex prompt'));
  outbox.accept(message(3, 'claude', `ond line${LINE}third`));
  assert.deepEqual(writes, [
    ['codex', 'plain codex prompt\r', 'text'],
    ['claude', '\x1b[200~first line\rsecond line\rthird\x1b[201~\r', 'paste'],
  ], 'another tab is unaffected, and the parts become one paste with its own Enter');
  assert.equal(outbox.ack, 3);
  outbox.accept(message(4, 'claude', 'single line'));
  assert.deepEqual(writes.at(-1), ['claude', 'single line\r', 'text'], 'a single-line prompt is typed as before');
  outbox.accept(message(5, 'claude', `${MORE}${'x'.repeat(590)}`));
  for (let id = 6; id < 20; id++) outbox.accept(message(id, 'claude', `${MORE}${'x'.repeat(590)}`));
  const writesBefore = writes.length;
  assert.equal(outbox.accept(message(20, 'claude', 'tail')).dropped, true, 'an oversized prompt is dropped and reported');
  assert.equal(writes.length, writesBefore, 'no part of it is typed');
  outbox.accept(message(21, 'claude', 'next prompt'));
  assert.deepEqual(writes.at(-1), ['claude', 'next prompt\r', 'text'], 'the next prompt starts clean');
});

test('a control message asks for a terminal width (capped at 160) or journal clear and is never typed', async () => {
  const { CONTROL } = await import('../src/outbox.js');
  const writes = [], requests = [];
  const outbox = new Outbox({ epoch: '0123abcd', write: (...args) => writes.push(args), onControl: request => requests.push(request) });
  const controlMsg = (id, text) => ({ epoch: '0123abcd', id, tab: 'claude', action: 'control', text });
  const legacyMsg = (id, text) => ({ epoch: '0123abcd', id, tab: 'claude', action: 'text', text: `${CONTROL}${text}` });
  assert.deepEqual(outbox.accept(controlMsg(1, 'cols=160')), { accepted: true, control: true, ack: 1 });
  for (const [id, bad] of [[2, 'cols=39'], [3, 'cols=161'], [4, 'rows=20'], [5, 'cols=abc']]) {
    assert.equal(outbox.accept(controlMsg(id, bad)).dropped, true, bad);
  }
  assert.deepEqual(outbox.accept(controlMsg(6, 'clear-journal')), { accepted: true, control: true, ack: 6 });
  assert.deepEqual(outbox.accept(legacyMsg(7, 'cols=132')), { accepted: true, control: true, ack: 7 });
  assert.equal(outbox.accept(legacyMsg(8, 'cols=161')).dropped, true);
  assert.deepEqual(requests, [{ cols: 160 }, { clearJournal: true }, { cols: 132 }]);
  assert.deepEqual(writes, [], 'no control text reaches a terminal');
  assert.equal(outbox.ack, 8);
});
