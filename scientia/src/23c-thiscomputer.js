/* ==========================================================================
   23c · This computer and the lab. One button on the lab site — "Open on
   my computer" — opens this app running here (from the notebook folder),
   in a new tab, always in step with the lab cloud.
   • The installed app's server starts at login and keeps this computer and
     the lab cloud in step all the time (labsync.py), so after a restart
     the button just opens the tab.
   • Installed but not running: the button starts it (scientia://start).
   • The first time: the site walks you through it — download, install, and
     connect this computer to your account. The site hands this computer a
     one-time code; nothing is connected until you confirm here (#/connect).
   • Settings → The lab: the state of the sync, Sync now, Disconnect, and
     Remove from this computer.
   ========================================================================== */
const THISPC = {
  PORT: 8766,
  local: () => 'http://localhost:' + THISPC.PORT,
  onSite() { try { return /(^|\.)mcgheelab\.com$/.test(location.hostname) || !!localStorage.getItem('sis:siteDev'); } catch (e) { return false; } },
  isLocalApp: () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname),
  DL: { win: '/rm/scientia/desktop/ScientiaInSitu-Windows.zip' },
  installed(v) {
    try { if (v === undefined) return localStorage.getItem('sis:pcInstalled') === '1'; localStorage.setItem('sis:pcInstalled', v ? '1' : ''); } catch (e) {}
    return false;
  },
  /** is the app running on this computer? (its server answers the lab site's pages only) */
  async ping(ms = 1500) {
    try {
      const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
      const r = await fetch(THISPC.local() + '/api/lab/ping', { signal: c.signal, cache: 'no-store' }); clearTimeout(t);
      const j = await r.json(); return j && j.app === 'scientia-in-situ' ? j : null;
    } catch (e) { return null; }
  },
  /** a one-time code from the lab cloud (signed in here), handed to the app on this computer */
  async offer() {
    const j = await (await fetch('api/cloud/pair/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'the lab cloud did not give a code');
    try { await fetch(THISPC.local() + '/api/lab/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: j.code, account: j.account }) }); } catch (e) {}
    return j;
  },
  /** the copy on this computer is older than the one this site offers: say so (it updates by running the installer again) */
  async checkUpdate(p) {
    try {
      if (!p || !p.version) return;
      const v = await (await fetch(THISPC.DL.win.replace(/[^/]+$/, 'version.json'), { cache: 'no-store' })).json();
      if (v && v.app && v.app !== p.version) toast('A newer Scientia is ready for this computer — Settings → The lab → Download the update', 7000);
    } catch (e) {}
  },
  target() { const hsh = location.hash || ''; return /^#\/(doc|project|theme|mat|read|litreviews|portfolio)\b/.test(hsh) ? hsh : ''; },
  waiting(tab, text) {
    try { tab.document.title = 'Scientia In Situ'; tab.document.body.style.cssText = 'font:16px system-ui,sans-serif;padding:48px;background:#16140f;color:#ddd'; tab.document.body.textContent = text; } catch (e) {}
  },

  /** the button */
  async open() {
    const want = THISPC.target(), tab = window.open('', '_blank');   // opened in the click, so no popup blocker
    if (tab) THISPC.waiting(tab, 'Opening Scientia on this computer…');
    let p = await THISPC.ping();
    if (p && p.connected) { THISPC.installed(true); THISPC.checkUpdate(p); if (tab) tab.location.href = THISPC.local() + '/scientia.html' + want; else location.href = THISPC.local() + '/scientia.html' + want; return; }
    if (!p && THISPC.installed()) {
      if (tab) { THISPC.waiting(tab, 'Starting Scientia on this computer…'); tab.location.href = 'scientia://start'; }
      for (let i = 0; i < 25 && !p; i++) { await new Promise(r => setTimeout(r, 1000)); p = await THISPC.ping(900); }
      if (p && p.connected) { if (tab) tab.location.href = THISPC.local() + '/scientia.html' + want; return; }
    }
    if (tab && !p) tab.close();
    THISPC.wizard(p, p ? tab : null);
  },

  /** first time on this computer: install, then connect */
  wizard(p0, tab0) {
    let tab = tab0, stop = false, code = null;
    const body = h('div.pc-wiz'), m = modal({ title: 'Scientia on this computer', body, wide: true, actions: [{ label: 'Close' }], onClose: () => { stop = true; } });
    const step = (n, title, ...rest) => h('div.pc-step', h('div.pc-n', n), h('div', h('b', title), ...rest));
    const draw = (stage, extra) => {
      body.replaceChildren(
        h('p.serif', { style: { marginTop: 0 } }, 'Scientia runs on your computer from a notebook folder, works without the internet, and stays in step with the lab cloud — so this site and your tablet see what you write there within a couple of seconds, and the other way round. Once it is set up, this button simply opens it.'),
        step(1, 'Download and install (once)',
          h('div.row', { style: { gap: '8px', margin: '6px 0' } }, h('a.btn.pri', { href: THISPC.DL.win, download: '' }, 'Download for Windows'), h('span.tiny.muted', 'Mac: coming soon')),
          h('div.tiny.muted', 'Open the zip and double-click "Install Scientia". If Windows says it protected your PC: More info → Run anyway. It installs for you only (no administrator), starts with Windows, and opens Scientia in a new tab.')),
        step(2, 'Allow this site to reach the app on your computer', h('div.tiny.muted', 'If your browser asks whether mcgheelab.com may reach devices on your network, choose Allow. ' + (stage === 'wait' ? 'Waiting for the app on this computer…' : stage === 'found' || stage === 'connect' || stage === 'done' ? 'Found it.' : ''))),
        step(3, 'Connect this computer to your account',
          stage === 'connect' ? h('div', h('div', 'In the Scientia tab that opened, confirm ', h('b', 'Connect'), '.'), code ? h('div.tiny.muted', 'If it asks for a code: ', h('b.mono', code)) : null)
            : stage === 'done' ? h('div', h('b', 'Connected.'), ' From now on, Open on my computer opens it — after a restart too.')
              : h('div.tiny.muted', 'Happens on its own once the app is installed.')),
        extra ? h('div.pc-err', extra) : null);
    };
    const run = async () => {
      let p = p0;
      draw(p ? 'found' : 'wait');
      while (!stop && !p) { await new Promise(r => setTimeout(r, 2000)); p = await THISPC.ping(); }
      if (stop) return;
      THISPC.installed(true);
      if (!p.connected) {
        try { code = (await THISPC.offer()).code; } catch (e) { draw('found', 'Could not get a code from the lab cloud: ' + e.message); return; }
        if (tab) tab.location.href = THISPC.local() + '/scientia.html#/connect'; else window.open(THISPC.local() + '/scientia.html#/connect', '_blank');
        draw('connect');
        while (!stop && !(p && p.connected)) { await new Promise(r => setTimeout(r, 2000)); p = await THISPC.ping(); }
        if (stop) return;
      } else if (tab) tab.location.href = THISPC.local() + '/scientia.html';
      draw('done');
    };
    run();
    return m;
  },

  /** the app on this computer: state of the sync, and what can be done about it */
  ask: msg => new Promise(res => modal({ title: 'Are you sure?', body: h('p', msg), actions: [{ label: 'Cancel', run: () => res(false) }, { label: 'Yes', pri: true, run: () => res(true) }], onClose: () => res(false) })),
  async status() { try { return await (await fetch('api/lab/status', { cache: 'no-store' })).json(); } catch (e) { return null; } },
  async post(path, body) { return (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json(); },
  STATES: { 'not-connected': 'Not connected to the lab', starting: 'Starting…', aligning: 'Connecting to the lab cloud…', syncing: 'In step with the lab cloud', realigning: 'Catching up…',
    offline: 'Offline — changes are kept here and sent when the connection is back', 'needs-choice': 'Waiting for you: which notes win', 'key-refused': 'The lab no longer accepts this computer — connect it again', error: 'Sync stopped' },
  panel(s, redraw) {
    if (!s) return h('div.tiny.muted', 'This copy of the app has no lab sync (an older server).');
    const who = s.account && (s.account.name || s.account.email), when = s.lastChange ? ' · last change ' + fmtWhen(s.lastChange) : '';
    const act = (label, run, cls) => h('button.btn.sm' + (cls || ''), { on: { click: async () => { await run(); redraw(); } } }, label);
    const code = h('input.inp.mono', { placeholder: 'XXXX-XXXX-XXXX', style: { width: '170px' } });
    const out = [h('div.pc-state.' + (s.state || ''), h('b', THISPC.STATES[s.state] || s.state), s.connected && who ? ' · ' + who : '', s.computer ? h('span.tiny.muted', ' · ' + s.computer) : null, h('span.tiny.muted', when))];
    if (!s.connected && s.offer) out.push(h('div.pc-offer', h('p', 'The lab site asks to connect this computer to ', h('b', (s.offer.account && (s.offer.account.name || s.offer.account.email)) || 'your account'), '. Its notes and this notebook folder will stay in step.'),
      act('Connect', async () => { const r = await THISPC.post('api/lab/connect'); if (!r.ok) toast(r.error || 'Could not connect'); else toast('Connected — syncing with the lab cloud'); }, '.pri')));
    if (!s.connected) out.push(h('div.row', { style: { gap: '6px', marginTop: '8px' } }, h('span.tiny.muted', 'Or type the code shown on the lab site:'), code,
      act('Connect', async () => { const r = await THISPC.post('api/lab/connect', { code: code.value }); toast(r.ok ? 'Connected' : (r.error || 'Could not connect')); })));
    if (s.state === 'needs-choice') out.push(h('div.pc-choice', h('p.tiny', s.choice || ''),
      act('Use the notes online (they replace this computer’s)', () => THISPC.post('api/lab/choose', { prefer: 'cloud' })),
      act('Use this computer’s notes (they replace the online ones)', () => THISPC.post('api/lab/choose', { prefer: 'local' })), h('div.tiny.muted', 'The replaced side keeps a copy first.')));
    if (s.state !== 'syncing' && s.state !== 'not-connected' && s.message) out.push(h('div.tiny.muted', s.message));
    if (s.update && s.update.available) out.push(h('div.pc-update', h('b', 'A newer Scientia is ready. '), 'Download it and run "Install Scientia" again — it replaces the app and keeps your notes, notebook folder and connection. ',
      h('a.btn.sm.pri', { href: s.update.download, target: '_blank', rel: 'noopener' }, 'Download the update')));
    if (s.connected) out.push(h('div.row', { style: { gap: '6px', marginTop: '8px' } },
      act('Sync now', () => THISPC.post('api/lab/sync-now')),
      act('Disconnect this computer', async () => { if (await THISPC.ask('Disconnect this computer from the lab cloud? Its notes stay in the notebook folder; the lab keeps its copy.')) await THISPC.post('api/lab/disconnect'); })));
    out.push(h('div.row', { style: { gap: '6px', marginTop: '8px' } }, act('Remove Scientia from this computer…', async () => {
      if (!(await THISPC.ask('Remove Scientia from this computer? It stops starting with Windows and disconnects from the lab cloud. Your notebook folder is kept, and the lab keeps its copy.'))) return;
      const r = await THISPC.post('api/lab/uninstall', { forget: true }); toast(r.ok ? 'Removing Scientia from this computer…' : (r.error || 'Could not remove it'));
    }, '.ghost')));
    return h('div.pc-panel', out);
  },
  settings() {
    if (THISPC.onSite()) return h('div', h('p.tiny.muted', 'Run Scientia on your computer from a notebook folder, in step with this site.'), h('button.btn.sm', { on: { click: () => THISPC.open() } }, 'Open on my computer'));
    if (!THISPC.isLocalApp()) return h('div.tiny.muted', 'Open the app on the computer itself to connect it to the lab.');
    const host = h('div', h('div.tiny.muted', 'Loading…')), redraw = async () => host.replaceChildren(THISPC.panel(await THISPC.status(), redraw));
    redraw(); return host;
  }
};

VIEWS.connect = {
  title: true,
  render() {
    App.setTitle('This computer and the lab', []);
    const host = h('div'), redraw = async () => { if (!host.isConnected && host._drawn) return; host._drawn = true; host.replaceChildren(THISPC.panel(await THISPC.status(), redraw)); };
    redraw(); const iv = setInterval(() => { if (!host.isConnected) return clearInterval(iv); redraw(); }, 2500);
    return h('div.page.pc-page', h('div.eyebrow', 'Settings'), h('h1.title', 'This computer and the lab'),
      h('p.stand', 'This notebook folder and the lab cloud stay in step on their own while the app runs here — and it runs from the moment you log in. What you write here reaches the lab site and your tablet within seconds, and theirs reaches you.'), host);
  }
};
TABOF.connect = 'settings';

{ // the button, on the lab site only
  const add = () => {
    if (!THISPC.onSite() || $('#pcbtn')) return;
    const anchor = $('#reloadbtn') || $('#themetoggle'); if (!anchor) return;
    anchor.before(h('button.btn.ghost.sm#pcbtn', { title: 'Open Scientia running on this computer, in step with the lab', on: { click: () => THISPC.open() } }, 'Open on my computer'));
  };
  document.addEventListener('DOMContentLoaded', add); setTimeout(add, 0); setTimeout(add, 1500);
}
