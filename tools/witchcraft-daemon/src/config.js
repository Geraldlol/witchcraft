import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAttachConfig } from './console-match.js';
import { atomicWrite } from './ring.js';

export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inSourceTree = path.basename(PACKAGE_DIR) === 'witchcraft-daemon' && path.basename(path.dirname(PACKAGE_DIR)) === 'tools';
export const INSTALLED_PACKAGE = !inSourceTree;
export const CLI_COMMAND = INSTALLED_PACKAGE ? 'npx witchcraft-daemon' : 'node bin/witchcraft.js';
export const PROJECT_DIR = inSourceTree ? path.resolve(PACKAGE_DIR, '../..') : process.cwd();
function fullyQualified(directory) {
  return typeof directory === 'string' && path.isAbsolute(directory)
    && (process.platform !== 'win32' || path.parse(directory).root.length > 1);
}
const stateHome = process.env.WITCHCRAFT_STATE_DIR;
if (stateHome !== undefined && !fullyQualified(stateHome)) {
  throw new Error('WITCHCRAFT_STATE_DIR must be an absolute directory');
}
const defaultStateDir = inSourceTree ? path.join(PACKAGE_DIR, '.local') : path.join(os.homedir(), '.witchcraft');
export const LOCAL_DIR = stateHome === undefined ? defaultStateDir : path.normalize(stateHome);
export const WOW_CONFIG_PATH = path.join(inSourceTree && stateHome === undefined ? PROJECT_DIR : LOCAL_DIR, 'wow.config.json');
export function boundedInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be ${min}..${max}`);
  return number;
}
function clientAddonsDir(directory) {
  if (!fullyQualified(directory)) throw new Error('wow.config.json requires an absolute addonsDir');
  const addonsDir = path.resolve(directory);
  if (path.basename(addonsDir).toLowerCase() !== 'addons' || path.basename(path.dirname(addonsDir)).toLowerCase() !== 'interface') {
    throw new Error('addonsDir must name the intended client Interface/AddOns directory');
  }
  return addonsDir;
}

export async function configureClient(directory, wowConfigPath = WOW_CONFIG_PATH) {
  const addonsDir = clientAddonsDir(directory);
  if (!(await fs.stat(addonsDir)).isDirectory()) throw new Error('addonsDir must be an existing directory');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(wowConfigPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('wow.config.json must contain an object');
  await fs.mkdir(path.dirname(wowConfigPath), { recursive: true, mode: 0o700 });
  await atomicWrite(wowConfigPath, JSON.stringify({ ...previous, addonsDir }, null, 2) + '\n');
}

export async function loadConfig({ repoRoot, account, character, configPath = path.join(LOCAL_DIR, 'config.json'),
  wowConfigPath = repoRoot ? path.join(repoRoot, 'wow.config.json') : WOW_CONFIG_PATH } = {}) {
  let wow;
  try { wow = JSON.parse(await fs.readFile(wowConfigPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') error.message += `. Run ${CLI_COMMAND} configure --addons-dir <absolute Interface/AddOns path>.`;
    throw error;
  }
  const addonsDir = clientAddonsDir(wow?.addonsDir);
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
  return { ...local, repoRoot: repoRoot ?? PROJECT_DIR, addonsDir, account, accountDir, configPath,
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
