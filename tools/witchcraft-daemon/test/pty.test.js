import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const harness = fileURLToPath(new URL('../test-support/pty-smoke-harness.js', import.meta.url));
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function terminateOwned(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(pid, 'SIGKILL');
}

test('real PTYs route both tabs, dedupe, resize and end with their isolated host', { timeout: 25000 }, async t => {
  const child = spawn(process.execPath, [harness], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const owned = new Map(), records = [];
  let stdout = '', stderr = '', closed = false, parseError = null, timer, outputBytes = 0;
  t.after(async () => {
    clearTimeout(timer);
    // Only these exact test-owned PIDs may be terminated after a failed assertion.
    if (!closed && child.pid) await terminateOwned(child.pid).catch(() => {});
    for (const pid of owned.values()) await terminateOwned(pid).catch(() => {});
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {
    outputBytes += Buffer.byteLength(data);
    stdout += data;
    if (outputBytes > 65536) { parseError = new Error('PTY harness exceeded output budget'); child.kill(); return; }
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || !['owned', 'result'].includes(record.type)) throw new Error('Unexpected harness record');
        if (record.type === 'owned') {
          if (!['claude', 'codex'].includes(record.tab) || !Number.isInteger(record.pid) || record.pid <= 0
            || record.pid === process.pid || record.pid === child.pid || owned.has(record.tab)
            || [...owned.values()].includes(record.pid)) throw new Error('Invalid owned PTY identity');
          owned.set(record.tab, record.pid);
        }
        if (records.length >= 3) throw new Error('PTY harness emitted excess records');
        records.push(record);
      } catch (error) { parseError = error; }
    }
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-16384); });
  const exit = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`PTY harness did not exit within 18 seconds. ${stderr}`)), 18000);
    child.once('error', reject);
    child.once('close', (code, signal) => { closed = true; clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.ifError(parseError);
  assert.equal(stdout.trim(), '', 'all harness records were newline terminated and drained');
  const results = records.filter(record => record.type === 'result');
  assert.equal(results.length, 1, `Expected one shutdown acknowledgment. stderr: ${stderr}`);
  const result = results[0];
  assert.equal(result.ok, true, result.error ?? stderr);
  assert.equal(exit.code, 0, stderr); assert.equal(exit.signal, null);
  assert.deepEqual([...owned.keys()].sort(), ['claude', 'codex']);
  assert.equal(result.checks.routing, true); assert.equal(result.checks.dedupe, true);
  assert.equal(result.checks.resize, true); assert.equal(result.checks.history, true); assert.equal(result.checks.naturalExit, true);
  assert.equal(result.checks.interruptExit, true);
  assert.equal(result.checks.disposed, true); assert.equal(result.checks.childrenGone, true);
  for (const [tab, pid] of owned) assert.equal(isAlive(pid), false, `${tab} PTY process ${pid} survived host exit`);
});
