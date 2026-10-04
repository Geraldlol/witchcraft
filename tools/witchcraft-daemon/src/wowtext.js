/** Render bounded terminal foreground runs as literal WoW FontString text. */
const CELL_CODE_POINTS = 4;
const ANSI = [0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5,
  0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff];

export function paletteColor(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return ANSI[index];
  if (index >= 232) { const shade = 8 + (index - 232) * 10; return shade * 0x010101; }
  const n = index - 16, levels = [0, 95, 135, 175, 215, 255];
  return levels[Math.floor(n / 36)] * 65536 + levels[Math.floor(n / 6) % 6] * 256 + levels[n % 6];
}

function foreground(run, fallback) {
  const fg = run.fg;
  let value;
  if (fg?.mode === 'rgb' && Number.isInteger(fg.value) && fg.value >= 0 && fg.value <= 0xffffff) value = fg.value;
  else if (fg?.mode === 'palette') value = paletteColor(fg.value < 8 && run.bold ? fg.value + 8 : fg.value);
  else if (Number.isInteger(fg)) value = paletteColor(fg < 8 && run.bold ? fg + 8 : fg);
  else if (typeof fg === 'string' && /^#?[0-9a-f]{6}$/i.test(fg)) value = parseInt(fg.replace('#', ''), 16);
  else if (fg && ['r', 'g', 'b'].every(k => Number.isInteger(fg[k]) && fg[k] >= 0 && fg[k] <= 255)) value = fg.r * 65536 + fg.g * 256 + fg.b;
  if (value === undefined || value === null) value = fallback;
  if (run.dim) value = Math.round((value >> 16) * 0.65) * 65536 + Math.round(((value >> 8) & 255) * 0.65) * 256 + Math.round((value & 255) * 0.65);
  return value.toString(16).padStart(6, '0');
}

function plainText(text) {
  if (typeof text !== 'string' || text.length > 65536) throw new TypeError('Terminal run exceeds text budget');
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/[\u{10000}-\u{10ffff}\ud800-\udfff]/gu, '?');
}

export function escapeText(text) { return plainText(text).replaceAll('|', '||'); }

export function renderRow(runs, { cols = 120, defaultFg = 0xd4d4d4 } = {}) {
  if (!Number.isInteger(cols) || cols < 1 || cols > 240 || !Number.isInteger(defaultFg) || defaultFg < 0 || defaultFg > 0xffffff
    || !Array.isArray(runs) || runs.length > 1024) throw new TypeError('Invalid terminal row bounds');
  let result = '', used = 0, activeForeground = null;
  for (const run of runs) {
    if (!run || typeof run !== 'object') throw new TypeError('Invalid terminal run');
    if (used >= cols) break;
    const raw = plainText(run.text);
    const width = run.width;
    if (width !== undefined && (!Number.isInteger(width) || width < 0 || width > 2)) throw new TypeError('Invalid terminal cell width');
    if (width === 0) continue; // xterm wide-cell continuation, already drawn by the preceding cell.
    if (width !== undefined && width > cols - used) break;
    // Agent text can stack any number of combining marks in one cell. Keeping its first few code
    // points bounds every row under the addon's 8192-byte line limit; plainText left no surrogates.
    const cell = width !== undefined && raw.length > CELL_CODE_POINTS ? raw.slice(0, CELL_CODE_POINTS) : raw;
    const text = width === undefined ? raw.slice(0, cols - used) : (cell || ' '.repeat(width));
    if (!text) continue;
    used += width ?? text.length;
    const color = foreground(run, defaultFg);
    if (color !== activeForeground) {
      if (activeForeground !== null) result += '|r';
      result += '|cff' + color;
      activeForeground = color;
    }
    result += text.replaceAll('|', '||');
  }
  return result + (activeForeground === null ? '' : '|r') + ' '.repeat(cols - used);
}

export function renderRows(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length > 100) throw new TypeError('Terminal snapshot exceeds row budget');
  return rows.map(row => renderRow(row, options));
}
