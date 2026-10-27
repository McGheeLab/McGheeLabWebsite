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

/* ✓ on a component → a My Week step. The steps are the lab's (the hub mirrors them into `mwsteps`, read-only), so the
   picker works offline; the choice is kept on the block as a pending entry and the hub reports it onto the step — the
   way the website's ✓ does at once — the next time this notebook reaches the lab cloud. */
LABSYNC.week = {
  steps() {
    return DB.all('mwsteps').filter(s => s && s.status !== 'cancelled')
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.startTime || '').localeCompare(String(a.startTime || '')));
  },
  entries: b => (Array.isArray(b.myweek) ? b.myweek : []).filter(e => e && e.stepId),
  report(b, s) {
    const cur = M.block(b.id); if (!cur) return;
    cur.myweek = [...LABSYNC.week.entries(cur).filter(e => e.stepId !== s.id), { stepId: s.id, title: s.title || '', date: s.date || '', at: isoLocal(new Date()), pending: true }].slice(-20);
    cur.modified = isoLocal(new Date()); DB.put('blocks', cur); App.refresh();
    toast('Goes to My Week · ' + (s.title || 'step') + ' — the next time this notebook syncs with the lab');
  },
  picker(b, e) {
    const all = LABSYNC.week.steps(), mine = new Set(LABSYNC.week.entries(b).map(x => x.stepId));
    const taken = s => mine.has(s.id) || (s.linked || []).includes(b.id);
    const row = s => h('button.wk-row' + (taken(s) ? '.on' : ''), { disabled: taken(s), title: taken(s) ? 'This component is already reported here' : s.notes || '',
      on: { click: () => { closePop(); LABSYNC.week.report(b, s); } } },
      h('span.mono.tiny', fmtDay(s.date + 'T12:00') + (s.startTime ? ' ' + s.startTime : '')), h('span.wk-t', s.title || 'Untitled step'), s.status === 'done' ? h('span.pill', 'done') : null);
    const list = h('div.wk-list'), q = { v: '' };
    const draw = () => {
      const m = q.v ? all.filter(s => (String(s.title) + ' ' + s.notes + ' ' + s.date).toLowerCase().includes(q.v)) : all;
      const need = m.filter(s => !s.hasOutcome), had = m.filter(s => s.hasOutcome);
      list.replaceChildren(...(m.length ? [need.length ? h('div.wk-g', 'Needs a result') : null, ...need.map(row), had.length ? h('div.wk-g', 'Already has an outcome') : null, ...had.map(row)].filter(Boolean)
        : [h('div.tiny.muted', all.length ? 'No step matches.' : 'No My Week steps here yet. They come from the lab the next time this notebook syncs.')]));
    };
    draw();
    const r = e.currentTarget.getBoundingClientRect();
    popover(r.left, r.bottom + 4, [h('div.wk-h', 'Report to My Week'), all.length > 6 ? h('input.inp.wk-q', { placeholder: 'Search steps', on: { input: ev => { q.v = ev.target.value.trim().toLowerCase(); draw(); } } }) : null, list], { cls: 'pop.wk-pop' });
  },
  button(b) {
    const en = LABSYNC.week.entries(b), wait = en.some(x => x.pending), bad = en.find(x => x.error && !x.pending);
    const title = en.length ? en.map(x => (x.pending ? 'Waiting to sync: ' : x.error ? 'Not sent: ' : 'In My Week: ') + (x.title || 'a step') + (x.date ? ' · ' + x.date : '') + (x.error ? ' — ' + x.error : '')).join('\n') + '\nClick to report it to another step'
      : 'Report this component to a My Week step';
    return h('button.ib.wk-btn' + (en.length ? '.on' : '') + (wait ? '.wait' : '') + (bad ? '.bad' : ''), { title, on: { click: e => { e.stopPropagation(); LABSYNC.week.picker(b, e); } } }, '✓');
  }
};
{
  const box = DocView.box;
  DocView.box = function (b) {
    const el = box.apply(this, arguments);
    if (!LABSYNC.lab() && !this.travel && b && b.kind !== 'ref') { const bh = $('.bh', el), more = bh && $('.bmore', bh); if (bh) bh.insertBefore(LABSYNC.week.button(b), more || null); }
    return el;
  };
}

{ // tasks: a mark until the hub has made the RM task
  // TASK.body and the widget's captured reference become the same function, so the website's lab layer (which wraps
  // TASK.body and re-points the widget only while the two still match) builds on this one
  const body = TASK.body;
  TASK.body = WIDGETS.task.body = function (b) {
    const el = body.apply(this, arguments);
    if (!LABSYNC.lab() && b && b.status === 'live' && !b.rmTaskId && el && el.appendChild)
      el.appendChild(LABSYNC.waitMark('Becomes an RM task the next time this notebook syncs with the lab cloud'));
    return el;
  };
}

{ // inventory materials: read-only card and sheet
  const card = MATS2.cardBody;   // as for tasks: one function behind MATS2.cardBody and the widget's reference
  MATS2.cardBody = WIDGETS.matcard.body = function (b, d, pane, ro) {
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
