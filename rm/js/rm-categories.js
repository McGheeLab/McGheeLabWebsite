/* ================================================================
   rm-categories.js — Bridge from RM's labConfig/categorySchema
   to the tree shape every lab-app expects.
   ================================================================
   RM stores a 4-level taxonomy at:

     labConfig/categorySchema  → {
       version: 1,
       categories: {
         research: {
           label: "Research", color: "#1e40af",
           activities: {
             grant:  { context_axis: "sponsor",
                       context_seed: ["nih","nsf","onr",...] },
             paper:  { ... },
             ...
           }
         },
         teaching: {...},
         ...
       }
     }

   Lab-apps expect:

     [
       { id, label, color, children: [
           { id, label, children: [
               { id, label, children: [] },
               ...
           ]},
           ...
       ]},
       ...
     ]

   This bridge fetches the RM schema once per page load (Firestore
   permits authenticated reads on labConfig), converts it, and caches
   it on window.McgheeLab.RmCategories.

   Used by apps/activity-tracker/app.js so the tracker shows the SAME
   categories as the rest of RM. Settings-panel edits are disabled in
   the tracker — categories are managed in RM (data/settings/
   category_schema.json + Settings page) and propagate from there.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.RmCategories = (function () {
  var _tree = null;          // converted tree, ready for tracker consumption
  var _raw  = null;          // original Firestore doc data (for debugging)
  var _loadPromise = null;   // single in-flight load

  // Acronyms that should stay uppercase in display labels.
  var ACRONYMS = {
    'nih': 'NIH', 'nsf': 'NSF', 'onr': 'ONR', 'dod': 'DoD', 'nasa': 'NASA',
    'doe': 'DoE', 'afrl': 'AFRL', 'r01': 'R01', 'r21': 'R21',
    'bme': 'BME', 'ame': 'AME', 'phd': 'PhD', 'lor': 'LoR',
    'ip': 'IP', 'pi': 'PI', 'co-pi': 'Co-PI', 'ubrp': 'UBRP',
    'aacr': 'AACR', 'aps': 'APS', 'sem': 'SEM', 'swces': 'SWCES',
    'coe': 'CoE', 'hr': 'HR', 'it': 'IT',
  };

  /* "course-prep" → "Course Prep"; "nih" → "NIH"; preserve common acronyms. */
  function prettifyId(id) {
    if (!id) return '';
    var lc = String(id).toLowerCase();
    if (ACRONYMS[lc]) return ACRONYMS[lc];
    return lc.split(/[-_]/g).map(function (w) {
      if (ACRONYMS[w]) return ACRONYMS[w];
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  /* Convert RM's nested-dict schema into the array-of-tree shape the
     tracker (and other lab-apps) expect. Three levels deep — L4
     specifics are open-ended in RM and discovered from existing
     entries, so we don't seed any here. */
  function buildTree(schema) {
    var cats = (schema && schema.categories) || {};
    var out = [];
    Object.keys(cats).forEach(function (catId) {
      var cat = cats[catId] || {};
      var node = {
        id: catId,
        label: cat.label || prettifyId(catId),
        color: cat.color || '#94a3b8',
        children: [],
      };
      var acts = cat.activities || {};
      Object.keys(acts).forEach(function (actId) {
        var act = acts[actId] || {};
        var actNode = {
          id: actId,
          label: prettifyId(actId),
          children: [],
        };
        var seeds = Array.isArray(act.context_seed) ? act.context_seed : [];
        seeds.forEach(function (seedId) {
          actNode.children.push({
            id: seedId,
            label: prettifyId(seedId),
            children: [],
          });
        });
        node.children.push(actNode);
      });
      out.push(node);
    });
    return out;
  }

  /* Load the schema. Caches the converted tree for the page lifetime;
     subsequent callers get the same Promise. Falls back to a small
     hard-coded set of top-level categories if Firestore is unreachable
     (offline, rules deny, etc.) so the UI never breaks. */
  function load() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async function () {
      try {
        if (typeof firebase === 'undefined' || !firebase.firestore) {
          throw new Error('Firebase not loaded');
        }
        var doc = await firebase.firestore()
          .collection('labConfig').doc('categorySchema').get();
        if (!doc.exists) {
          throw new Error('labConfig/categorySchema does not exist');
        }
        _raw  = doc.data() || {};
        _tree = buildTree(_raw);
        if (!_tree.length) throw new Error('schema is empty');
        console.info('[RmCategories] loaded', _tree.length, 'top-level categories from labConfig/categorySchema:',
          _tree.map(function (n) { return n.id + '(' + (n.children || []).length + ')'; }).join(', '));
        return _tree;
      } catch (err) {
        console.warn('[RmCategories] FALLBACK STUB — Firestore read failed:', err.message,
          '\nThis means the activity-tracker tree won\'t match RM. To fix:',
          '\n  1. Open /rm/pages/admin-migrate.html',
          '\n  2. Migrate settings/category_schema.json to Firestore',
          '\n  3. Reload this page.');
        _tree = [
          { id: 'service',  label: 'Service',  color: '#5b21b6', children: [] },
          { id: 'research', label: 'Research', color: '#1e40af', children: [] },
          { id: 'teaching', label: 'Teaching', color: '#92400e', children: [] },
          { id: 'admin',    label: 'Administration', color: '#374151', children: [] },
          { id: 'personal', label: 'Personal', color: '#991b1b', children: [] },
          { id: 'noise',    label: 'Noise',    color: '#64748b', children: [] },
          { id: 'unknown',  label: 'Unclassified', color: '#78350f', children: [] },
        ];
        return _tree;
      }
    })();
    return _loadPromise;
  }

  function get()      { return _tree; }
  function getRaw()   { return _raw; }
  function isReady()  { return _tree !== null; }
  function reload()   { _loadPromise = null; _tree = null; _raw = null; return load(); }

  return { load: load, get: get, getRaw: getRaw, isReady: isReady, reload: reload, prettifyId: prettifyId };
})();
