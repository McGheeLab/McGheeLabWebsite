/* ==========================================================================
   13zzk · Working together (V3.954, Gabe's SiS Shaping, Phase I — the app's
   side of presence and locks; the hub's side is the lab's, see
   CodeLog/ClaudesPlan/V3.954_scientia_presence_for_the_lab.md):
   • Who is here: a row of avatars in the header, left of the sync dot —
     filled while they work, grey after five minutes away — with the
     component they hold; click one to go there.
   • One person at a time in a component: the one writing in it (the caret
     in it, or a drag of it) holds it; everyone else sees it shaded in that
     person's colour and read-only, "Alex is editing", and can ask to take
     over. Leaving it frees it.
   • A heartbeat every 20 s carries where I am; the answer carries everyone
     else and the locks. The transport is the lab's (SIS_LAB.presence) or
     the hub routes behind the proxy (api/rm/presence, api/rm/lock);
     without either — no lab layer, no route yet, not paired — the module
     stays quiet and the app is as it was.
   ========================================================================== */
const PRESENCE = {
  T: null, off: false, me: null, acct: null, people: [], locks: {}, held: null, heldDoc: null, timer: null, row: null, relT: null, _in: 0, _asked: new Set(), AWAY: 5 * 60 * 1000, EVERY: 20000,
  /** The transport: the lab's, else the hub routes; null → quiet. */
  transport() { if (PRESENCE.off) return null; if (PRESENCE.T) return PRESENCE.T; const L = window.SIS_LAB; if (!L) return null; return (PRESENCE.T = L.presence || PRESENCE.viaHub()); },
  viaHub() {
    const gone = m => Object.assign(new Error(m), { gone: true });
    const call = async (path, body) => { const r = await fetch('api/rm/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 404 || r.status === 403 || r.status === 405) throw gone('no route'); let j = null; try { j = await r.json(); } catch (e) { throw gone('not json'); }
      if (!j) throw gone('empty'); if (j.ok === false) { if (j.by) return j; throw Object.assign(new Error(j.error || 'refused'), { gone: !!j.offline || /no such route|unknown|not found/i.test(j.error || '') }); } return j; };
    return { beat: p => call('presence', p), lock: (docId, blockId) => call('lock', { docId, blockId }), unlock: (docId, blockId) => call('lock', { docId, blockId, release: true }), ask: (docId, blockId, to) => call('lock', { docId, blockId, ask: to }) };
  },
  /** Another transport (the lab's, or a test's). */
  use(t) { PRESENCE.T = t || null; PRESENCE.off = false; PRESENCE.me = null; PRESENCE.start(); return PRESENCE.beat(); },
  quiet() { PRESENCE.off = true; PRESENCE.stop(); PRESENCE.people = []; PRESENCE.locks = {}; PRESENCE.render(); },
  /** Who I am: the transport says, else the web sign-in, else the paired account, else this device. */
  who() { if (PRESENCE.me) return PRESENCE.me; const T = PRESENCE.T; let m = T && typeof T.me === 'function' ? T.me() : null;
    if (!m && window.__sisCloud && __sisCloud.user) { const u = __sisCloud.user; m = { uid: u.uid, name: u.displayName || u.email || 'Me' }; }
    if (!m && PRESENCE.acct && (PRESENCE.acct.uid || PRESENCE.acct.email)) m = { uid: PRESENCE.acct.uid || PRESENCE.acct.email, name: PRESENCE.acct.name || PRESENCE.acct.email };
    if (!m) { let id = _ls.get('presence:id', null); if (!id) _ls.set('presence:id', id = uid('me')); m = { uid: id, name: 'Me' }; }
    m = Object.assign({}, m); m.hue = hashHue(m.uid); return (PRESENCE.me = m); },
  inputAt: () => Math.max((typeof HANDS !== 'undefined' && HANDS.userAt) || 0, PRESENCE._in || 0),
  docNow() { const pane = App.pane || (App.panes ? App.panes()[0] : null); return pane && pane.docId && M.doc(pane.docId) ? pane : null; },
  colour: p => `hsl(${p && p.hue != null ? p.hue : hashHue(p && p.uid)} 55% 45%)`,
  initials: n => String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?',
  nameOf(id) { const b = M.block(id); return b ? M.blockName(b) : 'a component'; },
  ago(iso) { const m = Math.round((Date.now() - +new Date(iso)) / 60000); return !isFinite(m) ? '' : m < 1 ? 'just now' : m < 60 ? m + ' min' : Math.round(m / 60) + ' h'; },

  /* ---------------- the heartbeat ---------------- */
  async beat() { const T = PRESENCE.transport(); if (!T || PRESENCE._beating) return; const pane = PRESENCE.docNow();
    if (!pane) { if (PRESENCE.people.length) { PRESENCE.people = []; PRESENCE.render(); } return; }
    const d = M.doc(pane.docId), me = PRESENCE.who(), held = PRESENCE.held && PRESENCE.heldDoc === d.id ? PRESENCE.held : null;
    const p = { docId: d.id, docTitle: d.title || '', projectId: d.projectId || null, uid: me.uid, name: me.name, hue: me.hue, blockId: held, blockName: held ? PRESENCE.nameOf(held) : null, away: Date.now() - PRESENCE.inputAt() > PRESENCE.AWAY, at: new Date().toISOString() };
    PRESENCE._beating = true; try { const j = await T.beat(p); PRESENCE.take(j, d.id); } catch (e) { if (e && e.gone) PRESENCE.quiet(); } finally { PRESENCE._beating = false; } },
  /** The answer: everyone else, and the locks. */
  take(j, docId) { const me = PRESENCE.who();
    PRESENCE.people = (j && Array.isArray(j.people) ? j.people : []).filter(p => p && p.uid && p.uid !== me.uid);
    const L = {}; Object.entries(j && j.locks || {}).forEach(([bid, l]) => { if (l && l.uid && l.uid !== me.uid) L[bid] = l; }); PRESENCE.locks = L;
    if (PRESENCE.held && L[PRESENCE.held]) {   // someone took the one I was in while I was away from it
      const id = PRESENCE.held, l = L[id]; PRESENCE.held = null; PRESENCE.heldDoc = null; const a = document.activeElement; if (a && a.closest && a.closest(`.box[data-id="${id}"]`)) a.blur();
      toast(`${l.name || 'Someone'} took over ${PRESENCE.nameOf(id)} — what you wrote is kept; the lab merges the two`, 5000); }
    (j && Array.isArray(j.asks) ? j.asks : []).forEach(a => { if (!a || !a.blockId) return; const k = a.blockId + ':' + (a.at || ''); if (PRESENCE._asked.has(k)) return; PRESENCE._asked.add(k); toast(`${a.from && a.from.name || 'Someone'} asks for ${PRESENCE.nameOf(a.blockId)} — leave it when you can`, 6000); });
    PRESENCE.render(); PRESENCE.paint(docId); },

  /* ---------------- holding a component ---------------- */
  /** I take one: the caret in it, or a drag of it. */
  hold(id) { const T = PRESENCE.transport(); if (!T || !id || PRESENCE.held === id) return; const b = M.block(id); if (!b || PRESENCE.locks[id]) return; clearTimeout(PRESENCE.relT);
    const prev = PRESENCE.held; PRESENCE.held = id; PRESENCE.heldDoc = b.docId; if (prev) PRESENCE.release(prev);
    Promise.resolve(T.lock ? T.lock(b.docId, id) : { ok: true }).then(r => {
      if (r && r.ok === false && r.by && r.by.uid !== PRESENCE.who().uid) { PRESENCE.locks[id] = r.by; if (PRESENCE.held === id) { PRESENCE.held = null; PRESENCE.heldDoc = null; } PRESENCE.paint(b.docId);
        const a = document.activeElement; if (a && a.closest && a.closest(`.box[data-id="${id}"]`)) a.blur(); toast(`${r.by.name || 'Someone'} is editing ${PRESENCE.nameOf(id)} — it is theirs until they leave it`); }
      else if (!T.lock) PRESENCE.beat(); }).catch(e => { if (e && e.gone) PRESENCE.quiet(); }); },
  /** I leave it — a moment after the caret goes, so a click within the box keeps it. */
  letGo(id) { clearTimeout(PRESENCE.relT); PRESENCE.relT = setTimeout(() => { if (PRESENCE.held !== id) return; const a = document.activeElement; if (a && a.closest && a.closest(`.box[data-id="${id}"]`)) return; PRESENCE.release(id); }, 1500); },
  release(id) { if (!id) return; const T = PRESENCE.T, b = M.block(id); if (PRESENCE.held === id) { PRESENCE.held = null; PRESENCE.heldDoc = null; } if (T && T.unlock && b) Promise.resolve(T.unlock(b.docId, id)).catch(() => { }); },
  askOver(b) { const l = PRESENCE.locks[b.id], T = PRESENCE.transport(); if (!l) return;
    if (T && T.ask) Promise.resolve(T.ask(b.docId, b.id, l.uid)).then(() => toast(`Asked ${l.name || 'them'} to hand over ${PRESENCE.nameOf(b.id)}`)).catch(() => toast('Could not reach them — try again in a moment'));
    else toast(`${l.name || 'Someone'} is editing ${PRESENCE.nameOf(b.id)} — it is theirs until they leave it`); },

  /* ---------------- what shows ---------------- */
  /** The header's row. */
  render() { const hd = $('#hd'); if (!hd) return; if (!PRESENCE.row) { PRESENCE.row = h('div.hd-people'); const at = $('.syncdot', hd) || $('#search', hd); at ? at.before(PRESENCE.row) : hd.append(PRESENCE.row); }
    const pane = PRESENCE.docNow(), docId = pane && pane.docId, here = p => !p.docId || p.docId === docId;
    const L = PRESENCE.people.slice().sort((a, b) => (a.away ? 1 : 0) - (b.away ? 1 : 0) || (here(a) ? 0 : 1) - (here(b) ? 0 : 1) || String(a.name || '').localeCompare(String(b.name || '')));
    PRESENCE.row.replaceChildren(...L.map(p => { const what = here(p) && p.blockId ? (p.blockName || PRESENCE.nameOf(p.blockId)) : null;
      const s = (p.name || 'Someone') + (p.away ? ' · away' + (p.at ? ' ' + PRESENCE.ago(p.at) : '') : what ? ' · editing ' + what : here(p) ? ' · in this note' : p.docTitle ? ' · in “' + p.docTitle + '”' : ' · on this project');
      return h('button.av' + (p.away ? '.away' : '') + (here(p) ? '' : '.elsewhere'), { type: 'button', title: s, 'aria-label': s, style: { '--pc': PRESENCE.colour(p) }, on: { click: e => { e.stopPropagation(); PRESENCE.menu(p, e, s); } } }, PRESENCE.initials(p.name)); }));
    PRESENCE.row.hidden = !L.length; },
  menu(p, e, s) { const pane = PRESENCE.docNow(), docId = pane && pane.docId, here = !p.docId || p.docId === docId;
    ctxMenu(e.clientX - 160, e.clientY + 10, [{ head: s }, here && p.blockId && M.block(p.blockId) ? { label: 'Go to what they are editing', run: () => pane.reveal(p.blockId) } : null,
      !here && p.docId && M.doc(p.docId) ? { label: 'Open their note', sub: p.docTitle || '', run: () => App.go('#/doc/' + p.docId) } : null].filter(Boolean)); },
  /** The boxes of the note: shaded and read-only while someone else holds them. */
  paint(docId) { const pane = PRESENCE.docNow(); if (!pane || pane.docId !== docId || !pane.paper) return; $$('.box.cmp', pane.paper.world).forEach(el => PRESENCE.deco(el, M.block(el.dataset.id), pane)); },
  deco(el, b, pane) { if (!el || !b) return; const l = PRESENCE.locks[b.id], was = el.classList.contains('locked'); if (!l && !was) return;
    el.classList.toggle('locked', !!l); const ed = $(':scope > .ed', el), labs = $$(':scope > .bh input.blab', el);
    if (l) { el.style.setProperty('--pc', PRESENCE.colour(l)); let rib = $(':scope > .lockby', el);
      if (!rib) { rib = h('div.lockby', h('span.who'), h('button.btn.sm', { type: 'button', on: { click: e => { e.stopPropagation(); PRESENCE.askOver(b); } } }, 'Ask to take over')); el.append(rib); }
      $('.who', rib).textContent = `${l.name || 'Someone'} is editing`; rib.title = `${l.name || 'Someone'} holds this component — it is theirs until they leave it`; if (ed) ed.contentEditable = 'false'; labs.forEach(i => { i.readOnly = true; }); }
    else { $$(':scope > .lockby', el).forEach(x => x.remove()); el.style.removeProperty('--pc'); if (ed && !(pane && pane.travel)) ed.contentEditable = 'true'; labs.forEach(i => { i.readOnly = false; }); } },

  start() { if (PRESENCE.timer) return; PRESENCE.timer = setInterval(() => PRESENCE.beat(), PRESENCE.EVERY); },
  stop() { clearInterval(PRESENCE.timer); PRESENCE.timer = null; },
  async boot() { if (!window.SIS_LAB) return; if (window.SIS_DESKTOP) { try { const j = await (await fetch('api/lab/status', { cache: 'no-store' })).json(); PRESENCE.acct = j && j.account || null; } catch (e) { } } PRESENCE.start(); PRESENCE.beat(); },
};
{
  if (document.readyState === 'complete') setTimeout(() => PRESENCE.boot(), 1500); else addEventListener('load', () => setTimeout(() => PRESENCE.boot(), 1500));
  // a beat when the note changes and when the tab comes back; what I held goes with the page
  addEventListener('hashchange', () => { if (PRESENCE.held) PRESENCE.release(PRESENCE.held); setTimeout(() => { PRESENCE.render(); PRESENCE.beat(); }, 400); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) PRESENCE.beat(); });
  addEventListener('pagehide', () => { if (PRESENCE.held) PRESENCE.release(PRESENCE.held); });
  // the caret in a component, or a drag of it, takes it; a held one takes nothing
  document.addEventListener('focusin', e => { const box = e.target.closest && e.target.closest('.box.cmp'); if (!box) return; const id = box.dataset.id; if (PRESENCE.locks[id]) { e.target.blur(); return; } if (e.target.matches('.ed, .ed *, input.blab')) PRESENCE.hold(id); }, true);
  document.addEventListener('focusout', e => { const box = e.target.closest && e.target.closest('.box.cmp'); if (box && PRESENCE.held === box.dataset.id) PRESENCE.letGo(box.dataset.id); }, true);
  document.addEventListener('pointerdown', e => { const box = e.target.closest && e.target.closest('.box.cmp'); if (!box) return; const id = box.dataset.id, l = PRESENCE.locks[id];
    if (l) { if (e.target.closest('.lockby')) return; e.preventDefault(); e.stopPropagation(); toast(`${l.name || 'Someone'} is editing ${PRESENCE.nameOf(id)} — it is theirs until they leave it`); return; }
    if (e.target.closest('.bh') && !e.target.closest('button, input')) PRESENCE.hold(id); }, true);
  ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, e => { if (e.isTrusted) PRESENCE._in = Date.now(); }, true));
  // a box drawn while someone holds it comes shaded; a save into a held box is refused
  const bx = DocView.box; DocView.box = function (b, d, p) { const el = bx.apply(this, arguments); try { if (el && b && PRESENCE.locks[b.id]) PRESENCE.deco(el, b, this); } catch (e) { } return el; };
  const oc = ED.commit; ED.commit = function (el, b) { if (b && PRESENCE.locks[b.id]) { toast(`${PRESENCE.locks[b.id].name || 'Someone'} is editing ${PRESENCE.nameOf(b.id)} — your change was not saved`); return; } return oc.apply(this, arguments); };
  // the ▤ Note pill, once the lab layer takes registrations (plan §10; the def's shape is in the V3.954 note for the lab)
  setTimeout(() => { const L = window.SIS_LAB; if (!L || typeof L.registerPill !== 'function') return; try { L.registerPill({ name: 'note', icon: '▤', label: 'This note — references, Pull in, a collection, Flag, the Atlas', side: 'left', vert: 'up', dock: true, orient: 'v', at: (w, hh) => [36, hh - 38],
    items: pane => { const d = M.doc(pane.docId); if (!d) return []; const refs = []; M.liveBlocks(d.id).forEach(b => (b.body && b.body.marks || []).forEach(m => { if (m.type !== 'link') return; const t = IX.linkTarget(m); if (t && t.id && !refs.some(r => r.id === t.id)) refs.push(t); }));
      const col = INSERTS.find(x => x.id === 'rmcollection'), flagged = M.flagFor('doc', d.id);
      return [{ icon: '▤', label: refs.length ? `Note references — ${refs.length} this note links to` : 'Note references — none yet', run: () => refs.length ? ctxMenu(innerWidth / 2 - 160, innerHeight / 2 - 100, refs.map(r => ({ label: r.title || 'Untitled', sub: M.docPath(r), run: () => App.go('#/doc/' + r.id) }))) : toast('This note links to no other yet — Ctrl+Enter → Link to a note…') },
        { icon: '⤓', label: 'Pull in — a barrier, a structure or a component from another note', run: () => pane.pullMenu(d) },
        col ? { icon: '≡', label: col.label, run: () => col.run(d, { x: 80, y: 120 }) } : null,
        { icon: flagged ? '⚑' : '⚐', label: flagged ? 'Flagged for the weekly review — tap to clear' : 'Flag this note for the weekly review', sel: !!flagged, run: () => M.toggleFlag('doc', d.id) },
        { icon: '⌕', label: 'Atlas search', run: () => CMD.run('find', []) }].filter(Boolean); } }); } catch (e) { } }, 0);
}
