import { decodeContextFrame, decodeFrame, sampleFrame } from './pixel.js';

export const BURST_ROWS = 22;
export const BURST_WIDTH = 132;
export const BURST_HEIGHT = 144;
export const BURST_TEXT_BYTES = 560;
export const BURST_MESSAGE_ID = 262143;
const TOKEN = 'WITCHCRAFT-BURST-PROBE|';

export function burstProbeText() {
  return TOKEN.repeat(Math.ceil(BURST_TEXT_BYTES / TOKEN.length)).slice(0, BURST_TEXT_BYTES);
}

const blackRow = () => Array.from({ length: 22 }, () => [0, 0, 0]);
const copyRow = row => row.map(color => [...color.slice(0, 3)]);

export function paginateBurst(frames) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 64
    || frames.some(row => !Array.isArray(row) || row.length !== 22)) throw new TypeError('Invalid burst frames');
  const pages = [];
  for (let start = 0; start < frames.length; start += BURST_ROWS) {
    pages.push(Array.from({ length: BURST_ROWS }, (_, row) => {
      const source = frames[start + row];
      return source ? copyRow(source) : blackRow();
    }));
  }
  return pages;
}

function isBlack(row) {
  return Array.isArray(row) && row.length === 22
    && row.every(color => Array.isArray(color) && color.length >= 3 && color[0] === 0 && color[1] === 0 && color[2] === 0);
}

export function decodeBurstPage(rows) {
  if (!Array.isArray(rows) || rows.length !== BURST_ROWS) return { status: 'invalid', reason: 'shape' };
  const parts = [];
  let padding = false;
  for (let rowIndex = 0; rowIndex < BURST_ROWS; rowIndex++) {
    const row = rows[rowIndex];
    if (isBlack(row)) { padding = true; continue; }
    if (padding) return { status: 'invalid', reason: 'live-after-padding' };
    const context = decodeContextFrame(row), terminal = decodeFrame(row);
    const part = context ?? terminal;
    if (!part || part.id === 0) return { status: 'invalid', reason: 'row-checksum' };
    parts.push({ ...part, cells: row, kind: context ? 'context' : 'terminal' });
  }
  if (parts.length === 0) return { status: 'idle' };
  const first = parts[0], last = parts.at(-1);
  if (first.index % BURST_ROWS !== 0) return { status: 'invalid', reason: 'page-alignment' };
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.kind !== first.kind || part.id !== first.id) return { status: 'invalid', reason: 'mixed-message' };
    if (part.index !== first.index + index) return { status: 'invalid', reason: 'torn-indices' };
    if (part.final && index !== parts.length - 1) return { status: 'invalid', reason: 'early-final' };
  }
  if (parts.length < BURST_ROWS && !last.final) return { status: 'invalid', reason: 'padding-before-final' };
  return { status: 'page', kind: first.kind, id: first.id, page: first.index / BURST_ROWS,
    final: last.final, rows: parts.map(part => part.cells) };
}

export function maxChannelError(rows) {
  if (!Array.isArray(rows) || rows.length !== BURST_ROWS) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 22) return Number.POSITIVE_INFINITY;
    for (const color of row) {
      if ((!Array.isArray(color) && !ArrayBuffer.isView(color)) || color.length < 3) return Number.POSITIVE_INFINITY;
      for (let channel = 0; channel < 3; channel++) {
        const value = color[channel];
        if (!Number.isFinite(value) || value < 0 || value > 255) return Number.POSITIVE_INFINITY;
        maximum = Math.max(maximum, Math.abs(value - Math.round(value / 85) * 85));
      }
    }
  }
  return maximum;
}

export function sampleBurstPage(image) {
  const rows = [];
  for (let row = 0; row < BURST_ROWS; row++) {
    const cells = sampleFrame(image, { x: 0, y: (row + 2) * 6 });
    if (!cells) return null;
    rows.push(cells);
  }
  return rows;
}
