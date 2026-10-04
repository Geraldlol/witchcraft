import readline from 'node:readline';

/** One console as a reader sees it: what runs in it, where it lives, and what it will give. */
export function candidateRow(candidate) {
  const label = candidate.running ?? candidate.command ?? candidate.name ?? 'console';
  const where = `${candidate.host}, ${candidate.scrollback === 'full' ? 'full scrollback' : 'viewport only'}`;
  return `${String(candidate.pid).padStart(7)}  ${label.slice(0, 64).padEnd(64)}  ${where}`;
}

/**
 * Ask which console a tab should mirror. Resolves to the chosen candidate, or null when the
 * reader cancels or there is nothing to offer.
 */
export function pickConsole({ candidates, input = process.stdin, output = process.stdout, tab }) {
  if (!candidates.length) {
    output.write(`No consoles found to mirror for the ${tab} tab. Start a terminal and try again.\n`);
    return Promise.resolve(null);
  }

  let selected = 0, drawn = 0;
  const draw = () => {
    // Redrawing in place keeps the list from marching down the screen on every keypress.
    if (drawn) output.write(`\u001b[${drawn}A\u001b[0J`);
    const rows = candidates.map((candidate, index) =>
      `${index === selected ? '\u001b[7m>' : ' '} ${candidateRow(candidate)}${index === selected ? '\u001b[27m' : ''}`);
    const text = `Which console should the ${tab} tab mirror? (up/down, enter to choose, escape to cancel)\n${rows.join('\n')}\n`;
    output.write(text);
    drawn = rows.length + 1;
  };

  return new Promise(resolve => {
    readline.emitKeypressEvents(input);
    // A pipe has no raw mode, which is what the tests drive and what a scripted start gets.
    try { input.setRawMode?.(true); } catch { /* not a terminal */ }
    const finish = value => {
      input.off('keypress', onKey);
      try { input.setRawMode?.(false); } catch { /* not a terminal */ }
      output.write('\n');
      resolve(value);
    };
    const onKey = (_character, key = {}) => {
      if (key.name === 'up') { selected = Math.max(0, selected - 1); return draw(); }
      if (key.name === 'down') { selected = Math.min(candidates.length - 1, selected + 1); return draw(); }
      if (key.name === 'return' || key.name === 'enter') return finish(candidates[selected]);
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
    };
    input.on('keypress', onKey);
    draw();
  });
}
