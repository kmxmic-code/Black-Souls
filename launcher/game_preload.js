// The game window's link to the launcher: friends list, invites and the P2P codes they carry, plus full screen.
const { contextBridge, ipcRenderer } = require('electron');
// the game reads its FULLSCREEN option at start: make it match how the window actually opened
try { const on = ipcRenderer.sendSync('fs-get'), s = JSON.parse(localStorage.getItem('bvb-settings') || '{}'); s.fullscreen = !!on; localStorage.setItem('bvb-settings', JSON.stringify(s)); } catch (e) {}
contextBridge.exposeInMainWorld('bsasLink', {
  send: msg => ipcRenderer.send('g2l', msg),
  on: cb => ipcRenderer.on('l2g', (e, m) => cb(m)),
  isFull: () => ipcRenderer.sendSync('fs-get'),
  fullscreen: on => ipcRenderer.send('fs-set', !!on),
  onFullscreen: cb => ipcRenderer.on('fs', (e, on) => cb(!!on)),
});
