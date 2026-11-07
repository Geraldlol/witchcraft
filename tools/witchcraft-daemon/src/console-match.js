import { AGENT_TABS } from './agents.js';

/**
 * How a tab names the console it mirrors: a process id, `pick` (choose from the list at start), or
 * `~TEXT`, the newest console whose program or command line contains TEXT. A pid dies with its
 * terminal; the words survive a restart. `label` starts the error, so the command line and the
 * config file can each say where the bad value came from.
 */
export function parseAttachTarget(value, label = 'An attach target') {
  const text = String(value ?? '');
  if (text === 'pick') return { pick: true };
  if (/^[1-9][0-9]*$/u.test(text)) return { pid: Number(text) };
  if (text.length > 1 && text.startsWith('~')) return { pattern: text.slice(1) };
  throw new Error(`${label} takes a process id, pick, or ~TEXT, not ${text}`);
}

/**
 * The newest console (candidates arrive newest first, console-list.js) whose running program or
 * command line contains the text, ignoring case; undefined when none does. The daemon's own console
 * (`own`) is passed over: its shell runs Witchcraft, whose command line carries the pattern itself.
 */
export function matchConsole(text, candidates = []) {
  const wanted = String(text).toLowerCase();
  return candidates.find(candidate => candidate.own !== true && [candidate.running, candidate.command]
    .some(field => typeof field === 'string' && field.toLowerCase().includes(wanted)));
}

/** `attach` in .local/config.json: each tab to a PID, pick, or ~TEXT, as --attach takes them. */
export function parseAttachConfig(attach) {
  if (!attach || typeof attach !== 'object' || Array.isArray(attach)) {
    throw new Error('attach in config.json must map claude, codex or copilot to PID, pick, or ~TEXT');
  }
  return Object.fromEntries(Object.entries(attach).map(([tab, value]) => {
    if (!AGENT_TABS.includes(tab)) throw new Error(`attach in config.json names ${tab}; the tabs are claude, codex, and copilot`);
    return [tab, parseAttachTarget(value, `attach.${tab} in config.json`)];
  }));
}
