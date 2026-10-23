/* grant-facilities.js — V3.178.
 *
 * "Facilities and Other Resources" + "Equipment" document generator.
 * Aggregates three live data sources into editable HTML sections:
 *
 *   - inventory  (collection 'inventory')  → major equipment items
 *   - equipment  (collection 'equipment')  → bookable shared instruments
 *   - users      (collection 'users')      → personnel narrative
 *
 * Each `facilitiesDocs/{docId}` is one named document the user can attach
 * to a future grant draft (V3.180+). Sections are stored as HTML strings
 * so users can hand-tune the auto-generated paragraphs without losing
 * structure.
 *
 * Regenerate-from-source: re-running the aggregator computes a hash of
 * each source collection and rewrites a section only if (a) the user
 * hasn't customized it (the saved HTML still equals the previously-auto-
 * generated HTML) OR (b) the user explicitly clicks "Regenerate".
 *
 * Public API on window.GRANT_FACILITIES.
 */

(function () {
  'use strict';

  var COLL = 'facilitiesDocs';

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---- Source loaders ---- */

  async function loadInventory() {
    try {
      // V3.646 — `inventory` is ONE collection with a `kind` discriminator
      // (item | chemical | stock). This read was unfiltered, so all 158
      // chemicals were already leaking into the Facilities & Equipment
      // boilerplate, and V3.646's lab-made stock batches would have followed.
      var snap = await firebridge.db().collection('inventory')
        .where('kind', '==', 'item').get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {
      console.warn('[grant-facilities] inventory load failed:', e);
      return [];
    }
  }

  async function loadEquipment() {
    try {
      var snap = await firebridge.db().collection('equipment').orderBy('name').get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {
      console.warn('[grant-facilities] equipment load failed:', e);
      return [];
    }
  }

  async function loadPeople() {
    try {
      var snap = await firebridge.db().collection('users').get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {
      console.warn('[grant-facilities] users load failed:', e);
      return [];
    }
  }

  /* ---- Lightweight hash for stale-detection ---- */

  function hashOf(arr, fields) {
    try {
      var items = arr.map(function (x) {
        var sub = {};
        fields.forEach(function (f) { sub[f] = x[f]; });
        return sub;
      });
      var s = JSON.stringify(items);
      var h = 0;
      for (var i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
      }
      return String(h);
    } catch (e) { return ''; }
  }

  /* ---- Auto-generators ---- */

  function autoEquipmentSection(inventoryItems, equipmentItems) {
    var html = '<p>The lab maintains the following major equipment available for this project:</p>';

    // 1. Bookable shared instruments (richer descriptions, take priority).
    if (equipmentItems.length) {
      html += '<h3>Shared instruments</h3><ul>';
      equipmentItems.forEach(function (e) {
        var bits = [];
        bits.push('<strong>' + esc(e.name || '(unnamed)') + '</strong>');
        if (e.description) bits.push(esc(e.description));
        if (e.location) bits.push('Location: ' + esc(e.location));
        html += '<li>' + bits.join(' — ') + '</li>';
      });
      html += '</ul>';
    }

    // 2. Inventory items in category 'equipment' OR unit_price ≥ 5000.
    var majorInv = inventoryItems.filter(function (it) {
      return it.category === 'equipment' || (Number(it.unit_price || 0) >= 5000);
    });

    if (majorInv.length) {
      // Group by subcategory (fallback to category).
      var groups = {};
      majorInv.forEach(function (it) {
        var key = (it.subcategory || it.category || 'other').replace(/_/g, ' ');
        if (!groups[key]) groups[key] = [];
        groups[key].push(it);
      });
      var keys = Object.keys(groups).sort();
      keys.forEach(function (k) {
        html += '<h3>' + esc(k.charAt(0).toUpperCase() + k.slice(1)) + '</h3><ul>';
        groups[k].forEach(function (it) {
          var bits = [];
          bits.push('<strong>' + esc(it.name || '(unnamed)') + '</strong>');
          if (it.vendor) bits.push(esc(it.vendor));
          if (it.catalogue_number) bits.push('cat# ' + esc(it.catalogue_number));
          if (it.description) bits.push(esc(it.description));
          var locs = (it.locations || []).map(function (l) { return l.name; }).filter(Boolean);
          if (locs.length) bits.push('Location: ' + esc(locs.join(', ')));
          html += '<li>' + bits.join(' — ') + '</li>';
        });
        html += '</ul>';
      });
    }

    if (!equipmentItems.length && !majorInv.length) {
      html += '<p class="gd-empty">No equipment found in <code>equipment</code> or <code>inventory</code> collections.</p>';
    }

    return html;
  }

  function autoFacilitiesSection(users) {
    var members = users.filter(function (u) { return LAB_USERS.isVisible(u); });
    var byCat = { postdoc: 0, grad: 0, undergrad: 0, highschool: 0, pi: 0 };
    members.forEach(function (u) {
      var c = u.category || 'guest';
      if (byCat[c] != null) byCat[c]++;
    });

    var personnelBits = [];
    if (byCat.pi)        personnelBits.push(byCat.pi + ' principal investigator' + (byCat.pi > 1 ? 's' : ''));
    if (byCat.postdoc)   personnelBits.push(byCat.postdoc + ' postdoctoral researcher' + (byCat.postdoc > 1 ? 's' : ''));
    if (byCat.grad)      personnelBits.push(byCat.grad + ' graduate student' + (byCat.grad > 1 ? 's' : ''));
    if (byCat.undergrad) personnelBits.push(byCat.undergrad + ' undergraduate researcher' + (byCat.undergrad > 1 ? 's' : ''));
    if (byCat.highschool) personnelBits.push(byCat.highschool + ' high-school student researcher' + (byCat.highschool > 1 ? 's' : ''));

    var personnelLine = personnelBits.length
      ? ('The lab currently consists of ' + personnelBits.join(', ') + '.')
      : 'Personnel composition can be edited here.';

    return ''
      + '<p>The McGhee Lab is housed in the Biomedical Sciences Research Laboratory '
      + '(BSRL) at the University of Arizona, Tucson, AZ. The lab occupies '
      + 'dedicated wet-lab space with adjacent computational and imaging '
      + 'facilities. ' + personnelLine + '</p>'
      + '<p>The lab has access to shared institutional resources including '
      + 'biomedical imaging cores, cell culture facilities, and high-performance '
      + 'computing resources at the University of Arizona Research Computing '
      + 'Center (UA HPC).</p>'
      + '<p><em>Edit this paragraph to add room numbers, square footage, '
      + 'biosafety level, and other institution-specific facility details.</em></p>';
  }

  function autoComputingSection() {
    return ''
      + '<p>The lab maintains a dedicated computational infrastructure for '
      + 'image analysis, data processing, and machine learning workflows. '
      + 'Resources include:</p>'
      + '<ul>'
      + '<li>Workstations with NVIDIA GPUs for deep learning–based image '
      + 'analysis (e.g., cell segmentation, traction force microscopy).</li>'
      + '<li>Network-attached storage (NAS) for collaborative data sharing.</li>'
      + '<li>Access to the University of Arizona High-Performance Computing '
      + '(HPC) cluster for compute-intensive batch jobs.</li>'
      + '<li>Cloud storage and synchronized backups for raw and processed '
      + 'experimental data.</li>'
      + '</ul>'
      + '<p><em>Edit to add specific GPU models, storage capacity, software '
      + 'licenses, etc.</em></p>';
  }

  function autoOfficeSection() {
    return ''
      + '<p>The PI maintains a private office in BSRL with desktop computing '
      + 'and standard office equipment. Lab personnel have access to shared '
      + 'desk space adjacent to the wet-lab, equipped with workstations, '
      + 'monitors, and a printer.</p>'
      + '<p><em>Edit to add specifics on office square footage, conference '
      + 'rooms, and shared meeting spaces.</em></p>';
  }

  function autoOtherResourcesSection() {
    return ''
      + '<p>The University of Arizona provides extensive institutional resources '
      + 'including the BIO5 Institute, the University of Arizona Health '
      + 'Sciences (UAHS) shared cores, the Imaging Cores, Statistical '
      + 'Consulting Services, the Office of Research Innovation & Impact, '
      + 'and the Sponsored Projects Services office for grant administration. '
      + 'Library, IT, and grant administration services are available to '
      + 'all faculty and students.</p>'
      + '<p><em>Edit to call out specific cores, collaborator labs, and '
      + 'consortium resources relevant to your project.</em></p>';
  }

  /* ---- Firestore I/O ---- */

  async function loadAll() {
    try {
      var snap = await firebridge.db().collection(COLL).orderBy('updatedAt', 'desc').get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) {
      // Fallback when no docs exist or index missing.
      var snap = await firebridge.db().collection(COLL).get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    }
  }

  async function load(docId) {
    return firebridge.getDoc(COLL, docId);
  }

  async function create(partial) {
    var user = firebridge.getUser();
    if (!user) throw new Error('Sign in required to create a facilities doc.');
    var inv = await loadInventory();
    var eq = await loadEquipment();
    var people = await loadPeople();

    var sections = {
      facilities:     autoFacilitiesSection(people),
      equipment:      autoEquipmentSection(inv, eq),
      computing:      autoComputingSection(),
      office:         autoOfficeSection(),
      otherResources: autoOtherResourcesSection(),
    };

    var sourceHashes = {
      inventory: hashOf(inv, ['name', 'category', 'subcategory', 'unit_price', 'locations']),
      equipment: hashOf(eq, ['name', 'description', 'location', 'category']),
      people:    hashOf(people, ['role', 'category']),
    };

    var stamp = firebase.firestore.FieldValue.serverTimestamp();
    var data = Object.assign({
      label: 'Facilities & Other Resources',
      scope: 'all',
      sections: sections,
      autoSections: Object.assign({}, sections),  // remember the auto-generated version for stale-detection
      sourceHashes: sourceHashes,
      attachedTo: [],
      generatedAt: stamp,
      createdBy: user.uid,
      createdAt: stamp,
      updatedAt: stamp,
    }, partial || {});

    var ref = await firebridge.db().collection(COLL).add(data);
    return ref.id;
  }

  async function save(docId, patch) {
    var stamp = firebase.firestore.FieldValue.serverTimestamp();
    var enriched = Object.assign({}, patch, { updatedAt: stamp });
    return firebridge.db().collection(COLL).doc(docId).update(enriched);
  }

  async function regenerate(docId) {
    var doc = await load(docId);
    if (!doc) throw new Error('Facilities doc not found.');
    var inv = await loadInventory();
    var eq = await loadEquipment();
    var people = await loadPeople();

    var fresh = {
      facilities:     autoFacilitiesSection(people),
      equipment:      autoEquipmentSection(inv, eq),
      computing:      autoComputingSection(),
      office:         autoOfficeSection(),
      otherResources: autoOtherResourcesSection(),
    };

    // For each section, replace user-content ONLY if the prior auto-generated
    // HTML matches what the user has saved (i.e. they haven't customized it).
    var nextSections = Object.assign({}, doc.sections || {});
    var auto = doc.autoSections || {};
    Object.keys(fresh).forEach(function (key) {
      var userVal = nextSections[key];
      var oldAuto = auto[key];
      if (userVal == null || userVal === '' || userVal === oldAuto) {
        nextSections[key] = fresh[key];
      }
    });

    var sourceHashes = {
      inventory: hashOf(inv, ['name', 'category', 'subcategory', 'unit_price', 'locations']),
      equipment: hashOf(eq, ['name', 'description', 'location', 'category']),
      people:    hashOf(people, ['role', 'category']),
    };

    var stamp = firebase.firestore.FieldValue.serverTimestamp();
    await firebridge.db().collection(COLL).doc(docId).update({
      sections: nextSections,
      autoSections: fresh,
      sourceHashes: sourceHashes,
      generatedAt: stamp,
      updatedAt: stamp,
    });
    return { sections: nextSections, autoSections: fresh, sourceHashes: sourceHashes };
  }

  async function remove(docId) {
    return firebridge.db().collection(COLL).doc(docId).delete();
  }

  window.GRANT_FACILITIES = {
    loadAll: loadAll,
    load: load,
    create: create,
    save: save,
    regenerate: regenerate,
    remove: remove,
    autoFacilities: autoFacilitiesSection,
    autoEquipment: autoEquipmentSection,
    autoComputing: autoComputingSection,
    autoOffice: autoOfficeSection,
    autoOtherResources: autoOtherResourcesSection,
  };
})();

/* ============================================================
   Page controller
   ============================================================ */

(function () {
  'use strict';

  var state = {
    uid: null,
    docs: [],
    active: null,
    saveTimer: 0,
  };

  function $(id) { return document.getElementById(id); }

  var SECTION_ORDER = [
    { key: 'facilities',     label: 'Facilities' },
    { key: 'equipment',      label: 'Equipment' },
    { key: 'computing',      label: 'Computing' },
    { key: 'office',         label: 'Office' },
    { key: 'otherResources', label: 'Other Resources' },
  ];

  function setStatus(s) {
    var el = $('gd-savestate');
    if (!el) return;
    el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'error' ? 'Save failed' : '';
  }

  function renderDocList() {
    var ul = $('gd-variant-list');
    if (!ul) return;
    if (!state.docs.length) {
      ul.innerHTML = '<li class="gd-empty">No facilities docs yet. Click + New to generate one.</li>';
      return;
    }
    ul.innerHTML = state.docs.map(function (d) {
      var active = state.active && state.active.id === d.id ? ' active' : '';
      var label = (d.label || '(unnamed)').replace(/[<>&"]/g, '');
      return ''
        + '<li class="' + active + '" data-did="' + d.id + '">'
        +   '<span class="gd-vlabel">' + label + '</span>'
        +   '<span class="gd-vmech">' + (d.scope || 'all') + '</span>'
        + '</li>';
    }).join('');
    ul.querySelectorAll('li[data-did]').forEach(function (li) {
      li.addEventListener('click', function () { selectDoc(li.getAttribute('data-did')); });
    });
  }

  function renderPaper() {
    var paper = $('gd-paper');
    if (!paper) return;
    if (!state.active) {
      paper.innerHTML = '<div class="grantdoc-empty-state">'
        + '<h2>Pick or create a facilities doc</h2>'
        + '<p>Each doc is a Facilities & Other Resources artifact for a proposal.</p></div>';
      return;
    }
    var d = state.active;
    var html = '';
    html += '<div class="gd-header">'
         +   '<div><div class="gd-name">' + (d.label || '').replace(/[<>&"]/g, '') + '</div>'
         +   '<div class="gd-position">Facilities &amp; Other Resources</div></div>'
         +   '<div class="gd-position">Generated ' + formatStamp(d.generatedAt) + '</div>'
         + '</div>';

    SECTION_ORDER.forEach(function (sec) {
      html += '<h2 class="gd-section">' + sec.label + '</h2>';
      html += '<div contenteditable="true" data-gd-edit-section="' + sec.key + '" style="min-height:30pt;">'
           +   ((d.sections && d.sections[sec.key]) || '')
           + '</div>';
    });

    paper.innerHTML = html;
    paper.querySelectorAll('[data-gd-edit-section]').forEach(function (el) {
      var key = el.getAttribute('data-gd-edit-section');
      el.addEventListener('input', function () {
        state.active.sections = state.active.sections || {};
        state.active.sections[key] = el.innerHTML;
        scheduleSave({ ['sections.' + key]: el.innerHTML });
      });
    });
  }

  function formatStamp(ts) {
    if (!ts) return '—';
    try {
      var ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : Date.parse(ts));
      var d = new Date(ms);
      return d.toLocaleDateString();
    } catch (e) { return '—'; }
  }

  function scheduleSave(patch) {
    if (!state.uid || !state.active) return;
    clearTimeout(state.saveTimer);
    setStatus('saving');
    state.saveTimer = setTimeout(async function () {
      try {
        await window.GRANT_FACILITIES.save(state.active.id, patch);
        setStatus('saved');
      } catch (e) {
        console.error('[grant-facilities] save failed:', e);
        setStatus('error');
      }
    }, 600);
  }

  async function selectDoc(docId) {
    var fresh = await window.GRANT_FACILITIES.load(docId);
    if (!fresh) return;
    state.active = fresh;
    renderDocList();
    renderPaper();
    var label = $('gd-active-label');
    if (label) label.value = fresh.label || '';
  }

  async function createNew() {
    var label = prompt('Label for this facilities doc?', 'Facilities & Other Resources');
    if (label == null) return;
    var did = await window.GRANT_FACILITIES.create({ label: label || 'Facilities & Other Resources' });
    state.docs = await window.GRANT_FACILITIES.loadAll();
    selectDoc(did);
  }

  async function regenActive() {
    if (!state.active) return;
    if (!confirm('Re-run the auto-generator? Sections you have hand-edited are preserved; only untouched sections will be rewritten.')) return;
    try {
      var result = await window.GRANT_FACILITIES.regenerate(state.active.id);
      state.active.sections = result.sections;
      state.active.autoSections = result.autoSections;
      state.active.sourceHashes = result.sourceHashes;
      renderPaper();
      setStatus('saved');
    } catch (e) {
      console.error('[grant-facilities] regenerate failed:', e);
      setStatus('error');
    }
  }

  async function deleteActive() {
    if (!state.active) return;
    if (!confirm('Delete this facilities doc?')) return;
    await window.GRANT_FACILITIES.remove(state.active.id);
    state.active = null;
    state.docs = await window.GRANT_FACILITIES.loadAll();
    renderDocList();
    renderPaper();
  }

  function onLabelChanged() {
    if (!state.active) return;
    var label = $('gd-active-label').value;
    state.active.label = label;
    scheduleSave({ label: label });
    renderDocList();
  }

  async function init() {
    if (firebridge.requireSignIn) firebridge.requireSignIn('Sign in to edit facilities documents.');
    firebridge.onAuth(async function (user, profile) {
      if (!user) {
        $('gd-paper').innerHTML = '<div class="grantdoc-empty-state"><h2>Sign in to use facilities docs</h2></div>';
        return;
      }
      state.uid = user.uid;
      state.docs = await window.GRANT_FACILITIES.loadAll();
      renderDocList();
      renderPaper();

      $('gd-new-btn').addEventListener('click', createNew);
      $('gd-regen-btn').addEventListener('click', regenActive);
      $('gd-delete-btn').addEventListener('click', deleteActive);
      $('gd-active-label').addEventListener('input', onLabelChanged);
      $('gd-print-btn').addEventListener('click', function () { window.print(); });
      $('gd-export-btn').addEventListener('click', function () {
        if (!state.active) return;
        if (!window.GRANT_BIOSKETCH_EXPORT) {
          alert('Export module not loaded.');
          return;
        }
        window.GRANT_BIOSKETCH_EXPORT.downloadFacilitiesDocx(state.active);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
