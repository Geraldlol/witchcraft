import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { renderRows } from './wowtext.js';

export class Screen {
  constructor({ cols = 120, rows = 40, history = 200 } = {}) {
    if (!Number.isInteger(history) || history < 0 || history > 1000) throw new TypeError('history must be 0..1000');
    this.history = history;
    this.terminal = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: history,
      convertEol: false, windowsPty: { backend: 'conpty', buildNumber: 26220 } });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.version = 0; this.disposed = false; this.pending = Promise.resolve();
    // Lines that have left the viewport since this screen began. The scrollback cap bounds how many
    // are still readable, so a reader anchored in history needs the count to follow its own rows.
    this.scrolled = 0;
    this.terminal.onScroll(() => { this.scrolled++; });
    this.rendered = null; this.renderedVersion = -1;
  }
  write(data) {
    if (this.disposed) return Promise.resolve();
    this.pending = this.pending.then(() => new Promise(resolve => {
      if (this.disposed) return resolve();
      this.terminal.write(data, () => { this.version++; resolve(); });
    }));
    return this.pending;
  }
  resize(cols, rows) { if (!this.disposed) { this.terminal.resize(cols, rows); this.version++; } }
  /**
   * Viewport rows plus the rendered scrollback above them (oldest first, at most `history` rows),
   * and the count of lines that have scrolled away. Rendering walks every cell, so an unchanged
   * screen returns the previous result rather than repeating it on each publish tick.
   */
  snapshot() {
    if (this.rendered && this.renderedVersion === this.version) return this.rendered;
    const { terminal } = this;
    const buffer = terminal.buffer.active;
    const runsAt = y => {
      const line = buffer.getLine(y), runs = [];
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line?.getCell(x);
        if (!cell) { runs.push({ text: ' ', width: 1 }); continue; }
        if (cell.getWidth() === 0) continue;
        runs.push({ text: cell.getChars() || ' ', width: cell.getWidth(),
          fg: cell.isFgRGB() ? { mode: 'rgb', value: cell.getFgColor() }
            : cell.isFgPalette() ? { mode: 'palette', value: cell.getFgColor() } : undefined,
          bold: cell.isBold(), dim: cell.isDim() });
      }
      return runs;
    };
    const render = (from, to) => {
      const rendered = [];
      for (let start = from; start < to; start += 100) {
        rendered.push(...renderRows(Array.from({ length: Math.min(100, to - start) }, (_, index) => runsAt(start + index)), { cols: terminal.cols }));
      }
      return rendered;
    };
    this.rendered = { lines: render(buffer.baseY, buffer.baseY + terminal.rows),
      history: render(Math.max(0, buffer.baseY - this.history), buffer.baseY), scrolled: this.scrolled };
    this.renderedVersion = this.version;
    return this.rendered;
  }
  plain() {
    const terminal = this.terminal, buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').join('\r\n');
  }
  serialize() { return this.disposed ? '' : this.serializer.serialize(); }
  async dispose() { this.disposed = true; await this.pending; this.terminal.dispose(); }
}
