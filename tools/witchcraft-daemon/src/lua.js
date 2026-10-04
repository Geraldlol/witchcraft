/** Bounded data-only Lua serializer. Output is a literal payload, never caller source. */
export const MAX_CHUNK_BYTES = 1048576;
const outputBudgetError = () => Object.assign(new TypeError('Lua output exceeds byte budget'), { code: 'LUA_OUTPUT_BUDGET' });
// Text an agent produced can be oversized or ill-formed. That costs one frame, never the bridge.
export const displayContentError = message => Object.assign(new TypeError(message), { code: 'DISPLAY_CONTENT' });

export function quoteLua(text) {
  if (typeof text !== 'string') throw new TypeError('Invalid bounded UTF-8 Lua string');
  if (Buffer.byteLength(text, 'utf8') > 262144 || /[\ud800-\udfff]/u.test(text)) throw displayContentError('Invalid bounded UTF-8 Lua string');
  let result = '"';
  for (const byte of Buffer.from(text, 'utf8')) {
    if (byte === 34) result += '\\"';
    else if (byte === 92) result += '\\\\';
    else if (byte < 32 || byte >= 127) result += '\\' + String(byte).padStart(3, '0');
    else result += String.fromCharCode(byte);
  }
  return result + '"';
}

export function serializeLua(value, { maxDepth = 8, maxNodes = 20000, maxBytes = 1048576 } = {}) {
  if (![maxDepth, maxNodes, maxBytes].every(Number.isInteger) || maxDepth < 1 || maxDepth > 16 || maxNodes < 1 || maxNodes > 50000
    || maxBytes < 1 || maxBytes > 2097152) throw new TypeError('Invalid serializer bounds');
  const active = new Set();
  let nodes = 0, bytes = 0;
  const account = text => { bytes += text.length; if (bytes > maxBytes) throw outputBudgetError(); return text; };
  const encode = (item, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) throw new TypeError('Lua payload exceeds structural budget');
    if (item === null) return account('nil');
    if (typeof item === 'string') return account(quoteLua(item));
    if (typeof item === 'boolean') return account(String(item));
    if (typeof item === 'number' && Number.isFinite(item)) return account(String(item));
    if (typeof item !== 'object' || active.has(item)) throw new TypeError('Unsupported or cyclic Lua payload');
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if ((!array && proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(item).length)
      throw new TypeError('Only ordinary arrays and objects are serializable');
    const keys = Object.keys(item);
    if (keys.length > 10000 || (array && (item.length > 10000 || keys.length !== item.length))) throw new TypeError('Sparse or oversized Lua collection');
    active.add(item);
    const entries = [];
    for (const key of keys.sort(array ? (a, b) => Number(a) - Number(b) : undefined)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || key === '__proto__' || key === 'constructor' || key === 'prototype')
        throw new TypeError('Unsafe Lua property');
      const prefix = array ? '' : account('[' + quoteLua(key) + ']=');
      if (array && (String(Number(key)) !== key || !Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) >= item.length))
        throw new TypeError('Unsupported array property');
      entries.push(prefix + encode(descriptor.value, depth + 1));
    }
    active.delete(item);
    return account('{') + entries.join(account(',')) + account('}');
  };
  const result = encode(value, 0);
  if (result.length > maxBytes) throw outputBudgetError();
  return result;
}

export function serializeChunk(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new TypeError('Chunk payload must be an object');
  const prefix = 'Witchcraft_ReceiveChunk(', suffix = ')\n';
  return prefix + serializeLua(payload, { maxBytes: MAX_CHUNK_BYTES - prefix.length - suffix.length }) + suffix;
}
