import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { OverlaySupervisor } from '../src/overlay-supervisor.js';

class FakeHost extends EventEmitter {
  constructor(options) { super(); this.options = options; this.sessionId = `session-${FakeHost.instances.length}`; FakeHost.instances.push(this); }
  async start() { return this; }
  async stop(reason) { this.emit('closed', { reason, unexpected: false }); }
  publishOutput() { return true; }
  publishStatus() { return true; }
  publishState() {}
}
FakeHost.instances = [];

test('overlay supervisor: presentation crash gets a bounded restart without touching terminal ownership', async () => {
  FakeHost.instances = [];
  const terminal = { disposed: 0, dispose() { this.disposed++; } }, children = [];
  const supervisor = new OverlaySupervisor({ terminal, maxRestarts: 1, restartDelayMs: 0,
    spawnChild: async () => { const child = { id: children.length + 1 }; children.push(child); return child; },
    hostFactory: options => new FakeHost(options) });
  await supervisor.start();
  const restarted = once(supervisor, 'ready');
  FakeHost.instances[0].emit('closed', { reason: 'crashed', unexpected: true });
  assert.equal((await restarted)[0].restart, 1);
  assert.equal(children.length, 2);
  assert.equal(terminal.disposed, 0);
  const unavailable = once(supervisor, 'unavailable');
  FakeHost.instances[1].emit('closed', { reason: 'crashed again', unexpected: true });
  assert.equal((await unavailable)[0].restarts, 1);
  assert.equal(children.length, 2);
  await supervisor.stop();
});

test('overlay supervisor: initial presentation failure recovers without rejecting daemon startup', async () => {
  let attempts = 0;
  class StartupHost extends FakeHost {
    async start() { attempts++; if (attempts === 1) throw new Error('electron cold-start failure'); return this; }
  }
  const supervisor = new OverlaySupervisor({ terminal: {}, maxRestarts: 1, restartDelayMs: 0,
    spawnChild: async () => ({}), hostFactory: options => new StartupHost(options) });
  const errors = []; supervisor.on('startup-error', error => errors.push(error.message)); supervisor.on('restart-error', () => {});
  const host = await supervisor.start();
  assert.ok(host instanceof StartupHost); assert.equal(attempts, 2);
  assert.deepEqual(errors, ['electron cold-start failure']);
  await supervisor.stop();
});

test('overlay supervisor: repeated startup failures stop recovery after the first healthy child', async () => {
  FakeHost.instances = [];
  let attempts = 0, spawns = 0;
  class FlakyStartupHost extends FakeHost {
    async start() { attempts++; if (attempts <= 2) throw new Error(`startup failure ${attempts}`); return this; }
  }
  const supervisor = new OverlaySupervisor({ terminal: {}, maxRestarts: 3, restartDelayMs: 0,
    spawnChild: async () => { spawns++; return { id: spawns }; },
    hostFactory: options => new FlakyStartupHost(options) });
  supervisor.on('restart-error', () => {});
  const host = await supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(host instanceof FlakyStartupHost);
  assert.equal(attempts, 3);
  assert.equal(spawns, 3);
  assert.equal(supervisor.host, host);
  assert.equal(supervisor.recovering, null);
  await supervisor.stop();
});
