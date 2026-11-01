// The launcher page's only door to the outside: check, update, play, and talk to the game window.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('launcher', {
  info: () => ipcRenderer.invoke('info'),
  check: () => ipcRenderer.invoke('check'),
  update: () => ipcRenderer.invoke('update'),
  play: () => ipcRenderer.invoke('play'),
  verify: () => ipcRenderer.invoke('verify'),
  folder: () => ipcRenderer.invoke('folder'),
  open: url => ipcRenderer.invoke('open', url),
  win: a => ipcRenderer.invoke('win', a),
  onProgress: cb => ipcRenderer.on('progress', (e, d) => cb(d)),
  onGame: cb => ipcRenderer.on('game', (e, d) => cb(d)),
  toGame: msg => ipcRenderer.send('l2g', msg),
  fromGame: cb => ipcRenderer.on('g2l', (e, m) => cb(m)),
  onQuit: cb => ipcRenderer.on('quitting', () => cb()),
  quitOk: () => ipcRenderer.send('quit-ok'),
  attention: () => ipcRenderer.send('attention'),
  onFirewall: cb => ipcRenderer.on('firewall', (e, st) => cb(st)),
  onLauncherUpdated: cb => ipcRenderer.on('launcher-updated', (e, d) => cb(d)),
});
