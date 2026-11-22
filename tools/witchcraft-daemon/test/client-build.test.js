import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkClientBuild } from '../src/client-build.js';

const HEADER = 'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Install Key!HEX:16|IM Size!DEC:4|CDN Path!STRING:0'
  + '|CDN Hosts!STRING:0|CDN Servers!STRING:0|Tags!STRING:0|Armadillo!STRING:0|Last Activated!STRING:0|Version!STRING:0'
  + '|KeyRing!HEX:16|Product!STRING:0';
const row = (version, product) => `us|1|a|b|||tpr/wow|hosts|servers|tags|||${version}||${product}`;
const EVIDENCE = 'local Evidence = { version = "1.60.1", build = "69977", interface = 16001 }\n';

async function client(t, { rows, evidence = EVIDENCE, folder = '_classic_beta_' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-build-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });
  const addonsDir = path.join(root, folder, 'Interface', 'AddOns');
  await fs.mkdir(path.join(addonsDir, 'Witchcraft'), { recursive: true });
  if (rows) await fs.writeFile(path.join(root, '.build.info'), [HEADER, ...rows].join('\r\n') + '\r\n');
  if (evidence !== null) await fs.writeFile(path.join(addonsDir, 'Witchcraft', 'Evidence.lua'), evidence);
  return addonsDir;
}

test('client build matches the installed Witchcraft pin', async t => {
  const addonsDir = await client(t, { rows: [row('1.60.1.69977', 'wow_classic_beta')] });
  assert.deepEqual(await checkClientBuild(addonsDir), { status: 'match', client: '1.60.1.69977', pinned: '1.60.1.69977' });
});

test('a patched client is reported as a mismatch naming both builds', async t => {
  const addonsDir = await client(t, { rows: [row('1.60.1.69999', 'wow_classic_beta')] });
  const result = await checkClientBuild(addonsDir);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.client, '1.60.1.69999'); assert.equal(result.pinned, '1.60.1.69977');
});

test('the row for this client folder is chosen among other installed products', async t => {
  const addonsDir = await client(t, { rows: [row('11.2.5.63000', 'wow'), row('1.60.1.69977', 'wow_classic_beta'),
    row('1.15.8.1', 'wow_classic_era')] });
  assert.equal((await checkClientBuild(addonsDir)).status, 'match');
  const retail = await client(t, { folder: '_retail_', rows: [row('11.2.5.63000', 'wow'), row('1.60.1.69977', 'wow_classic_beta')] });
  assert.equal((await checkClientBuild(retail)).client, '11.2.5.63000');
});

test('the launch wowf product maps to the _forever_ client folder', async t => {
  const evidence = 'local Evidence = { version = "1.60.1", build = "70685", interface = 16001 }\n';
  const addonsDir = await client(t, { folder: '_forever_', evidence,
    rows: [row('1.60.1.70532', 'wow_classic_beta'), row('1.60.1.70685', 'wowf')] });
  assert.deepEqual(await checkClientBuild(addonsDir),
    { status: 'match', client: '1.60.1.70685', pinned: '1.60.1.70685' });
});

test('missing or unreadable inputs are unknown, never a failure', async t => {
  assert.equal((await checkClientBuild(await client(t))).status, 'unknown', 'no .build.info');
  assert.equal((await checkClientBuild(await client(t, { rows: [row('1.60.1.69977', 'wow_other')] }))).status, 'unknown',
    'no row for this folder');
  assert.equal((await checkClientBuild(await client(t, { rows: [row('1.60.1.69977', 'wow_classic_beta')], evidence: null }))).status,
    'unknown', 'no installed Evidence.lua');
  assert.equal((await checkClientBuild(await client(t, { rows: [row('1.60.1.69977', 'wow_classic_beta')], evidence: '-- empty' }))).status,
    'unknown', 'no pin in Evidence.lua');
});
