import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';

test('client account resolution follows the configured AddOns root, not the process cwd', async t => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-config-'));
  t.after(async () => { assert.equal(path.dirname(repo), os.tmpdir()); await fs.rm(repo, { recursive: true, force: true }); });
  const addonsDir = path.join(repo, 'client/Interface/AddOns'), accounts = path.join(repo, 'client/WTF/Account');
  await fs.mkdir(addonsDir, { recursive: true }); await fs.mkdir(path.join(accounts, 'one'), { recursive: true });
  await fs.writeFile(path.join(repo, 'wow.config.json'), JSON.stringify({ addonsDir }));
  const options = { repoRoot: repo, configPath: path.join(repo, 'local.json') };
  const config = await loadConfig(options);
  assert.equal(config.accountDir, path.join(accounts, 'one'));
  assert.equal(config.savedVariables, path.join(accounts, 'one/SavedVariables/Witchcraft.lua'));
  await fs.mkdir(path.join(accounts, 'two'));
  await assert.rejects(loadConfig(options), /exactly one/u);
  await assert.rejects(loadConfig({ ...options, account: '../two' }), /Invalid account/u);
  assert.equal((await loadConfig({ ...options, account: 'two' })).account, 'two');
});

test('character resolution is opt-in, skips SavedVariables and refuses an ambiguous or unsafe name', async t => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'witchcraft-character-'));
  t.after(async () => { assert.equal(path.dirname(repo), os.tmpdir()); await fs.rm(repo, { recursive: true, force: true }); });
  const addonsDir = path.join(repo, 'client/Interface/AddOns'), account = path.join(repo, 'client/WTF/Account/one');
  await fs.mkdir(addonsDir, { recursive: true });
  await fs.mkdir(path.join(account, 'SavedVariables'), { recursive: true });
  await fs.mkdir(path.join(account, '70/Testchar-Testrealm'), { recursive: true });
  await fs.writeFile(path.join(repo, 'wow.config.json'), JSON.stringify({ addonsDir }));
  const options = { repoRoot: repo, configPath: path.join(repo, 'local.json') };

  // Nobody asked for a character, so the directory scan never runs.
  assert.equal((await loadConfig(options)).characterDir, undefined);

  // Enabling the carrier opts in, and SavedVariables is not mistaken for a realm.
  await fs.writeFile(options.configPath, JSON.stringify({ cooldownCarrier: true }));
  const enabled = await loadConfig(options);
  assert.equal(enabled.characterDir, path.join(account, '70/Testchar-Testrealm'));
  assert.equal(enabled.character, 'Testchar-Testrealm');

  // A second character makes automatic selection ambiguous until one is named.
  await fs.mkdir(path.join(account, '70/Altchar-Testrealm'));
  await assert.rejects(loadConfig(options), /Choose the character with --character/u);
  assert.equal((await loadConfig({ ...options, character: 'Altchar-Testrealm' })).characterDir,
    path.join(account, '70/Altchar-Testrealm'));
  await assert.rejects(loadConfig({ ...options, character: '../Testchar-Testrealm' }), /Invalid character/u);
  for (const unsafe of ['Alt\\char', 'Alt/char', 'Alt:char', 'Alt\0char', '.', '..']) {
    await assert.rejects(loadConfig({ ...options, character: unsafe }), /Invalid character/u);
  }
  await assert.rejects(loadConfig({ ...options, character: 'Ghost' }), /No character folder named/u);
  const source = await fs.readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.equal(source.includes('\0'), false, 'config.js must remain pure text without NUL bytes');
});
