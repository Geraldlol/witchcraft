import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedOverlaySender } from '../src/overlay-channel.js';

const input = seq => ({ v: 1, type: 'input', seq, payload: { tab: 'claude', data: `message ${seq}` } });

test('overlay channel: pending records are bounded until Node IPC callbacks drain', () => {
  const callbacks = [];
  const channel = { send(message, callback) { callbacks.push(callback); return false; } };
  const sender = new BoundedOverlaySender({ channel, direction: 'child', maxPendingRecords: 2, sendTimeoutMs: 1000 });
  assert.equal(sender.send(input(1)).accepted, false);
  sender.send(input(2));
  assert.equal(sender.pendingRecords, 2);
  assert.throws(() => sender.send(input(3)), error => error.code === 'IPC_BACKPRESSURE');
  callbacks.shift()();
  assert.equal(sender.pendingRecords, 1);
  assert.doesNotThrow(() => sender.send(input(3)));
  sender.dispose();
  assert.equal(sender.pendingBytes, 0);
});

test('overlay channel: send timeout and callback failure are explicit and release accounting', async () => {
  const failures = [];
  const timeout = new BoundedOverlaySender({ channel: { send() { return true; } }, direction: 'child', sendTimeoutMs: 15,
    onFailure: error => failures.push(error) });
  timeout.send(input(1));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(failures[0].code, 'IPC_SEND_TIMEOUT');
  assert.equal(timeout.pendingRecords, 0);
  timeout.dispose();

  const callbackFailure = new BoundedOverlaySender({ channel: { send(message, callback) { callback(new Error('closed')); return false; } },
    direction: 'child', onFailure: error => failures.push(error) });
  callbackFailure.send(input(1));
  assert.equal(failures.at(-1).message, 'closed');
  assert.equal(callbackFailure.pendingRecords, 0);
  callbackFailure.dispose();
});
