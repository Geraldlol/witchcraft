import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/event-log.js';

test('event log records input outcomes as JSON lines without any message text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.log'), log = createEventLog(file, { now: () => 1000 });
  log.input('pixel', { id: 3, tab: 'claude', action: 'text', text: 'rm -rf secret' }, { accepted: true, ack: 3 });
  log.input('binding', { id: 4, tab: 'codex', action: 'enter', text: '' }, { accepted: false, reason: 'invalid or stale session' });
  log.input('pixel', { id: 3, tab: 'claude', action: 'text', text: 'x' }, { accepted: true, duplicate: true });
  log.error('binding', new Error('Binding carrier quarantined: part ordering'));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.outcome), ['accepted', 'rejected', 'error']);
  assert.equal(lines[1].reason, 'invalid or stale session');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret|rm -rf/u);
});

test('event log rotates to one backup instead of growing without bound', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witchcraft-events-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.log'), log = createEventLog(file, { maxBytes: 400 });
  for (let id = 1; id <= 40; id++) log.input('pixel', { id, tab: 'claude', action: 'text' }, { accepted: true });
  assert.ok(fs.statSync(file).size <= 400 + 200);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.equal(fs.readdirSync(dir).length, 2);
});
