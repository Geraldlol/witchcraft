import test from 'node:test';
import assert from 'node:assert/strict';
import { consoleCandidates, listConsoles } from '../src/console-list.js';

// The shapes the process table actually takes on this machine, measured 2026-09-22:
// a classic console window owns a conhost.exe child, while a terminal that drives its shell
// through a pseudoconsole has an OpenConsole.exe beside the shell under the same host process.
const conhostWindow = [
  { pid: 30676, parentPid: 42876, name: 'cmd.exe', commandLine: 'cmd.exe' },
  { pid: 22680, parentPid: 30676, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
  { pid: 10996, parentPid: 30676, name: 'pwsh.exe', commandLine: 'pwsh.exe -NoExit' },
];
const vscodeTerminal = [
  { pid: 24440, parentPid: 14244, name: 'Code.exe', commandLine: 'Code.exe' },
  { pid: 21104, parentPid: 24440, name: 'Code.exe', commandLine: 'Code.exe --type=ptyHost' },
  { pid: 3568, parentPid: 21104, name: 'OpenConsole.exe', commandLine: 'OpenConsole.exe --server' },
  { pid: 24492, parentPid: 21104, name: 'pwsh.exe', commandLine: 'pwsh.exe -Command claude' },
];

test('a shell that owns a classic console is offered, with its full scrollback', () => {
  const found = consoleCandidates(conhostWindow);
  const shell = found.find(candidate => candidate.pid === 10996);
  assert.ok(shell, 'the shell beside a conhost is a console we can attach to');
  assert.equal(shell.host, 'conhost');
  assert.equal(shell.scrollback, 'full', 'a classic console keeps a real buffer above the window');
  assert.equal(shell.command, 'pwsh.exe -NoExit');
});

test('a shell under a pseudoconsole is offered, and named by the terminal driving it', () => {
  const shell = consoleCandidates(vscodeTerminal).find(candidate => candidate.pid === 24492);
  assert.ok(shell, 'attaching through a pseudoconsole works, so it belongs in the list');
  assert.equal(shell.host, 'vscode');
  // Measured: 400 history rows requested, 2 returned. The scrollback lives in the terminal's own
  // renderer, not in the console buffer, so only the window is readable.
  assert.equal(shell.scrollback, 'viewport');
});

test('the terminal programs themselves are never offered', () => {
  const offered = consoleCandidates([...conhostWindow, ...vscodeTerminal]).map(candidate => candidate.pid);
  for (const host of [22680, 3568, 24440, 21104]) {
    assert.equal(offered.includes(host), false, `${host} hosts a console rather than owning one`);
  }
});

test('a process with no console of its own is not a candidate', () => {
  const offered = consoleCandidates([
    { pid: 500, parentPid: 4, name: 'svchost.exe', commandLine: 'svchost.exe -k netsvcs' },
    { pid: 501, parentPid: 500, name: 'pwsh.exe', commandLine: 'pwsh.exe -File background.ps1' },
  ]);
  assert.deepEqual(offered, [], 'nothing here is attached to a console');
});

test('candidates come back newest first, so the console you just opened is at the top', () => {
  const found = consoleCandidates([...conhostWindow, ...vscodeTerminal].map(entry =>
    ({ ...entry, started: entry.pid === 10996 ? '2026-09-22T10:00:00Z' : '2026-09-22T12:00:00Z' })));
  assert.equal(found[0].pid, 24492);
  assert.equal(found.at(-1).pid, 10996);
});

test('listing consoles survives a process table it cannot read', async () => {
  const found = await listConsoles({ query: async () => { throw new Error('CIM is unavailable'); } });
  assert.deepEqual(found, [], 'an unreadable process table is an empty list, not a crash');
});

test('listing consoles ignores rows the process table returns malformed', async () => {
  const query = async () => [...conhostWindow, null, { pid: 'not a number' }, { name: 'no pid' }];
  const found = await listConsoles({ query });
  assert.deepEqual(found.map(candidate => candidate.pid), [10996]);
});

// Measured 2026-09-22 by opening one: `conhost.exe pwsh.exe` makes conhost the PARENT of the
// shell, the mirror image of a program that starts its own console, and the window handle sits
// on the shell rather than on conhost.
const launchedConsole = [
  { pid: 3356, parentPid: 14244, name: 'conhost.exe', commandLine: 'conhost.exe pwsh.exe' },
  { pid: 37272, parentPid: 3356, name: 'pwsh.exe', commandLine: 'pwsh.exe -NoExit' },
];

test('a shell launched under conhost is offered too', () => {
  const found = consoleCandidates(launchedConsole);
  assert.deepEqual(found.map(candidate => candidate.pid), [37272]);
  assert.equal(found[0].host, 'conhost');
  assert.equal(found[0].scrollback, 'full');
});

test('a console with no window is background work, and is held back unless asked for', () => {
  // An extension host's helper: a real console, but nobody is looking at it.
  const background = [
    { pid: 900, parentPid: 24440, name: 'node.exe', commandLine: 'node mcp-server.mjs' },
    { pid: 901, parentPid: 900, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
  ];
  const windows = new Set([37272]);
  const offered = consoleCandidates([...background, ...launchedConsole], { windows });
  assert.deepEqual(offered.map(candidate => candidate.pid), [37272], 'only the console with a window');
  assert.equal(offered[0].visible, true);

  const everything = consoleCandidates([...background, ...launchedConsole], { windows, all: true });
  assert.deepEqual(everything.map(candidate => candidate.pid).sort((left, right) => left - right), [900, 37272]);
  assert.equal(everything.find(candidate => candidate.pid === 900).visible, false);
});

test('a shell inside a terminal counts even though it owns no window of its own', () => {
  // VS Code draws the terminal itself, so the shell has no window handle; it is still the
  // console the reader is looking at.
  const offered = consoleCandidates(vscodeTerminal, { windows: new Set([24440]) });
  assert.deepEqual(offered.map(candidate => candidate.pid), [24492]);
});

test('listing consoles applies the window information the query returns', async () => {
  const query = async () => ({
    processes: [...launchedConsole,
      { pid: 900, parentPid: 24440, name: 'node.exe', commandLine: 'node mcp-server.mjs' },
      { pid: 901, parentPid: 900, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' }],
    windows: [37272],
  });
  assert.deepEqual((await listConsoles({ query })).map(candidate => candidate.pid), [37272]);
  assert.deepEqual((await listConsoles({ query, all: true })).map(candidate => candidate.pid).sort((a, b) => a - b),
    [900, 37272], 'asking for everything shows the background consoles too');
});

test('a background console does not inherit the window of the editor that started it', () => {
  // The trap this guards: an editor's helpers descend from a process that does own a window,
  // but they are not in its console, and 16 of them buried the one console worth showing.
  const offered = consoleCandidates([
    { pid: 24440, parentPid: 14244, name: 'Code.exe', commandLine: 'Code.exe' },
    { pid: 910, parentPid: 24440, name: 'node.exe', commandLine: 'node language-server.mjs' },
    { pid: 911, parentPid: 910, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
  ], { windows: new Set([24440]) });
  assert.deepEqual(offered, [], 'the editor owns the window; the helper owns the console');
});

test('a candidate is labelled by what is running inside it, not by the shell', () => {
  // Two VS Code terminals are both "pwsh.exe" and tell a reader nothing apart. What is running
  // in them does.
  const [claude, plain] = consoleCandidates([
    { pid: 21104, parentPid: 24440, name: 'Code.exe', commandLine: 'Code.exe --type=ptyHost' },
    { pid: 3568, parentPid: 21104, name: 'OpenConsole.exe', commandLine: 'OpenConsole.exe --server' },
    { pid: 24492, parentPid: 21104, name: 'pwsh.exe', commandLine: 'pwsh.exe', started: '2026-09-22T12:00:00Z' },
    { pid: 25000, parentPid: 24492, name: 'node.exe', commandLine: 'node claude.js --continue' },
    { pid: 3152, parentPid: 21104, name: 'pwsh.exe', commandLine: 'pwsh.exe', started: '2026-09-22T11:00:00Z' },
  ]);
  assert.equal(claude.pid, 24492);
  assert.equal(claude.running, 'node claude.js --continue', 'the innermost program is what the reader sees');
  assert.equal(plain.pid, 3152);
  assert.equal(plain.running, null, 'a shell sitting at its prompt is running nothing of its own');
});

test('the daemon\'s own console is marked, so a pattern can never name it', () => {
  // Witchcraft in a Windows Terminal tab: its shell reports Witchcraft as what is running, the
  // daemon holds the console its tabs run in, and a helper it starts holds one of its own. Codex
  // runs in a second tab.
  const table = [
    { pid: 100, parentPid: 1, name: 'WindowsTerminal.exe', commandLine: 'WindowsTerminal.exe' },
    { pid: 101, parentPid: 100, name: 'OpenConsole.exe', commandLine: 'OpenConsole.exe --headless' },
    { pid: 102, parentPid: 100, name: 'pwsh.exe', commandLine: 'pwsh.exe', started: '2026-11-07T10:00:00Z' },
    { pid: 103, parentPid: 102, name: 'node.exe', commandLine: 'node bin/witchcraft.js run --attach codex=~codex',
      started: '2026-11-07T10:01:00Z' },
    { pid: 104, parentPid: 103, name: 'conhost.exe', commandLine: 'conhost.exe --headless' },
    { pid: 105, parentPid: 103, name: 'pwsh.exe', commandLine: 'pwsh.exe -NoProfile -Command Get-CimInstance Win32_Process',
      started: '2026-11-07T10:02:00Z' },
    { pid: 106, parentPid: 105, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
    { pid: 107, parentPid: 100, name: 'pwsh.exe', commandLine: 'pwsh.exe', started: '2026-11-07T09:00:00Z' },
    { pid: 108, parentPid: 107, name: 'codex.exe', commandLine: 'codex.exe' },
  ];
  const own = found => Object.fromEntries(found.map(candidate => [candidate.pid, candidate.own]));
  const marked = consoleCandidates(table, { self: 103 }), plain = consoleCandidates(table);
  assert.deepEqual(own(marked), { 102: true, 103: true, 105: true, 107: false },
    'the daemon\'s shell, the daemon and its helper are its own; the Codex console is not');
  assert.equal(marked.find(candidate => candidate.pid === 107).running, 'codex.exe');
  assert.deepEqual(own(plain), { 102: false, 103: false, 105: false, 107: false }, 'without self nothing is own');
  assert.deepEqual(marked.map(candidate => candidate.pid), plain.map(candidate => candidate.pid), 'the order is unchanged');
});

test('a shell sharing the console the daemon inherited is own, even though the daemon made a pseudoconsole of its own', () => {
  // cmd owns a classic console (conhost 2). Both the daemon and a sibling pwsh running codex were
  // started from it; the daemon then opened its own pseudoconsole host (conhost 5) for its tabs.
  const table = [
    { pid: 1, parentPid: 0, name: 'cmd.exe', commandLine: 'cmd.exe' },
    { pid: 2, parentPid: 1, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
    { pid: 3, parentPid: 1, name: 'pwsh.exe', commandLine: 'pwsh.exe -Command codex' },
    { pid: 4, parentPid: 1, name: 'node.exe', commandLine: 'node bin/witchcraft.js run --attach codex=~codex' },
    { pid: 5, parentPid: 4, name: 'conhost.exe', commandLine: 'conhost.exe --headless' },
  ];
  const own = Object.fromEntries(consoleCandidates(table, { self: 4 }).map(candidate => [candidate.pid, candidate.own]));
  assert.equal(own[3], true, 'the sibling shell shares the console the daemon inherited');
  assert.equal(own[4], true, 'the daemon itself');
  const none = consoleCandidates(table).map(candidate => candidate.own);
  assert.deepEqual(none, none.map(() => false), 'without self nothing is own');
});

test("a daemon given a console of its own never claims the launcher's console, even when Codex runs there", () => {
  // A script shell (console 2) started the daemon in a new console (conhost 4) and then ran codex
  // in its own console. The daemon never shared console 2, so the Codex console is not its own
  // and `~codex` can still find it.
  const table = [
    { pid: 1, parentPid: 0, name: 'pwsh.exe', commandLine: 'pwsh.exe -File start-all.ps1' },
    { pid: 2, parentPid: 1, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
    { pid: 3, parentPid: 1, name: 'node.exe', commandLine: 'node bin/witchcraft.js run --attach codex=~codex' },
    { pid: 4, parentPid: 3, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
    { pid: 5, parentPid: 1, name: 'codex.exe', commandLine: 'codex.exe', started: '2026-11-07T10:00:00Z' },
  ];
  const own = Object.fromEntries(consoleCandidates(table, { self: 3 }).map(candidate => [candidate.pid, candidate.own]));
  assert.equal(own[3], true, 'the daemon itself');
  assert.equal(own[5], false, 'the Codex console belongs to the launcher, which the daemon never shared');
});
