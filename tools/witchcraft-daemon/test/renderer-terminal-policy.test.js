import test from 'node:test';
import assert from 'node:assert/strict';
import { Screen } from '../src/screen.js';
import {
  restoreAuthoritativeSnapshot,
  filterTerminalInput,
  terminalEventDisposition,
  validatedTerminalGeometry,
} from '../overlay/terminal-policy.js';

test('renderer terminal policy: raw output invalidates the authoritative snapshot instead of being appended', () => {
  assert.equal(terminalEventDisposition({ kind: 'snapshot', resyncPending: false }), 'apply');
  assert.equal(terminalEventDisposition({ kind: 'lifecycle', resyncPending: false }), 'apply');
  assert.equal(terminalEventDisposition({ kind: 'output', resyncPending: false }), 'resync');
  assert.equal(terminalEventDisposition({ kind: 'output', resyncPending: true }), 'ignore');
});

test('renderer terminal policy: xterm DA and DSR replies never become a second PTY response', () => {
  for (const response of [
    '\u001b[?1;2c',
    '\u001b[>0;276;0c',
    '\u001b[0n',
    '\u001b[12;34R',
    '\u001b[?12;34R',
  ]) {
    assert.equal(filterTerminalInput(response), '');
  }
});

test('renderer terminal policy: keyboard, paste, arrow and control input remain intact', () => {
  for (const input of ['hello', 'line one\rline two', '\u001b[A', '\u0003', '\u001b[200~paste\u001b[201~']) {
    assert.equal(filterTerminalInput(input), input);
  }
});

test('renderer terminal policy: authoritative geometry is applied before restoring serialized ANSI', async t => {
  const source = new Screen({ cols: 120, rows: 40 });
  const restored = new Screen({ cols: 80, rows: 24 });
  t.after(async () => Promise.all([source.dispose(), restored.dispose()]));
  await source.write(`${'X'.repeat(100)}\r\n\u001b[31mTAIL\u001b[0m\u001b[10;110H`);

  const geometry = validatedTerminalGeometry({ cols: 120, rows: 40 });
  assert.deepEqual(geometry, { cols: 120, rows: 40 });
  assert.equal(validatedTerminalGeometry({ cols: 39, rows: 40 }), null);
  await new Promise(resolve => {
    restoreAuthoritativeSnapshot(restored.terminal, source.serialize(), geometry, resolve);
  });

  assert.equal(restored.terminal.cols, 120);
  assert.equal(restored.terminal.rows, 40);
  assert.equal(restored.plain(), source.plain());
  assert.equal(restored.terminal.buffer.active.cursorX, source.terminal.buffer.active.cursorX);
  assert.equal(restored.terminal.buffer.active.cursorY, source.terminal.buffer.active.cursorY);
});
