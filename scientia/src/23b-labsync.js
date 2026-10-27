/* ==========================================================================
   23b · What waits for the lab. The app works offline; what belongs in the
   lab reaches RM when the notebook reaches the lab cloud (the desktop bridge,
   or the website) — the hub does it there and writes the result back here.
   • A task not yet in RM says so (the hub gives it an rmTaskId on sync).
   • A material from the lab inventory (a resource note with inventoryId,
     picked on the website) is the lab's: here it is a fixed card — still
     connected, linked and pulled in like any component — and its use is
     logged in RM, not here.
   On the website the lab layer handles both itself (window.SIS_LAB).
   ========================================================================== */
const LABSYNC = {
  lab: () => !!window.SIS_LAB,
  isInventory: r => !!(r && r.inventoryId),
  waitMark: (title) => h('span.lab-wait', { title }, 'waiting for the lab'),
  invLine: () => h('div.tiny.muted.inv-line', 'From the lab inventory · its use is logged on the lab website')
};

{ // tasks: a mark until the hub has made the RM task
  const body = WIDGETS.task.body;
  WIDGETS.task.body = function (b) {
    const el = body.apply(this, arguments);
    if (!LABSYNC.lab() && b && b.status === 'live' && !b.rmTaskId && el && el.appendChild)
      el.appendChild(LABSYNC.waitMark('Becomes an RM task the next time this notebook syncs with the lab cloud'));
    return el;
  };
}

{ // inventory materials: read-only card and sheet
  const card = WIDGETS.matcard.body;   // the widget holds its own reference to MATS2.cardBody
  WIDGETS.matcard.body = function (b, d, pane, ro) {
    const r = M.doc(b.matId), inv = LABSYNC.isInventory(r) && !LABSYNC.lab();
    const el = card.call(this, b, d, pane, inv ? true : ro);
    if (inv && el && el.appendChild) { el.classList.add('inv-ro'); el.appendChild(LABSYNC.invLine()); }
    return el;
  };
  const menu = WIDGETS.matcard.menu;
  WIDGETS.matcard.menu = function (b) {
    const items = menu.apply(this, arguments) || [];
    return LABSYNC.isInventory(M.doc(b.matId)) && !LABSYNC.lab() ? items.filter(x => x && /Open its sheet/.test(x.label)) : items;
  };
  const fill = MatSheet.fill;   // every (re)draw of the sheet goes through fill
  MatSheet.fill = function (d) {
    const out = fill.apply(this, arguments), host = this.host;
    if (LABSYNC.isInventory(d) && !LABSYNC.lab() && host) {
      host.classList.add('inv-ro');
      $$('input, textarea, select, button', host).forEach(x => { x.disabled = true; });
      $$('[contenteditable="true"]', host).forEach(x => { x.contentEditable = 'false'; });
      if (!$('.inv-line', host)) host.prepend(LABSYNC.invLine());
    }
    return out;
  };
}
