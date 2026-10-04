import fs from 'node:fs/promises';
import path from 'node:path';

// The launcher's .build.info at the install root has one row per installed product. A product's
// folder is its name after "wow_" between underscores (wow_classic_beta is _classic_beta_), and
// plain "wow" is _retail_.
function folderOf(product) { return product === 'wow' ? '_retail_' : product.startsWith('wow_') ? `_${product.slice(4)}_` : null; }

async function readClient(addonsDir) {
  const folder = path.basename(path.resolve(addonsDir, '../..'));
  const text = await fs.readFile(path.resolve(addonsDir, '../../../.build.info'), 'utf8').catch(() => null);
  if (!text) return null;
  const [header, ...rows] = text.split(/\r?\n/u).filter(Boolean).map(line => line.split('|'));
  const column = name => header.findIndex(field => field.split('!')[0] === name);
  const version = column('Version'), product = column('Product');
  if (version < 0 || product < 0) return null;
  const match = rows.find(fields => folderOf(fields[product] ?? '') === folder);
  return /^\d+(\.\d+){3}$/u.test(match?.[version] ?? '') ? match[version] : null;
}

// The pin lives in one Lua line (Witchcraft/Evidence.lua); the installed copy is what the game will load.
async function readPinned(addonsDir) {
  const text = await fs.readFile(path.join(addonsDir, 'Witchcraft', 'Evidence.lua'), 'utf8').catch(() => null);
  const pin = text && /version\s*=\s*"(\d+\.\d+\.\d+)"\s*,\s*build\s*=\s*"(\d+)"/u.exec(text);
  return pin ? `${pin[1]}.${pin[2]}` : null;
}

/** Compares the installed client with the build Witchcraft's carriers were checked against. */
export async function checkClientBuild(addonsDir) {
  const [client, pinned] = await Promise.all([readClient(addonsDir), readPinned(addonsDir)]);
  if (!client || !pinned) return { status: 'unknown', client, pinned };
  return { status: client === pinned ? 'match' : 'mismatch', client, pinned };
}
