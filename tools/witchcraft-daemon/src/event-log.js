import fs from 'node:fs';

// Security-relevant input events, one JSON object per line: which lane delivered or rejected which
// message id, and carrier errors. Message text is never written. Bounded to one rotated backup.
export function createEventLog(filename, { maxBytes = 1024 * 1024, now = Date.now } = {}) {
  const append = record => {
    try {
      const line = `${JSON.stringify({ at: new Date(now()).toISOString(), ...record })}\n`;
      let size = 0;
      try { size = fs.statSync(filename).size; } catch {}
      if (size + line.length > maxBytes) fs.renameSync(filename, `${filename}.1`);
      fs.appendFileSync(filename, line, { mode: 0o600 });
    } catch {}   // Auditing must never take input delivery down with it.
  };
  return {
    input(lane, message, result) {
      if (result?.duplicate) return;   // Lanes re-emit complete messages every cycle.
      const outcome = result?.dropped ? 'dropped' : result?.accepted ? 'accepted' : 'rejected';
      append({ lane, id: message?.id, tab: message?.tab, action: message?.action, outcome,
        ...(result?.reason ? { reason: String(result.reason) } : {}) });
    },
    error(lane, error) { append({ lane, outcome: 'error', reason: String(error?.message ?? error) }); },
    // Diagnostics for the trace log: timings, cursor moves and carrier verdicts. Never message text.
    note(record) { append(record); },
  };
}
