import test from 'node:test';
import assert from 'node:assert/strict';
import luaparse from 'luaparse';
import { MAX_CHUNK_BYTES, quoteLua, serializeLua, serializeChunk } from '../src/lua.js';

test('lua: malicious source and WoW tokens stay inside one quoted string AST', () => {
  const text = '"); os.execute("bad"); --\n|Tpath|t \\ [[ ]] \0 123 Привіт 🌕';
  const source = serializeChunk({ seq: 1, lines: [text], changed: true });
  const ast = luaparse.parse(source, { luaVersion: '5.1', encodingMode: 'pseudo-latin1' });
  assert.equal(ast.body.length, 1); assert.equal(ast.body[0].type, 'CallStatement');
  const call = ast.body[0].expression; assert.equal(call.base.name, 'Witchcraft_ReceiveChunk');
  const field = call.arguments[0].fields.find(f => f.key.value === 'lines');
  const literal = field.value.fields[0].value;
  assert.equal(Buffer.from(literal.value, 'latin1').toString('utf8'), text);
  assert.ok(!source.includes('\n|T'), 'literal newlines are escaped');
});

test('lua: fixed decimal byte escapes cannot swallow following digits', () => {
  assert.equal(quoteLua('\0' + '123\n\r\t"\\'), '"\\000123\\010\\013\\009\\"\\\\"');
  const ast = luaparse.parse('return ' + quoteLua('é😀'), { encodingMode: 'pseudo-latin1' });
  assert.equal(Buffer.from(ast.body[0].arguments[0].value, 'latin1').toString('utf8'), 'é😀');
});

test('lua: deterministic data serialization handles nested tab payloads', () => {
  const payload = { seq: 7, epoch: '0123abcd', uiNonce: '12345678', sessions: {
    codex: { lines: ['ready'], cols: 120, rows: 40 }, claude: { lines: [], cols: 120, rows: 40 },
  }, ack: 0, changed: false };
  const source = serializeChunk(payload);
  assert.equal(source, serializeChunk({ ...payload, sessions: { claude: payload.sessions.claude, codex: payload.sessions.codex } }));
  assert.doesNotThrow(() => luaparse.parse(source, { luaVersion: '5.1' }));
  assert.equal(serializeLua([true, false, null, -0.25]), '{true,false,nil,-0.25}');
});

test('lua: no functions, accessors, prototypes, cycles, sparse arrays or nonfinite numbers', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { throw Error('must not invoke'); } });
  for (const payload of [undefined, () => {}, Infinity, NaN, cyclic, getter, new Date(), [, 1], { constructor: 'bad' }, Symbol('x')])
    assert.throws(() => serializeLua(payload), TypeError);
  assert.throws(() => quoteLua('\udfff'), TypeError);
});

test('lua: byte, node, depth and string budgets fail before publication', () => {
  assert.throws(() => serializeLua({ a: { b: { c: 1 } } }, { maxDepth: 2 }), TypeError);
  assert.throws(() => serializeLua([1, 2, 3], { maxNodes: 2 }), TypeError);
  assert.throws(() => serializeLua('x'.repeat(300), { maxBytes: 100 }), TypeError);
  assert.throws(() => quoteLua('x'.repeat(262145)), TypeError);
  assert.throws(() => serializeChunk([]), TypeError);
});

test('lua: the chunk byte budget includes the call wrapper and has a specific error code', () => {
  const overhead = serializeChunk({ lines: ['', '', '', ''] }).length;
  const contentBytes = MAX_CHUNK_BYTES - overhead;
  const lines = Array(4).fill('x'.repeat(Math.floor(contentBytes / 4)));
  lines[0] += 'x'.repeat(contentBytes % 4);
  assert.equal(serializeChunk({ lines }).length, MAX_CHUNK_BYTES);
  lines[0] += 'x';
  assert.throws(() => serializeChunk({ lines }), { code: 'LUA_OUTPUT_BUDGET' });
});
