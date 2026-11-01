// The game window's link to the launcher: friends list, invites and the P2P codes they carry.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bsasLink', {
  send: msg => ipcRenderer.send('g2l', msg),
  on: cb => ipcRenderer.on('l2g', (e, m) => cb(m)),
});
