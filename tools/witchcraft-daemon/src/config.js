import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAttachConfig } from './console-match.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const LOCAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.local');
export function boundedInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be ${min}..${max}`);
  return number;
}
export async function loadConfig({ repoRoot = REPO_ROOT, account, character, configPath = path.join(LOCAL_DIR, 'config.json') } = {}) {
  const wow = JSON.parse(await fs.readFile(path.join(repoRoot, 'wow.config.json'), 'utf8'));
  if (typeof wow.addonsDir !== 'string' || !path.isAbsolute(wow.addonsDir)) throw new Error('wow.config.json requires an absolute addonsDir');
  const addonsDir = path.resolve(wow.addonsDir);
  if (path.basename(addonsDir).toLowerCase() !== 'addons' || path.basename(path.dirname(addonsDir)).toLowerCase() !== 'interface') {
    throw new Error('addonsDir must name the intended client Interface/AddOns directory');
  }
  let local = {};
  try { local = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const accountRoot = path.resolve(addonsDir, '../../WTF/Account');
  account ??= local.account;
  if (!account) {
    const accounts = (await fs.readdir(accountRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    if (accounts.length !== 1) throw new Error('Choose the WoW account with --account; automatic selection requires exactly one account folder');
    [account] = accounts;
  }
  if (typeof account !== 'string' || !account || account === '.' || account === '..' || /[\\/:\0]/u.test(account)) {
    throw new Error('Invalid account folder name');
  }
  const accountDir = path.join(accountRoot, account);
  character ??= local.character;
  // Scanning only happens when something actually asks for a character, so a normal start reads no extra directories.
  const characterDir = (character !== undefined || local.cooldownCarrier === true)
    ? await resolveCharacterDir(accountDir, character) : undefined;
  return { ...local, repoRoot, addonsDir, account, accountDir, configPath,
    character: characterDir ? path.basename(characterDir) : undefined, characterDir,
    savedVariables: path.join(accountDir, 'SavedVariables', 'Witchcraft.lua'),
    logFile: path.resolve(addonsDir, '../../Logs/General.log'),
    ...(local.attach === undefined ? {} : { attach: parseAttachConfig(local.attach) }),
    ringSize: boundedInteger(local.ringSize ?? 3000, 3, 9999, 'ring size') };
}

const SAVED_VARIABLES = 'savedvariables';
async function directoryNames(parent) {
  return (await fs.readdir(parent, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase() !== SAVED_VARIABLES)
    .map(entry => entry.name);
}
async function resolveCharacterDir(accountDir, character) {
  if (character !== undefined && (typeof character !== 'string' || !character
      || character === '.' || character === '..' || /[\\/:\0]/u.test(character))) {
    throw new Error('Invalid character folder name');
  }
  const candidates = [];
  for (const realm of await directoryNames(accountDir)) {
    for (const name of await directoryNames(path.join(accountDir, realm))) candidates.push({ realm, name });
  }
  if (character === undefined) {
    if (candidates.length !== 1) {
      throw new Error('Choose the character with --character; automatic selection requires exactly one character folder');
    }
    return path.join(accountDir, candidates[0].realm, candidates[0].name);
  }
  const matches = candidates.filter(candidate => candidate.name === character);
  if (!matches.length) throw new Error(`No character folder named ${character}`);
  if (matches.length > 1) throw new Error(`Character ${character} exists on more than one realm; remove the duplicate folder`);
  return path.join(accountDir, matches[0].realm, matches[0].name);
}
export async function saveConfig(config, updates) {
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(config.configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(config.configPath), { recursive: true });
  await fs.writeFile(config.configPath, JSON.stringify({ ...previous, ...updates }, null, 2) + '\n', { mode: 0o600 });
}
