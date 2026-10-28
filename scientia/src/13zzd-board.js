/* ==========================================================================
   13zzd · Whiteboards in image panels — the lab's whiteboard. An empty
   image of a panel can be a whiteboard instead (✎ Whiteboard in the empty
   cell): the Lab Notebook's own whiteboard (rm/pages/notebook-board.html,
   the whiteboard.js engine — pen, record, ＋ From paper), the board kept in
   the lab (userData/{uid}/notebookBoards/{board}). The cell shows the board;
   click it and it fills the window to draw on. cell.board = {lab: board id,
   owner: uid, title}.
   The board needs the lab sign-in, so it is made where Scientia runs in the
   Lab Notebook (on the website); on the desktop app a board opens on the
   website, in the browser.
   ========================================================================== */
const BOARD = {
  /** Signed in to the lab here (the website's Scientia): boards can be shown and made. */
  can: () => !window.SIS_DESKTOP && !!(window.__sisCloud && window.__sisCloud.user),
  url(bd, site) { return (site ? 'https://mcgheelab.com' : '') + '/rm/pages/notebook-board.html?board=' + encodeURIComponent(bd.lab) + '&owner=' + encodeURIComponent(bd.owner) + '&title=' + encodeURIComponent(bd.title || 'Whiteboard'); },
  /** The board in its cell (seen, not drawn on: a click opens it). */
  preview(bd) {
    if (!bd.lab) return h('div.wb-card', 'Whiteboard');
    if (!BOARD.can()) return h('div.wb-card', h('b', 'Lab whiteboard'), h('span', 'opens on mcgheelab.com ↗'));
    return h('iframe.wb-frame', { src: BOARD.url(bd), loading: 'lazy', tabindex: '-1', title: bd.title || 'Whiteboard', 'data-board': bd.lab });
  },
  make(b, i) {
    const c = b && FIG.cells(b)[i]; if (!c || c.media) return;
    if (!BOARD.can()) return toast('Whiteboards come from the lab — add one in Scientia on mcgheelab.com (the Lab Notebook)', 4000);
    const uid0 = window.__sisCloud.user.uid;
    c.board = { lab: 'nb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '_' + uid0, owner: uid0, title: (b.label || 'Image panel') + ' · ' + FIG.letter(i) };
    DB.beginGroup('board'); FIG.save(b); changed(); setTimeout(() => BOARD.open(M.block(b.id), i), 60);
  },
  remove(b, i) { const cur = M.block(b.id), c = cur && FIG.cells(cur)[i]; if (!c) return; DB.beginGroup('board'); delete c.board; FIG.save(cur); changed(); toast('Whiteboard taken out of the panel (the board stays in the lab) · Ctrl+Z puts it back'); },
  /** The lab's whiteboard filling the window. */
  open(b, i) {
    const c = b && FIG.cells(b)[i], bd = c && c.board; if (!bd || !bd.lab) return;
    if (!BOARD.can()) { window.open(BOARD.url(bd, true), '_blank', 'noopener'); return; }
    let sure = false;
    const drop = h('button.btn.sm.ghost', { title: 'An empty image again (the board stays in the lab)', on: { click: () => { if (!sure) { sure = true; drop.textContent = 'Remove — sure?'; setTimeout(() => { sure = false; drop.textContent = 'Remove whiteboard'; }, 3000); return; } close(); BOARD.remove(b, i); } } }, 'Remove whiteboard');
    const ov = h('div.embed-max.wb-max', h('div.em-bar', h('b', bd.title || 'Whiteboard'), h('span.tiny.muted', 'The lab’s whiteboard'), h('span.spacer'),
        h('a.btn.sm', { href: BOARD.url(bd), target: '_blank', rel: 'noopener' }, 'Open in a new tab ↗'), drop, h('button.btn.sm.pri', { on: { click: () => close() } }, 'Done')),
      h('iframe.wb-full', { src: BOARD.url(bd), allow: 'microphone; fullscreen', title: bd.title || 'Whiteboard' }));
    const key = e => { if (e.key === 'Escape' && !$('.ovl')) { e.stopPropagation(); close(); } };
    const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); $$(`iframe.wb-frame[data-board="${bd.lab}"]`).forEach(f => { f.src = BOARD.url(bd); }); };
    document.body.append(ov); document.addEventListener('keydown', key, true);
    return ov;
  },
};
