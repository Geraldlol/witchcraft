import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeTranscript, createSessionInfo, readClaudeInfo, readCodexInfo, replyLines } from '../src/session-info.js';

async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-info-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('a Claude transcript gives the latest model, context in use and last text reply', async t => {
  const file = path.join(await temp(t), 'session.jsonl');
  await fs.writeFile(file, jsonl([
    { type: 'assistant', message: { model: 'claude-old', usage: { input_tokens: 1 }, content: [{ type: 'text', text: 'Earlier reply' }] } },
    { type: 'user', message: { content: 'next' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 514857,
      cache_creation_input_tokens: 1080, output_tokens: 192 }, content: [{ type: 'tool_use', name: 'Bash' }] } },
    'not json',
  ].map(entry => entry)).replace('"not json"', 'not json'));
  const { info, reply } = await readClaudeInfo(file);
  assert.deepEqual(info, { model: 'claude-opus-5-5', used: 515939 }, 'input, cache reads and cache writes are the context in use');
  assert.deepEqual(reply, ['Earlier reply'], 'a tool call is not a reply; the last text is');
});

test('a Codex rollout gives model, effort, context against its window, and the player-facing reply', async t => {
  const file = path.join(await temp(t), 'rollout.jsonl');
  await fs.writeFile(file, jsonl([
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'ultra' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Patched the clipping.\r\nTests pass.' } },
    { type: 'response_item', payload: { type: 'agent_message', author: '/root/review', content: [{ text: 'subagent chatter' }] } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120860 }, model_context_window: 258400 } } },
  ]));
  assert.deepEqual(await readCodexInfo(file), {
    info: { model: 'gpt-6-astra', effort: 'ultra', used: 120860, window: 258400 },
    reply: ['Patched the clipping.', 'Tests pass.'],
  });
});

test('replies become bounded display lines without control characters', () => {
  assert.equal(replyLines('   '), undefined);
  assert.deepEqual(replyLines('a\tb\u0007c'), ['a    bc']);
  const long = replyLines(Array.from({ length: 300 }, (_, index) => `line ${index}`).join('\n'));
  assert.equal(long.length, 200); assert.equal(long.at(-1), '...');
  assert.equal(replyLines('x'.repeat(1000))[0].length, 400);
});

// Field structure copied from a real VS Code 'paginated' rollout (2026-09-29); the text is invented.
test('a paginated Codex rollout gives its last final answer, not commentary or traffic between agents', async t => {
  const file = path.join(await temp(t), 'rollout.jsonl');
  const final = 'Moved the pin.\nTests pass.';
  await fs.writeFile(file, jsonl([
    { type: 'session_meta', payload: { id: 'thread', source: 'vscode', history_mode: 'paginated' } },
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: final }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_1', phase: 'final_answer', content: [{ type: 'Text', text: final }] } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: final } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000 }, model_context_window: 258400 } } },
    // A newer turn is still in progress: its commentary and a subagent's message are not the reply.
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking at the ring next.' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_2', phase: 'commentary', content: [{ type: 'Text', text: 'Looking at the ring next.' }] } } },
    { type: 'response_item', payload: { type: 'agent_message', author: '/root/review', recipient: '/root', content: [{ type: 'input_text', text: 'subagent chatter' }] } },
  ]));
  assert.deepEqual(await readCodexInfo(file), {
    info: { model: 'gpt-6-astra', effort: 'high', used: 9000, window: 258400 },
    reply: ['Moved the pin.', 'Tests pass.'],
  });
});

test('a paginated Codex turn that only recorded its final message as an item still yields the reply', async t => {
  const file = path.join(await temp(t), 'rollout.jsonl');
  await fs.writeFile(file, jsonl([
    { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_1', phase: 'final_answer',
      content: [{ type: 'Text', text: 'First part.' }, { type: 'Text', text: 'Second part.' }] } } },
  ]));
  assert.deepEqual((await readCodexInfo(file)).reply, ['First part.', 'Second part.']);
});

test('a legacy Codex thread gives its last final answer, not newer commentary', async t => {
  // Legacy rollouts tag each agent_message event with a phase too; a turn still running ends in commentary.
  const file = path.join(await temp(t), 'rollout.jsonl');
  await fs.writeFile(file, jsonl([
    { type: 'session_meta', payload: { id: 'thread', source: 'vscode', history_mode: 'legacy' } },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'Done.' } },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'Now checking the ring.' } },
  ]));
  assert.deepEqual((await readCodexInfo(file)).reply, ['Done.']);
});

// A long turn can push every final answer out of the 1 MiB tail (one real 5.4 MB thread held only
// commentary and traffic between agents there); its progress beats an empty Copy reply.
test('a long Codex turn with no final answer in view gives its newest commentary, in either format', async t => {
  const legacy = path.join(await temp(t), 'legacy.jsonl');
  await fs.writeFile(legacy, jsonl([
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'Reading the ring.' } },
    { type: 'event_msg', payload: { type: 'agent_message', phase: 'commentary', message: 'Now the outbox.' } },
    { type: 'response_item', payload: { type: 'agent_message', author: '/root/review', content: [{ type: 'input_text', text: 'subagent chatter' }] } },
  ]));
  assert.deepEqual((await readCodexInfo(legacy)).reply, ['Now the outbox.']);
  const paginated = path.join(await temp(t), 'paginated.jsonl');
  await fs.writeFile(paginated, jsonl([
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Now the outbox.' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_9', phase: 'commentary', content: [{ type: 'Text', text: 'Now the outbox.' }] } } },
  ]));
  assert.deepEqual((await readCodexInfo(paginated)).reply, ['Now the outbox.']);
});

test('model and effort names fit the addon\'s byte limits and never split a surrogate pair', async t => {
  const file = path.join(await temp(t), 'rollout.jsonl');
  // Ring.lua accepts a model of at most 64 bytes and an effort of at most 16; a cut emoji would stop every publish.
  await fs.writeFile(file, jsonl([
    { type: 'turn_context', payload: { model: 'a'.repeat(63) + '\u{1F600}b', effort: 'x'.repeat(15) + 'éy' } },
  ]));
  const { info } = await readCodexInfo(file);
  assert.equal(info.model, 'a'.repeat(63));
  assert.equal(info.effort, 'x'.repeat(15));
  const transcript = path.join(await temp(t), 'session.jsonl');
  await fs.writeFile(transcript, jsonl([{ type: 'assistant', message: { model: 'b'.repeat(62) + '\u{1F600}', usage: { input_tokens: 1 }, content: [] } }]));
  assert.equal((await readClaudeInfo(transcript)).info.model, 'b'.repeat(62));
});

test('a reply line is cut by code point and never carries a lone surrogate', () => {
  // An emoji straddling the 400th unit used to leave half a surrogate pair, which stopped the bridge.
  assert.deepEqual(replyLines('a'.repeat(399) + '\u{1F600}b'), ['a'.repeat(399) + '\u{1F600}']);
  assert.deepEqual(replyLines('broken \ud83c pair'), ['broken � pair']);
});

test('the Claude transcript is found through the process record, and bad records find nothing', async t => {
  const home = await temp(t);
  await fs.mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'sessions', '42.json'),
    JSON.stringify({ pid: 42, sessionId: '892e7425-5e44-4ddc-9d5e-6fe6c09a398e', cwd: 'E:\\Fixtures\\Demo Project' }));
  await fs.writeFile(path.join(home, '.claude', 'sessions', '43.json'), JSON.stringify({ pid: 43, sessionId: '../../etc', cwd: 'C:\\x' }));
  assert.equal(await claudeTranscript(42, { home }),
    path.join(home, '.claude', 'projects', 'E--Fixtures-Demo-Project', '892e7425-5e44-4ddc-9d5e-6fe6c09a398e.jsonl'));
  assert.equal(await claudeTranscript(43, { home }), undefined, 'a session id that is not a UUID never becomes a path');
  assert.equal(await claudeTranscript(44, { home }), undefined);
  assert.equal(await claudeTranscript(undefined, { home }), undefined);
});

test('the poller publishes what it read and reports changes once', async t => {
  const home = await temp(t);
  const rollout = path.join(home, 'rollout.jsonl');
  await fs.writeFile(rollout, jsonl([{ type: 'turn_context', payload: { model: 'gpt-6-astra' } }]));
  let changes = 0;
  const info = createSessionInfo({ cwd: home, home, pid: () => undefined, codexFile: rollout, onChange: () => { changes++; } });
  await info.poll();
  assert.deepEqual(info.get('codex'), { info: { model: 'gpt-6-astra' } });
  assert.deepEqual(info.get('claude'), {}, 'a tab without session files carries nothing');
  await info.poll();
  assert.equal(changes, 1, 'an unchanged reading is not a change');
  info.stop();
});
