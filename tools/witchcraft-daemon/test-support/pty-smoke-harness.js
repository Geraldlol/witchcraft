// Native node-pty workers belong to this short-lived host, never the test runner.
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { TerminalPair } from '../src/pty.js';
import { Outbox } from '../src/outbox.js';

const output = { claude: '', codex: '' }, owned = [], checks = {};
let pair, failure = null;
const report = record => process.stdout.write(JSON.stringify(record) + '\n');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function waitFor(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`);
    await delay(20);
  }
}

const script = `
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', data => {
  pending += data;
  let end;
  while ((end = pending.search(/[\\r\\n]/u)) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line) continue;
    if (line === '__EXIT__') { process.stdout.write('NATURAL_EXIT\\n', () => process.exit(0)); return; }
    process.stdout.write('RECEIVED:' + line + '\\n');
  }
});
process.on('SIGINT', () => { process.stdout.write('INTERRUPTED\\n', () => process.exit(0)); });
console.log('READY');
`;

try {
  pair = new TerminalPair({
    commands: { claude: { file: process.execPath, args: ['-e', script] }, codex: { file: process.execPath, args: ['-e', script] } },
    cwd: process.cwd(), cols: 60, rows: 15, history: 5,
    spawn(file, args, options) {
      const child = pty.spawn(file, args, options), tab = owned.length === 0 ? 'claude' : 'codex';
      assert.ok(Number.isInteger(child.pid) && child.pid > 0);
      owned.push({ tab, pid: child.pid }); report({ type: 'owned', tab, pid: child.pid });
      return child;
    },
    onData(tab, data) { output[tab] = (output[tab] + data).slice(-65536); },
  });
  await waitFor(() => output.claude.includes('READY') && output.codex.includes('READY'), 'PTY startup');
  const outbox = new Outbox({ epoch: '0123abcd', write: (tab, data) => pair.write(tab, data) });
  const message = { epoch: '0123abcd', id: 1, tab: 'codex', action: 'text', text: 'ONLY_CODEX' };
  assert.equal(outbox.accept(message).accepted, true);
  assert.equal(outbox.accept(message).duplicate, true);
  outbox.accept({ ...message, id: 2, tab: 'claude', text: 'ONLY_CLAUDE' });
  await waitFor(() => output.codex.includes('RECEIVED:ONLY_CODEX') && output.claude.includes('RECEIVED:ONLY_CLAUDE'), 'Per-tab delivery');
  assert.ok(!output.claude.includes('ONLY_CODEX')); assert.ok(!output.codex.includes('ONLY_CLAUDE'));
  checks.routing = true;
  // Allow a second read interval so an accidentally duplicated line cannot hide behind the first match.
  await delay(100);
  assert.equal(output.codex.match(/RECEIVED:ONLY_CODEX/gu)?.length, 1);
  checks.dedupe = true;
  pair.resize(80, 20);
  const snapshot = pair.snapshot().filter(session => session.status !== 'not started');
  assert.equal(snapshot.length, 2);
  for (const session of [...pair.sessions.values()].filter(session => session.status !== 'not started')) {
    assert.equal(session.process.cols, 80); assert.equal(session.process.rows, 20);
  }
  assert.ok(snapshot.every(session => session.lines.length === 20));
  checks.resize = true;
  assert.ok(snapshot.every(session => Array.isArray(session.history) && session.history.length <= 5));
  checks.history = true;
  outbox.accept({ ...message, id: 3, tab: 'claude', text: '__EXIT__' });
  await waitFor(() => pair.sessions.get('claude').status !== 'running', 'Natural child exit');
  assert.ok(output.claude.includes('NATURAL_EXIT'));
  checks.naturalExit = true;
} catch (error) {
  failure = error;
  try { await error.cleanup; } catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'Startup and owned child cleanup failed'); }
}

try {
  if (pair) {
    let timeout;
    try {
      await Promise.race([pair.dispose(), new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('TerminalPair.dispose exceeded eight seconds')), 8000);
      })]);
    } finally { clearTimeout(timeout); }
    checks.disposed = true;
    assert.ok(output.codex.includes('INTERRUPTED'), 'The remaining child exited through its normal Ctrl+C handler');
    checks.interruptExit = true;
  }
  await waitFor(() => owned.every(({ pid }) => !isAlive(pid)), 'Owned child termination', 1500);
  assert.equal(owned.length, 2);
  checks.childrenGone = true;
} catch (error) { failure ??= error; }

report({ type: 'result', ok: failure === null, checks, error: failure?.stack });
// Explicit host lifetime is required by node-pty 1.1.0's retained ConoutConnection workers.
// The parent independently verifies process exit and all reported PTY PIDs after this acknowledgment.
await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))));
process.exit(failure ? 1 : 0);
