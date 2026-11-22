import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../bin/witchcraft.js';

test('a tab can be pointed at a console by process id', () => {
  const { options } = parseArgs(['run', '--attach', 'claude=24492']);
  assert.deepEqual(options.attach, { claude: { pid: 24492 } });
});

test('both tabs can name their own console', () => {
  const { options } = parseArgs(['run', '--attach', 'claude=24492', '--attach', 'codex=37272']);
  assert.deepEqual(options.attach, { claude: { pid: 24492 }, codex: { pid: 37272 } });
});

test('a tab can ask to be shown the consoles instead of naming one', () => {
  assert.deepEqual(parseArgs(['run', '--attach', 'claude=pick']).options.attach, { claude: { pick: true } });
});

test('a tab can name its console by what runs in it', () => {
  assert.deepEqual(parseArgs(['run', '--attach', 'codex=~codex', '--attach', 'claude=~--model=opus']).options.attach,
    { codex: { pattern: 'codex' }, claude: { pattern: '--model=opus' } });
});

test('an attach that names no tab, no console, or an unknown tab is refused', () => {
  for (const bad of ['claude', 'claude=', '=24492', 'browser=24492', 'claude=zero', 'claude=-1', 'claude=0', 'claude=~']) {
    assert.throws(() => parseArgs(['run', '--attach', bad]), /--attach/u, `${bad} should be refused`);
  }
});

test('the same tab cannot be attached twice', () => {
  assert.throws(() => parseArgs(['run', '--attach', 'claude=1', '--attach', 'claude=2']), /once/u);
});

test('a tab cannot be both attached and given a command to launch', () => {
  // `--only codex` silences claude, so attaching claude would mean two answers for one tab.
  assert.throws(() => parseArgs(['run', '--only', 'codex', '--attach', 'claude=24492']), /--only/u);
});

test('consoles is a command of its own, and takes --all', () => {
  assert.equal(parseArgs(['consoles']).command, 'consoles');
  assert.equal(parseArgs(['consoles', '--all']).options.all, true);
});

test('--no-current turns off joining the sessions already running', () => {
  assert.equal(parseArgs(['run']).options.noCurrent, undefined);
  assert.equal(parseArgs(['run', '--no-current']).options.noCurrent, true);
});
