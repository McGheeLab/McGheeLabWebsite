/* task-quick-builder.js — Shared "Build a task from this" form.
 *
 * Called by email-review.js and calendar.js inside an expanded item to let
 * the user pick a dashboard project + fill in title/hours/due/priority and
 * create a subtask wired to the source email/event.
 *
 * Public:
 *   TASK_QUICK_BUILDER.render({
 *     kind: 'email' | 'event' | 'item',
 *     sourceId: string,
 *     defaultTitle: string,
 *     defaultDescription?: string,
 *     defaultDue?: 'YYYY-MM-DD' | null,
 *   }) -> HTMLElement
 */
(function () {
  const BUCKETS_PATH = 'tasks/buckets.json';
  const DASH_HIDDEN_KEY = 'tasksDash.hiddenProjects';

  // Route through api.load/save so the per-user Firestore adapter handles it.
  function loadBuckets() {
    return api.load(BUCKETS_PATH);
  }
  // Surgical save — writes ONE project doc to userData/{uid}/buckets/{projectId}
  // instead of rewriting the whole projects array (which is what api.save would
  // do for the wrapKey:'projects' route). On collections with 30+ projects the
  // full rewrite easily takes 20+ seconds; the surgical write is one round
  // trip. Falls back to the full save if Firestore isn't available.
  async function saveProjectSurgical(project) {
    if (!project || !project.id) return;
    if (typeof firebridge === 'undefined' || !firebridge.db) {
      const me = firebridge && firebridge.getUser && firebridge.getUser();
      if (!me) return;
    }
    try {
      const me = firebridge.getUser();
      if (!me) throw new Error('not signed in');
      const ref = firebridge.db().collection('userData').doc(me.uid)
        .collection('buckets').doc(project.id);
      const clean = Object.assign({}, project);
      delete clean.id;
      clean.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await ref.set(clean, { merge: true });
    } catch (err) {
      console.warn('[task-quick-builder] surgical save failed, falling back:', err.message);
      // Fall through to full collection rewrite — slow but correct.
      const doc = await loadBuckets();
      // Replace the one project in the freshly-loaded doc; all-or-nothing write.
      const projects = doc.projects || [];
      const i = projects.findIndex(p => p.id === project.id);
      if (i >= 0) projects[i] = project; else projects.push(project);
      doc.updated_at = new Date().toISOString();
      await api.save(BUCKETS_PATH, doc);
    }
  }
  function dashHiddenSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DASH_HIDDEN_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function dashUnhide(projectId) {
    const s = dashHiddenSet();
    if (s.has(projectId)) {
      s.delete(projectId);
      localStorage.setItem(DASH_HIDDEN_KEY, JSON.stringify([...s]));
    }
  }
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
  }
  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  function emptyEvidence() { return { email_ids: [], event_ids: [], item_ids: [] }; }

  function ensureDefaultBucket(project) {
    let b = (project.buckets || []).find(x => x.id === `buk-${project.id}-default`);
    if (b) return b;
    b = {
      id: `buk-${project.id}-default`,
      category: project.category || '',
      sub_category: '',
      title: 'General',
      due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
      evidence: emptyEvidence(), notes: '', subtasks: [],
    };
    project.buckets = project.buckets || [];
    project.buckets.unshift(b);
    return b;
  }

  // Walk the doc to find an existing subtask whose evidence already includes this source id.
  function findExisting(doc, kind, sourceId) {
    const key = kind === 'email' ? 'email_ids' : kind === 'event' ? 'event_ids' : 'item_ids';
    function walk(arr, project, bucket) {
      for (const st of arr || []) {
        const ev = (st.evidence && st.evidence[key]) || [];
        if (ev.includes(sourceId)) return { st, project, bucket };
        if ((st.children || []).length) {
          const hit = walk(st.children, project, bucket);
          if (hit) return hit;
        }
      }
      return null;
    }
    for (const p of doc.projects || []) {
      for (const b of p.buckets || []) {
        const hit = walk(b.subtasks, p, b);
        if (hit) return hit;
      }
    }
    return null;
  }

  function render(opts) {
    const { kind, sourceId, defaultTitle, defaultDescription, defaultDue } = opts;
    const wrap = document.createElement('div');
    wrap.className = 'tqb-panel';

    const head = document.createElement('div');
    head.className = 'tqb-head';
    head.innerHTML = `<strong>+ Build a task from this ${kind}</strong>
      <span class="tqb-link"><a href="/rm/pages/tasks.html">Dashboard ↗</a></span>`;
    wrap.appendChild(head);

    const status = document.createElement('div');
    status.className = 'tqb-status';
    wrap.appendChild(status);

    const grid = document.createElement('div');
    grid.className = 'tqb-grid';

    // Project picker
    const projField = field('Project', () => {
      const sel = document.createElement('select');
      sel.className = 'tqb-project';
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = '— pick a project —';
      sel.appendChild(placeholder);
      const newOpt = document.createElement('option');
      newOpt.value = '__new__'; newOpt.textContent = '+ New project…';
      sel.appendChild(newOpt);
      return sel;
    });
    grid.appendChild(projField);

    // Title
    const titleField = field('Task title', () => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = defaultTitle || '';
      return inp;
    });
    grid.appendChild(titleField);

    // Due date
    const dueField = field('Due date', () => {
      const inp = document.createElement('input');
      inp.type = 'date';
      if (defaultDue) inp.value = defaultDue;
      return inp;
    });
    grid.appendChild(dueField);

    // Hours
    const hoursField = field('Hours estimate', () => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.25'; inp.min = '0';
      inp.value = '0';
      return inp;
    });
    grid.appendChild(hoursField);

    // Priority
    const priField = field('Priority', () => {
      const sel = document.createElement('select');
      for (const p of ['low', 'normal', 'high', 'urgent']) {
        const o = document.createElement('option');
        o.value = p; o.textContent = p;
        if (p === 'normal') o.selected = true;
        sel.appendChild(o);
      }
      return sel;
    });
    grid.appendChild(priField);

    wrap.appendChild(grid);

    // Notes
    const notesField = field('Notes (optional)', () => {
      const ta = document.createElement('textarea');
      ta.rows = 2;
      ta.value = defaultDescription || '';
      return ta;
    });
    notesField.style.gridColumn = '1 / -1';
    wrap.appendChild(notesField);

    const actions = document.createElement('div');
    actions.className = 'tqb-actions';
    const create = document.createElement('button');
    create.className = 'btn btn-primary btn-sm';
    create.textContent = '✓ Create task';
    create.disabled = true;     // enabled once a project is picked or "+ New" used
    actions.appendChild(create);
    wrap.appendChild(actions);

    // Inputs we need by ref
    const sel = projField.querySelector('select');
    const titleInp = titleField.querySelector('input');
    const dueInp = dueField.querySelector('input');
    const hoursInp = hoursField.querySelector('input');
    const priSel = priField.querySelector('select');
    const notesTa = notesField.querySelector('textarea');

    let bucketsDoc = null;
    let existingHit = null;

    // Async load: populate the project picker, check for an existing match.
    setStatus('Loading projects…');
    loadBuckets().then(doc => {
      bucketsDoc = doc;
      existingHit = findExisting(doc, kind, sourceId);
      const hidden = dashHiddenSet();
      const visible = (doc.projects || []).filter(p => p.id !== 'proj-inbox' && !hidden.has(p.id));
      // Sort by title for predictability
      visible.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      for (const p of visible) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.title;
        sel.insertBefore(o, sel.querySelector('option[value="__new__"]'));
      }
      if (existingHit) {
        setStatus(
          `Already linked to "${existingHit.st.text}" in ${existingHit.project.title}. ` +
          `Creating another will make a duplicate.`,
          'warn'
        );
      } else {
        setStatus('');
      }
    }).catch(err => {
      setStatus('Failed to load projects: ' + err.message, 'err');
    });

    sel.addEventListener('change', () => { create.disabled = !sel.value; });

    create.addEventListener('click', async () => {
      if (!bucketsDoc) return;
      const title = (titleInp.value || '').trim();
      if (!title) { setStatus('Title is required.', 'err'); return; }
      let projId = sel.value;
      let project;
      if (projId === '__new__') {
        const name = prompt('New project name:', titleInp.value || '');
        if (!name || !name.trim()) return;
        projId = `proj-${slugify(name.trim())}-${Date.now().toString(36)}`;
        project = {
          id: projId, title: name.trim(), status: 'active', category: '',
          due_date: 'TBD', hours_estimate: 0, tracker_entry_id: null,
          evidence: emptyEvidence(), notes: '',
          created_at: new Date().toISOString().slice(0, 10),
          completed_at: null, buckets: [],
        };
        bucketsDoc.projects.push(project);
      } else {
        project = (bucketsDoc.projects || []).find(p => p.id === projId);
      }
      if (!project) { setStatus('Project not found.', 'err'); return; }
      const bucket = ensureDefaultBucket(project);
      const ev = emptyEvidence();
      if (kind === 'email') ev.email_ids.push(sourceId);
      else if (kind === 'event') ev.event_ids.push(sourceId);
      else if (kind === 'item') ev.item_ids.push(sourceId);
      const subtask = {
        id: newId('sub'),
        text: title,
        description: notesTa.value || '',
        done: false, done_at: null,
        due_date: dueInp.value || 'TBD',
        priority: priSel.value || 'normal',
        hours_estimate: Number(hoursInp.value) || 0,
        tracker_entry_id: null,
        evidence: ev,
        notes: '',
        proposed: false,
        proposed_source: kind,
        proposed_at: new Date().toISOString(),
        children: [],
      };
      bucket.subtasks = bucket.subtasks || [];
      bucket.subtasks.push(subtask);
      dashUnhide(project.id);

      // Optimistic UX: lock fields + show success NOW, save in the background.
      // The surgical write is one Firestore set ~150-300ms; the full save was
      // 20+s for users with 30+ projects.
      create.disabled = true;
      sel.disabled = true; titleInp.disabled = true; dueInp.disabled = true;
      hoursInp.disabled = true; priSel.disabled = true; notesTa.disabled = true;
      setStatus(`Created in "${project.title}". `, 'ok');
      const link = document.createElement('a');
      link.href = '/rm/pages/tasks.html';
      link.textContent = 'Open Dashboard ↗';
      status.appendChild(link);

      saveProjectSurgical(project).catch(err => {
        setStatus('Save failed: ' + err.message + ' — refresh and try again.', 'err');
        if (window.TOAST) TOAST.error('Failed to save task', { detail: err.message });
        create.disabled = false;
      });
    });

    function setStatus(msg, kind) {
      status.textContent = msg || '';
      status.className = 'tqb-status' + (kind ? ' tqb-status-' + kind : '');
    }
    function field(label, makeInput) {
      const w = document.createElement('div');
      w.className = 'tqb-field';
      const lbl = document.createElement('div');
      lbl.className = 'tqb-label';
      lbl.textContent = label;
      w.appendChild(lbl);
      w.appendChild(makeInput());
      return w;
    }

    return wrap;
  }

  window.TASK_QUICK_BUILDER = { render };
})();
