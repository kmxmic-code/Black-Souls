/* Black Souls All Star — online accounts, friends and invites over Firebase's REST API.
   Accounts are username + password (Firebase Email/Password under the hood). The Realtime
   Database holds: users/<uid> {name} · usernames/<name> uid · status/<uid> {act,last} ·
   friends/<uid>/<friend> true · requests/<to>/<from> {name,at} · invites/<to>/<from> {name,code,at} ·
   answers/<to>/<from> {code|declined,at}. Live data arrives through the database's event streams. */
'use strict';
const CLOUD_CFG = {
  apiKey: 'AIzaSyAXOYQv3dIu7qLZyDIKA1Lwf4UiCeA2670',
  databaseURL: 'https://bsas-5f5f4-default-rtdb.europe-west1.firebasedatabase.app',
  emailDomain: 'players.bsas-5f5f4.firebaseapp.com',
  authBase: 'https://identitytoolkit.googleapis.com/v1/',
  tokenBase: 'https://securetoken.googleapis.com/v1/token',
};
const ONLINE_MS = 100000;        // seen within this long = online (heartbeat every 40 s)
const INVITE_MS = 180000;        // invites older than this are stale

class Cloud {
  constructor(over) {
    this.cfg = Object.assign({}, CLOUD_CFG, over || {});
    this.user = null;            // { uid, name }
    this.tok = null; this.refresh = null; this.tokAt = 0;
    this.streams = {}; this.data = { friends: {}, requests: {}, invites: {}, answers: {}, status: {}, names: {} };
    this.listeners = new Set(); this.offset = 0; this.act = 'In launcher';
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, extra) { for (const fn of this.listeners) { try { fn(kind, extra); } catch (e) { console.error(e); } } }
  now() { return Date.now() + this.offset; }

  // ---------- accounts ----------
  static cleanName(n) { return String(n || '').trim().toLowerCase(); }
  static nameError(n) { return /^[a-z0-9_]{3,16}$/.test(n) ? '' : 'Username: 3–16 letters, numbers or _'; }
  async authCall(op, body) {
    const r = await fetch(this.cfg.authBase + 'accounts:' + op + '?key=' + this.cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ returnSecureToken: true }, body)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const code = (j.error && j.error.message || 'ERROR').split(' ')[0]; throw Object.assign(new Error(code), { code }); }
    return j;
  }
  friendlyAuthError(code) {
    return ({ EMAIL_EXISTS: 'That username is taken.', INVALID_LOGIN_CREDENTIALS: 'Wrong username or password.', INVALID_PASSWORD: 'Wrong username or password.', EMAIL_NOT_FOUND: 'Wrong username or password.',
      WEAK_PASSWORD: 'Password needs at least 6 characters.', TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many tries. Wait a minute.', OPERATION_NOT_ALLOWED: 'Sign-in is switched off on the server (enable Email/Password in Firebase).',
      USER_DISABLED: 'This account is disabled.' })[code] || 'Could not reach the server. Check your internet.';
  }
  async signUp(name, pass) {
    name = Cloud.cleanName(name); const bad = Cloud.nameError(name); if (bad) throw new Error(bad);
    if (String(pass).length < 6) throw new Error('Password needs at least 6 characters.');
    let j; try { j = await this.authCall('signUp', { email: name + '@' + this.cfg.emailDomain, password: pass }); } catch (e) { throw new Error(this.friendlyAuthError(e.code)); }
    this.setTokens(j.idToken, j.refreshToken, j.expiresIn); this.user = { uid: j.localId, name };
    try { await this.patch('', { ['users/' + j.localId]: { name, created: { '.sv': 'timestamp' } }, ['usernames/' + name]: j.localId }); }
    catch (e) { this.save(); await this.start(); this.emit('denied', 'usernames'); return this.user; }   // the name is saved again on the next start once the rules allow it
    this.save(); await this.start(); return this.user;
  }
  async signIn(name, pass) {
    name = Cloud.cleanName(name); if (Cloud.nameError(name)) throw new Error('Wrong username or password.');
    let j; try { j = await this.authCall('signInWithPassword', { email: name + '@' + this.cfg.emailDomain, password: pass }); } catch (e) { throw new Error(this.friendlyAuthError(e.code)); }
    this.setTokens(j.idToken, j.refreshToken, j.expiresIn); this.user = { uid: j.localId, name };
    this.save(); await this.repairName(); await this.start(); return this.user;
  }
  async resume() {
    let s; try { s = JSON.parse(localStorage.getItem('bsasCloud') || 'null'); } catch (e) { s = null; }
    if (!s || !s.refresh) return null;
    this.refresh = s.refresh; this.user = { uid: s.uid, name: s.name };
    try { await this.refreshToken(); } catch (e) { if (e.fatal) { this.forget(); return null; } throw e; }
    await this.repairName(); await this.start(); return this.user;
  }
  // accounts made before the server rules were published may be missing their name: put it back
  async repairName() {
    try { if ((await this.get('usernames/' + this.user.name)) !== this.user.uid) await this.patch('', { ['users/' + this.user.uid]: { name: this.user.name, created: { '.sv': 'timestamp' } }, ['usernames/' + this.user.name]: this.user.uid }); }
    catch (e) { if (e.status === 401) this.emit('denied', 'usernames'); }
  }
  save() { try { localStorage.setItem('bsasCloud', JSON.stringify({ refresh: this.refresh, uid: this.user.uid, name: this.user.name })); } catch (e) {} }
  forget() { try { localStorage.removeItem('bsasCloud'); } catch (e) {} this.user = null; this.tok = null; this.refresh = null; }
  async signOut() {
    try { await this.goOffline(); } catch (e) {}
    this.stop(); this.forget(); this.emit('auth');
  }
  setTokens(id, ref, exp) { this.tok = id; if (ref) this.refresh = ref; this.tokAt = Date.now(); this.tokLife = (+exp || 3600) * 1000; }
  async refreshToken() {
    const r = await fetch(this.cfg.tokenBase + '?key=' + this.cfg.apiKey, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(this.refresh) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error('refresh'); err.fatal = r.status === 400; throw err; }
    this.setTokens(j.id_token, j.refresh_token, j.expires_in); this.save();
  }
  async token() { if (!this.tok || Date.now() - this.tokAt > this.tokLife - 300000) await this.refreshToken(); return this.tok; }

  // ---------- database ----------
  url(path, tok) { return this.cfg.databaseURL.replace(/\/$/, '') + '/' + path.replace(/^\//, '') + '.json?auth=' + encodeURIComponent(tok); }
  async req(method, path, body) {
    const r = await fetch(this.url(path, await this.token()), { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error((j && j.error) || 'HTTP ' + r.status), { status: r.status });
    return j;
  }
  get(p) { return this.req('GET', p); }
  put(p, v) { return this.req('PUT', p, v); }
  patch(p, v) { return this.req('PATCH', p, v); }
  del(p) { return this.req('DELETE', p); }
  // a live mirror of one path; calls back with the whole value whenever it changes
  stream(key, path, cb) {
    this.unstream(key);
    const st = { path, cb, value: null, es: null, dead: false, retry: 1000 };
    this.streams[key] = st;
    const open = async () => {
      if (st.dead) return;
      let tok; try { tok = await this.token(); } catch (e) { setTimeout(open, st.retry = Math.min(30000, st.retry * 2)); return; }
      if (st.dead) return;
      const es = new EventSource(this.url(path, tok)); st.es = es;
      const apply = (kind, e) => {
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (!m) return; st.retry = 1000;
        const segs = m.path.split('/').filter(Boolean);
        if (!segs.length) st.value = kind === 'put' ? m.data : Object.assign({}, st.value || {}, m.data);
        else {
          st.value = st.value && typeof st.value === 'object' ? JSON.parse(JSON.stringify(st.value)) : {};
          let o = st.value; for (let i = 0; i < segs.length - 1; i++) { if (!o[segs[i]] || typeof o[segs[i]] !== 'object') o[segs[i]] = {}; o = o[segs[i]]; }
          const k = segs[segs.length - 1];
          if (kind === 'put') { if (m.data === null) delete o[k]; else o[k] = m.data; }
          else o[k] = Object.assign({}, o[k] || {}, m.data);
        }
        cb(st.value);
      };
      es.addEventListener('put', e => apply('put', e)); es.addEventListener('patch', e => apply('patch', e));
      es.addEventListener('auth_revoked', () => { es.close(); this.tokAt = 0; open(); });
      es.addEventListener('cancel', () => { es.close(); cb(null); this.emit('denied', path); });
      es.onerror = () => { if (es.readyState === 2 && !st.dead) { this.get(path).catch(e => { if (e.status === 401) this.emit('denied', path); }); setTimeout(open, st.retry = Math.min(30000, st.retry * 2)); } };
    };
    open();
  }
  unstream(key) { const st = this.streams[key]; if (st) { st.dead = true; if (st.es) st.es.close(); delete this.streams[key]; } }

  // ---------- live session ----------
  async start() {
    this.stop();
    const me = this.user.uid;
    try { await this.heartbeat(); } catch (e) { if (e.status === 401) this.emit('denied', 'status'); }
    // Chrome allows only 6 open connections to one server, so only the time-critical invites stay live;
    // friends, requests and who is online are checked every few seconds instead (a stuck heartbeat made everyone look offline)
    this.stream('invites', 'invites/' + me, v => { this.data.invites = v || {}; this.emit('invites'); });
    this.stream('answers', 'answers/' + me, v => { this.data.answers = v || {}; this.emit('answers'); });
    this.hb = setInterval(() => this.heartbeat().catch(() => {}), 40000);
    this.poll(); this.pollT = setInterval(() => this.poll(), 12000);
    this.tick = setInterval(() => this.emit('tick'), 15000);   // online/offline can change just by time passing
    this.emit('auth');
  }
  stop() { for (const k of Object.keys(this.streams)) this.unstream(k); clearInterval(this.hb); clearInterval(this.tick); clearInterval(this.pollT); this.data = { friends: {}, requests: {}, invites: {}, answers: {}, status: {}, names: {} }; }
  async heartbeat() {
    if (!this.user) return;
    await this.put('status/' + this.user.uid, { act: this.act, last: { '.sv': 'timestamp' } });
    const s = await this.get('status/' + this.user.uid).catch(() => null);
    if (s && s.last) this.offset = s.last - Date.now();
  }
  setActivity(act) { if (act === this.act) return; this.act = act; if (this.user) this.heartbeat().catch(() => {}); this.emit('friends'); }
  async goOffline() { if (this.user && this.tok) await this.put('status/' + this.user.uid, { act: 'Offline', last: 0 }); }
  // friends, requests and everyone's online status, one short request at a time
  async poll() {
    if (!this.user || this.polling) return; this.polling = true;
    const me = this.user.uid;
    try {
      const [fr, rq] = await Promise.all([this.get('friends/' + me).catch(e => { if (e.status === 401) this.emit('denied', 'friends'); return this.data.friends; }), this.get('requests/' + me).catch(() => this.data.requests)]);
      const frs = fr || {}, ch = JSON.stringify(frs) !== JSON.stringify(this.data.friends), rch = JSON.stringify(rq || {}) !== JSON.stringify(this.data.requests);
      this.data.friends = frs; this.data.requests = rq || {};
      for (const f of Object.keys(this.data.status)) if (!frs[f]) delete this.data.status[f];
      await Promise.all(Object.keys(frs).map(async f => {
        this.data.status[f] = await this.get('status/' + f).catch(() => this.data.status[f]);
        if (!this.data.names[f]) this.data.names[f] = (await this.get('users/' + f + '/name').catch(() => null)) || 'player';
      }));
      if (rch) this.emit('requests');
      this.emit('friends'); void ch;
    } finally { this.polling = false; }
  }
  friendList() {
    const now = this.now();
    return Object.keys(this.data.friends).map(uid => {
      const s = this.data.status[uid], online = !!(s && s.last && now - s.last < ONLINE_MS && s.act !== 'Offline');
      return { uid, name: this.data.names[uid] || '…', online, act: online ? s.act || 'Online' : 'Offline' };
    }).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  }
  requestList() { return Object.entries(this.data.requests || {}).map(([uid, r]) => ({ uid, name: (r && r.name) || 'player' })); }
  inviteList() { const now = this.now(); return Object.entries(this.data.invites || {}).filter(([, v]) => v && v.at && now - v.at < INVITE_MS).map(([uid, v]) => ({ uid, name: v.name || 'player', code: v.code, at: v.at })); }

  // ---------- friends ----------
  async addFriend(name) {
    name = Cloud.cleanName(name);
    if (name === this.user.name) throw new Error('That is you!');
    const uid = await this.get('usernames/' + name);
    if (!uid) throw new Error('No player called "' + name + '".');
    if (this.data.friends[uid]) throw new Error('You are already friends.');
    if (this.data.requests[uid]) { await this.acceptFriend(uid); return 'accepted'; }   // they already asked you
    await this.put('requests/' + uid + '/' + this.user.uid, { name: this.user.name, at: { '.sv': 'timestamp' } });
    return 'sent';
  }
  async acceptFriend(uid) {
    const me = this.user.uid;
    await this.patch('', { ['friends/' + me + '/' + uid]: true, ['friends/' + uid + '/' + me]: true, ['requests/' + me + '/' + uid]: null });
    this.poll();
  }
  declineFriend(uid) { return this.del('requests/' + this.user.uid + '/' + uid).then(() => this.poll()); }
  async removeFriend(uid) { const me = this.user.uid; await this.del('friends/' + me + '/' + uid); await this.del('friends/' + uid + '/' + me).catch(() => {}); this.poll(); }

  // ---------- invites (the P2P connection codes travel through here) ----------
  sendInvite(to, code) { return this.put('invites/' + to + '/' + this.user.uid, { name: this.user.name, code, at: { '.sv': 'timestamp' } }); }
  cancelInvite(to) { return this.del('invites/' + to + '/' + this.user.uid).catch(() => {}); }
  async answerInvite(from, code) { await this.put('answers/' + from + '/' + this.user.uid, { code, at: { '.sv': 'timestamp' } }); await this.del('invites/' + this.user.uid + '/' + from).catch(() => {}); }
  async declineInvite(from) { await this.put('answers/' + from + '/' + this.user.uid, { declined: true, at: { '.sv': 'timestamp' } }).catch(() => {}); await this.del('invites/' + this.user.uid + '/' + from).catch(() => {}); }
  clearAnswer(from) { return this.del('answers/' + this.user.uid + '/' + from).catch(() => {}); }
}
Cloud.RULES = 'The friends server is blocking this: publish the Firebase rules (Realtime Database → Rules).';
window.Cloud = Cloud;
