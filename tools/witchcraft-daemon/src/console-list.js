import childProcess from 'node:child_process';
import { resolveProgram } from './pty.js';

// A console is hosted by one of these; they are never the process to attach to.
const HOSTS = new Set(['conhost.exe', 'openconsole.exe']);
// Terminals drive their shell through a pseudoconsole, so the shell is the candidate and the
// terminal only supplies the name a reader recognises.
const TERMINALS = Object.freeze({ 'code.exe': 'vscode', 'windowsterminal.exe': 'windows-terminal' });

const image = entry => String(entry.name ?? '').toLowerCase();

/**
 * The consoles on this machine that a mirror can attach to, newest first.
 *
 * A process owns a classic console when a conhost sits under it, and is driven through a
 * pseudoconsole when an OpenConsole shares its parent. Both attach; only the first keeps a
 * buffer above the window, because a pseudoconsole leaves the scrollback to the terminal's own
 * renderer, where the console API cannot reach it.
 */
export function consoleCandidates(processes, { windows = null, all = false } = {}) {
  // Without window information nothing can be judged background, so everything stands.
  const seen = windows instanceof Set ? windows : null;
  const rows = (Array.isArray(processes) ? processes : []).filter(entry => entry && Number.isInteger(entry.pid));
  const byPid = new Map(rows.map(entry => [entry.pid, entry]));
  const children = new Map();
  for (const entry of rows) {
    if (!children.has(entry.parentPid)) children.set(entry.parentPid, []);
    children.get(entry.parentPid).push(entry);
  }
  const named = pid => {
    // A shell can sit several levels under the terminal that owns the window, so the name comes
    // from the nearest ancestor a reader would recognise.
    for (let entry = byPid.get(pid), depth = 0; entry && depth < 8; entry = byPid.get(entry.parentPid), depth++) {
      const terminal = TERMINALS[image(entry)];
      if (terminal) return terminal;
    }
    return 'pty';
  };

  // The conhost serving a process, walking up, because a child inherits its parent's console
  // rather than creating one. A console window shows up either way round: a program that starts
  // its own console has conhost as a child, while `conhost.exe pwsh.exe` has it as the parent.
  const conhostAbove = pid => {
    for (let entry = byPid.get(pid), depth = 0; entry && depth < 16; entry = byPid.get(entry.parentPid), depth++) {
      const host = (children.get(entry.pid) ?? []).find(child => image(child) === 'conhost.exe');
      if (host) return host.pid;
      const parent = byPid.get(entry.parentPid);
      if (parent && image(parent) === 'conhost.exe') return parent.pid;
    }
    return null;
  };

  // What a console is actually running: the innermost program under the shell. Two terminals are
  // both "pwsh.exe" and look identical in a list; what is running in them is what tells them apart.
  const innermost = pid => {
    let entry = byPid.get(pid);
    for (let depth = 0; entry && depth < 16; depth++) {
      const next = (children.get(entry.pid) ?? []).filter(child => !HOSTS.has(image(child)));
      if (next.length !== 1) break; // Two children mean no single answer; a shell's prompt means none.
      entry = next[0];
    }
    return entry && entry.pid !== pid ? (entry.commandLine ?? entry.name) : null;
  };

  const found = [];
  for (const entry of rows) {
    if (HOSTS.has(image(entry)) || TERMINALS[image(entry)]) continue;
    const console = conhostAbove(entry.pid);
    const throughPty = (children.get(entry.parentPid) ?? []).some(sibling => image(sibling) === 'openconsole.exe');
    if (console === null && !throughPty) continue;
    found.push({
      pid: entry.pid,
      name: entry.name,
      command: entry.commandLine ?? entry.name,
      host: console === null ? named(entry.parentPid) : 'conhost',
      scrollback: console === null ? 'viewport' : 'full',
      running: innermost(entry.pid),
      started: entry.started ?? null,
      console,
      visible: seen === null || seen.has(entry.pid),
    });
  }

  // Everything in one console window shares that console, and attaching to any of them gives the
  // same screen. Only the innermost is offered, because that is the shell the reader is looking at.
  const ancestors = pid => {
    const chain = new Set();
    for (let entry = byPid.get(pid), depth = 0; entry && depth < 16; entry = byPid.get(entry.parentPid), depth++) {
      if (entry.pid !== pid) chain.add(entry.pid);
    }
    return chain;
  };
  const outer = new Set();
  for (const candidate of found) {
    if (candidate.console === null) continue;
    for (const pid of ancestors(candidate.pid)) {
      if (!found.some(other => other.pid === pid && other.console === candidate.console)) continue;
      outer.add(pid);
      // The window belongs to the console, so it counts for whichever member is offered — but
      // only for a process actually in that console. An editor that spawns a helper owns a
      // window and no console, and the helper's console is not on screen because of it.
      if (seen?.has(pid)) candidate.visible = true;
    }
  }
  // A console window nobody can see is background work — an editor's helper or a language
  // server — and listing dozens of those buries the one console the reader means. A shell inside
  // a terminal owns no window of its own, because the terminal draws it, so it always counts.
  const wanted = candidate => all || candidate.visible || candidate.host !== 'conhost';
  // Newest first: the console you just opened is the one you are most likely naming.
  return found.filter(candidate => !outer.has(candidate.pid) && wanted(candidate))
    .sort((left, right) => String(right.started ?? '').localeCompare(String(left.started ?? '')));
}

// The process tree and the windows on screen in one pass, so the two cannot disagree about a
// console that opened or closed between them.
const QUERY = `$processes = Get-CimInstance Win32_Process |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate
$windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty Id)
[pscustomobject]@{ processes = $processes; windows = $windows } | ConvertTo-Json -Compress -Depth 3`;

async function queryProcesses() {
  const { stdout } = await new Promise((resolve, reject) => {
    childProcess.execFile(resolveProgram('pwsh'), ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
  });
  const { processes, windows } = JSON.parse(stdout);
  return {
    processes: (Array.isArray(processes) ? processes : [processes]).map(row => ({
      pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.Name,
      commandLine: row.CommandLine, started: row.CreationDate,
    })),
    windows,
  };
}

/** The candidates, or an empty list when the process table cannot be read. */
export async function listConsoles({ query = queryProcesses, all = false } = {}) {
  try {
    const result = await query();
    const processes = Array.isArray(result) ? result : result?.processes;
    const windows = Array.isArray(result?.windows) ? new Set(result.windows) : null;
    return consoleCandidates(processes, { windows, all });
  } catch { return []; }
}
