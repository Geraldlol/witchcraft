'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const TABS = new Set(['claude', 'codex']);

function tab(value) {
  if (!TABS.has(value)) throw new TypeError('tab must be claude or codex');
  return value;
}

function text(value) {
  if (typeof value !== 'string') throw new TypeError('terminal input must be a string');
  if (Buffer.byteLength(value, 'utf8') > 16_384) throw new RangeError('terminal input exceeds 16 KiB');
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function opacity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('opacity must be a number from 0 through 1');
  }
  return value;
}

const witchcraft = Object.freeze({
  getState: () => ipcRenderer.invoke('witchcraft:get-state'),
  sendInput: (target, data) => ipcRenderer.invoke('witchcraft:send-input', {
    tab: tab(target), data: text(data),
  }),
  resize: (cols, rows) => ipcRenderer.invoke('witchcraft:resize', {
    cols: integer(cols, 'cols', 40, 160),
    rows: integer(rows, 'rows', 10, 60),
  }),
  setActiveTab: target => ipcRenderer.invoke('witchcraft:set-active-tab', { tab: tab(target) }),
  setOpacity: value => ipcRenderer.invoke('witchcraft:set-opacity', opacity(value)),
  setClickThrough: value => {
    if (typeof value !== 'boolean') throw new TypeError('click-through must be a boolean');
    return ipcRenderer.invoke('witchcraft:set-click-through', value);
  },
  requestResync: () => ipcRenderer.invoke('witchcraft:request-resync'),
  minimize: () => ipcRenderer.invoke('witchcraft:minimize'),
  close: () => ipcRenderer.invoke('witchcraft:close'),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('state subscriber must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('witchcraft:state', listener);
    return () => ipcRenderer.removeListener('witchcraft:state', listener);
  },
});

contextBridge.exposeInMainWorld('witchcraft', witchcraft);
