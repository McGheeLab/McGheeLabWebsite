/* task-editor.js — shared task editor UI.
 *
 * Renders the Description · Planning · Pacing · Action items block that
 * appears both on the tasks-inbox page (when a task row is expanded) and on
 * the email-review page (under Related tasks, when an email is expanded).
 *
 * Keeping this in one module guarantees the two views stay visually and
 * behaviorally identical — the email-review page should "mirror what I see
 * if I click on a task on the activity page" (user requirement).
 *
 * Usage:
 *   const el = TASK_EDITOR.render(task, {
 *     save: async () => { ... },          // required — persist the mutated task
 *     onTaskChange: (task) => { ... },    // optional — re-render caller's row
 *     hoursLogged: (taskId) => number,    // optional — for pacing; default 0
 *     logDecision: async (...args) => {}, // optional — audit trail; default no-op
 *     onReschedule: async () => { ... },  // optional — after Schedule blocks; default save()
 *   });
 *
 * Depends on globals already loaded on both pages:
 *   - S.escapeHtml · S.starBar · S.todayStr (yr-shared.js)
 *   - api.load · api.save · safeCloseOnBackdrop (util.js)
 */
(function () {
  // Shared yr-shared helpers (todayStr / escapeHtml / starBar). Aliased as S
  // to match the naming used on pages that consume this module.
  const S = window.YR_SHARED;

  const DAILY_WORK_HOURS = 6;
  const BUFFER_FACTOR = 7;

  const PRIORITY_FLAG_STYLE = {
    'overdue':       { bg: '#fecaca', fg: '#7f1d1d', icon: '\u26A0' },
    'overdue-risk':  { bg: '#fee2e2', fg: '#991b1b', icon: '\u26A0' },
    'schedule-now':  { bg: '#fef3c7', fg: '#92400e', icon: '\u23F3' },
    'on-track':      { bg: '#dcfce7', fg: '#166534', icon: '\u2713' },
    'unscheduled':   { bg: '#e5e7eb', fg: '#374151', icon: '\u2014' },
    'completed':     { bg: '#dbeafe', fg: '#1e40af', icon: '\u2713' },
  };

  function businessDaysUntil(dateStr) {
    if (!dateStr || dateStr === 'TBD') return null;
    const from = new Date(S.todayStr() + 'T00:00:00');
    const to = new Date(dateStr + 'T00:00:00');
    if (to < from) return 0;
    let days = 0;
    const cur = new Date(from);
    while (cur < to) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) days += 1;
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  function businessDaySequence(fromStr, n) {
    const out = [];
    const cur = new Date(fromStr + 'T00:00:00');
    while (out.length < n) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) {
        out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function derivePriority(task, hoursLoggedFn) {
    if (task._is_ledger) return { flag: 'completed', label: 'done' };
    if (!task.due_date || task.due_date === 'TBD') return { flag: 'unscheduled', label: 'no due date' };
    const hoursEst = task.hours_estimate || 0;
    if (hoursEst <= 0) return { flag: 'unscheduled', label: 'no estimate' };
    const logged = (typeof hoursLoggedFn === 'function') ? (hoursLoggedFn(task.id) || 0) : 0;
    const hoursRem = Math.max(0, hoursEst - logged);
    const days = businessDaysUntil(task.due_date);
    const workLeft = days * DAILY_WORK_HOURS;
    if (days <= 0 && hoursRem > 0) return { flag: 'overdue', label: 'overdue', hoursRem, workLeft: 0 };
    if (workLeft === 0) return { flag: 'on-track', label: 'on track', hoursRem, workLeft: 0 };
    if (hoursRem > workLeft) return { flag: 'overdue-risk', label: `${hoursRem.toFixed(1)}h / ${workLeft}h`, hoursRem, workLeft };
    if (hoursRem > workLeft / BUFFER_FACTOR) return { flag: 'schedule-now', label: `pace: ${hoursRem.toFixed(1)}h in ${workLeft}h`, hoursRem, workLeft };
    return { flag: 'on-track', label: 'on track', hoursRem, workLeft };
  }

  function priorityChipHtml(task, hoursLoggedFn) {
    const d = derivePriority(task, hoursLoggedFn);
    const s = PRIORITY_FLAG_STYLE[d.flag] || PRIORITY_FLAG_STYLE['unscheduled'];
    return `<span class="priority-chip" style="background:${s.bg};color:${s.fg}" title="${S.escapeHtml(d.label)}">${s.icon} ${d.flag.replace('-', ' ')}</span>`;
  }

  /* ---------- section renderers ---------- */

  function renderDescription(task) {
    const wrap = document.createElement('div');
    wrap.className = 'section';
    wrap.innerHTML = `<div class="label">Description</div>
      <div class="body">${S.escapeHtml(task.description || '(no description)')}</div>`;
    return wrap;
  }

  function renderPlanning(task, ctx) {
    const wrap = document.createElement('div');
    wrap.className = 'section';
    wrap.innerHTML = `<div class="label">Planning</div>`;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px;font-size:12px';
    wrap.appendChild(grid);

    const labeled = (label, control) => {
      const cell = document.createElement('div');
      const lbl = document.createElement('div');
      lbl.style.cssText = 'font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px';
      lbl.textContent = label;
      cell.appendChild(lbl);
      cell.appendChild(control);
      return cell;
    };

    // Self-importance (0–5 stars). Separate from derived priority: what the
    // user says matters, independent of the clock.
    const starsHost = document.createElement('div');
    starsHost.className = 'self-imp-host';
    const mountStars = (val) => {
      starsHost.innerHTML = '';
      starsHost.appendChild(S.starBar(val, async (v) => {
        task.self_importance = v;
        task.user_edited = true;
        await ctx.save();
        mountStars(v);
      }, 16));
    };
    mountStars(task.self_importance || 0);
    grid.appendChild(labeled('Importance', starsHost));

    const hrs = document.createElement('input');
    hrs.type = 'number'; hrs.step = '0.25'; hrs.min = '0';
    hrs.value = task.hours_estimate ?? '';
    hrs.placeholder = 'hrs';
    hrs.style.cssText = 'width:100%;font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px';
    hrs.addEventListener('change', async () => {
      const raw = hrs.value.trim();
      const v = raw === '' ? null : parseFloat(raw);
      task.hours_estimate = (v === null || isNaN(v)) ? null : v;
      task.user_edited = true;
      await ctx.save();
    });
    grid.appendChild(labeled('Hours estimate', hrs));

    const due = document.createElement('input');
    due.type = 'date';
    due.value = (task.due_date && task.due_date !== 'TBD') ? task.due_date : '';
    due.style.cssText = 'width:100%;font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px';
    due.addEventListener('change', async () => {
      task.due_date = due.value || 'TBD';
      task.user_edited = true;
      await ctx.save();
      ctx.onTaskChange?.(task);
    });
    grid.appendChild(labeled('Due date', due));

    const planned = document.createElement('input');
    planned.type = 'date';
    planned.value = task.planned_for || '';
    planned.style.cssText = 'width:100%;font-size:12px;padding:4px 6px;border:1px solid #d1d5db;border-radius:4px';
    planned.addEventListener('change', async () => {
      task.planned_for = planned.value || null;
      task.user_edited = true;
      // Mirrors tasks-inbox logic: sized + planned flips accepted → active.
      if (task.status === 'accepted' && task.hours_estimate != null && task.planned_for) {
        task.status = 'active';
      }
      await ctx.save();
      ctx.onTaskChange?.(task);
    });
    grid.appendChild(labeled('Planned for', planned));

    return wrap;
  }

  function renderPacing(task, ctx) {
    const d = derivePriority(task, ctx.hoursLogged);
    const wrap = document.createElement('div');
    wrap.className = 'section';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px';
    row.innerHTML = `<span class="label" style="margin:0">Pacing</span>${priorityChipHtml(task, ctx.hoursLogged)}
      <span style="color:#6b7280">${S.escapeHtml(d.label || '')}</span>`;
    wrap.appendChild(row);
    if (['overdue-risk', 'schedule-now', 'overdue'].includes(d.flag)) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.style.cssText = 'font-size:11px;padding:4px 10px;margin-left:auto';
      btn.textContent = '\u23F0 Schedule blocks';
      btn.addEventListener('click', () => openScheduleBlocksDialog(task, d, ctx));
      row.appendChild(btn);
    }
    return wrap;
  }

  function renderActionItems(task, ctx) {
    const wrap = document.createElement('div');
    wrap.className = 'section';
    wrap.innerHTML = `<div class="label">Action items</div>`;
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:6px';
    wrap.appendChild(list);

    const renderItem = (ai) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!ai.done;
      const text = document.createElement('span');
      text.textContent = ai.text;
      text.style.cssText = `flex:1;font-size:13px;${ai.done ? 'text-decoration:line-through;color:#9ca3af' : ''}`;
      text.contentEditable = 'true';
      text.spellcheck = true;
      text.addEventListener('blur', async () => {
        const v = text.textContent.trim();
        if (!v) return;
        ai.text = v;
        await ctx.save();
      });
      text.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); text.blur(); }
      });
      cb.addEventListener('change', async () => {
        ai.done = cb.checked;
        ai.done_at = cb.checked ? new Date().toISOString() : null;
        text.style.textDecoration = cb.checked ? 'line-through' : '';
        text.style.color = cb.checked ? '#9ca3af' : '';
        await ctx.save();
      });
      const del = document.createElement('span');
      del.textContent = '\u2716';
      del.title = 'Remove action item';
      del.style.cssText = 'color:#dc2626;cursor:pointer;font-size:12px;padding:2px 4px';
      del.addEventListener('click', async () => {
        task.action_items = (task.action_items || []).filter(x => x.id !== ai.id);
        await ctx.save();
        row.remove();
      });
      row.appendChild(cb);
      row.appendChild(text);
      row.appendChild(del);
      return row;
    };

    for (const ai of (task.action_items || [])) list.appendChild(renderItem(ai));

    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:6px';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '+ add action item (Enter to save)';
    inp.style.cssText = 'flex:1;font-size:12px;padding:4px 8px;border:1px solid #d1d5db;border-radius:4px';
    inp.addEventListener('keydown', async (ev) => {
      if (ev.key !== 'Enter') return;
      const v = inp.value.trim();
      if (!v) return;
      const ai = { id: `ai-${Date.now().toString(36)}`, text: v, done: false };
      (task.action_items = task.action_items || []).push(ai);
      list.appendChild(renderItem(ai));
      inp.value = '';
      await ctx.save();
    });
    addRow.appendChild(inp);
    wrap.appendChild(addRow);

    return wrap;
  }

  /* ---------- schedule blocks dialog ---------- */

  async function openScheduleBlocksDialog(task, derived, ctx) {
    const hoursRem = derived?.hoursRem ?? (task.hours_estimate || 0);
    const blocks = Math.max(1, Math.ceil(hoursRem / 2));
    const startDays = businessDaySequence(S.todayStr(), blocks);

    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:95;display:flex;align-items:center;justify-content:center';
    const panel = document.createElement('div');
    panel.style.cssText = 'background:#fff;border-radius:10px;min-width:520px;max-width:620px;padding:18px 22px;box-shadow:0 20px 40px rgba(0,0,0,.25)';
    panel.innerHTML = `
      <h3 style="margin:0 0 6px 0;font-size:15px">Schedule blocks for "${S.escapeHtml(task.title || '')}"</h3>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px">
        ${hoursRem.toFixed(1)}h remaining — proposing ${blocks} \u00d7 2h block${blocks === 1 ? '' : 's'} on weekdays starting today. Adjust any date, then confirm.
      </div>
      <div class="sb-rows" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-k="cancel">Cancel</button>
        <button class="btn btn-primary" data-k="confirm">Create ${blocks} event${blocks === 1 ? '' : 's'}</button>
      </div>
    `;
    back.appendChild(panel);
    document.body.appendChild(back);
    safeCloseOnBackdrop(back, panel, () => { if (back.parentNode) document.body.removeChild(back); });

    const rowsHost = panel.querySelector('.sb-rows');
    const blockRows = [];
    for (let i = 0; i < blocks; i++) {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px;gap:6px;align-items:center';
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.value = startDays[i] || startDays[startDays.length - 1];
      dateInput.style.cssText = 'font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px';
      const startInput = document.createElement('input');
      startInput.type = 'time';
      startInput.value = '09:00';
      startInput.style.cssText = 'font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px';
      const hrsInput = document.createElement('input');
      hrsInput.type = 'number'; hrsInput.min = '0.25'; hrsInput.step = '0.25';
      hrsInput.value = '2';
      hrsInput.style.cssText = 'font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px';
      row.appendChild(dateInput);
      row.appendChild(startInput);
      row.appendChild(hrsInput);
      rowsHost.appendChild(row);
      blockRows.push({ dateInput, startInput, hrsInput });
    }
    panel.querySelector('[data-k="cancel"]').addEventListener('click', () => document.body.removeChild(back));
    panel.querySelector('[data-k="confirm"]').addEventListener('click', async () => {
      const events = blockRows.map(({ dateInput, startInput, hrsInput }) => {
        const hours = Math.max(0.25, parseFloat(hrsInput.value) || 2);
        const start = new Date(`${dateInput.value}T${startInput.value}:00`);
        const end = new Date(start.getTime() + hours * 3600 * 1000);
        return {
          id: `user-block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          source: 'user_block',
          title: `[block] ${task.title || ''}`,
          start: `${dateInput.value}T${startInput.value}:00`,
          end: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}T${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}:00`,
          duration_min: Math.round(hours * 60),
          category: task.category,
          sub_category: task.sub_category,
          assigned_task_id: task.id,
          organizer: '(self)',
          attendees: [],
          location: '',
          description: `Scheduled block for task ${task.id}.`,
          category_source: 'user_block',
        };
      });
      document.body.removeChild(back);
      try {
        let doc;
        try { doc = await api.load('calendar_user_events.json'); }
        catch { doc = { events: [] }; }
        doc.events = (doc.events || []).concat(events);
        await api.save('calendar_user_events.json', doc);
        const earliest = events.map(e => e.start.slice(0, 10)).sort()[0];
        if (earliest) task.planned_for = earliest;
        if (task.status === 'accepted') task.status = 'active';
        if (ctx.onReschedule) await ctx.onReschedule();
        else await ctx.save();
        ctx.onTaskChange?.(task);
      } catch (e) {
        alert('Failed to save blocks: ' + e.message);
      }
    });
  }

  /* ---------- public entry point ---------- */

  function render(task, ctx) {
    if (!ctx || typeof ctx.save !== 'function') {
      throw new Error('TASK_EDITOR.render: ctx.save is required');
    }
    const root = document.createElement('div');
    root.className = 'task-editor';
    root.appendChild(renderDescription(task));
    if (!task._is_ledger) {
      root.appendChild(renderPlanning(task, ctx));
      root.appendChild(renderPacing(task, ctx));
      root.appendChild(renderActionItems(task, ctx));
    }
    return root;
  }

  window.TASK_EDITOR = {
    render,
    derivePriority,
    priorityChipHtml,
    businessDaysUntil,
    businessDaySequence,
  };
})();
