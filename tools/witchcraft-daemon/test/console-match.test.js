import test from 'node:test';
import assert from 'node:assert/strict';
import { matchConsole, parseAttachConfig, parseAttachTarget } from '../src/console-match.js';

const consoles = [
  { pid: 40, command: 'pwsh.exe', running: null },
  { pid: 41, command: 'pwsh.exe', running: '"C:\\tools\\claude.exe" --continue' },
  { pid: 42, command: 'pwsh.exe', running: 'claude' },
  { pid: 43, command: 'cmd.exe /k codex', running: null },
];

test('the newest console running the text wins', () => {
  assert.equal(matchConsole('claude', consoles).pid, 41);
});

test('a console is also named by its command line', () => {
  assert.equal(matchConsole('codex', consoles).pid, 43);
});

test('a pattern ignores case', () => {
  assert.equal(matchConsole('CLAUDE.EXE', consoles).pid, 41);
  assert.equal(matchConsole('Codex', consoles).pid, 43);
});

test('a pattern that matches nothing names no console', () => {
  assert.equal(matchConsole('copilot', consoles), undefined);
  assert.equal(matchConsole('claude', []), undefined);
});

test('the daemon\'s own console is passed over for the next match', () => {
  const own = { pid: 50, command: 'pwsh.exe', running: 'node bin/witchcraft.js run --attach codex=~codex', own: true };
  assert.equal(matchConsole('codex', [own, ...consoles]).pid, 43);
  assert.equal(matchConsole('codex', [own]), undefined, 'only the daemon\'s own console matches: none is named');
});

test('an attach target is a pid, pick, or ~TEXT', () => {
  assert.deepEqual(parseAttachTarget('24492'), { pid: 24492 });
  assert.deepEqual(parseAttachTarget(24492), { pid: 24492 });
  assert.deepEqual(parseAttachTarget('pick'), { pick: true });
  assert.deepEqual(parseAttachTarget('~claude'), { pattern: 'claude' });
  assert.deepEqual(parseAttachTarget('~--model=opus'), { pattern: '--model=opus' });
});

test('an empty pattern, zero, or anything else is refused with its label', () => {
  for (const bad of ['~', '0', '-1', 'zero', '', undefined, null, true]) {
    assert.throws(() => parseAttachTarget(bad, '--attach claude='), /^Error: --attach claude= takes a process id, pick, or ~TEXT/u,
      `${bad} should be refused`);
  }
});

test('config attach takes the same forms per tab, and refuses an unknown tab or a bad target', () => {
  assert.deepEqual(parseAttachConfig({ claude: '~claude', codex: 37272, copilot: 'pick' }),
    { claude: { pattern: 'claude' }, codex: { pid: 37272 }, copilot: { pick: true } });
  assert.throws(() => parseAttachConfig({ browser: '~x' }), /names browser/u);
  assert.throws(() => parseAttachConfig({ codex: '~' }), /attach\.codex in config\.json takes/u);
  for (const bad of [null, 'claude', ['~claude']]) assert.throws(() => parseAttachConfig(bad), /must map/u);
});
