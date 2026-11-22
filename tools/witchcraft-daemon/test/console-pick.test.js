import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { candidateRow, pickConsole } from '../src/console-pick.js';

const candidates = [
  { pid: 24492, name: 'pwsh.exe', command: 'pwsh.exe', running: 'claude.exe', host: 'vscode', scrollback: 'viewport' },
  { pid: 37272, name: 'pwsh.exe', command: 'pwsh.exe -NoExit', running: null, host: 'conhost', scrollback: 'full' },
];

function harness() {
  const input = new PassThrough();
  const written = [];
  const output = { write: text => { written.push(text); return true; } };
  return { input, output, written, text: () => written.join('') };
}

test('a row names the console by what runs in it, and says what it will give', () => {
  const row = candidateRow(candidates[0]);
  assert.match(row, /24492/u);
  assert.match(row, /claude\.exe/u);
  assert.match(row, /vscode/u);
  assert.match(row, /viewport/u, 'a reader should know before choosing that there is no scrollback here');
  // A shell with nothing running falls back to its own command rather than showing a blank.
  assert.match(candidateRow(candidates[1]), /pwsh\.exe -NoExit/u);
});

test('enter takes the highlighted console', async () => {
  const { input, output, text } = harness();
  const chosen = pickConsole({ candidates, input, output, tab: 'claude' });
  input.write('\r');
  assert.equal((await chosen).pid, 24492, 'the newest console is highlighted first');
  assert.match(text(), /claude/u, 'the prompt says which tab is being named');
});

test('the arrow keys move the highlight before choosing', async () => {
  const { input, output } = harness();
  const chosen = pickConsole({ candidates, input, output, tab: 'codex' });
  input.write('\u001b[B');
  input.write('\r');
  assert.equal((await chosen).pid, 37272);
});

test('the highlight stops at the ends rather than wrapping', async () => {
  const { input, output } = harness();
  const chosen = pickConsole({ candidates, input, output, tab: 'claude' });
  input.write('\u001b[A');
  input.write('\u001b[A');
  input.write('\r');
  assert.equal((await chosen).pid, 24492);
});

test('escape cancels the choice', async () => {
  const { input, output } = harness();
  const chosen = pickConsole({ candidates, input, output, tab: 'claude' });
  input.write('\u001b');
  assert.equal(await chosen, null);
});

test('with no consoles to offer it says so instead of waiting for a key', async () => {
  const { input, output, text } = harness();
  assert.equal(await pickConsole({ candidates: [], input, output, tab: 'claude' }), null);
  assert.match(text(), /no consoles/iu);
});
