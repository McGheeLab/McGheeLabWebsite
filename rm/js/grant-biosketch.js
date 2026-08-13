/* grant-biosketch.js — V3.178.
 *
 * NIH / NSF / DOD biosketch generator and editor. Pulls live data from
 * `cvData/{uid}` (shared with the public-site CV builder and cv-schemas.js)
 * and overlays user-edited variant state from
 * `biosketches/{uid}/variants/{vid}`.
 *
 * Per-variant editable fields:
 *   - personalStatement  (textarea)
 *   - contributions[]    (NIH only — title + narrative + citations)
 *   - synergisticActivities[]  (NSF only)
 *   - positions[]        (optional override of cvData-derived list)
 *   - productsOverride   (optional curated citation list)
 *
 * Everything else is rendered live from `cvData` at view time so a CV
 * edit elsewhere in RM (cv-editor.html) immediately reflects here.
 *
 * Public API on window.GRANT_BIOSKETCH (used by the HTML wrapper).
 */

(function () {
  'use strict';

  var COLL = 'biosketches';
  var SUB = 'variants';

  /* ---- escape helpers ---- */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function cleanText(s) {
    return (typeof cvCleanText === 'function') ? cvCleanText(s) : (s == null ? '' : String(s));
  }
  function escClean(s) { return esc(cleanText(s)); }

  /* ---- Firestore I/O ---- */

  async function loadCvSnapshot(uid) {
    if (!uid) throw new Error('loadCvSnapshot: uid required');
    var doc = await firebridge.getDoc('cvData', uid);
    return doc || { profile: {} };
  }

  async function listVariants(uid) {
    if (!uid) return [];
    var snap = await firebridge.subCollection(COLL, uid, SUB).get();
    return snap.docs
      .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .sort(function (a, b) {
        var ta = (a.updatedAt && a.updatedAt.toMillis) ? a.updatedAt.toMillis() : 0;
        var tb = (b.updatedAt && b.updatedAt.toMillis) ? b.updatedAt.toMillis() : 0;
        return tb - ta;
      });
  }

  async function loadVariant(uid, variantId) {
    var doc = await firebridge.subCollection(COLL, uid, SUB).doc(variantId).get();
    if (!doc.exists) return null;
    return Object.assign({ id: doc.id }, doc.data());
  }

  async function createVariant(uid, partial) {
    var stamp = firebase.firestore.FieldValue.serverTimestamp();
    var data = Object.assign({
      label: 'Untitled biosketch',
      mechanism: 'NIH-5pg',
      personalStatement: '',
      contributions: [],
      synergisticActivities: [],
      positions: null,
      productsOverride: null,
      grantDraftIds: [],
      generatedAt: stamp,
      sourceCvSnapshotHash: '',
      createdAt: stamp,
      updatedAt: stamp,
    }, partial || {});
    var ref = await firebridge.subCollection(COLL, uid, SUB).add(data);
    return ref.id;
  }

  async function saveVariant(uid, variantId, patch) {
    var stamp = firebase.firestore.FieldValue.serverTimestamp();
    var enriched = Object.assign({}, patch, { updatedAt: stamp });
    return firebridge.subCollection(COLL, uid, SUB).doc(variantId).update(enriched);
  }

  async function deleteVariant(uid, variantId) {
    return firebridge.subCollection(COLL, uid, SUB).doc(variantId).delete();
  }

  /* ---- Hash for stale-detection ---- */

  function cvSnapshotHash(cv) {
    try {
      var fields = [
        cv.profile && cv.profile.name,
        (cv.journals || []).length,
        (cv.conferences || []).length,
        (cv.grants || []).length,
        (cv.awards || []).length,
      ];
      var s = JSON.stringify(fields);
      var h = 0;
      for (var i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
      }
      return String(h);
    } catch (e) { return ''; }
  }

  /* ---- Derived data helpers ---- */

  function derivePositions(cv, variant) {
    if (variant && Array.isArray(variant.positions) && variant.positions.length) {
      return variant.positions;
    }
    var p = (cv && cv.profile) || {};
    var out = [];
    if (p.institution || p.title) {
      out.push({
        start: '', end: 'Present',
        title: cleanText(p.title) || 'Faculty',
        org: cleanText(p.institution) + (p.department ? (', ' + cleanText(p.department)) : ''),
      });
    }
    return out;
  }

  function deriveEducation(cv) {
    return (cv.courses || [])
      .filter(function (c) { return c.role === 'Instructor' || c.role === 'Co-Instructor'; })
      .map(function (c) { return c; });
  }

  function deriveHonors(cv) {
    return (cv.awards || [])
      .slice()
      .sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
  }

  function deriveTopPubs(cv, limit) {
    var pubs = []
      .concat((cv.journals || []).map(function (p) {
        return Object.assign({ _kind: 'journal' }, p);
      }))
      .concat((cv.conferences || []).map(function (p) {
        return Object.assign({ _kind: 'conf' }, p);
      }));
    pubs.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
    return pubs.slice(0, limit || 15);
  }

  function formatCitation(p) {
    var authors = cleanText(p.authors || '');
    var title = cleanText(p.title || '');
    var venue = cleanText(p.journal || p.conference || '');
    var year = p.year || '';
    var doi = p.doi ? (' doi:' + cleanText(p.doi)) : '';
    return [authors, '(' + year + ')', title + '.', venue + (venue ? '.' : '')].filter(Boolean).join(' ') + doi;
  }

  /* ---- Renderers ---- */

  function renderHeader(cv) {
    var p = (cv && cv.profile) || {};
    var name = escClean(p.name) || '(Set name in CV editor)';
    var role = escClean(p.title) || '';
    var org = [escClean(p.institution), escClean(p.department)].filter(Boolean).join(' · ');
    var contact = [escClean(p.email), escClean(p.orcid && ('ORCID: ' + p.orcid))].filter(Boolean).join(' · ');
    return ''
      + '<div class="gd-header">'
      +   '<div>'
      +     '<div class="gd-name">' + name + '</div>'
      +     '<div class="gd-position">' + role + (role && org ? ', ' : '') + org + '</div>'
      +   '</div>'
      +   '<div class="gd-position">' + contact + '</div>'
      + '</div>';
  }

  function renderPositionsList(positions) {
    if (!positions.length) {
      return '<p class="gd-empty">No positions on file. Add to CV → Profile to populate.</p>';
    }
    var rows = positions.map(function (pos) {
      var dates = [pos.start || '', pos.end || ''].filter(Boolean).join('–');
      return ''
        + '<tr>'
        +   '<td>' + esc(dates) + '</td>'
        +   '<td>' + esc(pos.title || '') + '</td>'
        +   '<td>' + esc(pos.org || '') + '</td>'
        + '</tr>';
    }).join('');
    return ''
      + '<table>'
      +   '<thead><tr><th style="width:18%">Dates</th><th style="width:32%">Title</th><th>Organization</th></tr></thead>'
      +   '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  function renderHonorsList(honors) {
    if (!honors.length) return '<p class="gd-empty">No awards on file.</p>';
    var rows = honors.map(function (a) {
      return '<li>' + esc(a.year || '') + ' — ' + escClean(a.title) + ', ' + escClean(a.awarding_body) + '</li>';
    }).join('');
    return '<ul>' + rows + '</ul>';
  }

  function renderCitationsByIds(cv, ids) {
    var allPubs = (cv.journals || []).concat(cv.conferences || []);
    if (!Array.isArray(ids) || !ids.length) return '';
    var found = ids.map(function (id) {
      for (var i = 0; i < allPubs.length; i++) {
        if (allPubs[i]._id === id) return allPubs[i];
      }
      return null;
    }).filter(Boolean);
    if (!found.length) return '';
    return '<ol>' + found.map(function (p) {
      return '<li class="gd-citation">' + esc(formatCitation(p)) + '</li>';
    }).join('') + '</ol>';
  }

  function renderTopPubsList(cv, limit) {
    var pubs = deriveTopPubs(cv, limit || 5);
    if (!pubs.length) return '<p class="gd-empty">No publications on file.</p>';
    return '<ol>' + pubs.map(function (p) {
      return '<li class="gd-citation">' + esc(formatCitation(p)) + '</li>';
    }).join('') + '</ol>';
  }

  function renderEditableTextarea(value, attrs) {
    attrs = attrs || {};
    var placeholder = attrs.placeholder || 'Click to edit…';
    var minLines = attrs.minLines || 4;
    var html = ''
      + '<div contenteditable="true" '
      +   'data-gd-edit="' + esc(attrs.bind || '') + '" '
      +   'style="min-height:' + (minLines * 14) + 'pt;white-space:pre-wrap;" '
      +   (attrs.maxLen ? ('data-maxlen="' + attrs.maxLen + '" ') : '')
      +   'data-placeholder="' + esc(placeholder) + '">'
      +   esc(value || '')
      + '</div>';
    return html;
  }

  function renderNIH5pg(cv, variant, opts) {
    var v = variant || {};
    opts = opts || {};
    var positions = derivePositions(cv, v);
    var honors = deriveHonors(cv);
    var contributions = Array.isArray(v.contributions) ? v.contributions : [];

    var html = '';
    if (!opts.omitHeader) html += renderHeader(cv);

    html += '<h2 class="gd-section">A. Personal Statement</h2>';
    html += renderEditableTextarea(v.personalStatement, {
      bind: 'personalStatement',
      placeholder: 'Briefly describe why you are well-suited for this role on this project…',
      minLines: 8,
      maxLen: 4000,
    });
    html += '<h3 class="gd-subsection">Most relevant publications</h3>';
    if (Array.isArray(v.productsOverride) && v.productsOverride.length) {
      html += renderCitationsByIds(cv, v.productsOverride);
    } else {
      html += renderTopPubsList(cv, 4);
    }

    html += '<h2 class="gd-section">B. Positions, Scientific Appointments, and Honors</h2>';
    html += '<h3 class="gd-subsection">Positions and Scientific Appointments</h3>';
    html += renderPositionsList(positions);
    html += '<h3 class="gd-subsection">Honors</h3>';
    html += renderHonorsList(honors);

    html += '<h2 class="gd-section">C. Contributions to Science</h2>';
    html += '<div data-gd-contributions="1">';
    if (!contributions.length) {
      html += '<p class="gd-empty">Add up to 5 contributions, each with a 1-paragraph narrative and 4 citations.</p>';
    }
    contributions.forEach(function (c, idx) {
      html += renderContributionCard(cv, c, idx);
    });
    html += '</div>';
    html += '<p style="margin-top:8pt;"><button class="btn" data-gd-action="add-contribution">+ Add contribution</button></p>';

    return html;
  }

  function renderContributionCard(cv, c, idx) {
    var citations = renderCitationsByIds(cv, c.citations || []);
    return ''
      + '<div class="gd-contribution" data-contribution-idx="' + idx + '">'
      +   '<div class="gd-contribution-head">'
      +     '<div class="gd-contribution-title" contenteditable="true" '
      +       'data-gd-edit-contrib="title" data-idx="' + idx + '">'
      +       esc(c.title || ('Contribution ' + (idx + 1)))
      +     '</div>'
      +     '<div class="gd-contribution-actions">'
      +       '<button data-gd-action="remove-contribution" data-idx="' + idx + '">×</button>'
      +     '</div>'
      +   '</div>'
      +   '<div contenteditable="true" data-gd-edit-contrib="narrative" data-idx="' + idx + '" '
      +     'style="min-height:60pt;white-space:pre-wrap;" '
      +     'data-placeholder="Narrative (≤2000 chars)…">'
      +     esc(c.narrative || '')
      +   '</div>'
      +   (citations ? '<div style="margin-top:4pt;">' + citations + '</div>' : '')
      + '</div>';
  }

  function renderNSF(cv, variant) {
    var v = variant || {};
    var positions = derivePositions(cv, v);
    var synActs = Array.isArray(v.synergisticActivities) ? v.synergisticActivities : [];

    var html = '';
    html += renderHeader(cv);

    html += '<h2 class="gd-section">Identifying Information</h2>';
    var p = cv.profile || {};
    html += '<p>' + escClean(p.name) + (p.orcid ? (' &middot; ORCID: ' + escClean(p.orcid)) : '')
         + (p.email ? (' &middot; ' + escClean(p.email)) : '') + '</p>';

    html += '<h2 class="gd-section">A. Professional Preparation</h2>';
    html += '<p class="gd-empty">Enter degrees in CV → Courses (role: Instructor) or override via the variant editor.</p>';

    html += '<h2 class="gd-section">B. Appointments and Positions</h2>';
    html += renderPositionsList(positions);

    html += '<h2 class="gd-section">C. Products</h2>';
    html += '<h3 class="gd-subsection">Closely related products</h3>';
    html += renderTopPubsList(cv, 5);
    html += '<h3 class="gd-subsection">Other significant products</h3>';
    html += renderTopPubsList(cv, 10);

    html += '<h2 class="gd-section">D. Synergistic Activities</h2>';
    html += '<div data-gd-synactivities="1">';
    if (!synActs.length) {
      html += '<p class="gd-empty">Add up to 5 synergistic activities (outreach, mentoring, service, software, etc.).</p>';
    }
    synActs.forEach(function (s, idx) {
      html += ''
        + '<div class="gd-contribution" data-synact-idx="' + idx + '">'
        +   '<div class="gd-contribution-head">'
        +     '<div contenteditable="true" data-gd-edit-synact data-idx="' + idx + '" '
        +       'style="flex:1 1 auto;min-height:30pt;white-space:pre-wrap;">'
        +       esc(s || '')
        +     '</div>'
        +     '<div class="gd-contribution-actions">'
        +       '<button data-gd-action="remove-synact" data-idx="' + idx + '">×</button>'
        +     '</div>'
        +   '</div>'
        + '</div>';
    });
    html += '</div>';
    html += '<p style="margin-top:8pt;"><button class="btn" data-gd-action="add-synact">+ Add activity</button></p>';

    return html;
  }

  function renderDOD(cv, variant) {
    // V1: NIH 5-page section tree with a DOD header note above it. Full
    // DOD CDMRP layout ships in V3.183 with the CDMRP template.
    var v = variant || {};
    return ''
      + renderHeader(cv)
      + '<p style="font-style:italic;color:#666;margin:6pt 0;">'
      +   'DOD biosketch (V1). Currently mirrors the NIH 5-page format. '
      +   'A CDMRP-specific template ships in V3.183.'
      + '</p>'
      + renderNIH5pg(cv, v, { omitHeader: true });
  }

  function renderForMechanism(cv, variant) {
    if (!variant) return '<div class="grantdoc-empty-state"><h2>No variant selected</h2><p>Pick a biosketch from the list or click "+ New".</p></div>';
    switch (variant.mechanism) {
      case 'NSF': return renderNSF(cv, variant);
      case 'DOD': return renderDOD(cv, variant);
      case 'NIH-5pg':
      default:    return renderNIH5pg(cv, variant);
    }
  }

  /* ---- Wire-up: bind contenteditable surfaces to variant state ---- */

  function attachEditHandlers(rootEl, getVariant, scheduleSave) {
    if (!rootEl) return;

    // Simple top-level fields (personalStatement).
    rootEl.querySelectorAll('[data-gd-edit]').forEach(function (el) {
      var key = el.getAttribute('data-gd-edit');
      if (!key) return;
      el.addEventListener('input', function () {
        var v = getVariant();
        if (!v) return;
        v[key] = el.innerText;
        scheduleSave({ [key]: el.innerText });
      });
    });

    // Contribution title / narrative.
    rootEl.querySelectorAll('[data-gd-edit-contrib]').forEach(function (el) {
      var field = el.getAttribute('data-gd-edit-contrib');
      var idx = Number(el.getAttribute('data-idx') || 0);
      el.addEventListener('input', function () {
        var v = getVariant();
        if (!v) return;
        v.contributions = v.contributions || [];
        v.contributions[idx] = v.contributions[idx] || {};
        v.contributions[idx][field] = el.innerText;
        scheduleSave({ contributions: v.contributions });
      });
    });

    // Synergistic activity.
    rootEl.querySelectorAll('[data-gd-edit-synact]').forEach(function (el) {
      var idx = Number(el.getAttribute('data-idx') || 0);
      el.addEventListener('input', function () {
        var v = getVariant();
        if (!v) return;
        v.synergisticActivities = v.synergisticActivities || [];
        v.synergisticActivities[idx] = el.innerText;
        scheduleSave({ synergisticActivities: v.synergisticActivities });
      });
    });

    // Action buttons (add/remove contribution + synact).
    rootEl.querySelectorAll('[data-gd-action]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var action = btn.getAttribute('data-gd-action');
        var v = getVariant();
        if (!v) return;
        if (action === 'add-contribution') {
          v.contributions = v.contributions || [];
          if (v.contributions.length >= 5) {
            if (window.TOAST) window.TOAST.warn('NIH limits Contributions to Science to 5 entries.');
            return;
          }
          v.contributions.push({ title: '', narrative: '', citations: [] });
          scheduleSave({ contributions: v.contributions }, /* rerender */ true);
        } else if (action === 'remove-contribution') {
          var idx = Number(btn.getAttribute('data-idx') || 0);
          v.contributions = (v.contributions || []).filter(function (_, i) { return i !== idx; });
          scheduleSave({ contributions: v.contributions }, true);
        } else if (action === 'add-synact') {
          v.synergisticActivities = v.synergisticActivities || [];
          if (v.synergisticActivities.length >= 5) {
            if (window.TOAST) window.TOAST.warn('NSF limits Synergistic Activities to 5 entries.');
            return;
          }
          v.synergisticActivities.push('');
          scheduleSave({ synergisticActivities: v.synergisticActivities }, true);
        } else if (action === 'remove-synact') {
          var sidx = Number(btn.getAttribute('data-idx') || 0);
          v.synergisticActivities = (v.synergisticActivities || []).filter(function (_, i) { return i !== sidx; });
          scheduleSave({ synergisticActivities: v.synergisticActivities }, true);
        }
      });
    });
  }

  /* ---- Public API ---- */

  window.GRANT_BIOSKETCH = {
    loadCvSnapshot: loadCvSnapshot,
    listVariants: listVariants,
    loadVariant: loadVariant,
    createVariant: createVariant,
    saveVariant: saveVariant,
    deleteVariant: deleteVariant,
    cvSnapshotHash: cvSnapshotHash,
    renderNIH5pg: renderNIH5pg,
    renderNSF: renderNSF,
    renderDOD: renderDOD,
    renderForMechanism: renderForMechanism,
    attachEditHandlers: attachEditHandlers,
    formatCitation: formatCitation,
  };
})();

/* ============================================================
   Page controller — boots when DOMContentLoaded and firebridge auth
   resolves. Renders the variant rail + active variant paper.
   ============================================================ */

(function () {
  'use strict';

  var state = {
    uid: null,
    cv: null,
    variants: [],
    active: null,        // current variant object (live, mutated on input)
    saveTimer: 0,
    saveStatus: 'idle',  // 'idle' | 'saving' | 'saved' | 'error'
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(s) {
    state.saveStatus = s;
    var el = $('gd-savestate');
    if (!el) return;
    el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'error' ? 'Save failed' : '';
  }

  function renderVariantList() {
    var ul = $('gd-variant-list');
    if (!ul) return;
    if (!state.variants.length) {
      ul.innerHTML = '<li class="gd-empty">No biosketches yet. Click + New to start.</li>';
      return;
    }
    ul.innerHTML = state.variants.map(function (v) {
      var active = state.active && state.active.id === v.id ? ' active' : '';
      return ''
        + '<li class="' + active + '" data-vid="' + v.id + '">'
        +   '<span class="gd-vlabel">' + (v.label ? v.label.replace(/[<>&"]/g, '') : '(unnamed)') + '</span>'
        +   '<span class="gd-vmech">' + (v.mechanism || 'NIH-5pg') + '</span>'
        + '</li>';
    }).join('');
    ul.querySelectorAll('li[data-vid]').forEach(function (li) {
      li.addEventListener('click', function () { selectVariant(li.getAttribute('data-vid')); });
    });
  }

  function renderPaper() {
    var paper = $('gd-paper');
    if (!paper) return;
    if (!state.active) {
      paper.innerHTML = '<div class="grantdoc-empty-state">'
        + '<h2>Pick or create a biosketch</h2>'
        + '<p>Variants are stored per-mechanism (NIH 5-page, NSF, DOD).</p></div>';
      return;
    }
    paper.innerHTML = window.GRANT_BIOSKETCH.renderForMechanism(state.cv, state.active);
    window.GRANT_BIOSKETCH.attachEditHandlers(paper, function () { return state.active; }, scheduleSave);
  }

  function scheduleSave(patch, rerender) {
    if (!state.uid || !state.active) return;
    clearTimeout(state.saveTimer);
    setStatus('saving');
    state.saveTimer = setTimeout(async function () {
      try {
        await window.GRANT_BIOSKETCH.saveVariant(state.uid, state.active.id, patch);
        setStatus('saved');
        // Reflect updatedAt locally so list ordering matches without reload.
        state.active.updatedAt = { toMillis: function () { return Date.now(); } };
        if (rerender) {
          // Bump local active in state.variants then redraw.
          state.variants = state.variants.map(function (v) { return v.id === state.active.id ? state.active : v; });
          renderPaper();
          renderVariantList();
        }
      } catch (e) {
        console.error('[grant-biosketch] save failed:', e);
        setStatus('error');
      }
    }, 600);
  }

  async function selectVariant(vid) {
    var fresh = await window.GRANT_BIOSKETCH.loadVariant(state.uid, vid);
    if (!fresh) return;
    state.active = fresh;
    renderVariantList();
    renderPaper();
    // Update title meta line.
    var label = $('gd-active-label');
    if (label) label.value = fresh.label || '';
    var mech = $('gd-active-mech');
    if (mech) mech.value = fresh.mechanism || 'NIH-5pg';
  }

  async function createNew() {
    var label = prompt('Biosketch label (e.g. "NSF CAREER 2026")?', 'Untitled biosketch');
    if (label == null) return;
    var mechSel = $('gd-new-mech');
    var mechanism = mechSel ? mechSel.value : 'NIH-5pg';
    var vid = await window.GRANT_BIOSKETCH.createVariant(state.uid, { label: label || 'Untitled biosketch', mechanism: mechanism });
    state.variants = await window.GRANT_BIOSKETCH.listVariants(state.uid);
    selectVariant(vid);
  }

  async function deleteActive() {
    if (!state.active) return;
    if (!confirm('Delete biosketch "' + (state.active.label || '') + '"? This cannot be undone.')) return;
    await window.GRANT_BIOSKETCH.deleteVariant(state.uid, state.active.id);
    state.active = null;
    state.variants = await window.GRANT_BIOSKETCH.listVariants(state.uid);
    renderVariantList();
    renderPaper();
  }

  function onMechChanged() {
    if (!state.active) return;
    var mech = $('gd-active-mech').value;
    state.active.mechanism = mech;
    scheduleSave({ mechanism: mech }, true);
  }

  function onLabelChanged() {
    if (!state.active) return;
    var label = $('gd-active-label').value;
    state.active.label = label;
    scheduleSave({ label: label });
    renderVariantList();
  }

  async function init() {
    if (firebridge.requireSignIn) firebridge.requireSignIn('Sign in to edit biosketches.');
    firebridge.onAuth(async function (user, profile) {
      if (!user) {
        $('gd-paper').innerHTML = '<div class="grantdoc-empty-state"><h2>Sign in to use biosketches</h2></div>';
        return;
      }
      state.uid = user.uid;

      try {
        state.cv = await window.GRANT_BIOSKETCH.loadCvSnapshot(state.uid);
      } catch (e) {
        console.warn('[grant-biosketch] CV load failed:', e);
        state.cv = { profile: {} };
      }
      state.variants = await window.GRANT_BIOSKETCH.listVariants(state.uid);
      renderVariantList();
      renderPaper();

      $('gd-new-btn').addEventListener('click', createNew);
      $('gd-delete-btn').addEventListener('click', deleteActive);
      $('gd-active-mech').addEventListener('change', onMechChanged);
      $('gd-active-label').addEventListener('input', onLabelChanged);
      $('gd-print-btn').addEventListener('click', function () { window.print(); });
      $('gd-export-btn').addEventListener('click', function () {
        if (!state.active) return;
        if (!window.GRANT_BIOSKETCH_EXPORT) {
          alert('Export module not loaded.');
          return;
        }
        window.GRANT_BIOSKETCH_EXPORT.downloadDocx(state.cv, state.active);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
