// BKS — the launcher for B.S.A.S (Black Souls All Star) and future games. Keeps the game up to date from GitHub (only changed files are
// downloaded, each checked against its SHA-256), then runs it in its own window.
const { app, BrowserWindow, protocol, net, Menu, shell, session, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), fsp = fs.promises, crypto = require('crypto'), { pathToFileURL } = require('url');

const LAUNCHER_VERSION = 7;                            // this launcher code (updates itself from GitHub)
const BOOT = global.BKS_BOOT || { runtime: 4, core: 'bundled' };   // set by the small loader in resources/app/main.js
const RAW = process.env.BSAS_UPDATE_URL || 'https://raw.githubusercontent.com/kmxmic-code/Black-Souls/main/';
const BUNDLED = path.join(app.getAppPath(), 'game');   // the game that shipped inside the installer (next to the loader)
const UI = path.join(__dirname, 'launcher');
let GAME, INSTALLED;                                   // the live copy in the user's app data, and its record

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();

const GAME_CSS = `
  html, body { height: 100%; overflow: hidden; }
  body { padding: 0 !important; margin: 0; background: #07040d; }
  header, .controls, .note { display: none !important; }
  .wrap { max-width: none !important; height: 100vh; display: grid; place-items: center; gap: 0 !important; }
  #stage { width: min(100vw, 100vh * 16 / 9) !important; border: 0 !important; box-shadow: none !important; }
`;

// ---------- installed files ----------
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const safe = p => typeof p === 'string' && /^[\w.\-\/]+$/.test(p) && !p.split('/').includes('..') && !p.startsWith('/');
async function firstRun() {
  // copy the game that came with the installer into app data, once (or after a broken install)
  const inst = readJSON(INSTALLED);
  if (inst && fs.existsSync(path.join(GAME, 'index.html'))) return;
  await fsp.rm(GAME, { recursive: true, force: true }); await fsp.mkdir(GAME, { recursive: true });
  for (const f of await fsp.readdir(BUNDLED)) if (f !== 'release.json') await fsp.copyFile(path.join(BUNDLED, f), path.join(GAME, f));
  await fsp.writeFile(INSTALLED, JSON.stringify(readJSON(path.join(BUNDLED, 'release.json')) || { version: '0', files: {} }));
}
async function fetchRelease() {
  const r = await net.fetch(RAW + 'release.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function plan(rel) {
  const inst = readJSON(INSTALLED) || { files: {} };
  const changed = Object.entries(rel.files || {}).filter(([p, f]) => safe(p) && (!inst.files[p] || inst.files[p].sha !== f.sha || !fs.existsSync(path.join(GAME, p))));
  return { inst, changed, bytes: changed.reduce((s, [, f]) => s + f.size, 0) };
}
let updating = null;
async function update(win, rel) {
  const { changed, bytes } = plan(rel);
  const stage = path.join(app.getPath('userData'), 'staging');
  await fsp.rm(stage, { recursive: true, force: true }); await fsp.mkdir(stage, { recursive: true });
  // up to 4 files at once (much faster on many small files), each retried 3 times and checked against its SHA-256
  let got = 0; const live = {}, t0 = Date.now(); let lastSend = 0;
  const send = (extra, force) => { const now = Date.now(); if (!force && now - lastSend < 80) return; lastSend = now; if (!win.isDestroyed()) win.webContents.send('progress', Object.assign({ got, bytes, files: changed.length, now: got + Object.values(live).reduce((a, b) => a + b, 0), ms: now - t0 }, extra)); };
  const one = async ([p, f]) => {
    let lastErr;
    for (let tryN = 0; tryN < 3; tryN++) {
      try {
        live[p] = 0;
        const r = await net.fetch(RAW + 'game/' + p.split('/').map(encodeURIComponent).join('/') + '?v=' + f.sha.slice(0, 12), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const chunks = []; const rd = r.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value)); live[p] += value.length; send({ file: p }); }
        const buf = Buffer.concat(chunks);
        if (buf.length !== f.size || sha256(buf) !== f.sha) throw new Error('bad file ' + p);
        await fsp.mkdir(path.dirname(path.join(stage, p)), { recursive: true });
        await fsp.writeFile(path.join(stage, p), buf); delete live[p]; got += f.size; send({ file: p }); return;
      } catch (e) { lastErr = e; delete live[p]; }
    }
    throw lastErr;
  };
  const queue = changed.slice().sort((a, b) => b[1].size - a[1].size);   // big files first keeps all 4 lanes busy
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
  // everything arrived and checked: swap it in, drop files the new version no longer has
  for (const [p] of changed) { const dst = path.join(GAME, p); await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.rm(dst, { force: true }); await fsp.rename(path.join(stage, p), dst); }
  const inst = readJSON(INSTALLED) || { files: {} };
  for (const p of Object.keys(inst.files || {})) if (!rel.files[p] && safe(p)) await fsp.rm(path.join(GAME, p), { force: true });
  await fsp.writeFile(INSTALLED, JSON.stringify({ version: rel.version, files: rel.files }));
  await fsp.rm(stage, { recursive: true, force: true });
  send({ now: bytes, done: true }, true);
}

// ---------- desktop + Start menu shortcuts (Windows) ----------
// Made once on first run; kept pointing at this copy if the folder moves; never re-made if the player deletes one.
function shortcuts() {
  if (process.platform !== 'win32') return;
  const flag = path.join(app.getPath('userData'), 'shortcuts.json'), made = readJSON(flag) || {};
  const opts = { target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0, description: 'BKS', appUserModelId: 'com.blacksouls.allstar' };
  const dirs = { desktop: app.getPath('desktop'), start: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs') };
  const places = { desktop: path.join(dirs.desktop, 'BKS.lnk'), start: path.join(dirs.start, 'BKS.lnk') };
  for (const [k, lnk] of Object.entries(places)) {
    try {   // the launcher is BKS now: an old "Black Souls All Star" shortcut is renamed, not duplicated
      const old = path.join(dirs[k], 'Black Souls All Star.lnk');
      if (fs.existsSync(old) && !fs.existsSync(lnk)) fs.renameSync(old, lnk);
      if (fs.existsSync(lnk)) { const cur = shell.readShortcutLink(lnk); if (cur.target !== process.execPath) shell.writeShortcutLink(lnk, 'replace', opts); }
      else if (!made[k]) { shell.writeShortcutLink(lnk, 'create', opts); made[k] = true; }
    } catch (e) {}
  }
  try { fs.writeFileSync(flag, JSON.stringify(made)); } catch (e) {}
}

// ---------- Windows Firewall: allow online play once, so Windows stops asking ----------
// Adds an inbound allow rule for this exact .exe (one admin "Yes"), replacing any rule left for an older copy.
function firewallRule() {
  if (process.platform !== 'win32') return;
  const { execFile, spawn } = require('child_process');
  const flag = path.join(app.getPath('userData'), 'firewall.json'), done = readJSON(flag) || {}, exe = process.execPath, NAME = 'Black Souls All Star';
  if (done.exe === exe) return;   // already handled for this copy (allowed, or the player said no)
  execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + NAME, 'verbose'], { windowsHide: true }, (err, out) => {
    if (!err && String(out).toLowerCase().includes(exe.toLowerCase())) { try { fs.writeFileSync(flag, JSON.stringify({ exe, ok: true })); } catch (e) {} return; }
    const cmd = path.join(app.getPath('temp'), 'bsas-firewall.cmd');
    const q = s => '"' + s + '"';
    fs.writeFileSync(cmd, [
      '@echo off',
      `netsh advfirewall firewall delete rule name=${q(NAME)} >nul 2>&1`,
      `netsh advfirewall firewall add rule name=${q(NAME)} dir=in action=allow program=${q(exe)} enable=yes profile=any protocol=UDP >nul`,
      `netsh advfirewall firewall add rule name=${q(NAME)} dir=in action=allow program=${q(exe)} enable=yes profile=any protocol=TCP >nul`,
    ].join('\r\n'));
    if (launcher) launcher.webContents.send('firewall', 'asking');
    // one UAC prompt; the .cmd runs hidden and elevated
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c "${cmd.replace(/'/g, "''")}"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 5 }`], { windowsHide: true });
    ps.on('exit', code => {
      try { fs.writeFileSync(flag, JSON.stringify({ exe, ok: code === 0, at: Date.now() })); } catch (e) {}
      try { fs.unlinkSync(cmd); } catch (e) {}
      if (launcher) launcher.webContents.send('firewall', code === 0 ? 'ok' : 'declined');
    });
  });
}

// ---------- windows ----------
let launcher = null, game = null, quitting = false, gameReady = false, toGame = [];
function createLauncher() {
  launcher = new BrowserWindow({
    width: 1120, height: 660, minWidth: 900, minHeight: 560, frame: false, backgroundColor: '#07040d', show: false,
    title: 'BKS', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  launcher.on('close', e => { if (quitting) return; e.preventDefault(); quitting = true; launcher.webContents.send('quitting'); setTimeout(() => { if (launcher) launcher.destroy(); }, 2500); });
  launcher.once('ready-to-show', () => { launcher.show(); if (BOOT.markOk) BOOT.markOk(); });   // tell the loader this version starts fine
  launcher.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  launcher.on('closed', () => { launcher = null; if (!game) app.quit(); });
  launcher.loadURL('app://launcher/index.html');
}
function createGame() {
  if (game) { game.focus(); return; }
  game = new BrowserWindow({
    width: 1280, height: 720, useContentSize: true, minWidth: 640, minHeight: 360, backgroundColor: '#07040d',
    title: 'B.S.A.S', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, 'game_preload.js') },
  });
  gameReady = false;
  game.setMenuBarVisibility(false);
  game.webContents.on('did-finish-load', () => game.webContents.insertCSS(GAME_CSS));
  game.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.alt && input.key === 'Enter')) { game.setFullScreen(!game.isFullScreen()); e.preventDefault(); }
  });
  game.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  game.on('closed', () => { game = null; gameReady = false; toGame = []; if (launcher && !quitting) { launcher.show(); launcher.webContents.send('game', { running: false }); } else if (!launcher) app.quit(); });
  game.loadURL('app://game/index.html');
  if (launcher) { launcher.hide(); launcher.webContents.send('game', { running: true }); }
}

// ---------- the launcher updates itself ----------
// release.json lists the launcher's own code under launcher.core. A newer version is downloaded into app data
// (every file checked against its SHA-256) and the loader starts it next time; the copy inside the install stays as
// the fallback if a new version ever fails to start.
let coreBusy = null;
function coreUpdate(rel) {
  const C = rel.launcher && rel.launcher.core;
  if (!C || !(C.version > LAUNCHER_VERSION) || coreBusy) return coreBusy || Promise.resolve();
  const base = path.join(app.getPath('userData'), 'core'), dir = path.join(base, 'v' + C.version), cur = readJSON(path.join(base, 'current.json'));
  if (cur && cur.version >= C.version && fs.existsSync(path.join(cur.dir || '', 'main.js'))) return Promise.resolve();
  coreBusy = (async () => {
    const tmp = dir + '.part'; await fsp.rm(tmp, { recursive: true, force: true }); await fsp.mkdir(tmp, { recursive: true });
    for (const [p, f] of Object.entries(C.files || {})) {
      if (!safe(p)) throw new Error('bad path ' + p);
      const r = await net.fetch(RAW + 'launcher/' + p.split('/').map(encodeURIComponent).join('/') + '?v=' + f.sha.slice(0, 12), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== f.size || sha256(buf) !== f.sha) throw new Error('bad file ' + p);
      await fsp.mkdir(path.dirname(path.join(tmp, p)), { recursive: true }); await fsp.writeFile(path.join(tmp, p), buf);
    }
    await fsp.rm(dir, { recursive: true, force: true }); await fsp.rename(tmp, dir);
    await fsp.writeFile(path.join(base, 'current.json'), JSON.stringify({ version: C.version, dir }));
    if (launcher && !launcher.isDestroyed()) launcher.webContents.send('launcher-updated', { version: C.version });
    // apply it right away: if nobody is playing, BKS restarts itself into the new version (a game in progress is never interrupted;
    // then it simply starts next time)
    if (!game) setTimeout(() => { if (!game && !updating) { quitting = true; app.relaunch(); app.exit(0); } }, 1500);
  })().finally(() => { coreBusy = null; });
  return coreBusy;
}

// ---------- launcher page API ----------
ipcMain.handle('info', () => ({ launcher: LAUNCHER_VERSION, launcherFrom: BOOT.core, installed: (readJSON(INSTALLED) || {}).version || '0', cloud: process.env.BSAS_CLOUD ? JSON.parse(process.env.BSAS_CLOUD) : null }));
ipcMain.handle('check', async () => {
  const rel = await fetchRelease();
  const { changed, bytes } = plan(rel);
  const needLauncher = rel.launcher && rel.launcher.min > BOOT.runtime;   // only a new Electron runtime needs a manual download
  coreUpdate(rel).catch(e => console.error('launcher update', e));
  return { version: rel.version, notes: rel.notes || [], news: rel.news || null, files: changed.length, bytes, needLauncher, launcherUrl: rel.launcher && rel.launcher.url };
});
ipcMain.handle('update', async e => {
  if (updating) return updating;
  updating = fetchRelease().then(rel => update(BrowserWindow.fromWebContents(e.sender), rel)).finally(() => { updating = null; });
  return updating;
});
ipcMain.handle('play', () => { createGame(); });
// repair: hash every installed file again; anything damaged or missing is dropped from the record so the next update re-downloads it
ipcMain.handle('verify', async () => {
  const inst = readJSON(INSTALLED) || { files: {} }; let bad = 0;
  for (const [p, f] of Object.entries(inst.files || {})) {
    if (!safe(p)) continue;
    let ok = false; try { const buf = await fsp.readFile(path.join(GAME, p)); ok = buf.length === f.size && sha256(buf) === f.sha; } catch (e) {}
    if (!ok) { delete inst.files[p]; bad++; }
  }
  await fsp.writeFile(INSTALLED, JSON.stringify(inst)); return { bad };
});
ipcMain.handle('folder', () => shell.openPath(GAME));
// launcher <-> game messages (friends, invites, connection codes). Messages that need the game start it.
ipcMain.on('l2g', (e, msg) => {
  if (!msg) return;
  if (!game && msg.start) createGame();
  if (!game) return;
  if (gameReady) game.webContents.send('l2g', msg); else toGame.push(msg);
  if (msg.focus) { if (game.isMinimized()) game.restore(); game.focus(); }
});
ipcMain.on('g2l', (e, msg) => {
  if (msg && msg.type === 'ready') { gameReady = true; for (const m of toGame.splice(0)) game.webContents.send('l2g', m); }
  if (launcher) launcher.webContents.send('g2l', msg);
});
ipcMain.on('quit-ok', () => { if (launcher) launcher.destroy(); });
ipcMain.on('attention', () => { const w = game || launcher; if (w && !w.isFocused()) w.flashFrame(true); });
ipcMain.handle('open', (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('win', (e, a) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; if (a === 'min') w.minimize(); else if (a === 'close') w.close(); });

app.on('second-instance', () => { const w = game || launcher; if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('com.blacksouls.allstar');
  GAME = path.join(app.getPath('userData'), 'game'); INSTALLED = path.join(app.getPath('userData'), 'installed.json');
  protocol.handle('app', req => {
    const u = new URL(req.url), root = u.hostname === 'launcher' ? UI : u.hostname === 'game' ? GAME : null;
    if (!root) return new Response('no', { status: 404 });
    const file = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (!file.startsWith(root)) return new Response('no', { status: 403 });
    // never serve an old copy: an updated game must always run its own new files
    return net.fetch(pathToFileURL(file).toString()).then(r => new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || '', 'cache-control': 'no-store' } }));
  });
  await session.defaultSession.clearCache().catch(() => {});
  try { await firstRun(); } catch (e) { console.error(e); }
  createLauncher();
  shortcuts();
  // no firewall prompt at launch any more: online play goes out through normal connections, and if Windows ever
  // wants to ask, it shows its own one-time "Allow access" box instead of an admin command window
});
app.on('window-all-closed', () => app.quit());
