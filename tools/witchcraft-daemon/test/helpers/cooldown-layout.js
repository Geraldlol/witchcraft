// Builds the client-side `1|Base64(Deflate(CBOR(layout)))` value that WoW writes to
// cooldownmanager.txt, so tests can produce a real carrier file without the game.
import { deflateRawSync, deflateSync } from 'node:zlib';

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value <= 0xff) return Buffer.from([(major << 5) | 24, value]);
  if (value <= 0xffff) { const out = Buffer.alloc(3); out[0] = (major << 5) | 25; out.writeUInt16BE(value, 1); return out; }
  const out = Buffer.alloc(5); out[0] = (major << 5) | 26; out.writeUInt32BE(value, 1); return out;
}

const uint = value => head(0, value);
const bytes = value => Buffer.concat([head(2, value.length), value]);
const array = values => Buffer.concat([head(4, values.length), ...values]);
const map = entries => Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, value]) => [uint(key), value])]);

export function cooldownLayout(wire, { empty = 'array', unknown = false, raw = false, trailing = false } = {}) {
  const emptyValue = empty === 'array' ? array([]) : map([]);
  const entries = [[1, uint(5)], [2, emptyValue], [3, emptyValue], [4, emptyValue]];
  if (wire) entries.push([127, bytes(wire)]);
  if (unknown) entries.push([126, uint(1)]);
  const cbor = map(entries), compressed = (raw ? deflateRawSync : deflateSync)(cbor);
  const body = trailing ? Buffer.concat([compressed, Buffer.from('trailing')]) : compressed;
  return Buffer.from(`1|${body.toString('base64')}`, 'ascii');
}
