/* research-composer.js — V3.545 + V3.552 (Research Foci program)
 *
 * Admin-only authoring modals for the research map:
 *   openCreate(level, onDone)  — new card, guided template → compiled
 *                                description → rich-text polish → save.
 *   openEdit(foci, onDone)     — same, prefilled.
 *   openOverview(foci, onDone) — the block composer for the PUBLIC overview
 *                                (V3.552): text / image / video / youtube /
 *                                html blocks, reorderable, referencing the
 *                                card's uploaded media[].
 *
 * The guided template is a set of per-level prompts. compileDescription()
 * stitches the answers into an <h3>-sectioned HTML draft (pure JS, no AI —
 * Alex's choice); the draft drops into a contentEditable surface the PI
 * polishes freely. We store the sanitized HTML in description_html AND the
 * raw answers in template_fields.answers so a re-compile never loses intent.
 *
 * Rich text: contentEditable + document.execCommand for bold/italic/lists,
 * sanitized on save via RESEARCH_DATA.sanitizeHtml (the library-themes
 * policy). Globals: window.RESEARCH_COMPOSER.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;
  function iconPreview(v) { return window.ICON_PICKER ? ICON_PICKER.html(v || '🔬', { size: '20px' }) : esc(v || '🔬'); }

  /* Per-level guided prompts. `key` is the answers map key; `q` the prompt;
   * `h` the compiled section heading. */
  var TEMPLATES = {
    specialty: [
      { key: 'what_is_it',     h: 'What it is',        q: 'What is this capability, in one paragraph a new student could understand?' },
      { key: 'uniquely_ours',  h: 'What makes it ours', q: 'What makes it uniquely ours — the twist no other lab does?' },
      { key: 'what_it_enables',h: 'What it enables',    q: 'What does it enable that is otherwise impossible or hard?' },
    ],
    concept: [
      { key: 'vision',         h: 'The vision',        q: 'The vision — what does the world look like if this works?' },
      { key: 'why_it_matters', h: 'Why it matters',    q: 'Why it matters (scientific and translational stakes)?' },
      { key: 'which_specialties', h: 'How we attack it', q: 'Which of our specialties combine to attack it?' },
      { key: 'open_questions', h: 'Open questions',    q: 'Open questions — what do we not yet know?' },
    ],
    output: [
      { key: 'goal',          h: 'Goal',              q: 'The goal — what artifact ships (paper / grant / patent) and its central claim?' },
      { key: 'approach',      h: 'Approach',          q: 'Approach — how do the concepts and specialties get combined here?' },
      { key: 'milestones',    h: 'Milestones',        q: 'Milestones — the 3–5 gates to done?' },
      { key: 'target_venue',  h: 'Target venue',      q: 'Target venue / agency / patent office?' },
    ],
  };

  function compileDescription(level, answers) {
    var tpl = TEMPLATES[level] || [];
    var out = tpl.map(function (f) {
      var a = (answers[f.key] || '').trim();
      if (!a) return '';
      // Preserve paragraph breaks as <p>.
      var paras = a.split(/\n{2,}/).map(function (p) {
        return '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>';
      }).join('');
      return '<h3>' + esc(f.h) + '</h3>' + paras;
    }).filter(Boolean).join('');
    return out;
  }

  /* ── rich-text editor helper ────────────────────────────────── */
  function richToolbar() {
    return '<div class="rf-rt-toolbar">' +
      '<button type="button" data-cmd="bold"><b>B</b></button>' +
      '<button type="button" data-cmd="italic"><i>I</i></button>' +
      '<button type="button" data-cmd="insertUnorderedList">• List</button>' +
      '<button type="button" data-cmd="insertOrderedList">1. List</button>' +
      '<button type="button" data-cmd="formatBlock" data-val="h3">H3</button>' +
      '<button type="button" data-cmd="formatBlock" data-val="p">P</button>' +
      '</div>';
  }
  function wireRich(scope) {
    scope.querySelectorAll('.rf-rt-toolbar button').forEach(function (b) {
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var cmd = b.getAttribute('data-cmd'), val = b.getAttribute('data-val') || null;
        document.execCommand(cmd, false, val);
      });
    });
  }

  /* ── create / edit ──────────────────────────────────────────── */

  function openForm(mode, seed, onDone) {
    var isEdit = mode === 'edit';
    var f = seed || {};
    var level = f.level || 'specialty';
    var answers = (f.template_fields && f.template_fields.answers) || {};

    var m = RD.modal({ title: (isEdit ? 'Edit ' : 'New ') + RD.LEVELS[level].label + ' card', wide: true });

    function levelPicker() {
      if (isEdit) return '<input type="hidden" data-field="level" value="' + esc(level) + '">';
      return '<div class="rf-field"><label>Level</label><div class="rf-level-tabs">' +
        RD.LEVEL_ORDER.map(function (l) {
          return '<button type="button" class="rf-level-tab' + (l === level ? ' active' : '') + '" data-set-level="' + l + '">' +
            RD.LEVELS[l].icon + ' ' + RD.LEVELS[l].label + '</button>';
        }).join('') + '</div></div>';
    }
    function templateFields(lvl) {
      return (TEMPLATES[lvl] || []).map(function (t) {
        return '<div class="rf-field"><label>' + esc(t.q) + '</label>' +
          '<textarea data-answer="' + esc(t.key) + '" rows="3">' + esc(answers[t.key] || '') + '</textarea></div>';
      }).join('');
    }

    // Output-card statuses (lean lifecycle — the label:value pairs).
    var OUTPUT_STATUSES = [
      ['planning', 'Planning'], ['drafting', 'Drafting'], ['submitted', 'Submitted'],
      ['under_review', 'Under review'], ['awarded_published', 'Awarded / published'], ['closed', 'Closed'],
    ];
    function descBox(withCompile) {
      return (withCompile
        ? '<fieldset class="rf-template"><legend>Guided description</legend>' +
            '<div data-template-fields>' + templateFields(level) + '</div>' +
            '<button type="button" class="rf-btn" data-act="compile">↳ Compile into description</button>' +
          '</fieldset>'
        : '') +
        '<div class="rf-field rf-grow"><label>' + (withCompile ? 'Description (edit freely)' : 'Notes (optional)') + '</label>' +
          richToolbar() +
          '<div class="rf-richtext-edit" contenteditable="true" data-desc>' + (f.description_html ? RD.sanitizeHtml(f.description_html) : '') + '</div>' +
        '</div>';
    }

    // The middle section differs by level: specialty/concept get the guided
    // template; output cards stay lean — just a status + optional notes.
    // (EXISTING papers/grants never come through this form: the ⤵ Existing
    // picker auto-creates one draft-backed card per record, nothing typed.
    // This form is only for NEW outputs — a patent, a planned effort.)
    function variableFor(lvl) {
      if (lvl !== 'output') return descBox(true);
      var statusOpts = OUTPUT_STATUSES.map(function (s) {
        return '<option value="' + s[0] + '"' + ((f.status || 'planning') === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('');
      return '<div class="rf-field"><label>Status</label><select data-field="status">' + statusOpts + '</select></div>' +
        '<p class="rf-hint">For an EXISTING paper or grant, use "⤵ Existing paper" instead (grants attach to a concept via its Grant section) — each becomes its own card automatically.</p>' +
        descBox(false);
    }

    m.body.innerHTML =
      levelPicker() +
      '<div class="rf-field-row">' +
        '<div class="rf-field rf-grow"><label>Title</label><input type="text" data-field="title" value="' + esc(f.title || '') + '"></div>' +
        '<div class="rf-field"><label>Abbr.</label><input type="text" data-field="abbr" value="' + esc(f.abbr || '') + '" placeholder="MEBP"></div>' +
      '</div>' +
      '<div class="rf-field-row">' +
        '<div class="rf-field"><label>Icon</label>' +
          '<button type="button" class="rf-btn rf-icon-btn" data-act="pick-icon">' +
            '<span data-icon-preview>' + iconPreview(f.icon) + '</span> Choose…</button>' +
          '<input type="hidden" data-field="icon" value="' + esc(f.icon || '') + '"></div>' +
        '<div class="rf-field"><label>Accent color</label><input type="color" data-field="color" value="' + esc(f.color || '#2563eb') + '"></div>' +
        (isEdit ? '' : '<div class="rf-field rf-grow"><label>Id (slug)</label><input type="text" data-field="id" value="' + esc(f.id || '') + '" placeholder="auto from title"></div>') +
      '</div>' +
      '<div class="rf-field rf-grow"><label>One-liner</label><input type="text" data-field="one_liner" value="' + esc(f.one_liner || '') + '" placeholder="The card-face tagline"></div>' +
      '<div data-variable>' + variableFor(level) + '</div>' +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="save">' + (isEdit ? 'Save' : 'Create') + '</button>' +
      '</div>';

    wireRich(m.body);
    var errEl = m.body.querySelector('.rf-modal-err');
    function showErr(msg) { errEl.textContent = msg; errEl.hidden = !msg; }

    m.body.addEventListener('click', function (e) {
      var lt = e.target.closest('[data-set-level]');
      if (lt) {
        level = lt.getAttribute('data-set-level');
        m.body.querySelectorAll('.rf-level-tab').forEach(function (b) { b.classList.toggle('active', b === lt); });
        m.body.querySelector('[data-variable]').innerHTML = variableFor(level);
        wireRich(m.body);
        return;
      }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'pick-icon') {
        var hidden = m.body.querySelector('[data-field="icon"]');
        if (window.ICON_PICKER) ICON_PICKER.open({
          current: hidden.value,
          onPick: function (v) {
            hidden.value = v;
            var prev = m.body.querySelector('[data-icon-preview]');
            if (prev) prev.innerHTML = iconPreview(v);
          },
        });
        return;
      }
      if (a === 'cancel') { m.close(); return; }
      if (a === 'compile') {
        var ans = collectAnswers();
        var html = compileDescription(level, ans);
        if (!html) { showErr('Fill at least one prompt to compile.'); return; }
        m.body.querySelector('[data-desc]').innerHTML = RD.sanitizeHtml(html);
        showErr('');
        return;
      }
      if (a === 'save') { save(); return; }
    });

    function collectAnswers() {
      var out = {};
      m.body.querySelectorAll('[data-answer]').forEach(function (ta) {
        out[ta.getAttribute('data-answer')] = ta.value;
      });
      return out;
    }
    function val(field) { var el = m.body.querySelector('[data-field="' + field + '"]'); return el ? el.value.trim() : ''; }

    async function save() {
      var title = val('title');
      if (!title) { showErr('Title is required.'); return; }
      var descEl = m.body.querySelector('[data-desc]');
      var payload = {
        level: level,
        title: title,
        abbr: val('abbr'),
        icon: val('icon'),
        color: val('color'),
        one_liner: val('one_liner'),
        template_fields: { template_version: 1, answers: collectAnswers() },
        description_html: descEl ? RD.sanitizeHtml(descEl.innerHTML) : (f.description_html || ''),
      };
      // Output cards: persist the chosen status. draft_refs are managed by
      // the ⤵ Existing picker / spawn actions, never by this form.
      if (level === 'output') {
        var st = val('status'); if (st) payload.status = st;
      }
      act('save').disabled = true;
      try {
        if (isEdit) {
          await RD.update(f.id, payload);
        } else {
          payload.id = val('id') || title;
          await RD.create(payload);
        }
        m.close();
        if (onDone) onDone();
      } catch (err) {
        showErr(err && err.message || 'Save failed.');
        act('save').disabled = false;
      }
    }
    function act(name) { return m.body.querySelector('[data-act="' + name + '"]'); }
  }

  /* ── public overview block composer (V3.552) ────────────────── */

  function openOverview(f, onDone) {
    var blocks = (f.overview_blocks || []).map(function (b) { return Object.assign({}, b); });
    var m = RD.modal({ title: 'Public overview — ' + f.title, wide: true });

    function mediaOptions(kind) {
      return (f.media || []).filter(function (md) { return md.kind === kind; })
        .map(function (md) { return '<option value="' + esc(md.id) + '">' + esc(md.caption || md.title || md.id) + '</option>'; }).join('');
    }

    function blockRow(b, i) {
      var inner = '';
      if (b.kind === 'text') {
        inner = richToolbar() + '<div class="rf-richtext-edit" contenteditable="true" data-block-html="' + i + '">' + (b.html ? RD.sanitizeHtml(b.html) : '') + '</div>';
      } else if (b.kind === 'youtube') {
        inner = '<label>YouTube video id or URL</label><input type="text" data-block-yt="' + i + '" value="' + esc(b.video_id || '') + '" placeholder="dQw4w9WgXcQ">' +
          '<label class="rf-inline-check"><input type="checkbox" data-block-autoplay="' + i + '"' + (b.autoplay !== false ? ' checked' : '') + '> Autoplay (muted)</label>';
      } else if (b.kind === 'image' || b.kind === 'video' || b.kind === 'html') {
        var opts = mediaOptions(b.kind);
        inner = '<label>Which ' + b.kind + ' (from the card\'s media)</label>' +
          (opts ? '<select data-block-media="' + i + '">' + opts + '</select>'
                : '<p class="rf-empty-sm">Upload a ' + b.kind + ' to this card first (Media → ＋ Add).</p>');
        if (opts && b.media_id) { /* selection restored after mount */ }
      }
      return '<div class="rf-block" data-block-idx="' + i + '">' +
        '<div class="rf-block-head"><span class="rf-block-kind">' + esc(b.kind) + '</span>' +
          '<span class="rf-block-move"><button type="button" data-move="up" data-i="' + i + '">▲</button>' +
          '<button type="button" data-move="down" data-i="' + i + '">▼</button>' +
          '<button type="button" class="rf-btn-danger" data-remove="' + i + '">✕</button></span></div>' +
        '<div class="rf-block-body">' + inner + '</div>' +
      '</div>';
    }

    function render() {
      m.body.innerHTML =
        '<p class="rf-hint">Build the page visitors see on the lab website. Text, images, videos, autoplay YouTube, and interactive HTML — drag order with ▲▼. Publish from the card when ready.</p>' +
        '<div class="rf-add-block">Add block: ' +
          ['text', 'image', 'video', 'youtube', 'html'].map(function (k) {
            return '<button type="button" class="rf-btn rf-btn-sm" data-add="' + k + '">＋ ' + k + '</button>';
          }).join('') +
        '</div>' +
        '<div data-blocks>' + (blocks.length ? blocks.map(blockRow).join('') : '<p class="rf-empty-sm">No blocks yet.</p>') + '</div>' +
        '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
          '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
          '<button type="button" class="rf-btn rf-btn-primary" data-act="save">Save overview</button>' +
        '</div>';
      wireRich(m.body);
      // restore media selections
      m.body.querySelectorAll('[data-block-media]').forEach(function (sel) {
        var i = +sel.getAttribute('data-block-media');
        if (blocks[i] && blocks[i].media_id) sel.value = blocks[i].media_id;
      });
    }

    function collect() {
      m.body.querySelectorAll('[data-block-idx]').forEach(function (row) {
        var i = +row.getAttribute('data-block-idx');
        var b = blocks[i]; if (!b) return;
        if (b.kind === 'text') { var d = row.querySelector('[data-block-html]'); if (d) b.html = RD.sanitizeHtml(d.innerHTML); }
        if (b.kind === 'youtube') {
          var yt = row.querySelector('[data-block-yt]'); if (yt) b.video_id = parseYouTube(yt.value);
          var ap = row.querySelector('[data-block-autoplay]'); b.autoplay = ap ? ap.checked : true;
        }
        if (b.kind === 'image' || b.kind === 'video' || b.kind === 'html') {
          var sel = row.querySelector('[data-block-media]'); if (sel) b.media_id = sel.value;
        }
      });
    }

    m.body.addEventListener('click', function (e) {
      var add = e.target.closest('[data-add]');
      if (add) { collect(); blocks.push(makeBlock(add.getAttribute('data-add'))); render(); return; }
      var rm = e.target.closest('[data-remove]');
      if (rm) { collect(); blocks.splice(+rm.getAttribute('data-remove'), 1); render(); return; }
      var mv = e.target.closest('[data-move]');
      if (mv) {
        collect();
        var i = +mv.getAttribute('data-i'), dir = mv.getAttribute('data-move') === 'up' ? -1 : 1, j = i + dir;
        if (j >= 0 && j < blocks.length) { var t = blocks[i]; blocks[i] = blocks[j]; blocks[j] = t; render(); }
        return;
      }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') === 'save') { save(); return; }
    });

    async function save() {
      collect();
      try {
        await RD.update(f.id, { overview_blocks: blocks });
        m.close();
        if (onDone) onDone();
      } catch (err) {
        var el = m.body.querySelector('.rf-modal-err'); if (el) { el.textContent = err && err.message; el.hidden = false; }
      }
    }
    render();
  }

  function makeBlock(kind) {
    var b = { id: RD.newId('bl'), kind: kind };
    if (kind === 'text') b.html = '';
    if (kind === 'youtube') { b.video_id = ''; b.autoplay = true; }
    if (kind === 'image' || kind === 'video' || kind === 'html') b.media_id = '';
    return b;
  }
  function parseYouTube(v) {
    v = String(v || '').trim();
    var m = v.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/);
    return m ? m[1] : v.replace(/[^\w-]/g, '').slice(0, 20);
  }

  window.RESEARCH_COMPOSER = {
    // seed (optional) pre-fills the new card — e.g. { links: { concept_ids:
    // [conceptId] } } so a "＋ New output" from a concept auto-links back.
    openCreate: function (level, onDone, seed) { openForm('create', Object.assign({ level: level }, seed || {}), onDone); },
    openEdit: function (foci, onDone) { openForm('edit', foci, onDone); },
    openOverview: openOverview,
    compileDescription: compileDescription,
    // V3.600 — the roadmap editor mounts its own contentEditable surfaces
    // and shares this toolbar so both authoring surfaces stay identical.
    richToolbar: richToolbar,
    wireRich: wireRich,
  };
})();
