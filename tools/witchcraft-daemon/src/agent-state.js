// What an agent's screen says it is doing, read from its bottom rows so the same rules serve
// spawned and mirrored tabs of both CLIs:
//   waiting  a choice menu is open (a permission prompt, or a picker such as /model)
//   working  the CLI shows its "esc to interrupt" hint while it runs
//   idle     neither
// A menu counts only when one option carries a selection marker, so a numbered list in an answer
// never reads as a question.

const BOTTOM_ROWS = 20, STATUS_ROWS = 8, MAX_CHOICES = 9, LABEL_CHARS = 60;
const OPTION = /^\s*(?:(\S)\s+)?(\d{1,2})[.)]\s+(\S.*?)\s*$/u;
const MARKERS = new Set(['❯', '›', '>', '→', '▶', '●', '*']);

/** Rendered rows carry WoW colour runs and doubled pipes (wowtext.js); return the text a reader sees. */
export function unmark(row) {
  return String(row).replace(/\|c[0-9a-fA-F]{8}|\|r|\|\|/gu, value => value === '||' ? '|' : '');
}

/**
 * The last selectable numbered menu among `rows` (plain text, top to bottom): options numbered
 * 1..n in order, at most three unnumbered rows (wrapped descriptions) between them, one marked.
 */
export function readChoices(rows) {
  const bottom = rows.slice(-BOTTOM_ROWS);
  let best = null, run = null;
  bottom.forEach((row, index) => {
    const match = OPTION.exec(row);
    const number = match ? Number(match[2]) : 0;
    if (match && (number === 1 || (run && number === run.options.length + 1 && index - run.last <= 4))) {
      if (number === 1) run = { options: [], last: index };
      run.options.push({ label: match[3].slice(0, LABEL_CHARS), selected: MARKERS.has(match[1] ?? '') });
      run.last = index;
      if (run.options.length >= 2 && run.options.some(option => option.selected)) best = run;
    } else if (run && index - run.last > 4) run = null;
  });
  if (!best) return undefined;
  const options = best.options.slice(0, MAX_CHOICES);
  const selected = options.findIndex(option => option.selected);
  return selected < 0 ? undefined : { options: options.map(option => option.label), selected: selected + 1 };
}

/** The state and, when waiting, the menu, for one session's rendered rows. */
export function agentState(lines) {
  const rows = (Array.isArray(lines) ? lines : []).map(unmark);
  const choices = readChoices(rows);
  if (choices) return { state: 'waiting', choices };
  const working = rows.slice(-STATUS_ROWS).some(row => /esc to interrupt/iu.test(row));
  return { state: working ? 'working' : 'idle' };
}
