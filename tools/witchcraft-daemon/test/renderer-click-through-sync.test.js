import test from 'node:test';
import assert from 'node:assert/strict';
import { ClickThroughSynchronizer } from '../overlay/click-through-sync.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('renderer click-through sync keeps Workbench selected across a late HUD acknowledgement', async () => {
  const first = deferred();
  const second = deferred();
  const requests = [];
  const synchronizer = new ClickThroughSynchronizer({
    send(value) {
      requests.push(value);
      return requests.length === 1 ? first.promise : second.promise;
    },
  });

  synchronizer.setDesired(true);
  synchronizer.setDesired(false);

  assert.deepEqual(requests, [true]);
  assert.equal(synchronizer.observe(true), false);
  assert.equal(synchronizer.desired, false);

  first.resolve({ ok: true });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requests, [true, false]);
  assert.equal(synchronizer.desired, false);

  second.resolve({ ok: true });
  await synchronizer.whenIdle();

  assert.equal(synchronizer.acknowledged, false);
  assert.equal(synchronizer.desired, false);
});
