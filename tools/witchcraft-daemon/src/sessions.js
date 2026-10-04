import { TerminalPair as SpawnedPair } from './pty.js';
import { ConsoleMirror as Mirror, CONSOLE_DEFAULT_ROWS } from './console-mirror.js';
import { agentState } from './agent-state.js';

const TABS = Object.freeze(['claude', 'codex']);
const TITLES = Object.freeze({ claude: 'Claude', codex: 'Codex' });

/**
 * The two tabs, each behind whichever source it was given: a terminal the daemon spawns, or a
 * console the user owns and the daemon only mirrors. It presents what the bridge already
 * consumes — `write`, `snapshot`, `sessions`, `cols`, `rows` — so the ring chunk, and with it the
 * addon, is unchanged.
 */
export class SessionSet {
  constructor({ commands, attach = {}, cwd, cols = 120, rows = CONSOLE_DEFAULT_ROWS, history = 200,
    onData = () => {}, onFrame = () => {}, onExit = () => {}, onError = () => {},
    TerminalPair = SpawnedPair, ConsoleMirror = Mirror, spawn } = {}) {
    this.cols = cols; this.rows = rows;
    this.attached = new Map();
    this.sessions = new Map();

    // An attached tab is never launched: the whole point is that you started it yourself.
    const spawned = Object.fromEntries(TABS.map(tab => [tab, attach[tab] ? null : commands[tab] ?? null]));
    this.pair = new TerminalPair({ commands: spawned, cwd, cols, rows, history, onData, onExit,
      ...(spawn ? { spawn } : {}) });

    for (const tab of TABS) {
      if (!attach[tab]) { this.sessions.set(tab, this.pair.sessions.get(tab)); continue; }
      // No `screen`: an attached tab carries no xterm buffer, and the local display reads one.
      const session = { id: tab, title: TITLES[tab], status: 'running', pid: attach[tab], mirrored: true };
      const mirror = new ConsoleMirror({
        pid: attach[tab], rows, cols, historyRows: history,
        onError,
        onExit: () => {
          if (session.status !== 'running') return;
          session.status = `exited (console ${attach[tab]} closed)`;
          onExit(tab, { exitCode: 0 });
        },
        onFrame: () => { onFrame(tab); onData(tab, ''); },
      });
      mirror.start();
      this.attached.set(tab, mirror);
      this.sessions.set(tab, session);
    }
  }

  /**
   * Input from the game. A spawned tab takes the bytes the outbox already writes; a mirrored
   * console takes typing and named keys, so it needs the action rather than a byte stream.
   */
  write(tab, data, action) {
    const mirror = this.attached.get(tab);
    if (!mirror) return this.pair.write(tab, data);
    if (!action) throw new Error(`${tab} is mirrored from a console you own; type in its own window`);
    // A closed console, or a helper that refuses a write, will never take this input. Saying so
    // lets the outbox report it dropped instead of acknowledging input that went nowhere.
    const session = this.sessions.get(tab);
    const refused = () => Object.assign(new Error(`${tab} console ${session.status === 'running' ? 'is not taking input' : `has ${session.status}`}`),
      { code: 'TAB_NOT_RUNNING' });
    const send = sent => { if (!sent) throw refused(); };
    if (session.status !== 'running') throw refused();
    if (action === 'paste') {
      // The markers and returns are typed like any other characters; the trailing return submits.
      send(mirror.write(data.endsWith('\r') ? data.slice(0, -1) : data));
      return send(mirror.key('enter'));
    }
    if (action === 'text') {
      // The outbox appends the newline to the text; for a console that newline is a keypress.
      const text = data.endsWith('\r') ? data.slice(0, -1) : data;
      if (text) send(mirror.write(text));
      return send(mirror.key('enter'));
    }
    return send(mirror.key(action));
  }

  snapshot() {
    const spawned = new Map(this.pair.snapshot().map(session => [session.id, session]));
    return TABS.map(tab => {
      const mirror = this.attached.get(tab);
      const session = mirror ? { id: tab, title: this.sessions.get(tab).title, status: this.sessions.get(tab).status,
        ...mirror.snapshot() } : spawned.get(tab);
      // Read from the screen alike for both sources: working, waiting on a choice menu, or idle.
      return session && { ...session, ...agentState(session.lines) };
    }).filter(Boolean);
  }

  /** The process behind a tab: the console it mirrors, or the terminal it spawned. */
  pid(tab) {
    if (this.attached.has(tab)) return this.sessions.get(tab)?.pid;
    return this.pair.sessions?.get(tab)?.process?.pid;
  }

  /** Plain desktop presentation, without adding an owned PTY screen to mirrored sessions. */
  plain(tab) {
    const mirror = this.attached.get(tab);
    return mirror ? mirror.plain() : this.pair.sessions.get(tab)?.screen?.plain?.();
  }

  /**
   * The game's pane decides the width once it has asked (`from` 'game'); the daemon's own window
   * resizing afterwards changes only the rows, so the two never fight over the columns.
   */
  resize(cols, rows, from) {
    if (from === 'game') this.gameCols = cols;
    else if (this.gameCols) cols = this.gameCols;
    this.cols = cols; this.rows = rows;
    this.pair.resize(cols, rows);
    for (const mirror of this.attached.values()) { mirror.rows = rows; mirror.cols = cols; mirror.rendered = null; }
  }

  /**
   * Attached mode stays alive until explicitly stopped, including mixed attached/spawned tabs.
   * Only a set consisting entirely of spawned terminals ends when its last terminal exits.
   */
  finished() {
    if (this.attached.size) return false;
    const spawned = TABS.map(tab => this.pair.sessions.get(tab));
    if (!spawned.some(session => session && session.status !== 'not started')) return false;
    return spawned.every(session => !session || session.status !== 'running');
  }

  dispose() {
    for (const mirror of this.attached.values()) mirror.stop();
    return this.pair.dispose();
  }
}
