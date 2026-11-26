import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BINDING_PROBE_BODY, BindingReceiver, crc32Ascii, encodeBase32 } from '../src/binding-carrier.js';
import { LogCarrier, encodeLogFrame, encodeLogLine, parseLogLine } from '../src/log-carrier.js';

// tests/witchcraft/log-carrier.lua repeats these vectors for the addon's encoder; change both together.
const VECTORS = [
  { name: 'probe',
    frame: { epoch: '00000000', nonce: '00000000', uiNonce: 'abcdef01', slot: 1, seq: 1, payload: Buffer.from('PFAM_BIND_PROBE', 'ascii') },
    text: 'WCL1_00000000_00000000_ABCDEF01_0001_000001_KBDECTK7IJEU4RC7KBJE6QSF_0F068518' },
  { name: 'heartbeat',
    frame: { epoch: '0123abcd', nonce: '89abcdef', uiNonce: 'abcdef01', slot: 2, seq: 0, payload: Buffer.from([0x48, 0x01]) },
    text: 'WCL1_0123ABCD_89ABCDEF_ABCDEF01_0002_000000_JAAQ_37756B3D' },
  // 610 bytes: I, id 1, tab 1 (codex), action 0 (text), then 604 bytes of "w".
  { name: 'input body of 610 bytes',
    frame: { epoch: '0123abcd', nonce: '89abcdef', uiNonce: 'abcdef01', slot: 9999, seq: 2,
      payload: Buffer.concat([Buffer.from([0x49, 0x00, 0x00, 0x01, 0x01, 0x00]), Buffer.from('w'.repeat(604), 'ascii')]) },
    text: 'WCL1_0123ABCD_89ABCDEF_ABCDEF01_270F_000002_JEAAAAIBAB3XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53X_A520811C' },
];

const ZERO = '00000000', EPOCH = '0123abcd', NONCE = '89abcdef', UI = 'abcdef01', STAMP = '11/23 19:41:31.260';
const withCrc = core => `${core}_${crc32Ascii(core)}`;
const asLine = text => `${STAMP}  [N][Lua] ${text}`;
const inputBody = text => Buffer.concat([Buffer.from([0x49, 0x00, 0x00, 0x01, 0x01, 0x00]), Buffer.from(text, 'utf8')]);

test('log frame vectors encode exactly and parse back with a slot-free fingerprint', () => {
  for (const { name, frame, text } of VECTORS) {
    assert.equal(encodeLogFrame(frame), text, name);
    const line = encodeLogLine(frame);
    assert.equal(line, asLine(text), name);
    const parsed = parseLogLine(line);
    assert.ok(parsed, name);
    for (const field of ['epoch', 'nonce', 'uiNonce', 'slot', 'seq']) assert.equal(parsed[field], frame[field], `${name} ${field}`);
    assert.equal(parsed.part, 1); assert.equal(parsed.count, 1);
    assert.ok(Buffer.isBuffer(parsed.payload) && parsed.payload.equals(frame.payload), name);
    const fields = text.split('_');
    assert.equal(parsed.action, [0, 1, 2, 3, 5, 6].map(index => fields[index]).join('_'), name);
    // The same frame logged again naming another slot keeps its fingerprint.
    const moved = parseLogLine(encodeLogLine({ ...frame, slot: frame.slot === 7 ? 8 : 7 }));
    assert.equal(moved.action, parsed.action, name); assert.notEqual(moved.slot, parsed.slot);
  }
  assert.equal(VECTORS[2].frame.payload.length, 610);
});

test('the log encoder refuses what the binding encoder refuses, with the payload limit raised to 610', () => {
  const base = VECTORS[1].frame, input = { ...base, seq: 2, payload: inputBody('x') };
  assert.throws(() => encodeLogFrame({ ...input, payload: Buffer.alloc(611, 0x77) }), /1\.\.610 bytes/u);
  assert.throws(() => encodeLogFrame({ ...input, payload: Buffer.alloc(0) }), /1\.\.610 bytes/u);
  assert.throws(() => encodeLogFrame({ ...input, epoch: 'ABCDEF01' }), /Invalid carrier epoch/u);
  assert.throws(() => encodeLogFrame({ ...input, uiNonce: ZERO }), /Invalid carrier UI nonce/u);
  assert.throws(() => encodeLogFrame({ ...input, epoch: ZERO }), /Invalid carrier epoch/u);
  assert.throws(() => encodeLogFrame({ ...input, slot: 0 }), /coordinates/u);
  assert.throws(() => encodeLogFrame({ ...input, slot: 10000 }), /coordinates/u);
  assert.throws(() => encodeLogFrame({ ...input, seq: 0x1000000 }), /Invalid carrier sequence/u);
  assert.throws(() => encodeLogFrame({ ...input, seq: 0 }), /coordinates/u);
  assert.throws(() => encodeLogFrame({ ...base, payload: Buffer.from([0x48, 0x04]) }), /coordinates/u);
  assert.equal(encodeLogFrame({ ...input, payload: Buffer.alloc(1, 0x49) }).length > 0, true);
});

test('only exact General.log frame lines parse; padding, foreign, cut and corrupt lines are null', () => {
  const text = VECTORS[0].text, heartbeat = VECTORS[1].text;
  for (const stamp of ['1/2 03:04:05.006', '11/23 19:41:31.260', '12/1 00:00:00.000']) {
    assert.ok(parseLogLine(`${stamp}  [N][Lua] ${text}`), stamp);
  }
  for (const stamp of ['111/23 19:41:31.260', '11/123 19:41:31.260', '11/23 9:41:31.260', '11/23 19:41:31.26',
    '11/23 19:41:31', '11-23 19:41:31.260', '']) {
    assert.equal(parseLogLine(`${stamp}  [N][Lua] ${text}`), null, stamp);
  }
  assert.ok(parseLogLine(`${asLine(text)}\r`), 'a trailing carriage return is tolerated');
  const core = fields => fields.join('_');
  const rejected = [
    `${STAMP} [N][Lua] ${text}`, `${STAMP}   [N][Lua] ${text}`, ` ${asLine(text)}`,
    `${STAMP}  [N][Console] ${text}`, `${STAMP}  [W][Lua] ${text}`, `${STAMP}  [N][LUA] ${text}`,
    `${STAMP}  [N][Lua]  ${text}`, `${asLine(text)} `, `${asLine(text)}\n`, `${asLine(text)}\r\r`,
    asLine(`WCLP${'.'.repeat(3990)}`), asLine('WCLP'), asLine('another addon mentions WCL1'), asLine(`x${text}`),
    asLine(text.slice(0, 40)), asLine(text.slice(0, -1)), asLine(text.slice(0, text.lastIndexOf('_'))),
    asLine(`${text.slice(0, -1)}${text.endsWith('8') ? '9' : '8'}`),
    asLine(text.replace('ABCDEF01', 'ABCDEF02')),
    asLine(text.toLowerCase()),
    // Lowercase hex or base32 with a matching CRC: the encoder writes uppercase only.
    asLine(withCrc(core(['WCL1', '0123abcd', '89ABCDEF', 'ABCDEF01', '0002', '000000', 'JAAQ']))),
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000000', 'jaaq']))),
    // Payload sizes outside 1..610 and non-canonical base32, each with a matching CRC.
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000002', encodeBase32(Buffer.alloc(611, 0x77))]))),
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000002', '']))),
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000002', 'JB']))),
    // Coordinates the encoder refuses, each with a matching CRC.
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', ZERO, '0002', '000002', 'JE']))),
    asLine(withCrc(core(['WCL1', ZERO, '89ABCDEF', 'ABCDEF01', '0002', '000002', 'JE']))),
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0000', '000002', 'JE']))),
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '2710', '000002', 'JE']))),
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000000', 'JE']))),
    // A binding frame is not a log frame.
    asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000002', '01', '01', 'JE']))),
  ];
  for (const line of rejected) assert.equal(parseLogLine(line), null, JSON.stringify(line.slice(0, 90)));
  assert.ok(parseLogLine(asLine(heartbeat)));
  assert.ok(parseLogLine(asLine(withCrc(core(['WCL1', '0123ABCD', '89ABCDEF', 'ABCDEF01', '0002', '000002', 'JE'])))),
    'the hand-built control frame is valid');
  for (const value of [null, undefined, 42, Buffer.from(asLine(text))]) assert.equal(parseLogLine(value), null);
});

async function tempLog(t, { create = true } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'witchcraft-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logFile = path.join(root, 'Logs', 'General.log');
  if (create) await fs.mkdir(path.dirname(logFile));
  return logFile;
}

function recorder({ fail = () => false } = {}) {
  const receiver = new BindingReceiver({ epoch: EPOCH, nonce: NONCE }), seen = [];
  receiver.accept = async frame => {
    seen.push(frame.seq);
    if (fail(frame)) throw new Error(`synthetic accept failure ${frame.seq}`);
    return { accepted: true };
  };
  return { receiver, seen };
}

const frameLine = (seq, slot = 1) => encodeLogLine({ epoch: EPOCH, nonce: NONCE, uiNonce: UI, slot, seq, payload: inputBody(`body ${seq}`) });
const noise = '11/23 19:41:30.001  [N][Console] Connecting to the realm server\n11/23 19:41:30.002  [N][Lua] WCLP........\n';

test('the reader starts at the end of an existing file and reads appended frames in file order', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, `${noise}${frameLine(1)}\r\n`);
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), maxPassBytes: 64 });
  await carrier.scan();
  assert.deepEqual(seen, [], 'history before the first scan is skipped');
  await fs.appendFile(logFile, `${frameLine(2)}\r\n${noise}${frameLine(3)}\n${frameLine(4)}\r\n`);
  await carrier.scan();
  assert.deepEqual(seen, [2, 3, 4]);
  await carrier.scan();
  assert.deepEqual(seen, [2, 3, 4], 'nothing is read twice');
  assert.deepEqual(errors, []);
});

test('a reader that starts inside an unfinished line skips the rest of that line', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, `${noise}11/23 19:41:31.000  [N][Console] cut short`);
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  await carrier.scan();
  await fs.appendFile(logFile, `${frameLine(1)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [], 'the rest of the line the reader joined midway');
  await fs.appendFile(logFile, `${frameLine(2)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [2]);
  assert.deepEqual(errors, []);
});

test('the reader reads a truncated or re-created file from its start', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, `${noise}${frameLine(1)}\n${frameLine(2)}\n`);
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  await carrier.scan();
  await fs.writeFile(logFile, `${frameLine(5)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [5], 'truncated');
  await fs.rm(logFile);
  await carrier.scan();
  await fs.writeFile(logFile, `${frameLine(6)}\n${frameLine(7)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [5, 6, 7], 're-created after a scan saw it missing');
  await fs.rm(logFile);
  await fs.writeFile(logFile, `${frameLine(8)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [5, 6, 7, 8], 're-created shorter between scans');
  assert.deepEqual(errors, []);
});

test('the reader holds an unterminated last line until it is completed', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder();
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver });
  await carrier.scan();
  const line = frameLine(1);
  await fs.appendFile(logFile, line.slice(0, 30));
  await carrier.scan();
  await fs.appendFile(logFile, line.slice(30, 60));
  await carrier.scan();
  assert.deepEqual(seen, []);
  await fs.appendFile(logFile, `${line.slice(60)}\r\n${frameLine(2).slice(0, 10)}`);
  await carrier.scan();
  assert.deepEqual(seen, [1]);
  await fs.appendFile(logFile, `${frameLine(2).slice(10)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2]);
});

test('an over-long line is dropped and the next frame still arrives', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), maxPassBytes: 4096 });
  await carrier.scan();
  // Carried across scans past the limit, then completed by what looks like a frame line.
  await fs.appendFile(logFile, 'x'.repeat(5000));
  await carrier.scan();
  await fs.appendFile(logFile, 'x'.repeat(5000));
  await carrier.scan();
  await fs.appendFile(logFile, `${frameLine(1)}\n${frameLine(2)}\n`);
  await carrier.scan();
  // Within one read: a line of 9,000 bytes ending in a frame line's text.
  await fs.appendFile(logFile, `${'y'.repeat(9000)}${frameLine(3)}\n${frameLine(4)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [2, 4]);
  assert.deepEqual(errors, []);
});

test('a foreign unterminated tail is not kept, and the frame on the next line still arrives', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder();
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver });
  await carrier.scan();
  await fs.appendFile(logFile, '11/23 19:41:31.260  [N][AccountData] secret-looking text');
  await carrier.scan();
  assert.deepEqual(carrier.carry, []); assert.equal(carrier.carryBytes, 0);
  await fs.appendFile(logFile, ` and more of it\n${frameLine(1)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1]);
  // A kept line start that a later chunk turns foreign is dropped too.
  await fs.appendFile(logFile, '11/23 19:41:32.000  [N][');
  await carrier.scan();
  assert.equal(carrier.carryBytes, 24, 'a possible frame start is kept');
  await fs.appendFile(logFile, 'AccountData] more secret-looking text');
  await carrier.scan();
  assert.deepEqual(carrier.carry, []); assert.equal(carrier.carryBytes, 0);
  await fs.appendFile(logFile, `\n${frameLine(2)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2]);
});

test('a frame line split at any byte across two appends arrives exactly once', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder();
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver });
  await carrier.scan();
  const text = `${frameLine(1)}\r\n`;
  for (let at = 0; at <= text.length; at += 1) {
    await fs.appendFile(logFile, text.slice(0, at));
    await carrier.scan();
    await fs.appendFile(logFile, text.slice(at));
    await carrier.scan();
    assert.equal(seen.length, at + 1, `split at ${at}`);
  }
  // A one-digit month and day put the frame tag at 32; one character past it is still a frame start.
  const short = `${encodeLogLine({ epoch: 'b0000000', nonce: NONCE, uiNonce: UI, slot: 1, seq: 2, payload: inputBody('short') }, '1/5 19:41:31.260')}\n`;
  await fs.appendFile(logFile, short.slice(0, 33));
  await carrier.scan();
  assert.equal(carrier.carryBytes, 33);
  await fs.appendFile(logFile, short.slice(33));
  await carrier.scan();
  assert.equal(seen.at(-1), 2);
});

test('a kept tail is bounded by a frame line, and the longest frame line split before its end still arrives', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder();
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver });
  await carrier.scan();
  await fs.appendFile(logFile, `${STAMP}  [N][Lua] WCL1_${'Z'.repeat(5000)}`);
  await carrier.scan();
  assert.deepEqual(carrier.carry, []); assert.equal(carrier.carryBytes, 0);
  await fs.appendFile(logFile, `\n${frameLine(1)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1]);
  const text = `${encodeLogLine(VECTORS[2].frame)}\r\n`;
  await fs.appendFile(logFile, text.slice(0, -1));
  await carrier.scan();
  assert.equal(carrier.carryBytes, text.length - 1, 'the longest frame line and its \\r are kept');
  await fs.appendFile(logFile, text.slice(-1));
  await carrier.scan();
  assert.deepEqual(seen, [1, 2]);
});

test('only a prefix of a real frame line is kept as a tail', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder();
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver });
  await carrier.scan();
  const complete = encodeLogFrame({ epoch: EPOCH, nonce: NONCE, uiNonce: UI, slot: 1, seq: 1, payload: inputBody('body 1') });
  for (const tail of ['WCL1_Z', 'WCL1_0123ABCD_89ABCDEF_ABCDEF01_00G', 'WCL1_00000000__', `${complete}\rX`, 'WCL1_0123ABCD0']) {
    await fs.appendFile(logFile, asLine(tail));
    await carrier.scan();
    assert.deepEqual(carrier.carry, [], tail); assert.equal(carrier.carryBytes, 0, tail);
    await fs.appendFile(logFile, '\n');
    await carrier.scan();
  }
  await fs.appendFile(logFile, asLine('WCL1_0123ABCD_89'));
  await carrier.scan();
  assert.equal(carrier.carryBytes, asLine('WCL1_0123ABCD_89').length, 'a real frame prefix is kept');
  await fs.appendFile(logFile, `\n${frameLine(2)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [2]);
});

test('a file that vanishes between stat and open is the missing-file case; another open failure is an error', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  await carrier.scan();
  await fs.appendFile(logFile, frameLine(1).slice(0, 40));
  await carrier.scan();
  assert.equal(carrier.carryBytes, 40);
  await fs.appendFile(logFile, `${frameLine(1).slice(40)}\n`);
  // fs.open fails as it would for a file removed after the stat.
  const open = fs.open, failWith = code => async () => { throw Object.assign(new Error(code), { code }); };
  fs.open = failWith('ENOENT');
  try { await carrier.scan(); } finally { fs.open = open; }
  assert.equal(carrier.offset, 0); assert.equal(carrier.birth, null); assert.equal(carrier.carryBytes, 0);
  assert.deepEqual(errors, []);
  fs.open = failWith('EACCES');
  try { await carrier.scan(); } finally { fs.open = open; }
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'EACCES');
  await carrier.scan();
  assert.deepEqual(seen, [1], 'the next scan reads the file from its start');
});

test('each read is one bounded read; scan reads the rest in order, and a truncation between reads restarts', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), maxPassBytes: 64 });
  await carrier.read();
  assert.equal(carrier.offset, 0);
  await fs.appendFile(logFile, [1, 2, 3, 4].map(seq => `${frameLine(seq)}\n`).join(''));
  await carrier.read();
  assert.equal(carrier.offset, 64, 'one read of at most maxPassBytes');
  assert.deepEqual(seen, []);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2, 3, 4]);
  await fs.appendFile(logFile, [5, 6, 7].map(seq => `${frameLine(seq)}\n`).join(''));
  await carrier.read(); await carrier.read(); await carrier.read();
  const before = [...seen];
  await fs.writeFile(logFile, `${frameLine(9)}\n`);
  const { size } = await fs.stat(logFile);
  assert.ok(size < carrier.offset, 'the rewritten file is shorter than the offset');
  await carrier.read();
  assert.equal(carrier.offset, Math.min(64, size), 'the read after the truncation starts at 0');
  await carrier.scan();
  assert.deepEqual(seen, [...before, 9]);
  assert.deepEqual(errors, []);
});

test('a file that shrank is a new file even while the reader is behind it', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), maxPassBytes: 64 });
  await carrier.read();
  await fs.appendFile(logFile, [1, 2, 3, 4].map(seq => `${frameLine(seq)}\n`).join(''));
  await carrier.read();
  assert.equal(carrier.offset, 64, 'the reader is behind the file');
  // Another epoch, so the new first line differs from the old one within the bytes already read.
  const other = seq => encodeLogLine({ epoch: 'b0000000', nonce: NONCE, uiNonce: UI, slot: 1, seq, payload: inputBody(`body ${seq}`) });
  await fs.writeFile(logFile, `${other(9)}\n${other(10)}\n`);
  const { size } = await fs.stat(logFile);
  assert.ok(size > 64 && size < 4 * (frameLine(1).length + 1), 'shorter than the old file, longer than the offset');
  await carrier.scan();
  assert.deepEqual(seen, [9, 10], 'the new file from its first line, none of the old one');
  assert.deepEqual(errors, []);
});

test('stop leaves no carried bytes', async t => {
  const logFile = await tempLog(t), { receiver } = recorder();
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver });
  await carrier.scan();
  await fs.appendFile(logFile, frameLine(1).slice(0, 40));
  await carrier.scan();
  assert.equal(carrier.carryBytes, 40);
  await carrier.stop();
  assert.deepEqual(carrier.carry, []); assert.equal(carrier.carryBytes, 0);
});

// A handle opened r+ writes at any position; a write past the end zero-fills the gap (a hole of NUL bytes).
async function writeAt(file, text, position) {
  const handle = await fs.open(file, 'r+');
  try { const bytes = Buffer.from(text, 'latin1'); await handle.write(bytes, 0, bytes.length, position); }
  finally { await handle.close(); }
}
// Non-frame lines of exactly length bytes in all.
const padding = length => `${'p'.repeat(999)}\n`.repeat(Math.floor(length / 1000)) + (length % 1000 ? `${'q'.repeat(length % 1000 - 1)}\n` : '');
const oldLines = count => Array.from({ length: count }, (_, index) =>
  `11/23 19:40:${String(index % 60).padStart(2, '0')}.000  [N][Console] old run line ${index}\n`).join('');
const oldExit = '11/23 19:41:29.000  [N][Console] old client exiting\n11/23 19:41:29.001  [N][Console] log closed\n';

// The quick relaunch: the new client truncates, the old one writes its last lines at its old offset, and
// the new client writes from 0 into the NUL bytes without changing the size.
async function holeIncident(t, { seeShrink }) {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, oldLines(200));
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  await carrier.scan();
  const { size: oldSize } = await fs.stat(logFile);
  await fs.truncate(logFile, 0);
  if (seeShrink) await carrier.scan();
  await writeAt(logFile, oldExit, oldSize);
  await carrier.scan();
  assert.deepEqual(seen, [], 'the old run\'s exit lines after the hole are not read');
  assert.equal(carrier.offset, 0, 'parked at the hole');
  assert.deepEqual(carrier.carry, []); assert.equal(carrier.carryBytes, 0, 'a park holds no tail');
  const fileSize = oldSize + oldExit.length;
  let at = 0;
  const write = async text => { await writeAt(logFile, text, at); at += text.length; };
  await write(`${frameLine(1)}\n`);
  assert.equal((await fs.stat(logFile)).size, fileSize, 'the size did not change');
  await carrier.scan();
  assert.deepEqual(seen, [1]);
  await write(`${frameLine(2)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2]);
  // Frame 3 starts 10 bytes before the old size: the write crosses the hole's end and the old size.
  await write(`${padding(fileSize - 10 - at)}${frameLine(3)}\n`);
  assert.ok(at > fileSize);
  await carrier.scan();
  await fs.appendFile(logFile, `${frameLine(4)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2, 3, 4], 'each frame once, in order');
  assert.deepEqual(errors, []);
}

test('a relaunch that leaves a hole: the reader parks at the NUL bytes and reads what is written into them', async t => {
  await holeIncident(t, { seeShrink: true });
});

test('a relaunch that leaves a hole, the shrink unseen: the head mark finds the new file', async t => {
  await holeIncident(t, { seeShrink: false });
});

test('a file truncated under a running writer: the park ends only after 256 KiB of growth', async t => {
  for (const options of [{}, { maxPassBytes: 4096 }]) {
    const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
    await fs.writeFile(logFile, oldLines(600));
    const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), ...options });
    await carrier.scan();
    const { size } = await fs.stat(logFile);
    await fs.truncate(logFile, 0);
    await writeAt(logFile, `${frameLine(1)}\n${noise}${frameLine(2)}\n`, size);
    await carrier.scan();
    assert.deepEqual(seen, []);
    await fs.appendFile(logFile, padding(256 * 1024));
    await carrier.scan();
    assert.deepEqual(seen, [], 'growth of 256 KiB does not end the park');
    await fs.appendFile(logFile, `${frameLine(3)}\n`);
    if (options.maxPassBytes) {
      await carrier.read();
      assert.equal(carrier.offset, 4096, 'the move over the NUL bytes is bounded per pass');
      assert.equal(carrier.queued, true);
    }
    await carrier.scan();
    assert.deepEqual(seen, [1, 2, 3], 'the frames after the hole, the first line included');
    await fs.appendFile(logFile, `${frameLine(4)}\n`);
    await carrier.scan();
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.deepEqual(errors, []);
  }
});

test('a reader that starts on a file with a hole parks at its first NUL byte', async t => {
  // The second file is longer than 256 KiB before its hole: the search runs outside the end window.
  for (const [before, hole] of [[2000, 5000], [300 * 1024, 300 * 1024]]) {
    const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
    const live = `${frameLine(1)}\n${padding(before)}`;
    await fs.writeFile(logFile, Buffer.concat([Buffer.from(live, 'latin1'), Buffer.alloc(hole), Buffer.from(oldLines(40), 'latin1')]));
    const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
    await carrier.scan();
    assert.equal(carrier.offset, live.length, 'the cursor is at the first NUL byte');
    assert.equal(carrier.overflow, false);
    assert.deepEqual(seen, [], 'nothing before the cursor is read');
    await writeAt(logFile, `${frameLine(2)}\n`, live.length);
    await carrier.scan();
    assert.deepEqual(seen, [2]);
    assert.deepEqual(errors, []);
  }
});

// While run goes, fs.open hands out handles whose read goes through wrap: to cut a read short or to fail it.
async function wrapReads(wrap, run) {
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    return { read: (...read) => wrap((...inner) => handle.read(...inner), ...read), close: () => handle.close() };
  };
  try { return await run(); } finally { fs.open = open; }
}

test('a tail held before a hole is dropped when the reader moves over the hole in several passes', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), maxPassBytes: 64 });
  await carrier.scan();
  // 40 bytes of a frame line, a hole of two passes, then a whole frame line starting exactly at a pass start.
  await fs.writeFile(logFile, Buffer.concat([Buffer.from(frameLine(9).slice(0, 40), 'latin1'), Buffer.alloc(128),
    Buffer.from(`${frameLine(1)}\n`, 'latin1')]));
  await carrier.scan();
  assert.equal(carrier.offset, 40); assert.equal(carrier.carryBytes, 40, 'parked with the unfinished line held');
  await fs.appendFile(logFile, `${padding(256 * 1024 + 1000)}${frameLine(2)}\n`);
  await carrier.read(); await carrier.read();
  assert.equal(carrier.offset, 168, 'two passes of NUL bytes');
  assert.equal(carrier.carryBytes, 0, 'the held tail went when the move began');
  carrier.maxPassBytes = 4 * 1024 * 1024;
  await carrier.scan();
  assert.deepEqual(seen, [1, 2], 'the first line after the hole is whole');
  assert.deepEqual(errors, []);
});

test('a start on a hole places the cursor only when every read for it succeeded and was complete', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  // A physical line that is not finished before the hole: what fills the hole first is the rest of that line.
  const live = `${noise}secret `;
  await fs.writeFile(logFile, Buffer.concat([Buffer.from(live, 'latin1'), Buffer.alloc(5000), Buffer.from(oldLines(40), 'latin1')]));
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  // The read of the byte before the cursor fails: nothing is placed.
  await wrapReads((read, buffer, offset, length, position) => {
    if (length === 1 && position === live.length - 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return read(buffer, offset, length, position);
  }, () => carrier.scan());
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'EIO');
  assert.equal(carrier.offset, null, 'not placed');
  // The end window comes back empty (the file went away under the read): nothing is placed, and it is no error.
  await wrapReads((read, buffer, offset, length, position) =>
    (length > 64 ? { bytesRead: 0, buffer } : read(buffer, offset, length, position)), () => carrier.scan());
  assert.equal(carrier.offset, null); assert.equal(errors.length, 1);
  // So do the head mark and the one-byte reads of the search and of the byte before the cursor.
  const emptyWhen = when => wrapReads((read, buffer, offset, length, position) =>
    (when(length, position) ? { bytesRead: 0, buffer } : read(buffer, offset, length, position)), () => carrier.scan());
  for (const when of [(length, position) => length === 64 && position === 0, length => length === 1,
    (length, position) => length === 1 && position === live.length - 1]) {
    await emptyWhen(when);
    assert.equal(carrier.offset, null, 'a read that found the file ended places nothing');
    assert.equal(carrier.parkSize, null); assert.equal(errors.length, 1);
  }
  // Reads that come back short are read on until they are complete.
  await wrapReads((read, buffer, offset, length, position) => read(buffer, offset, Math.min(length, 1024), position),
    () => carrier.scan());
  assert.equal(carrier.offset, live.length, 'the cursor is at the first NUL byte');
  assert.equal(carrier.overflow, true, 'inside an unfinished line');
  await writeAt(logFile, `${frameLine(1)}\n`, live.length);
  await carrier.scan();
  assert.deepEqual(seen, [], 'the rest of the unfinished line is not a line of its own');
  await writeAt(logFile, `${frameLine(2)}\n`, live.length + frameLine(1).length + 1);
  await carrier.scan();
  assert.deepEqual(seen, [2]);
  assert.equal(errors.length, 1);
});

test('a file rewritten in one step to a longer one is known by its first bytes', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder(), errors = [];
  await fs.writeFile(logFile, `${noise}${frameLine(1)}\n`);
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  await carrier.scan();
  const { size } = await fs.stat(logFile);
  const next = `${frameLine(2)}\n${noise}${frameLine(3)}\n${noise}`;
  assert.ok(next.length > size, 'no scan sees a smaller file');
  await fs.writeFile(logFile, next);
  await carrier.scan();
  assert.deepEqual(seen, [2, 3], 'the new file from its first line');
  assert.deepEqual(errors, []);
});

test('a missing folder and file are not errors, and a file that appears is read from its start', async t => {
  const logFile = await tempLog(t, { create: false }), { receiver, seen } = recorder(), errors = [];
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error) });
  await carrier.scan();
  await fs.mkdir(path.dirname(logFile));
  await carrier.scan();
  await fs.writeFile(logFile, `${noise}${frameLine(1)}\n${frameLine(2)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(errors, []);
});

test('an accept failure goes to onError and the scan continues with the next line', async t => {
  const logFile = await tempLog(t), { receiver, seen } = recorder({ fail: frame => frame.seq === 2 }), errors = [];
  await fs.writeFile(logFile, '');
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error.message) });
  await carrier.scan();
  await fs.appendFile(logFile, `${frameLine(1)}\n${frameLine(2)}\n${frameLine(3)}\n`);
  await carrier.scan();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(errors, ['synthetic accept failure 2']);
});

test('start polls a folder that does not exist yet, and stop ends reading', async t => {
  const logFile = await tempLog(t, { create: false }), { receiver, seen } = recorder(), errors = [];
  const carrier = new LogCarrier({ logFile, receiver, onError: error => errors.push(error), pollMs: 20 });
  assert.throws(() => new LogCarrier({ logFile: 'relative.log', receiver }), /Invalid log carrier configuration/u);
  assert.throws(() => new LogCarrier({ logFile, receiver: {} }), /Invalid log carrier configuration/u);
  await carrier.start();
  t.after(() => carrier.stop());
  await fs.mkdir(path.dirname(logFile));
  await fs.writeFile(logFile, `${frameLine(1)}\n`);
  const deadline = Date.now() + 3000;
  while (seen.length < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, [1]);
  await carrier.stop();
  await fs.appendFile(logFile, `${frameLine(2)}\n`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(seen, [1]);
  assert.deepEqual(errors, []);
});

test('the binding receiver through the log parser: probe, input, duplicate on a newer slot, new UI probe', async () => {
  const cursors = [], messages = [], acks = [];
  const receiver = new BindingReceiver({ epoch: EPOCH, nonce: NONCE,
    onCursor: frame => { cursors.push([frame.uiNonce, frame.slot]); return true; },
    onMessage: message => { messages.push(message); return { accepted: true }; },
    onAck: (seq, _frame, result) => { acks.push([seq, result?.probe === true, result?.duplicate === true]); } });
  const feed = frame => receiver.accept(parseLogLine(encodeLogLine(frame)));
  const probe = await feed({ epoch: ZERO, nonce: ZERO, uiNonce: UI, slot: 1, seq: 1, payload: BINDING_PROBE_BODY });
  assert.equal(probe.probe, true); assert.equal(probe.ack, 1);
  const input = { epoch: EPOCH, nonce: NONCE, uiNonce: UI, slot: 2, seq: 2, payload: inputBody('from the log') };
  const accepted = await feed(input);
  assert.equal(accepted.accepted, true); assert.equal(accepted.ack, 2);
  assert.deepEqual(messages.map(message => [message.tab, message.action, message.text]), [['codex', 'text', 'from the log']]);
  const again = await feed({ ...input, slot: 3 });
  assert.equal(again.accepted, true); assert.equal(again.duplicate, true); assert.equal(again.ack, 2);
  assert.equal(receiver.quarantined, false, 'a newer slot is not a sequence mutation');
  assert.deepEqual(cursors.at(-1), [UI, 3], 'the cursor callback saw the new slot');
  assert.equal(messages.length, 1);
  const reloaded = await feed({ epoch: ZERO, nonce: ZERO, uiNonce: 'abcdef02', slot: 1, seq: 1, payload: BINDING_PROBE_BODY });
  assert.equal(reloaded.probe, true); assert.equal(reloaded.ack, 1); assert.equal(receiver.uiNonce, 'abcdef02');
  const next = await feed({ ...input, uiNonce: 'abcdef02', payload: inputBody('after reload') });
  assert.equal(next.ack, 2); assert.equal(messages.at(-1).text, 'after reload');
  assert.deepEqual(acks, [[1, true, false], [2, false, false], [2, false, true], [1, true, false], [2, false, false]]);
});
