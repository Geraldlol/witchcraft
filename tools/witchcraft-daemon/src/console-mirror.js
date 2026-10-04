import childProcess from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { renderRows } from './wowtext.js';
import { resolveProgram } from './pty.js';

export const HELPER = fileURLToPath(new URL('../console/console-mirror.ps1', import.meta.url));
export const CONSOLE_DEFAULT_ROWS = 40;
export const CONSOLE_DEFAULT_COLS = 120;

// The console packs its foreground into three bits, blue/green/red, in that bit order, plus an
// intensity bit. ANSI orders the same eight colours differently, so the nibble is translated
// rather than passed through, and intensity travels as bold so the renderer picks the bright half.
const TO_ANSI = Object.freeze([0, 4, 2, 6, 1, 5, 3, 7]);
const KEYS = Object.freeze(new Set(['enter', 'escape', 'up', 'down', 'left', 'right',
  'pageup', 'pagedown', 'backspace', 'tab', 'interrupt']));

/** One console row, as runs of equal attribute, translated into renderer runs. */
export function consoleRuns(row, defaultAttribute) {
  if (!Array.isArray(row)) return [];
  return row.flatMap(cell => {
    if (!Array.isArray(cell) || cell.length < 2) return [];
    const [attribute, text] = cell;
    if (typeof text !== 'string' || !Number.isInteger(attribute)) return [];
    // A cell carrying the console's own default is ordinary text; colouring it would paint the
    // whole screen in whatever the shell happens to use for its default.
    if (attribute === defaultAttribute) return [{ text }];
    return [{ text, fg: { mode: 'palette', value: TO_ANSI[attribute & 0x07] }, bold: Boolean(attribute & 0x08) }];
  });
}

// Keep every console cell when the desktop console is wider than Witchcraft. Split before
// adding WoW markup, so colour changes and literal pipes do not consume display columns.
function wrapRuns(runs, cols) {
  const rows = [[]];
  let used = 0;
  for (const run of runs) {
    for (let offset = 0; offset < run.text.length;) {
      if (used === cols) { rows.push([]); used = 0; }
      const text = run.text.slice(offset, offset + cols - used);
      rows.at(-1).push({ ...run, text });
      offset += text.length; used += text.length;
    }
  }
  return rows;
}

/**
 * A console owned by another process, shown in game and typed into. The helper does the attaching
 * and the Windows calls; this owns its lifetime and speaks its JSON-line protocol. The snapshot it
 * produces is the shape the ring already publishes, so nothing downstream changes.
 */
export class ConsoleMirror {
  constructor({ pid, historyRows = 200, intervalMs = 250, cols = CONSOLE_DEFAULT_COLS,
    rows = CONSOLE_DEFAULT_ROWS, helper = HELPER, spawn = childProcess.spawn,
    onError = () => {}, onFrame = () => {}, onExit = () => {} } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('A console mirror needs the process id of a console');
    Object.assign(this, { pid, historyRows, intervalMs, cols, rows, helper, spawn, onError, onFrame, onExit });
    this.frame = null; this.rendered = null; this.child = null; this.stopped = false; this.ready = false; this.failed = false;
    this.presentation = null;
  }

  start() {
    if (this.child || this.stopped) return this;
    this.child = this.spawn(resolveProgram('pwsh'), ['-NoProfile', '-NonInteractive', '-File', this.helper,
      '-TargetPid', String(this.pid), '-HistoryRows', String(this.historyRows),
      '-IntervalMs', String(this.intervalMs)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    readline.createInterface({ input: this.child.stdout }).on('line', text => this.#accept(text));
    this.child.stderr?.on('data', chunk => this.#fail(`console mirror helper: ${String(chunk).trim()}`));
    // A write that races the helper's exit fails asynchronously on stdin; unheard, that would be
    // an uncaught exception that takes the whole daemon down.
    this.child.stdin?.on?.('error', error => this.#fail(`console mirror input failed: ${error.message}`));
    this.child.on?.('error', error => this.#fail(`console mirror helper could not start: ${error.message}`));
    this.child.on?.('exit', code => {
      this.child = null;
      if (this.stopped) return;
      this.#fail(`console mirror for process ${this.pid} exited (${code})`);
      try { this.onExit(code); } catch { /* a reporter must not break the mirror */ }
    });
    return this;
  }

  #fail(message) { try { this.onError(new Error(message)); } catch { /* a reporter must not break the mirror */ } }

  #accept(text) {
    if (!text.trim()) return;
    let value;
    try { value = JSON.parse(text); } catch { return this.#fail(`console mirror sent an unreadable line: ${text.slice(0, 120)}`); }
    if (value.type === 'ready') { this.ready = true; return; }
    if (value.type === 'error') {
      this.#fail(String(value.message ?? 'console mirror failed'));
      // After startup the helper reports only that the console can no longer be read. It can then
      // sit waiting on its open stdin, so it is ended here and its exit marks the tab exited.
      // Until that exit arrives, nothing more is written to it.
      if (this.ready) { this.failed = true; try { this.child?.kill(); } catch { /* already gone */ } }
      return;
    }
    if (value.type !== 'frame' || !Array.isArray(value.lines)) return;
    this.frame = value; this.rendered = null;
    try { this.onFrame(value); } catch { /* a listener must not break the mirror */ }
  }

  /** The same visible rows as snapshot(), without game color tags or pipe escaping. */
  plain() {
    return this.#presentation().shown.map(row => row.map(run => run.text).join('')).join('\r\n');
  }

  #presentation() {
    const frame = this.frame, previous = this.presentation;
    if (previous?.frame === frame && previous.cols === this.cols && previous.rows === this.rows) return previous;
    this.rendered = null;
    if (!frame) return { shown: [], above: [], scrolled: 0 };
    if (!Number.isInteger(this.cols) || this.cols < 1 || this.cols > 240) throw new RangeError('Invalid console mirror columns');
    const defaultAttribute = Number.isInteger(frame.default) ? frame.default : -1;
    const rows = source => (Array.isArray(source) ? source : []).filter(Array.isArray);
    const wrap = source => rows(source).map(row => wrapRuns(consoleRuns(row, defaultAttribute), this.cols));
    const sourceWindow = wrap(frame.lines), sourceHistory = wrap(frame.history);
    const window = sourceWindow.flat();
    const shown = this.rows > 0 ? window.slice(-this.rows) : [];
    const overflow = window.slice(0, window.length - shown.length);
    const above = this.historyRows > 0 ? [...sourceHistory.flat(), ...overflow].slice(-this.historyRows) : [];
    const sourceTop = Number.isInteger(frame.scrolled) && frame.scrolled >= 0 ? frame.scrolled : 0;
    let scrolled = sourceTop + overflow.length, position = scrolled;
    if (previous) {
      // Reflow changes row coordinates. Establish a fresh baseline without mistaking a
      // source/destination resize, or native counter reset, for newly arrived output.
      scrolled = previous.scrolled; position = scrolled;
      if (previous.cols === this.cols && previous.rows === this.rows && previous.sourceCols === frame.cols
        && previous.windowCounts.length === sourceWindow.length && sourceTop >= previous.sourceTop) {
        let advanced = sourceTop - previous.sourceTop;
        const counts = new Map(previous.windowCounts.map((count, index) => [previous.sourceTop + index, count]));
        // Current history is the freshest measurement of rows that just left the source window.
        // A gap larger than retained history has unknowable wrap counts; unseen rows retain
        // their one-source-row baseline instead of inventing content or unbounded state.
        sourceHistory.forEach((row, index) => counts.set(sourceTop - sourceHistory.length + index, row.length));
        for (const [index, count] of counts) {
          if (index >= previous.sourceTop && index < sourceTop) advanced += count - 1;
        }
        // A TUI can shorten and restore an existing row without new output. Track its
        // signed position separately from the lifetime counter so that cycle cannot
        // ratchet a reader farther into history on every redraw.
        position = previous.position + advanced + overflow.length - previous.overflow;
        scrolled = Math.min(2147483647, Math.max(scrolled, position));
      }
    }
    this.presentation = { frame, cols: this.cols, rows: this.rows, sourceCols: frame.cols, sourceTop,
      windowCounts: sourceWindow.map(row => row.length), overflow: overflow.length, shown, above, scrolled, position };
    return this.presentation;
  }

  /** The window and scrollback are one wrapped sequence, bounded in destination rows. */
  snapshot() {
    const presentation = this.#presentation();
    if (this.rendered) return this.rendered;
    if (!this.frame) return { lines: [], history: [], scrolled: 0, cols: this.cols, rows: this.rows };
    // renderRows takes at most 100 rows in one call, and history runs deeper than that, so rows
    // go through it in batches the way the terminal path does.
    const render = source => {
      const rendered = [];
      for (let start = 0; start < source.length; start += 100) {
        rendered.push(...renderRows(source.slice(start, start + 100), { cols: this.cols }));
      }
      return rendered;
    };
    const lines = render(presentation.shown);
    this.rendered = {
      lines,
      history: render(presentation.above),
      scrolled: presentation.scrolled,
      cols: this.cols, rows: lines.length,
    };
    return this.rendered;
  }

  #send(command) {
    if (!this.child || this.stopped || this.failed) return false;
    try { this.child.stdin.write(JSON.stringify(command) + '\n'); return true; }
    catch (error) { this.#fail(`console mirror input failed: ${error.message}`); return false; }
  }

  write(text) { return typeof text === 'string' && text.length > 0 && this.#send({ type: 'text', text }); }
  key(name) { return KEYS.has(name) && this.#send({ type: 'key', name }); }
  refresh() { return this.#send({ type: 'frame' }); }

  stop() {
    if (this.stopped) return;
    // Ask it to leave before closing the door: #send refuses once stopped is set.
    this.#send({ type: 'stop' });
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child) setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 250).unref?.();
  }
}
