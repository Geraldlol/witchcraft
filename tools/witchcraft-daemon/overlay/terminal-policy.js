const XTERM_DA_OR_DSR_RESPONSE = /^(?:\u001b\[(?:\?[0-9;]+|>[0-9;]+)c|\u001b\[0n|\u001b\[\??[0-9]+;[0-9]+R)$/u;

/**
 * The daemon's headless terminal is the sole terminal emulator allowed to
 * answer device-attribute and status queries. A browser xterm can emit the
 * same replies through onData while parsing output, which would otherwise
 * send duplicate answers to the owned PTY.
 */
export function filterTerminalInput(data) {
  return typeof data === 'string' && !XTERM_DA_OR_DSR_RESPONSE.test(data) ? data : '';
}

/** Plain snapshots are authoritative; raw output is only an invalidation. */
export function terminalEventDisposition({ kind, resyncPending }) {
  if (kind !== 'output') return 'apply';
  return resyncPending ? 'ignore' : 'resync';
}

export function validatedTerminalGeometry(value) {
  if (!value || !Number.isSafeInteger(value.cols) || !Number.isSafeInteger(value.rows)) return null;
  if (value.cols < 40 || value.cols > 160 || value.rows < 10 || value.rows > 60) return null;
  return { cols: value.cols, rows: value.rows };
}

export function restoreAuthoritativeSnapshot(terminal, data, geometry, onWritten) {
  const validated = validatedTerminalGeometry(geometry);
  if (!terminal || typeof terminal.resize !== 'function' || typeof terminal.reset !== 'function'
    || typeof terminal.write !== 'function') throw new TypeError('terminal snapshot target is invalid');
  if (!validated) throw new RangeError('terminal snapshot geometry is invalid');
  terminal.resize(validated.cols, validated.rows);
  terminal.reset();
  terminal.write(data, onWritten);
}
