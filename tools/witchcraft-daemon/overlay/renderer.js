import { ClickThroughSynchronizer } from './click-through-sync.js';
import {
  filterTerminalInput,
  restoreAuthoritativeSnapshot,
  terminalEventDisposition,
  validatedTerminalGeometry,
} from './terminal-policy.js';

const VALID_TABS = new Set(['claude', 'codex']);
const VALID_CONNECTIONS = new Set(['connecting', 'connected', 'disconnected', 'error']);
const api = window.witchcraft;

const elements = {
  app: document.querySelector('#app'),
  connectionLabel: document.querySelector('#connection-label'),
  modeToggle: document.querySelector('#mode-toggle'),
  modeLabel: document.querySelector('#mode-label'),
  minimize: document.querySelector('#minimize-button'),
  close: document.querySelector('#close-button'),
  opacity: document.querySelector('#opacity-slider'),
  opacityOutput: document.querySelector('#opacity-output'),
  focusTerminal: document.querySelector('#focus-terminal'),
  composer: document.querySelector('#composer'),
  composerLabel: document.querySelector('#composer-label'),
  prompt: document.querySelector('#prompt-input'),
  send: document.querySelector('#send-button'),
  linkDetail: document.querySelector('#link-detail'),
  activeDetail: document.querySelector('#active-detail'),
  updateDetail: document.querySelector('#update-detail'),
  shortcutDetail: document.querySelector('#shortcut-detail'),
  escapeHint: document.querySelector('#escape-hint'),
  toast: document.querySelector('#toast'),
};

const tabs = Object.fromEntries([...VALID_TABS].map(id => [id, {
  button: document.querySelector(`#tab-${id}`),
  panel: document.querySelector(`#panel-${id}`),
  host: document.querySelector(`#terminal-${id}`),
  empty: document.querySelector(`#empty-${id}`),
  status: document.querySelector(`#${id}-status`),
  sequence: document.querySelector(`#${id}-sequence`),
  terminal: null,
  fit: null,
  disposable: null,
  lastText: null,
  generation: 0,
  writeChain: Promise.resolve(),
  inputBuffer: '',
  inputTimer: null,
}]));

let activeTab = 'claude';
let currentState = null;
let lastEventSequence = -1;
let lastGeneration = 0;
let lastAuthoritativeGeneration = -1;
let resyncAfterGeneration = null;
let toastTimer = null;
let resizeTimer = null;
let stateUnsubscribe = null;
let xtermAvailable = false;
let tabRequestSerial = 0;
let clickThrough = false;
let shortcutState = { accelerator: 'Ctrl+Shift+H', registered: false, conflict: false, known: false };
let shortcutNotice = '';

const GLASS_LAYERS = Object.freeze({
  '--surface': [4, 8, 10, 1],
  '--surface-deep': [1, 3, 4, 1],
  '--surface-raised': [13, 20, 23, 0.92],
  '--surface-title': [3, 7, 8, 0.8],
  '--surface-rail': [7, 12, 14, 0.62],
  '--surface-tab': [6, 11, 13, 0.7],
  '--surface-control': [18, 26, 29, 0.7],
  '--surface-input': [0, 2, 3, 0.86],
  '--surface-status': [2, 6, 7, 0.92],
  '--surface-toast': [4, 9, 11, 1],
  '--surface-kbd': [20, 28, 31, 0.68],
  '--surface-send': [57, 42, 20, 0.55],
  '--surface-send-hover': [85, 61, 27, 0.66],
  '--surface-danger': [62, 20, 19, 0.72],
  '--surface-hover': [40, 42, 35, 0.8],
  '--surface-tab-hover': [17, 25, 28, 0.85],
  '--surface-tab-selected': [12, 18, 20, 0.93],
  '--surface-composer': [5, 10, 12, 0.91],
  '--surface-deck-glow': [34, 54, 58, 0.14],
});

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ }
}

function bridgeCall(method, ...args) {
  if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('Witchcraft bridge unavailable'));
  try { return Promise.resolve(api[method](...args)); }
  catch (error) { return Promise.reject(error); }
}

const clickThroughSync = new ClickThroughSynchronizer({
  async send(value) {
    const result = await bridgeCall('setClickThrough', value);
    if (result?.ok === false) throw new Error('The host rejected the HUD click-through change.');
    return result;
  },
  onError(error, acknowledged) {
    clickThrough = acknowledged;
    showToast(error instanceof Error ? error.message : String(error), true);
    setMode(acknowledged ? 'hud' : 'workbench', { syncClickThrough: false, persist: false });
  },
});

function requestResync(message) {
  if (resyncAfterGeneration !== null) return;
  resyncAfterGeneration = lastGeneration;
  elements.linkDetail.textContent = 'RESYNCING';
  bridgeCall('requestResync').then(result => {
    if (result?.ok === false) elements.linkDetail.textContent = 'RESYNC PENDING';
  }).catch(error => {
    resyncAfterGeneration = null;
    showToast(`Could not resynchronize: ${error.message}`, true);
  });
  if (message) console.warn(`Witchcraft requested a terminal resync: ${message}`);
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', error);
  elements.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2600);
}

function connectionFrom(state) {
  const raw = String(state?.lifecycle ?? state?.connection ?? '').toLowerCase();
  if (raw === 'running' || raw === 'ready' || raw === 'connected') return 'connected';
  if (raw === 'starting' || raw === 'connecting' || raw === 'syncing') return 'connecting';
  if (raw === 'failed' || raw === 'error') return 'error';
  return 'disconnected';
}

function sessionStatus(session) {
  const status = String(session?.status ?? 'waiting').toLowerCase();
  if (status === 'running' || status === 'ready') return 'running';
  if (status === 'starting' || status === 'connecting') return 'starting';
  if (status === 'failed' || status === 'error') return 'error';
  if (/^(?:exited|closed|stopped)(?:\s*\([^)]*\))?$/.test(status)) return 'exited';
  return 'waiting';
}

function terminalText(session) {
  if (typeof session?.ansi === 'string') return session.ansi;
  if (typeof session?.text === 'string') return session.text;
  if (!Array.isArray(session?.lines)) return '';
  return session.lines.map(line => {
    if (typeof line === 'string') return line;
    if (line && typeof line.text === 'string') return line.text;
    return '';
  }).map(line => line
    .replace(/\u001b/gu, '[ESC]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?'))
    .join('\r\n');
}

function normalizeOpacity(value, fallback = 0.88) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function setOpacityUi(value) {
  const bounded = normalizeOpacity(value);
  const percentage = Math.round(bounded * 100);
  elements.opacity.value = String(percentage);
  elements.opacityOutput.value = `${percentage}%`;
  elements.opacityOutput.textContent = `${percentage}%`;
  document.documentElement.style.setProperty('--background-opacity', String(bounded));
  document.documentElement.style.setProperty('--glass-blur', bounded === 0 ? '0px' : '18px');
  for (const [name, [red, green, blue, weight]] of Object.entries(GLASS_LAYERS)) {
    const alpha = Math.min(1, bounded * weight);
    document.documentElement.style.setProperty(name, `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`);
  }
  document.documentElement.style.setProperty('--surface-gold-wash', `rgba(208, 164, 92, ${(bounded * 0.04).toFixed(3)})`);
  document.documentElement.style.setProperty('--surface-selected-wash', `rgba(208, 164, 92, ${(bounded * 0.12).toFixed(3)})`);
  document.documentElement.style.setProperty('--surface-cyan-wash', `rgba(98, 197, 220, ${(bounded * 0.03).toFixed(3)})`);
  document.documentElement.style.setProperty('--surface-scanline', `rgba(222, 238, 242, ${(bounded * 0.014).toFixed(3)})`);
  document.documentElement.style.setProperty('--surface-shadow', `rgba(0, 0, 0, ${(bounded * 0.55).toFixed(3)})`);
  document.documentElement.style.setProperty('--surface-highlight', `rgba(255, 255, 255, ${(bounded * 0.03).toFixed(3)})`);
}

function updateShortcut(state) {
  const shortcut = state?.shortcut;
  if (!shortcut || typeof shortcut !== 'object') return;
  const accelerator = typeof shortcut.accelerator === 'string' && shortcut.accelerator.trim()
    ? shortcut.accelerator.trim()
    : 'Ctrl+Shift+H';
  shortcutState = {
    accelerator,
    registered: shortcut.registered === true,
    conflict: shortcut.conflict === true,
    known: true,
  };
  elements.app.dataset.shortcut = shortcutState.conflict
    ? 'conflict'
    : shortcutState.registered ? 'ready' : 'unavailable';
  elements.modeToggle.disabled = shortcutState.conflict;
  elements.shortcutDetail.textContent = shortcutState.conflict
    ? `${accelerator.toUpperCase()} CONFLICT`
    : shortcutState.registered ? `${accelerator.toUpperCase()} READY` : `${accelerator.toUpperCase()} UNAVAILABLE`;
  elements.escapeHint.querySelector('.hint-keys').textContent = accelerator.toUpperCase();
  elements.escapeHint.querySelector('.hint-copy').textContent = shortcutState.conflict
    ? 'HUD HOTKEY UNAVAILABLE'
    : 'ESCAPE HUD';
  elements.modeToggle.title = shortcutState.conflict
    ? `${accelerator} is already in use; HUD click-through is disabled.`
    : `Toggle HUD / Workbench (${accelerator})`;
  const notice = `${shortcutState.conflict}:${accelerator}`;
  if (shortcutState.conflict && shortcutNotice !== notice) {
    shortcutNotice = notice;
    showToast(`${accelerator} could not be registered. HUD click-through is unavailable.`, true);
  }
}

function formatAge(state) {
  const stamp = Number(state?.sampledAt ?? state?.updatedAt ?? 0);
  if (!Number.isFinite(stamp) || stamp <= 0) return 'LIVE STATE';
  const age = Math.max(0, Date.now() - stamp);
  if (age < 1_000) return 'UPDATED NOW';
  if (age < 60_000) return `UPDATED ${Math.floor(age / 1_000)}S AGO`;
  return `UPDATED ${Math.floor(age / 60_000)}M AGO`;
}

function updateConnection(state) {
  const connection = connectionFrom(state);
  elements.app.dataset.connection = VALID_CONNECTIONS.has(connection) ? connection : 'disconnected';
  const labels = {
    connecting: 'CONNECTING',
    connected: 'LINKED',
    disconnected: api ? 'OFFLINE' : 'PREVIEW',
    error: 'LINK ERROR',
  };
  elements.connectionLabel.textContent = labels[connection];
  elements.linkDetail.textContent = resyncAfterGeneration !== null
    ? 'RESYNCING'
    : connection === 'connected'
      ? `PROTOCOL ${String(state?.protocolVersion ?? 'LOCAL').toUpperCase()}`
      : (api ? labels[connection] : 'BRIDGE UNAVAILABLE');
  elements.updateDetail.textContent = formatAge(state);
}

function queueTerminalWrite(view, data) {
  if (!view.terminal || !data) return;
  view.writeChain = view.writeChain
    .then(() => new Promise(resolve => view.terminal.write(data, resolve)))
    .catch(error => {
      console.error('Witchcraft terminal render failed:', error);
      showToast('Terminal rendering failed; waiting for a fresh state.', true);
    });
}

function queueTerminalSnapshot(view, data, geometry) {
  if (!view.terminal) return;
  view.writeChain = view.writeChain
    .then(() => new Promise(resolve => {
      restoreAuthoritativeSnapshot(view.terminal, data, geometry, resolve);
    }))
    .catch(error => {
      console.error('Witchcraft terminal snapshot failed:', error);
      showToast('Terminal rendering failed; waiting for a fresh state.', true);
    });
}

function writeSnapshot(id, session, generation, geometry) {
  const view = tabs[id];
  const text = terminalText(session);
  const status = sessionStatus(session);
  const hasOutput = Boolean(text);
  view.empty.hidden = hasOutput && xtermAvailable;

  if (!xtermAvailable) {
    view.empty.querySelector('strong').textContent = 'TERMINAL RENDERER UNAVAILABLE';
    view.empty.querySelector('small').textContent = 'Install the local xterm renderer dependencies, then reopen Witchcraft.';
    return;
  }
  if (!view.terminal || (view.generation === generation && view.lastText === text)) return;
  view.lastText = text;
  view.generation = generation;
  const cursor = status === 'running' ? '\u001b[?25h' : '\u001b[?25l';
  queueTerminalSnapshot(view, `${text}${cursor}`, geometry);
}

function updateSession(id, session, generation, write, geometry) {
  const status = sessionStatus(session);
  const view = tabs[id];
  view.button.dataset.status = status;
  view.status.textContent = status.toUpperCase();
  view.sequence.textContent = generation > 0 ? `SYNC ${generation}` : 'LOCAL STATE';
  view.button.setAttribute('aria-label', `${id === 'claude' ? 'Claude' : 'Codex'} terminal, ${status}`);
  if (view.terminal) view.terminal.options.disableStdin = status !== 'running';
  if (write) writeSnapshot(id, session, generation, geometry);
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  const kind = typeof state.kind === 'string' ? state.kind : 'snapshot';
  const eventSequence = Number(state.eventSeq ?? state.seq);
  if (Number.isFinite(eventSequence) && eventSequence <= lastEventSequence) return;
  const generation = Number(state.generation);
  const freshAuthoritativeSnapshot = kind === 'snapshot'
    && state.authoritative === true
    && Number.isFinite(generation)
    && generation > lastAuthoritativeGeneration;
  if (Number.isFinite(eventSequence)) {
    const sequenceGap = lastEventSequence >= 0 && eventSequence !== lastEventSequence + 1;
    lastEventSequence = eventSequence;
    const selfHealingSnapshot = kind === 'snapshot' && state.authoritative === true
      && Number.isFinite(generation) && generation > lastGeneration;
    if (sequenceGap && !selfHealingSnapshot) {
      requestResync(`renderer event gap before ${eventSequence}`);
      return;
    }
  }
  if (Number.isFinite(generation) && generation < lastGeneration) return;
  const terminalDisposition = terminalEventDisposition({
    kind,
    resyncPending: resyncAfterGeneration !== null,
  });
  if (terminalDisposition === 'ignore') return;
  if (terminalDisposition === 'resync') {
    const generationMatches = state.output && state.output.generation === lastGeneration;
    requestResync(generationMatches ? undefined : 'output generation did not match the active snapshot');
    return;
  }
  if (kind === 'snapshot' && Number.isFinite(generation)) {
    if (resyncAfterGeneration === null || generation > resyncAfterGeneration) {
      lastGeneration = generation;
      resyncAfterGeneration = null;
    }
  }
  currentState = state;
  updateConnection(state);
  updateShortcut(state);

  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const snapshotGeometry = validatedTerminalGeometry(state);
  const shouldWriteSnapshot = kind === 'snapshot' && resyncAfterGeneration === null && snapshotGeometry !== null;
  for (const id of VALID_TABS) {
    const session = sessions.find(candidate => candidate?.id === id) ?? { id, status: 'waiting', lines: [] };
    updateSession(id, session, Number.isFinite(generation) ? generation : 0, shouldWriteSnapshot, snapshotGeometry);
  }
  if (kind === 'error' && state.error?.message) showToast(String(state.error.message), true);

  if (freshAuthoritativeSnapshot) {
    lastAuthoritativeGeneration = generation;
    if (VALID_TABS.has(state.activeTab) && state.activeTab !== activeTab) selectTab(state.activeTab, false, false);
    if (typeof state.opacity === 'number' && Number.isFinite(state.opacity)) setOpacityUi(state.opacity);
  }
  if (typeof state.clickThrough === 'boolean') {
    const previousClickThrough = clickThrough;
    clickThrough = state.clickThrough;
    const stateMatchesDesiredMode = clickThroughSync.observe(clickThrough);
    if (stateMatchesDesiredMode && clickThrough !== previousClickThrough) {
      setMode(clickThrough ? 'hud' : 'workbench', { syncClickThrough: false, persist: false });
    }
  }
  elements.send.disabled = sessionStatus(sessions.find(session => session?.id === activeTab)) !== 'running';
}

function selectTab(id, notify = true, focus = true) {
  if (!VALID_TABS.has(id)) return;
  activeTab = id;
  for (const [candidate, view] of Object.entries(tabs)) {
    const selected = candidate === id;
    view.button.setAttribute('aria-selected', String(selected));
    view.button.tabIndex = selected ? 0 : -1;
    view.panel.hidden = !selected;
    view.panel.classList.toggle('is-active', selected);
  }
  const proper = id === 'claude' ? 'Claude' : 'Codex';
  elements.composerLabel.textContent = `TO ${proper.toUpperCase()} / PROMPT`;
  elements.prompt.placeholder = `Send an instruction to ${proper}...`;
  elements.activeDetail.textContent = id.toUpperCase();
  const session = currentState?.sessions?.find(candidate => candidate?.id === id);
  elements.send.disabled = sessionStatus(session) !== 'running';
  requestAnimationFrame(() => {
    fitActiveTerminal();
    if (focus) tabs[id].terminal?.focus();
  });
  if (notify) {
    const request = ++tabRequestSerial;
    bridgeCall('setActiveTab', id).then(result => {
      if (result?.ok === false) throw new Error('The host rejected the terminal selection.');
      if (request === tabRequestSerial && activeTab === id) selectTab(id, false, false);
    }).catch(error => {
      showToast(error.message, true);
      requestResync('terminal selection was not acknowledged');
    });
  }
}

function setMode(mode, { syncClickThrough = true, persist = true } = {}) {
  const hud = mode === 'hud';
  if (syncClickThrough && hud && shortcutState.known && !shortcutState.registered) {
    showToast(`${shortcutState.accelerator} is unavailable; HUD click-through was not enabled.`, true);
    return false;
  }
  elements.app.classList.toggle('mode-hud', hud);
  elements.app.classList.toggle('mode-workbench', !hud);
  elements.app.dataset.clickThrough = String(hud);
  elements.modeToggle.setAttribute('aria-pressed', String(hud));
  elements.modeToggle.setAttribute('aria-label', hud ? 'Switch to full workbench' : 'Switch to compact HUD');
  elements.modeLabel.textContent = hud ? 'FULL' : 'HUD';
  if (persist) safeStorageSet('witchcraft.viewMode', hud ? 'hud' : 'workbench');
  requestAnimationFrame(fitActiveTerminal);
  if (syncClickThrough && api) void clickThroughSync.setDesired(hud);
  return true;
}

function toggleMode() {
  setMode(elements.app.classList.contains('mode-hud') ? 'workbench' : 'hud');
}

function fitActiveTerminal() {
  const view = tabs[activeTab];
  if (!view?.fit || view.panel.hidden) return;
  try {
    view.fit.fit();
    const cols = Math.max(40, Math.min(160, view.terminal.cols));
    const rows = Math.max(10, Math.min(60, view.terminal.rows));
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      bridgeCall('resize', cols, rows).catch(() => {});
    }, 120);
  } catch { /* A hidden or closing window has no measurable terminal bounds. */ }
}

function bufferTerminalInput(id, data) {
  const view = tabs[id];
  if (!data || tabs[id].button.dataset.status !== 'running') return;
  view.inputBuffer += data;
  if (new TextEncoder().encode(view.inputBuffer).byteLength > 16_384) {
    view.inputBuffer = '';
    showToast('Terminal input exceeded the 16 KiB safety limit.', true);
    return;
  }
  if (view.inputTimer) return;
  view.inputTimer = setTimeout(() => {
    const payload = view.inputBuffer;
    view.inputBuffer = '';
    view.inputTimer = null;
    bridgeCall('sendInput', id, payload).catch(error => showToast(error.message, true));
  }, 8);
}

async function loadTerminals() {
  try {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('../node_modules/@xterm/xterm/lib/xterm.mjs'),
      import('../node_modules/@xterm/addon-fit/lib/addon-fit.mjs'),
    ]);

    for (const [id, view] of Object.entries(tabs)) {
      const terminal = new Terminal({
        allowProposedApi: false,
        allowTransparency: true,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 1,
        disableStdin: true,
        drawBoldTextInBrightColors: false,
        fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
        fontSize: 12,
        fontWeight: '400',
        fontWeightBold: '600',
        letterSpacing: 0,
        lineHeight: 1.16,
        minimumContrastRatio: 4.5,
        overviewRulerWidth: 0,
        rightClickSelectsWord: true,
        screenReaderMode: true,
        scrollback: 2_000,
        smoothScrollDuration: 0,
        theme: {
          background: '#01030400',
          foreground: '#d8e0e2',
          cursor: id === 'claude' ? '#f0c777' : '#62c5dc',
          cursorAccent: '#010304',
          selectionBackground: '#d0a45c40',
          selectionInactiveBackground: '#8b989f28',
          black: '#121719',
          red: '#da6a64',
          green: '#57c58b',
          yellow: '#d0a45c',
          blue: '#669bc5',
          magenta: '#b184bd',
          cyan: '#62c5dc',
          white: '#d8e0e2',
          brightBlack: '#657279',
          brightRed: '#f08b84',
          brightGreen: '#81d3a6',
          brightYellow: '#f0c777',
          brightBlue: '#89b9dc',
          brightMagenta: '#cca6d4',
          brightCyan: '#8ad5e5',
          brightWhite: '#f3f6f7',
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(view.host);
      view.terminal = terminal;
      view.fit = fit;
      view.disposable = terminal.onData(data => {
        const input = filterTerminalInput(data);
        if (input) bufferTerminalInput(id, input);
      });
    }
    xtermAvailable = true;
    requestAnimationFrame(() => {
      fitActiveTerminal();
      if (currentState) applyState(currentState);
    });
  } catch (error) {
    xtermAvailable = false;
    for (const id of VALID_TABS) writeSnapshot(id, { lines: [] }, 0);
    showToast('Local xterm renderer could not be loaded.', true);
    console.error('Witchcraft xterm initialization failed:', error);
  }
}

async function submitPrompt() {
  const value = elements.prompt.value;
  if (!value.trim()) {
    tabs[activeTab].terminal?.focus();
    return;
  }
  const session = currentState?.sessions?.find(candidate => candidate?.id === activeTab);
  if (sessionStatus(session) !== 'running') {
    showToast(`${activeTab === 'claude' ? 'Claude' : 'Codex'} is not running.`, true);
    return;
  }
  if (new TextEncoder().encode(value).byteLength + 1 > 16_384) {
    showToast('Prompt exceeds the 16 KiB terminal input limit.', true);
    return;
  }
  elements.send.disabled = true;
  try {
    await bridgeCall('sendInput', activeTab, `${value}\r`);
    elements.prompt.value = '';
    showToast(`Sent to ${activeTab === 'claude' ? 'Claude' : 'Codex'}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    const latestSession = currentState?.sessions?.find(candidate => candidate?.id === activeTab);
    elements.send.disabled = sessionStatus(latestSession) !== 'running';
    elements.prompt.focus();
  }
}

function bindEvents() {
  for (const [id, view] of Object.entries(tabs)) {
    view.button.addEventListener('click', () => selectTab(id));
    view.button.addEventListener('keydown', event => {
      const order = ['claude', 'codex'];
      const index = order.indexOf(id);
      let next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = order[(index + 1) % order.length];
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = order[(index - 1 + order.length) % order.length];
      if (event.key === 'Home') next = order[0];
      if (event.key === 'End') next = order[order.length - 1];
      if (next) {
        event.preventDefault();
        selectTab(next, true, false);
        tabs[next].button.focus();
      }
    });
  }

  elements.modeToggle.addEventListener('click', toggleMode);
  elements.focusTerminal.addEventListener('click', () => tabs[activeTab].terminal?.focus());
  elements.close.addEventListener('click', () => bridgeCall('close').catch(error => showToast(error.message, true)));
  elements.minimize.addEventListener('click', () => bridgeCall('minimize').catch(error => showToast(error.message, true)));

  elements.opacity.addEventListener('input', () => {
    setOpacityUi(Number(elements.opacity.value) / 100);
  });
  elements.opacity.addEventListener('change', () => {
    const value = Number(elements.opacity.value) / 100;
    safeStorageSet('witchcraft.opacity', String(value));
    bridgeCall('setOpacity', value).catch(error => showToast(error.message, true));
  });

  elements.composer.addEventListener('submit', event => {
    event.preventDefault();
    void submitPrompt();
  });
  elements.prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitPrompt();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.altKey && !event.ctrlKey && !event.shiftKey && (event.code === 'Digit1' || event.code === 'Digit2')) {
      event.preventDefault();
      selectTab(event.code === 'Digit1' ? 'claude' : 'codex');
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyH') {
      event.preventDefault();
      if (!shortcutState.registered) {
        showToast(`${shortcutState.accelerator} is unavailable; use the HUD button after resolving the shortcut conflict.`, true);
      }
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyT') {
      event.preventDefault();
      tabs[activeTab].terminal?.focus();
    }
  });

  const observer = new ResizeObserver(() => fitActiveTerminal());
  observer.observe(elements.app);
  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    stateUnsubscribe?.();
    for (const view of Object.values(tabs)) {
      clearTimeout(view.inputTimer);
      view.disposable?.dispose();
      view.terminal?.dispose();
    }
  });
}

async function initialize() {
  bindEvents();
  elements.modeToggle.disabled = true;
  const savedMode = safeStorageGet('witchcraft.viewMode') === 'hud' ? 'hud' : 'workbench';
  setMode('workbench', { syncClickThrough: false, persist: false });
  const savedOpacityText = safeStorageGet('witchcraft.opacity');
  const savedOpacity = savedOpacityText === null ? NaN : Number(savedOpacityText);
  const hasSavedOpacity = Number.isFinite(savedOpacity) && savedOpacity >= 0 && savedOpacity <= 1;
  setOpacityUi(hasSavedOpacity ? savedOpacity : 0.88);
  await loadTerminals();

  if (!api) {
    applyState({ lifecycle: 'disconnected', activeTab: 'claude', sessions: [] });
    elements.minimize.disabled = true;
    elements.close.disabled = true;
    return;
  }

  if (typeof api.onState === 'function') {
    stateUnsubscribe = api.onState(state => applyState(state));
  }
  try {
    if (hasSavedOpacity) await bridgeCall('setOpacity', savedOpacity);
    applyState(await bridgeCall('getState'));
    if (savedMode === 'hud' && shortcutState.registered && !clickThrough) setMode('hud');
  } catch (error) {
    applyState({ lifecycle: 'error', activeTab, sessions: [] });
    showToast(error.message, true);
  }
}

void initialize();
