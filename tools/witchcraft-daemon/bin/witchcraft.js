#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig, boundedInteger, LOCAL_DIR, REPO_ROOT } from '../src/config.js';
import { initializeRing } from '../src/init.js';
import { RingWriter, isTransientWriteError, atomicWrite } from '../src/ring.js';
import { TerminalPair, attachTerminal } from '../src/pty.js';
import { SessionSet } from '../src/sessions.js';
import { listConsoles } from '../src/console-list.js';
import { candidateRow, pickConsole } from '../src/console-pick.js';
import { Outbox, watchSavedVariables } from '../src/outbox.js';
import { PixelDecoder, ContextDecoder, decodeHeartbeat, sampleFrame, calibrate } from '../src/pixel.js';
import { Capture, captureOnce } from '../src/capture.js';
import { BURST_MESSAGE_ID, burstProbeText, decodeBurstPage, maxChannelError, sampleBurstPage } from '../src/burst.js';
import { ContextCache, contextWriteKey, shouldPersistContext } from '../src/context-cache.js';
import { foldContextWants, readContextWants } from '../src/context-want.js';
import { setupClaudeMcp, withWoWMcp } from '../src/mcp-launch.js';
import { claudeSessionAlive, findClaudeSession, findCodexThread } from '../src/current-sessions.js';
import { createSessionInfo } from '../src/session-info.js';
import { createEventLog } from '../src/event-log.js';
import { acquireLock, releaseOwnedLock } from '../src/bridge-lock.js';
import { hasWoWTools, presenceDir } from '../src/mcp-presence.js';
import { BindingCarrier, BindingReceiver } from '../src/binding-carrier.js';
import { CooldownCarrierReader, CooldownCarrierReceiver } from '../src/cooldown-carrier.js';
import { checkClientBuild } from '../src/client-build.js';
import { createElectronOverlaySupervisor } from '../src/overlay-launch.js';

const ZERO_EPOCH = '00000000';
// Each ends the bridge through stop(), so the lock and the chunks are cleaned up. On Windows,
// SIGHUP is the console window closing and SIGBREAK is Ctrl+Break.
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'];

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv, options = {}, child = [];
  const values = new Set(['ring', 'cols', 'rows', 'hz', 'history', 'account', 'character', 'tab', 'only', 'cwd', 'timeout']);
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (token === '--') { child.push(...rest.slice(index + 1)); break; }
    if (token === '--clean') { options.clean = true; continue; }
    if (token === '--no-mcp') { options.noMcp = true; continue; }
    if (token === '--no-overlay') { options.noOverlay = true; continue; }
    if (token === '--no-current') { options.noCurrent = true; continue; }
    if (token === '--pixels') { options.pixels = true; continue; }
    if (token === '--no-pixels') { options.noPixels = true; continue; }
    if (token === '--all') { options.all = true; continue; }
    if (token === '--apply') { options.apply = true; continue; }
    if (token === '--attach') {
      const value = rest[++index];
      const [tab, target] = String(value ?? '').split('=');
      if (!['claude', 'codex'].includes(tab) || !target) throw new Error(`--attach takes claude=PID, codex=PID, or claude=pick`);
      options.attach ??= {};
      if (options.attach[tab] !== undefined) throw new Error(`--attach names the ${tab} tab more than once; a tab mirrors one console`);
      if (target !== 'pick' && !/^[1-9][0-9]*$/u.test(target)) throw new Error(`--attach ${tab}= takes a process id or pick, not ${target}`);
      options.attach[tab] = target === 'pick' ? 'pick' : Number(target);
      continue;
    }
    if (!token.startsWith('--') || !values.has(token.slice(2)) || rest[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${token}`);
    options[token.slice(2)] = rest[++index];
  }
  for (const key of ['tab', 'only']) if (options[key] && !['claude', 'codex'].includes(options[key])) throw new Error(`--${key} must be claude or codex`);
  // --only silences the other tab, so attaching the tab it silenced would give it two answers.
  if (options.only && options.attach && options.attach[options.only === 'claude' ? 'codex' : 'claude'] !== undefined) {
    throw new Error(`--only ${options.only} silences the other tab, so it cannot also be attached`);
  }
  return { command, options, child };
}

export async function runBridge(config, options = {}, child = [], adapters = {}) {
  const Pair = adapters.TerminalPair ?? TerminalPair, Display = adapters.attachTerminal ?? attachTerminal;
  const CaptureStream = adapters.Capture ?? Capture, watch = adapters.watchSavedVariables ?? watchSavedVariables;
  const localDir = adapters.localDir ?? LOCAL_DIR;
  const contextPath = path.join(localDir, 'wow-context.json');
  const cols = boundedInteger(options.cols ?? 120, 40, 160, 'columns');
  const rows = boundedInteger(options.rows ?? 40, 10, 60, 'rows');
  const hz = Number(options.hz ?? 1);
  if (!Number.isFinite(hz) || hz < 0.125 || hz > 2) throw new Error('hz must be 0.125..2');
  const history = boundedInteger(options.history ?? 200, 0, 1000, 'history');
  const commands = { claude: { file: 'claude', args: [] }, codex: { file: 'codex', args: [] }, ...config.commands };
  const chosen = { ...commands }, initialTab = options.tab ?? options.only ?? 'claude';
  if (options.only && options.tab && options.only !== options.tab) throw new Error('--tab must match --only when one terminal is started');
  if (options.only) chosen[options.only === 'claude' ? 'codex' : 'claude'] = null;
  if (child.length) chosen[initialTab] = { file: child[0], args: child.slice(1) };
  for (const entry of Object.values(chosen)) {
    if (entry && (typeof entry.file !== 'string' || !Array.isArray(entry.args ?? []) || (entry.args ?? []).some(arg => typeof arg !== 'string'))) {
      throw new Error('Terminal commands require an executable file and an array of arguments');
    }
  }
  // Join the conversations already running here: the Claude tab mirrors the newest Claude Code
  // console in this folder, and the Codex tab resumes the newest top-level Codex thread (the VS Code
  // extension's, which has no console to mirror). An explicit --attach, --only or child command wins.
  const requested = { ...options.attach }, current = [];
  let resumedCodexFile, joinedClaude;
  const joinCwd = path.resolve(options.cwd ?? config.repoRoot);
  if (!options.noCurrent) {
    const cwd = joinCwd;
    const findClaude = adapters.findClaudeSession ?? findClaudeSession, findCodex = adapters.findCodexThread ?? findCodexThread;
    const spawned = tab => chosen[tab] && requested[tab] === undefined && !(child.length && initialTab === tab)
      && path.basename(chosen[tab].file).toLowerCase().replace(/\.exe$/u, '') === tab;
    if (spawned('claude')) {
      const session = await findClaude({ cwd });
      if (session) {
        requested.claude = joinedClaude = session.pid;
        current.push(`Claude tab mirrors the running session in this folder (process ${session.pid})`);
      }
    }
    if (spawned('codex') && !(chosen.codex.args ?? []).some(arg => arg === 'resume' || arg === 'fork')) {
      const thread = await findCodex({ cwd });
      if (thread) {
        chosen.codex = { ...chosen.codex, args: [...(chosen.codex.args ?? []), 'resume', thread.id] };
        resumedCodexFile = thread.file;
        current.push(`Codex tab resumes thread ${thread.id} (${thread.source})`);
      }
    }
  }
  if (!options.noMcp) {
    for (const tab of ['claude', 'codex']) chosen[tab] = withWoWMcp(tab, chosen[tab], { cachePath: contextPath });
  }
  // Naming a console is interactive, so it happens before the lock is taken: cancelling here
  // should leave nothing behind.
  const attach = {};
  const consoles = adapters.listConsoles ?? listConsoles, choose = adapters.pickConsole ?? pickConsole;
  for (const [tab, target] of Object.entries(requested)) {
    if (target !== 'pick') { attach[tab] = target; continue; }
    const picked = await choose({ candidates: await consoles({}), tab });
    if (!picked) throw new Error(`No console chosen for the ${tab} tab, so nothing was started.`);
    attach[tab] = picked.pid;
  }
  await fs.mkdir(localDir, { recursive: true });
  const lockPath = path.join(localDir, 'bridge.lock');
  let epoch, bindingNonce, cooldownNonce;
  do { epoch = randomBytes(4).toString('hex'); } while (epoch === '00000000');
  do { bindingNonce = randomBytes(4).toString('hex'); } while (bindingNonce === '00000000');
  do { cooldownNonce = randomBytes(4).toString('hex'); } while (cooldownNonce === '00000000');
  // Ownership is the identity of the file this run created, not its contents (see bridge-lock.js).
  const { handle: lock, identity: lockIdentity, reclaimed } = await acquireLock({ lockPath, tag: epoch,
    record: { pid: process.pid, epoch, bindingNonce, cooldownNonce, startedAt: new Date().toISOString() } });
  for (const stale of reclaimed) process.stderr.write(`Witchcraft: set aside a stale lock (${stale.reason}): ${stale.path}\n`);
  const releaseLock = () => releaseOwnedLock({ lockPath, identity: lockIdentity, tag: epoch });
  let writer, decoder, contextDecoder, context;
  try {
    writer = new RingWriter({ addonsDir: config.addonsDir, ringSize: config.ringSize, epoch });
    decoder = new PixelDecoder();
    contextDecoder = new ContextDecoder();
    context = new ContextCache({ epoch });
  } catch (error) {
    // Everything before the guarded block below: release the lock rather than strand it.
    await lock.close().catch(() => {});
    await releaseLock().catch(release => process.stderr.write(`\nWitchcraft lock: ${release.message}\n`));
    throw error;
  }
  let contextAck = 0, contextWarningAt = 0, contentWarningAt = 0, contextGeneration = 0, contextWrites = Promise.resolve();
  let contextWritten = null;
  let contextWant = 0, contextWantMask = 0, wantServedAt = {};
  let pair, terminal, overlay, capture, bindingCarrier, bindingReceiver, timer, unwatch, sessionInfo;
  // A joined Claude session loaded its MCP servers when it started, so only its own WoW server can
  // say whether it has the tools (mcp-presence.js). false is published so the game can say so;
  // undefined (not joined, or its process gone) claims nothing.
  let claudeTools, toolsTimer;
  async function checkClaudeTools() {
    if (!joinedClaude || stopped) return;
    const live = adapters.claudeSessionAlive ?? claudeSessionAlive, find = adapters.findClaudeSession ?? findClaudeSession;
    // A session restarted in the mirrored console has a new pid. The joined one counts only while
    // its own record still names it; otherwise the newest live session in the folder is judged.
    let pid = joinedClaude;
    if (!(await live(pid, { cwd: joinCwd }).catch(() => false))) pid = (await find({ cwd: joinCwd }).catch(() => undefined))?.pid;
    if (pid) joinedClaude = pid;
    const next = pid ? await hasWoWTools(presenceDir(contextPath), pid).catch(() => undefined) : undefined;
    if (next === claudeTools || stopped) return;
    claudeTools = next;
    if (next === false) {
      const where = path.resolve(joinCwd) === path.resolve(REPO_ROOT) ? '' : ` --cwd "${joinCwd}"`;
      process.stderr.write(`\nWitchcraft: the Claude session this tab mirrors (process ${pid}) has no WoW tools. Run `
        + `"node bin/witchcraft.js mcp-setup --apply${where}" once, restart that session (claude --continue), then restart Witchcraft.\n`);
    }
    void publish();
  }
  let cooldownCarrierReader, cooldownReceiver, startCooldownSession;
  let stopped = false, oldScreen = '', writing = false, dirty = false;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  let finishStartup, shutdown;
  const startupDone = new Promise(resolve => { finishStartup = resolve; });
  const pendingStarts = new Map(), shutdownErrors = [], cleanupTasks = new Set();
  function rememberFailure(error) {
    if (error && !shutdownErrors.includes(error)) shutdownErrors.push(error);
    if (error?.cleanup) cleanupTasks.add(error.cleanup);
  }
  async function startResource(resource) {
    if (stopped) return;
    const operation = Promise.resolve().then(() => { if (!stopped) return resource.start(); });
    pendingStarts.set(resource, operation);
    try { return await operation; }
    finally { pendingStarts.delete(resource); }
  }
  // The addon reports how many columns its pane fits; both terminals are resized to match.
  const outbox = new Outbox({ epoch, write: (tab, data, action) => pair.write(tab, data, action),
    onControl: ({ cols: fitted }) => { pair?.resize(fitted, pair.rows, 'game'); if (!stopped) void publish(); } });
  // Every game-originated input decision is recorded (never its text) so a forged or dropped
  // message is visible after the fact; stderr is repainted by the terminal display.
  const events = (adapters.createEventLog ?? createEventLog)(path.join(localDir, 'events.log'));
  // Diagnostics beside the audit log: how the lanes, the cursor and publishing behave over time.
  const trace = (adapters.createEventLog ?? createEventLog)(path.join(localDir, 'trace.log'));
  let tracedSlot = 0, tracedFrame = '', stopLagProbe = () => {};
  const deliver = (lane, message) => {
    try { const result = outbox.accept(message); events.input(lane, message, result); return result; }
    catch (error) { events.input(lane, message, { accepted: false, reason: error.message }); throw error; }
  };
  function persistContext() {
    const operation = contextWrites.catch(() => {}).then(async () => {
      try {
        const generation = contextGeneration, ack = context.ack;
        // An unchanged document already speaks for the cache, so acknowledging it is still honest.
        if (!shouldPersistContext(contextWritten, context.raw)) {
          if (generation === contextGeneration) contextAck = ack;
          return true;
        }
        const snapshot = context.snapshot();
        // Stamp the key from the same state the snapshot came from. Reading the cache again
        // after the await would record a newer key against an older document, and the next
        // write would be skipped as unchanged while its message was acknowledged anyway.
        const written = { key: contextWriteKey(context.raw), lastHeartbeatAt: context.raw.lastHeartbeatAt };
        await (adapters.writeContext ?? atomicWrite)(contextPath, JSON.stringify(snapshot) + '\n');
        contextWritten = written;
        if (generation === contextGeneration) contextAck = ack;
        return true;
      } catch (error) {
        if (!contextWarningAt || Date.now() - contextWarningAt >= 10000) {
          process.stderr.write(`\nWoW context cache unavailable (${error.code ?? 'write failed'}); terminal remains active.\n`);
          contextWarningAt = Date.now();
        }
        return false;
      }
    });
    contextWrites = operation;
    return operation;
  }
  let cooldownCursorMoved = false;
  // A receiver follows one UI session. When the writer moves to another (seen through any lane)
  // it is rebuilt; one that has not adopted a session yet, or already follows this one, stays.
  function resetCooldownReceiver() {
    if (stopped || !startCooldownSession) return;
    if (cooldownReceiver && (cooldownReceiver.uiNonce === null || cooldownReceiver.uiNonce === writer.uiNonce)) return;
    const previous = cooldownCarrierReader;
    cooldownCarrierReader = null; cooldownReceiver = null;
    if (previous) void previous.stop();
    startCooldownSession();
  }
  // The file lanes advertise the addon's ring demand on every frame; both follow it the same way.
  function followCursor({ uiNonce, nextSeq }) {
    const previousSeq = writer.cursor, previousNonce = writer.uiNonce;
    if (!writer.request({ epoch: ZERO_EPOCH, uiNonce, nextSeq })) return false;
    if (context.setSession(epoch, writer.uiNonce)) {
      contextGeneration++; contextAck = 0; contextDecoder.clear(); decoder.clear(); resetCooldownReceiver(); forgetWants();
    }
    context.heartbeat();
    if (previousNonce !== writer.uiNonce) decoder.clear();
    cooldownCursorMoved = previousSeq !== writer.cursor || previousNonce !== writer.uiNonce;
    if (cooldownCursorMoved) trace.note({ what: 'cursor', lane: 'file', from: previousSeq, to: writer.cursor, ui: writer.uiNonce });
    return true;
  }
  // A new UI session has served nothing, so the want the chunks still name would be captured
  // again. Forget it; the next refresh folds back only the wants still inside their TTL.
  function forgetWants() { contextWant = 0; contextWantMask = 0; wantServedAt = {}; }
  // Context is pulled, not streamed: the addon stays quiet until a want id changes, and the
  // mask beside the id names only the domains requested since the previous id.
  async function refreshContextWant() {
    try {
      const folded = foldContextWants(await readContextWants(contextPath), wantServedAt);
      if (!folded.mask) return;
      wantServedAt = folded.servedAt;
      contextWant = (contextWant % 262143) + 1;
      contextWantMask = folded.mask;
    } catch { /* an unreadable want simply leaves the addon quiet */ }
  }
  async function publish() {
    if (stopped || !pair) return;
    if (writing) { dirty = true; return; }
    writing = true;
    try {
      do {
        dirty = false;
        const started = performance.now();
        await refreshContextWant();
        const wanted = performance.now();
        await persistContext();
        const persisted = performance.now();
        if (stopped) return;
        const bindingAck = bindingReceiver?.ack ?? 0;
        // The carrier extension is omitted entirely when disabled, so the addon reads a nil protocol and stands down.
        const cooldown = startCooldownSession
          ? { cooldownProtocol: 2, cooldownNonce, cooldownAck: cooldownReceiver?.ack ?? 0,
            cooldownChecksum: cooldownReceiver?.lastChecksum ?? 0 } : {};
        // The model, context and last reply come from each agent's own session files.
        const sessions = pair.snapshot().map(session => ({ ...session, ...sessionInfo?.get(session.id),
          ...(session.id === 'claude' && claudeTools === false ? { tools: false } : {}) }));
        const signature = JSON.stringify({ sessions, ack: outbox.ack, contextAck, contextWant, contextWantMask, bindingAck, cooldown });
        const published = await writer.publish({ changed: signature !== oldScreen, ack: outbox.ack,
          contextProtocol: 4, contextAck, contextWant, contextWantMask, bindingProtocol: 1, bindingNonce, bindingAck, ...cooldown,
          cols: pair.cols, rows: pair.rows, sessions });
        if (published) oldScreen = signature;
        const finished = performance.now();
        if (finished - started > 1000) {
          trace.note({ what: 'slow-publish', ms: Math.round(finished - started), want: Math.round(wanted - started),
            context: Math.round(persisted - wanted), write: Math.round(finished - persisted) });
        }
        if (published && writer.cursor !== tracedSlot) {
          trace.note({ what: 'slot-written', slot: writer.cursor, previous: tracedSlot });
          tracedSlot = writer.cursor;
        }
      } while (dirty && !stopped);
    } catch (error) {
      trace.note({ what: 'publish-error', code: error?.code, reason: error?.message, slot: writer.cursor });
      // A slot the game still has open is skipped; the next heartbeat asks for a fresh one.
      if (isTransientWriteError(error)) process.stderr.write(`\r\nWitchcraft: skipped a chunk write (${error.code}); retrying on the next tick\r\n`);
      else if (error.code === 'LUA_OUTPUT_BUDGET') process.stderr.write('\r\nWitchcraft: display snapshot exceeds the chunk budget; keeping both terminal sessions active.\r\n');
      else if (error.code === 'DISPLAY_CONTENT') {
        // Agent text the Lua serializer refuses skips this frame and the next change publishes again.
        // Every advisory field is now made well-formed before it gets here, so this is a safety net:
        // a fault that persisted would skip every frame, which the throttled warning reports.
        if (Date.now() - contentWarningAt > 30000) {
          contentWarningAt = Date.now();
          process.stderr.write(`\r\nWitchcraft: skipped a frame whose text the game cannot take (${error.message}); both terminal sessions stay active.\r\n`);
        }
      }
      // A startup callback can publish while startResource is still waiting. Shutdown waits
      // for startup, so publishing must request it without awaiting that same startup chain.
      else void stop(error);
    }
    finally { writing = false; }
  }
  function stop(error) {
    rememberFailure(error);
    if (shutdown) return shutdown;
    stopped = true;
    const starting = [...pendingStarts.entries()];
    shutdown = Promise.resolve().then(async () => {
      const attempt = async operation => { try { await operation(); } catch (failure) { rememberFailure(failure); } };
      clearInterval(timer);
      stopLagProbe();
      sessionInfo?.stop();
      clearInterval(toolsTimer);
      // Cancel an acquisition before waiting for it: start() may need stop() to unblock.
      // Stop it again after it settles, in case it acquired a handle after cancellation.
      await Promise.all(starting.map(([resource]) => attempt(() => resource.stop())));
      await startupDone;
      await Promise.all(starting.map(([, operation]) => attempt(() => operation)));
      await attempt(() => unwatch?.());
      for (const resource of new Set([bindingCarrier, cooldownCarrierReader, capture, overlay, ...starting.map(([resource]) => resource)])) {
        await attempt(() => resource?.stop());
      }
      await attempt(() => terminal?.dispose());
      for (const signal of STOP_SIGNALS) process.off(signal, terminate);
      await attempt(() => writer.stop());
      context.disconnect();
      await attempt(() => persistContext());
      for (const cleanup of cleanupTasks) await attempt(() => cleanup);
      await attempt(() => pair?.dispose());
      await attempt(() => lock.close());
      await attempt(() => releaseLock());
      const failure = shutdownErrors.length ? new AggregateError(shutdownErrors, shutdownErrors.map(item => item.message).join('; ')) : undefined;
      if (failure) process.stderr.write(`\nWitchcraft stopped: ${failure.message}\n`);
      finish(failure);
    });
    return shutdown;
  }
  const terminate = () => { void stop(); };
  try {
    const stale = await writer.scrubStale();
    for (const failure of stale.failed) {
      events.error('ring', failure);
      process.stderr.write(`\nA previous run's terminal transcript could not be cleared (${failure}); it is removed once the game releases it and a later start or stop scrubs it.\n`);
    }
    pair = new SessionSet({ commands: chosen, attach, cwd: path.resolve(options.cwd ?? config.repoRoot), cols, rows, history,
      TerminalPair: Pair, ...(adapters.ConsoleMirror ? { ConsoleMirror: adapters.ConsoleMirror } : {}),
      onData: (tab, data) => { terminal?.output(tab, data); overlay?.publishOutput(tab, data); },
      onFrame: () => { if (!stopped) overlay?.publishState(); },
      onError: error => { events.error('mirror', error); process.stderr.write(`\nWitchcraft console mirror: ${error.message}\n`); },
      onExit: tab => {
        overlay?.publishStatus(tab, pair?.sessions.get(tab)?.status ?? 'exited');
        void publish();
        // Attached mode stays available until an explicit stop, including after an owned PTY exits.
        if (pair?.finished()) void stop();
      } });
    terminal = Display(pair, { initialTab });
    sessionInfo = (adapters.createSessionInfo ?? createSessionInfo)({ cwd: path.resolve(options.cwd ?? config.repoRoot),
      pid: tab => pair?.pid?.(tab), codexFile: resumedCodexFile, onChange: () => { if (!stopped) void publish(); } }).start();
    if (joinedClaude) {
      void checkClaudeTools();
      toolsTimer = setInterval(() => void checkClaudeTools(), adapters.presencePollMs ?? 5000);
      toolsTimer.unref?.();
    }
    const lifetime = pair.attached.size ? 'Attached mode stays active until Witchcraft is stopped.' : 'Close both agents to stop.';
    process.stderr.write(`Witchcraft: Claude + Codex tabs; Ctrl+] switches the real terminal. ${lifetime}\n`);
    for (const line of current) process.stderr.write(`Witchcraft: ${line}. --no-current starts fresh sessions instead.\n`);
    // A patched client silently turns the carriers off in game; say so before the player logs in.
    const build = await checkClientBuild(config.addonsDir);
    if (build.status === 'mismatch') {
      process.stderr.write(`Witchcraft: the client is ${build.client} but the carriers were checked on ${build.pinned}; the fast link `
        + 'stays off and typing falls back to the screen strip until Witchcraft/Evidence.lua is moved to the new build.\n');
    }
    for (const signal of STOP_SIGNALS) process.on(signal, terminate);
    if (!options.noOverlay && adapters.overlay !== false) {
      try {
        const createOverlay = adapters.createOverlay ?? createElectronOverlaySupervisor;
        overlay = createOverlay({ terminal: pair });
        overlay.on?.('startup-error', error => process.stderr.write(`\nWitchcraft overlay unavailable: ${error.message}\n`));
        overlay.on?.('restart-error', error => process.stderr.write(`\nWitchcraft overlay restart failed: ${error.message}\n`));
        overlay.on?.('protocol-error', error => process.stderr.write(`\nWitchcraft overlay protocol error: ${error.message}\n`));
        overlay.on?.('unavailable', () => process.stderr.write('\nWitchcraft overlay stopped; both terminal sessions remain active.\n'));
        await startResource(overlay);
      } catch (error) {
        process.stderr.write(`\nWitchcraft overlay unavailable: ${error.message}\n`);
        if (stopped) rememberFailure(error);
        await overlay?.stop().catch(() => {});
        overlay = null;
      }
    }
    if (stopped) return done;
    if (config.accountDir && adapters.bindingCarrier !== false) {
      const Receiver = adapters.BindingReceiver ?? BindingReceiver;
      const Carrier = adapters.BindingCarrier ?? BindingCarrier;
      bindingReceiver = new Receiver({ epoch, nonce: bindingNonce,
        onCursor: frame => followCursor({ uiNonce: frame.uiNonce, nextSeq: frame.slot }),
        onMessage: message => {
          if (message.kind === 'context') {
            const result = context.accept(message);
            if (result.accepted) contextGeneration++;
            return result;
          }
          return deliver('binding', message);
        },
        onAck: () => { void publish(); },
      });
      bindingCarrier = new Carrier({ accountDir: config.accountDir, receiver: bindingReceiver,
        onError: error => { events.error('binding', error); process.stderr.write(`\nBinding carrier retained for inspection: ${error.message}\n`); } });
      await startResource(bindingCarrier);
    }
    if (stopped) return done;
    if (config.cooldownCarrier === true && config.characterDir && adapters.cooldownCarrier !== false) {
      const Reader = adapters.CooldownCarrierReader ?? CooldownCarrierReader;
      const Receiver = adapters.CooldownCarrierReceiver ?? CooldownCarrierReceiver;
      // The reader runs from daemon start; the receiver adopts the UI session of its first accepted
      // frame, so the addon's zero-id heartbeats bootstrap the ring before any host session exists.
      startCooldownSession = () => {
        if (stopped) return;
        cooldownReceiver = new Receiver({ epoch, nonce: cooldownNonce, uiNonce: null,
          onCursor: cursor => followCursor(cursor),
          onMessage: async (message, metadata) => {
            if (message.kind !== 'context') return false;
            const result = context.accept({ kind: 'context', epoch: metadata.epoch, uiNonce: metadata.uiNonce,
              id: message.id, text: message.text });
            if (result.accepted) contextGeneration++;
            return result.accepted === true;
          } });
        cooldownCarrierReader = new Reader({ characterDir: config.characterDir, receiver: cooldownReceiver,
          // A heartbeat that moved nothing is not worth a chunk write; the interval publishes anyway.
          onResult: (result, frame, fingerprint) => {
            const seen = `${fingerprint ?? 'same'}:${result?.accepted}:${result?.reason ?? ''}`;
            if (!result?.duplicatePoll && seen !== tracedFrame) {
              tracedFrame = seen;
              trace.note({ what: 'carrier-frame', kind: frame?.kind, seq: frame?.seq, slot: frame?.slot, message: frame?.message,
                accepted: result?.accepted === true, reason: result?.reason, ack: result?.ack });
            }
            if (result?.accepted && !result.duplicatePoll && (!result.heartbeat || cooldownCursorMoved)) void publish();
          },
          onError: error => { events.error('cooldown', error); trace.note({ what: 'carrier-read-error', code: error?.code, reason: error?.message });
            process.stderr.write(`
Cooldown carrier retained for inspection: ${error.message}
`); } });
        void startResource(cooldownCarrierReader).catch(error => { void stop(error); });
      };
      startCooldownSession();
    }
    await publish();
    if (stopped) return done;
    // A configured account enables the local binding carrier, and the cooldown carrier brings its
    // own demand signal. Pixel capture is retained only as an explicit compatibility mode.
    // The strip stays available wherever it is calibrated: the carrier's gate can refuse in game
    // (build mismatch, taint, combat), and then the strip is the only signal that tells the writer
    // which slot the addon wants. --no-pixels is the explicit way to run on the carrier alone.
    if (config.region && !options.noPixels) capture = new CaptureStream({ region: config.region,
      onError: error => { void stop(error); },
      onFrame: image => {
        if (stopped || !image.foreground) return;
        const heartbeat = decodeHeartbeat(sampleFrame(image, { row: 1 }));
        const previousSeq = writer.cursor, previousNonce = writer.uiNonce;
        const currentHeartbeat = heartbeat && writer.request(heartbeat);
        if (currentHeartbeat) {
          if (context.setSession(epoch, writer.uiNonce)) {
            contextGeneration++;
            contextAck = 0;
            contextDecoder.clear();
            resetCooldownReceiver();
            forgetWants();
          }
          context.heartbeat();
          if (previousSeq !== writer.cursor || previousNonce !== writer.uiNonce) {
            if (previousNonce !== writer.uiNonce) decoder.clear();
            trace.note({ what: 'cursor', lane: 'strip', from: previousSeq, to: writer.cursor, ui: writer.uiNonce });
            void publish();
          }
        }
        const message = decoder.push(sampleFrame(image, { row: 0 }));
        if (message) {
          try { if (deliver('pixel', message).accepted) void publish(); }
          catch (error) { process.stderr.write(`\nInput retained: ${error.message}\n`); }
        }
        if (currentHeartbeat) {
          const telemetry = contextDecoder.push(sampleFrame(image, { row: 0 }));
          if (telemetry && context.accept(telemetry).accepted) void publish();
        }
      } });
    capture?.start();
    if (stopped) return done;
    unwatch = watch(config.savedVariables, {
      onReset: () => { writer.reset(); decoder.clear(); contextDecoder.clear(); return publish(); },
      onRecovery: parsed => { for (const message of parsed.messages) deliver('savedvariables', message); return publish(); },
      onError: error => { events.error('savedvariables', error); process.stderr.write(`\nSavedVariables left unchanged: ${error.message}\n`); },
    });
    if (stopped) return done;
    timer = setInterval(() => { void publish(); }, Math.round(1000 / hz));
    // A blocked event loop freezes every lane at once; record how long each stall lasted.
    let expected = performance.now() + 500;
    const lag = setInterval(() => {
      const now = performance.now(), late = now - expected;
      expected = now + 500;
      if (late > 1000) trace.note({ what: 'loop-stall', ms: Math.round(late) });
    }, 500);
    lag.unref?.();
    stopLagProbe = () => clearInterval(lag);
  } catch (error) { void stop(error); }
  finally { finishStartup(); }
  return done;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

/** Probe-only expanded capture. It reports carrier evidence and never touches a PTY, ACK, cache, or ring. */
export function runBurstProbe(config, options = {}, adapters = {}) {
  const seconds = Number(options.timeout ?? 30);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) {
    return Promise.reject(new TypeError('timeout must be an integer from 5 to 300 seconds'));
  }
  if (!config.region) return Promise.reject(new Error('Calibrate the normal strip first'));
  const CaptureStream = adapters.Capture ?? Capture;
  const decoder = new ContextDecoder({ timeoutMs: 60000, maxPending: 4 });
  const targetSamples = 100, requiredPages = 99;
  const stats = { captures: 0, acceptedPages: 0, foregroundIdleRecords: 0, blankPages: 0, validPayloads: 0,
    foregroundRecoveries: 0, rejectedPages: {}, captureMs: [], intervals: [], maxChannelError: 0 };
  let lastAt = null, awaitingRecovery = false, sampleStarted = false, heartbeatKey = null;
  const summary = passed => ({ passed, payloadBytes: Buffer.byteLength(burstProbeText()), expectedPages: 3,
    sampleGate: `${requiredPages}/${targetSamples}`,
    captures: stats.captures, acceptedPages: stats.acceptedPages,
    foregroundIdleRecords: stats.foregroundIdleRecords, blankPages: stats.blankPages,
    foregroundRecoveries: stats.foregroundRecoveries,
    sampledPages: stats.acceptedPages + Object.values(stats.rejectedPages).reduce((sum, count) => sum + count, 0),
    validPayloads: stats.validPayloads, maxChannelError: stats.maxChannelError,
    rejectedPages: stats.rejectedPages, captureP95Ms: percentile(stats.captureMs, .95),
    intervalP95Ms: percentile(stats.intervals, .95) });
  return new Promise((resolve, reject) => {
    let capture, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); capture?.stop();
      if (error) reject(error); else resolve(result);
    };
    const armTimer = label => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const result = summary(false);
        finish(new Error(`Burst probe ${label}: ${JSON.stringify(result)}`));
      }, seconds * 1000);
      timer.unref?.();
    };
    capture = new CaptureStream({ region: { x: config.region.x, y: config.region.y }, profile: 'burst',
      onError: error => finish(error),
      onIdle: () => { stats.foregroundIdleRecords++; awaitingRecovery = true; },
      onFrame: image => {
        if (awaitingRecovery) { stats.foregroundRecoveries++; awaitingRecovery = false; }
        const now = Date.now();
        stats.captures++;
        stats.captureMs.push(image.captureMs);
        if (lastAt !== null) stats.intervals.push(now - lastAt);
        lastAt = now;
        const rows = sampleBurstPage(image);
        stats.maxChannelError = Math.max(stats.maxChannelError, maxChannelError(rows));
        const page = decodeBurstPage(rows);
        const heartbeat = decodeHeartbeat(sampleFrame(image, { row: 1 }));
        let expectedEpoch = null;
        if (heartbeat && heartbeat.uiNonce !== '00000000') {
          const nextKey = `${heartbeat.epoch}:${heartbeat.uiNonce}`;
          if (heartbeatKey !== null && nextKey !== heartbeatKey) {
            finish(new Error('Burst probe session changed; restart the probe after the reload or host transition'));
            return;
          }
          heartbeatKey = nextKey;
          expectedEpoch = heartbeat.epoch === '00000000' ? heartbeat.uiNonce : heartbeat.epoch;
        }
        if (page.status === 'idle') { stats.blankPages++; return; }
        if (!sampleStarted && expectedEpoch) { sampleStarted = true; armTimer('sample window timed out'); }
        if (!expectedEpoch || page.status !== 'page' || page.kind !== 'context' || page.id !== BURST_MESSAGE_ID) {
          const reason = !expectedEpoch ? 'heartbeat' : page.status !== 'page' ? page.reason
            : page.kind !== 'context' ? 'wrong-kind' : 'wrong-id';
          stats.rejectedPages[reason] = (stats.rejectedPages[reason] ?? 0) + 1;
        } else {
          stats.acceptedPages++;
          let message = null;
          for (const row of page.rows) message = decoder.push(row, now) ?? message;
          if (message) {
            if (message.id !== BURST_MESSAGE_ID || message.epoch !== expectedEpoch
              || message.uiNonce !== heartbeat.uiNonce || message.text !== burstProbeText()) {
              finish(new Error(`Burst decoded an unexpected payload after ${stats.captures} captures`));
              return;
            }
            stats.validPayloads++;
          }
        }
        const sampledPages = stats.acceptedPages
          + Object.values(stats.rejectedPages).reduce((sum, count) => sum + count, 0);
        if (sampledPages >= targetSamples) {
          const p95 = percentile(stats.captureMs, .95);
          const result = summary(stats.acceptedPages >= requiredPages && stats.validPayloads >= 1
            && stats.maxChannelError <= 40 && p95 !== null && p95 < 100);
          if (result.passed) finish(null, result);
          else finish(new Error(`Burst probe failed its native gate: ${JSON.stringify(result)}`));
        }
      },
    });
    armTimer('activation timed out');
    capture.start();
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options, child } = parseArgs(argv);
  if (command === 'help' || command === '--help') {
    console.log(`Witchcraft - separate Claude and Codex terminals inside WoW\n\n` +
      `witchcraft init [--ring 3000] [--clean] [--account NAME] [--character NAME]\n` +
      `witchcraft calibrate [--account NAME]    (show /witch calibrate first)\n` +
      `witchcraft burst-probe [--timeout 30]     (show /witch burstprobe first)\n` +
      `witchcraft run [--cols 120 --rows 40 --hz 1 --history 200] [--cwd PATH] [--no-overlay] [--pixels]\n` +
      `witchcraft run --only claude -- <executable> <args...>\n` +
      `witchcraft run --attach claude=PID|pick [--attach codex=PID|pick]\n` +
      `witchcraft consoles [--all]                (the consoles a tab can mirror)\n` +
      `witchcraft mcp-setup [--apply]             (give a joined Claude session the WoW tools)\n\n` +
      `run starts both agents by default. --only claude|codex starts one.\n` +
      `--attach mirrors a console you started yourself instead of launching that tab;\n` +
      `type in that console's own window. Its colour is the sixteen ANSI colours.\n` +
      `WoW MCP is added to recognized Claude/Codex commands. --no-mcp skips it.\n` +
      `The transparent desktop overlay starts by default; --no-overlay keeps only the terminal UI.\n` +
      `The local binding carrier is the default; --pixels enables legacy screen capture.\n` +
      `Ctrl+] selects the real terminal; WoW tabs select independently.\n` +
      `By default the Claude tab mirrors the newest Claude Code console running in --cwd and the\n` +
      `Codex tab resumes the newest Codex thread there; --attach or --no-current overrides that.`);
    return;
  }
  if (command === 'consoles') {
    const found = await listConsoles({ all: options.all === true });
    if (!found.length) {
      console.log('No consoles found. Start a terminal, or pass --all to include background consoles.');
      return;
    }
    console.log('    PID  RUNNING                                                            WHERE');
    for (const candidate of found) console.log(candidateRow(candidate));
    console.log(`\nAttach one with: witchcraft run --attach claude=<PID>`);
    return;
  }
  if (command === 'mcp-setup') {
    // Needs only this checkout's paths, not the game's: it works before wow.config.json exists.
    // Local scope applies only to sessions started in that folder, so it follows run's --cwd.
    await setupClaudeMcp({ repoRoot: path.resolve(options.cwd ?? REPO_ROOT), cachePath: path.join(LOCAL_DIR, 'wow-context.json'),
      apply: options.apply === true });
    return;
  }
  const config = await loadConfig({ account: options.account, character: options.character });
  if (command === 'init') {
    const ringSize = boundedInteger(options.ring ?? config.ringSize, 3, 9999, 'ring size');
    const result = await initializeRing({ addonsDir: config.addonsDir, ringSize, clean: options.clean === true });
    await saveConfig(config, { ringSize, account: config.account, ...(config.character ? { character: config.character } : {}) });
    console.log(JSON.stringify(result, null, 2));
    console.log('Restart WoW after creating chunk addons. Existing unrelated or unmarked folders are preserved.');
  } else if (command === 'calibrate') {
    const image = await captureOnce({ calibration: true });
    const found = calibrate(image);
    if (!found) throw new Error('No exact Witchcraft calibration strip found. Show /witch calibrate and keep WoW visible.');
    const region = { ...found, x: found.x + image.x, y: found.y + image.y };
    await saveConfig(config, { region, account: config.account });
    console.log(JSON.stringify({ region, captureMs: image.captureMs }, null, 2));
    console.log('Calibration saved. Run /witch calibrate off to return to the live strip.');
  } else if (command === 'burst-probe') {
    process.stderr.write('Return to WoW and run /witch burstprobe 1000. Keep WoW foreground until this exits.\n');
    console.log(JSON.stringify(await runBurstProbe(config, options), null, 2));
  } else if (command === 'run') {
    const error = await runBridge(config, options, child);
    if (error) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // node-pty 1.1.0 can retain a ConPTY worker after its child has exited.
  // This CLI owns that worker's lifetime. runBridge verifies child shutdown and
  // releases the capture, writer, input hooks and lock before main resolves.
  main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))));
    process.exit(process.exitCode ?? 0);
  });
}
