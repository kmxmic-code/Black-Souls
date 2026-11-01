/* Launcher friends panel: sign in, friends with live status, requests, invites.
   Invites carry the P2P connection codes the game makes; the launcher just passes them along. */
'use strict';
(async function () {
  const L = window.launcher, $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const info = await L.info();
  const cloud = new Cloud(info.cloud);
  const box = $('social');
  let mode = 'signin', err = '', busy = false, note = '', running = false, pendingTo = {}, seenInvite = {}, seenAnswer = {};
  window.bsasCloud = cloud;

  // ---------- render ----------
  function render() {
    const u = cloud.user;
    if (!u) {
      box.innerHTML = `<h2>FRIENDS</h2>
        <div class="tabs"><button type="button" data-m="signin" class="${mode === 'signin' ? 'on' : ''}">SIGN IN</button><button type="button" data-m="signup" class="${mode === 'signup' ? 'on' : ''}">CREATE ACCOUNT</button></div>
        <form id="authf" class="authf" autocomplete="off">
          <input id="un" maxlength="16" placeholder="Username" spellcheck="false" ${busy ? 'disabled' : ''}>
          <input id="pw" type="password" maxlength="64" placeholder="Password${mode === 'signup' ? ' (6+ characters)' : ''}" ${busy ? 'disabled' : ''}>
          <button type="submit" class="go" ${busy ? 'disabled' : ''}>${busy ? 'PLEASE WAIT…' : mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'}</button>
        </form>
        ${err ? `<p class="err">${esc(err)}</p>` : ''}
        <p class="hint">${mode === 'signup' ? 'Pick a username your friends will search for. Write your password down — it cannot be reset.' : 'Sign in to add friends and invite them straight into a match.'}</p>`;
      box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; err = ''; render(); });
      $('authf').onsubmit = async e => {
        e.preventDefault(); const n = $('un').value, p = $('pw').value; busy = true; err = ''; render();
        try { if (mode === 'signup') await cloud.signUp(n, p); else await cloud.signIn(n, p); }
        catch (ex) { err = ex.message; }
        busy = false; render();
      };
      return;
    }
    const inv = cloud.inviteList(), req = cloud.requestList(), fr = cloud.friendList(), on = fr.filter(f => f.online).length;
    box.innerHTML = `<h2>FRIENDS <small>${on} ONLINE · <button type="button" class="link" id="out">SIGN OUT</button></small></h2>
      <div class="me"><span class="dot on"></span><b>${esc(u.name)}</b><span>${esc(cloud.act)}</span></div>
      ${inv.map(i => `<div class="inv"><b>${esc(i.name)}</b> invites you to fight!<div class="row"><button type="button" class="go" data-acc="${i.uid}">ACCEPT</button><button type="button" data-dec="${i.uid}">DECLINE</button></div></div>`).join('')}
      <form id="addf" class="addf" autocomplete="off"><input id="addn" maxlength="16" placeholder="Add a friend by username" spellcheck="false"><button type="submit">ADD</button></form>
      ${note ? `<p class="${/^✓/.test(note) ? 'ok' : 'err'}">${esc(note)}</p>` : ''}
      ${req.length ? `<div class="sec">FRIEND REQUESTS</div>` + req.map(r => `<div class="fr"><span class="dot"></span><b>${esc(r.name)}</b><span class="sp"></span><button type="button" class="go sm" data-fa="${r.uid}">ACCEPT</button><button type="button" class="sm" data-fd="${r.uid}">✕</button></div>`).join('') : ''}
      <div class="list">${fr.length ? fr.map(f => {
        const can = f.online && !/match|lobby/i.test(f.act), wait = pendingTo[f.uid];
        return `<div class="fr ${f.online ? '' : 'off'}"><span class="dot ${f.online ? 'on' : ''}"></span><b>${esc(f.name)}</b><span class="act">${esc(f.act)}</span><span class="sp"></span>
          ${wait ? `<button type="button" class="sm" data-cx="${f.uid}">CANCEL</button>` : `<button type="button" class="go sm" data-iv="${f.uid}" ${can ? '' : 'disabled'}>INVITE</button>`}</div>`;
      }).join('') : '<p class="hint">No friends yet. Add one by their username above.</p>'}</div>`;
    $('out').onclick = () => cloud.signOut();
    $('addf').onsubmit = async e => {
      e.preventDefault(); const n = $('addn').value.trim(); if (!n) return;
      try { const r = await cloud.addFriend(n); note = r === 'accepted' ? '✓ You are now friends with ' + Cloud.cleanName(n) + '.' : '✓ Request sent to ' + Cloud.cleanName(n) + '. They need to accept it.'; }
      catch (ex) { note = ex.status === 401 ? Cloud.RULES : ex.status ? 'The server refused that. Try again in a moment.' : ex.message; }
      render(); setTimeout(() => { note = ''; render(); }, 6000);
    };
    box.querySelectorAll('[data-fa]').forEach(b => b.onclick = () => cloud.acceptFriend(b.dataset.fa).catch(() => { note = 'Could not accept. Try again.'; render(); }));
    box.querySelectorAll('[data-fd]').forEach(b => b.onclick = () => cloud.declineFriend(b.dataset.fd).catch(() => {}));
    box.querySelectorAll('[data-iv]').forEach(b => b.onclick = () => invite(b.dataset.iv));
    box.querySelectorAll('[data-cx]').forEach(b => b.onclick = () => cancel(b.dataset.cx));
    box.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => accept(b.dataset.acc));
    box.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => decline(b.dataset.dec));
  }

  // ---------- invites ----------
  const nameOf = uid => (cloud.friendList().find(f => f.uid === uid) || {}).name || 'friend';
  function invite(to) { pendingTo[to] = Date.now(); render(); L.toGame({ type: 'host', to, name: nameOf(to), start: true, focus: true }); }
  function cancel(to) { delete pendingTo[to]; cloud.cancelInvite(to); L.toGame({ type: 'cancel', to }); render(); }
  function accept(from) {
    const i = cloud.inviteList().find(x => x.uid === from); if (!i) return;
    L.toGame({ type: 'join', from, name: i.name, code: i.code, start: true, focus: true });
  }
  function decline(from) { cloud.declineInvite(from); }
  function pushSocial() {
    L.toGame({ type: 'social', signedIn: !!cloud.user, me: cloud.user ? cloud.user.name : null,
      friends: cloud.user ? cloud.friendList() : [], invites: cloud.user ? cloud.inviteList().map(i => ({ uid: i.uid, name: i.name })) : [], pending: Object.keys(pendingTo) });
  }
  cloud.on(kind => {
    if (kind === 'denied') { note = Cloud.RULES; render(); return; }
    if (kind === 'invites') {
      for (const i of cloud.inviteList()) if (seenInvite[i.uid] !== i.at) { seenInvite[i.uid] = i.at; L.attention(); if (!running) beep(); }
    }
    if (kind === 'answers') {
      for (const [from, a] of Object.entries(cloud.data.answers || {})) {
        if (!a || seenAnswer[from] === a.at) continue; seenAnswer[from] = a.at;
        if (cloud.now() - (a.at || 0) > 180000) { cloud.clearAnswer(from); continue; }
        if (a.declined) L.toGame({ type: 'declined', from, name: nameOf(from) });
        else if (a.code) L.toGame({ type: 'answer', from, code: a.code });
        delete pendingTo[from]; cloud.clearAnswer(from);
      }
    }
    for (const [to, t] of Object.entries(pendingTo)) if (Date.now() - t > 180000) { delete pendingTo[to]; cloud.cancelInvite(to); }
    render(); pushSocial();
  });
  L.fromGame(m => {
    if (!m) return;
    if (m.type === 'ready') pushSocial();
    else if (m.type === 'activity') cloud.setActivity(m.act);
    else if (m.type === 'invite') invite(m.to);
    else if (m.type === 'offer') { pendingTo[m.to] = Date.now(); cloud.sendInvite(m.to, m.code).catch(() => L.toGame({ type: 'declined', from: m.to, name: nameOf(m.to), why: 'error' })); render(); }
    else if (m.type === 'cancel') { delete pendingTo[m.to]; cloud.cancelInvite(m.to); render(); }
    else if (m.type === 'accept') accept(m.from);
    else if (m.type === 'decline') decline(m.from);
    else if (m.type === 'answer') cloud.answerInvite(m.to, m.code).catch(() => {});
    else if (m.type === 'connected') { delete pendingTo[m.with]; cloud.cancelInvite(m.with); render(); }
  });
  L.onGame(g => { running = g.running; if (!running) cloud.setActivity('In launcher'); });
  L.onQuit(async () => { try { await Promise.race([cloud.goOffline(), new Promise(r => setTimeout(r, 1500))]); } catch (e) {} L.quitOk(); });

  // a short two-note chime for an incoming invite
  function beep() { try { const a = new AudioContext(), t = a.currentTime; [660, 990].forEach((f, k) => { const o = a.createOscillator(), g = a.createGain(); o.type = 'square'; o.frequency.value = f; g.gain.setValueAtTime(0.06, t + k * 0.12); g.gain.exponentialRampToValueAtTime(0.001, t + k * 0.12 + 0.11); o.connect(g).connect(a.destination); o.start(t + k * 0.12); o.stop(t + k * 0.12 + 0.12); }); setTimeout(() => a.close(), 600); } catch (e) {} }

  render();
  const tryResume = async () => { try { await cloud.resume(); note = ''; } catch (e) { note = 'Offline — retrying the friends server…'; setTimeout(tryResume, 15000); } render(); };
  tryResume();
})();
