import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { Screen } from './screen.js';

export function resolveProgram(command) {
  const candidates = [];
  if (path.isAbsolute(command)) candidates.push(command);
  else {
    for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
      // An empty or relative entry would resolve against the daemon's cwd, where a planted
      // claude.exe could then receive every keystroke typed into its tab.
      if (!path.isAbsolute(folder)) continue;
      candidates.push(path.join(folder, command));
      if (process.platform === 'win32' && !path.extname(command)) candidates.push(path.join(folder, `${command}.exe`));
    }
    if (command === 'claude') candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile() && (!['.cmd', '.bat'].includes(path.extname(candidate).toLowerCase()))) return candidate; } catch {}
  }
  throw new Error(`Cannot find executable ${command}. Configure its executable path in Witchcraft's local config.`);
}
// Absolute System32 path: execFile('taskkill.exe') searches the cwd before System32 on Windows.
export function taskkillPath() {
  const root = process.env.SystemRoot || process.env.windir;
  const resolved = root && path.isAbsolute(root) ? path.join(root, 'System32', 'taskkill.exe') : null;
  if (!resolved || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new Error('System32 taskkill.exe not found');
  return resolved;
}
export class TerminalPair {
  constructor({ commands, cwd, cols = 120, rows = 40, history = 200, onData = () => {}, onExit = () => {}, spawn = pty.spawn }) {
    this.cols = cols; this.rows = rows; this.sessions = new Map(); this.disposed = false;
    try {
      for (const tab of ['claude', 'codex']) {
        const command = commands[tab];
        const session = { id: tab, title: tab === 'claude' ? 'Claude' : 'Codex', status: command ? 'starting' : 'not started',
          screen: new Screen({ cols, rows, history }), process: null, subscriptions: [] };
        this.sessions.set(tab, session);
        if (!command) continue;
        const child = spawn(resolveProgram(command.file), command.args ?? [], { name: 'xterm-256color', cols, rows,
          cwd, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: true, useConptyDll: false });
        session.process = child; session.status = 'running';
        // Device-status responses go only to the terminal that produced them.
        session.subscriptions.push(session.screen.terminal.onData(data => { if (session.status === 'running') child.write(data); }));
        session.subscriptions.push(child.onData(data => { void session.screen.write(data); onData(tab, data); }));
        session.subscriptions.push(child.onExit(event => { session.status = `exited (${event.exitCode})`; onExit(tab, event); }));
      }
    } catch (error) { error.cleanup = this.dispose(); throw error; }
  }
  write(tab, data) {
    const session = this.sessions.get(tab);
    if (this.disposed || !session?.process || session.status !== 'running') {
      throw Object.assign(new Error(`${tab} terminal is not running`), { code: 'TAB_NOT_RUNNING' });
    }
    session.process.write(data);
  }
  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    for (const session of this.sessions.values()) {
      session.screen.resize(cols, rows);
      if (session.status === 'running') session.process?.resize(cols, rows);
    }
  }
  snapshot() { return [...this.sessions.values()].map(session => ({ id: session.id, title: session.title, status: session.status, ...session.screen.snapshot() })); }
  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.allSettled([...this.sessions.values()].map(async session => {
      let failure;
      try {
      // Give the owned CLI its normal interrupt/exit path before terminating
      // its process tree. Avoid node-pty 1.1.0's OS-ConPTY kill-helper race.
      if (session.status === 'running') {
        try { session.process.write('\x03'); } catch { /* An exit callback may already be queued. */ }
        // node-pty's OS-ConPTY adapter drains output for one second after exit.
        const deadline = Date.now() + 1500;
        while (session.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (session.status === 'running') {
        if (process.platform === 'win32') {
          try {
            await promisify(execFile)(taskkillPath(), ['/PID', String(session.process.pid), '/T', '/F'], { windowsHide: true });
          } catch (error) {
            let exists = true;
            try { process.kill(session.process.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') exists = false; }
            if (exists && session.status === 'running') throw new Error(`Could not stop owned ${session.id} terminal: ${error.message}`);
          }
          const deadline = Date.now() + 1500;
          while (session.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        } else session.process.kill();
      }
      if (session.process) {
        const exists = () => {
          try { process.kill(session.process.pid, 0); return true; }
          catch (error) { if (error.code === 'ESRCH') return false; throw error; }
        };
        const deadline = Date.now() + 2000;
        while (exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (exists()) throw new Error(`Owned ${session.id} terminal PID ${session.process.pid} did not exit`);
      }
      } catch (error) { failure = error; }
      finally {
        for (const subscription of session.subscriptions) subscription.dispose();
        await session.screen.dispose();
      }
      if (failure) throw failure;
    })).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
    });
    return this.disposePromise;
  }
}

export function attachTerminal(pair, { stdin = process.stdin, stdout = process.stdout, initialTab = 'claude',
  onError = error => stdout.write(`\r\nWitchcraft terminal: ${error.message}\r\n`) } = {}) {
  // A mirrored tab shows a console in its own window and keeps no xterm screen here, so this
  // display can neither draw it nor sensibly take keystrokes for it.
  const running = tab => {
    const session = pair.sessions.get(tab);
    return session?.status === 'running' && Boolean(session.screen);
  };
  let activeTab = running(initialTab) ? initialTab : ['claude', 'codex'].find(running) ?? initialTab;
  let disposed = false;
  const decoder = new StringDecoder('utf8');
  const previousRaw = stdin.isRaw;
  function report(error) {
    try { onError(error); } catch { /* A closed display must not crash the other agent. */ }
  }
  function redraw() {
    try {
      const screen = pair.sessions.get(activeTab)?.screen;
      if (!screen) return;
      const terminal = screen.terminal, cursor = terminal?.buffer.active;
      const x = Math.max(1, Math.min(terminal?.cols ?? pair.cols ?? 120, (cursor?.cursorX ?? 0) + 1));
      const y = Math.max(1, Math.min(terminal?.rows ?? pair.rows ?? 40, (cursor?.cursorY ?? 0) + 1));
      stdout.write(`\x1b[0m\x1b[2J\x1b[H${screen.plain()}\x1b[${y};${x}H`);
    } catch (error) { report(error); }
  }
  function input(data) {
    if (disposed) return;
    const text = decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
    // Ctrl+] selects which PTY the real terminal displays; ordinary Ctrl+C is passed through.
    const pieces = text.split('\x1d');
    pieces.forEach((piece, index) => {
      if (index) {
        const other = activeTab === 'claude' ? 'codex' : 'claude';
        if (running(other)) activeTab = other;
        redraw();
      }
      if (piece) {
        try {
          if (!running(activeTab)) throw new Error(`${activeTab} terminal is not running; Ctrl+] selects a running terminal`);
          pair.write(activeTab, piece);
        } catch (error) { report(error); }
      }
    });
  }
  function resize() {
    if (disposed) return;
    try {
      if (stdout.columns && stdout.rows) pair.resize(Math.max(40, Math.min(160, stdout.columns)), Math.max(10, Math.min(60, stdout.rows)));
    } catch (error) { report(error); }
  }
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume(); stdin.on('data', input); stdout.on('resize', resize);
  return { output(tab, data) {
    if (!disposed && tab === activeTab) { try { stdout.write(data); } catch (error) { report(error); } }
  },
  dispose() {
    if (disposed) return;
    disposed = true;
    stdin.off('data', input); stdout.off('resize', resize); decoder.end();
    try { if (stdin.isTTY) stdin.setRawMode(Boolean(previousRaw)); stdin.pause(); } catch (error) { report(error); }
  } };
}
