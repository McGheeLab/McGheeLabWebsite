/* page-collections.js — pageId → Firestore-collection mapping.
 *
 * V3.212 — hard data-layer enforcement of the page-allow matrix for
 * collaborators. When admin ticks a pageId in admin-permissions.html,
 * admin-permissions.js denormalizes the page's required Firestore
 * collections via this map and writes them to
 * userPermissions/{uid}.allowedCollections. firestore.rules' new
 * `collabMay(coll)` helper reads that array to enforce access.
 *
 * Owner-locked subcollections (userData/{uid}/...) are intentionally
 * NOT listed — those rules already gate by `isOwner`. The public-read
 * `users` collection is also omitted since collaborators can already
 * read it (same exposure as anonymous users). `labConfig` is included
 * everywhere because every page hits the workflow chip strip + nav,
 * which read labConfig.
 *
 * Pages absent from the map yield an empty collection list when
 * granted — the admin matrix UI flags this with a "no data access"
 * warning so admin notices, rather than silently breaking the page.
 *
 * Loaded after page-registry.js so PAGE_REGISTRY is available for the
 * "list every pageId" helpers below. Both files declare globals on
 * window; later loaders (admin-permissions.js) read both. */

(function () {

  /* pageId → array of Firestore collection names the page actively
   * reads or writes. Subcollection paths are NOT enumerated — listing
   * the parent collection grants access to its subcollections under
   * the matching V3.211/V3.212 rule clauses. Keep entries sorted
   * within each section.
   *
   * Collection names match the `match /<name>/{docId}` blocks in
   * firestore.rules — don't invent names, look them up. */
  var PAGE_COLLECTIONS = {
    /* ── Library + papers ───────────────────────────────────── */
    'library':                  ['items', 'labConfig'],
    'library__tab__comments':   ['items', 'papers', 'labConfig'],
    'library-paper':            ['items', 'papers', 'labConfig'],
    'sharing':                  ['papers', 'labConfig'],
    'paper-builder':            ['drafts', 'draftAuthors', 'items', 'labConfig', 'paperTemplates', 'papers', 'projects'],

    /* ── Lab operations ─────────────────────────────────────── */
    'chat':                     ['chatChannels', 'chatConfig', 'chatMessages', 'chatReadState', 'chatUserMeta', 'labConfig'],
    'lab-notebook':             ['inventory', 'labConfig', 'projects', 'protocols'],
    'meetings':                 ['labConfig', 'meetingConfig', 'meetings'],
    'pmr':                      ['labConfig', 'papers', 'projects', 'protocols'],
    'protocols':                ['labConfig', 'protocols'],
    'tasks':                    ['labConfig'],  // tasks live in userData/{uid}/tasks (owner-locked)

    /* ── Research mgmt ──────────────────────────────────────── */
    'compliance':               ['compliance', 'complianceSubmissions', 'labConfig'],
    'equipment':                ['equipment', 'equipmentBookings', 'equipmentSettings', 'equipmentTraining', 'labConfig'],
    'funding':                  ['funding', 'labConfig', 'projects'],
    'inventory':                ['inventory', 'labConfig', 'projects'],
    'procurement':              ['inventory', 'labConfig', 'procurementTickets'],
    'projects':                 ['items', 'labConfig', 'projects'],
    'scheduler':                ['labConfig', 'schedules'],

    /* ── Grants ─────────────────────────────────────────────── */
    'biosketch':                ['biosketches', 'cvData', 'labConfig'],
    'facilities-doc':           ['facilitiesDocs', 'labConfig'],
    'grant-doc':                ['grantDrafts', 'funding', 'labConfig', 'paperTemplates', 'projects'],
    'grants':                   ['funding', 'grantDrafts', 'labConfig', 'projects'],

    /* ── Roster / overview ──────────────────────────────────── */
    'dashboard':                ['compliance', 'funding', 'importantPeople', 'inventory', 'items', 'labConfig', 'projects'],
    'people':                   ['labConfig'],  // users is public-read

    /* ── Calendar / activity (mostly user-scoped) ───────────── */
    'activity-overview':                ['labConfig'],
    'activity-overview__tab__tracker':  ['labConfig'],  // trackerData / trackerEntries are owner-locked
    'activity-overview__tab__email':    ['labConfig'],  // userData/{uid}/emailArchive is owner-locked
    'calendar':                         ['labConfig'],

    /* ── User-scoped utilities (own data is owner-locked) ──── */
    'cv-editor':                        ['labConfig'],  // cvData/{uid} owner-locked
    'profile':                          ['labConfig'],  // static — no Firestore
    'settings':                         ['labConfig'],  // userSettings/{uid} owner-locked; users public-read
    'finance':                          ['labConfig'],  // userData/{uid}/finance* owner-locked

    /* ── Standup / huddle ──────────────────────────────────── */
    'huddle':                           ['huddleConfig', 'huddleHelpRequests', 'huddlePlans', 'huddleRundown', 'labConfig'],

    /* ── Misc operational ──────────────────────────────────── */
    'chemicals':                        ['inventory', 'labConfig'],
    'split-view':                       ['labConfig'],  // shell-only — iframes own their data deps

    /* ── Training: V3.162 curriculum (mostly static) ───────── */
    'training':                              ['labConfig'],
    'training-paper-writing':                ['labConfig'],
    'training-phd-triangle':                 ['labConfig'],
    'training-scientific-communication':     ['labConfig'],
    'training-microscope-basics':            ['labConfig'],
    'training-image-analysis-basic':         ['labConfig'],
    'training-image-analysis-intermediate':  ['labConfig'],
    'training-image-analysis-advanced':      ['labConfig'],
    'training-spheroid-sizes':               ['labConfig'],
    'training-image-train':                  ['labConfig'],
    'training-cell-tracker':                 ['labConfig'],
    'training-confocal':                     ['labConfig'],
    'training-imagej-fiji':                  ['labConfig'],
    'training-epifluorescence':              ['labConfig'],
    'training-rm-essentials':                ['labConfig'],
    'training-rm-papers':                    ['labConfig'],
    'training-rm-tasks-pmr':                 ['labConfig'],
    'training-rm-daily-research':            ['labConfig'],
  };

  /* Union of all collections needed for the given pageIds. Pages not
   * in the map contribute nothing. Returns a sorted, deduped string[]
   * (deterministic so userPermissions writes are diff-friendly). */
  function collectionsFor(pageIds) {
    if (!Array.isArray(pageIds)) return [];
    var set = Object.create(null);
    for (var i = 0; i < pageIds.length; i++) {
      var pid = pageIds[i];
      var colls = PAGE_COLLECTIONS[pid];
      if (!colls) continue;
      for (var j = 0; j < colls.length; j++) set[colls[j]] = true;
    }
    return Object.keys(set).sort();
  }

  /* For admin matrix UI: pageIds that have NO mapping entry. Granting
   * any of these warns the admin "this page won't have data access
   * unless you also add its collections to page-collections.js." */
  function unmappedPageIds(pageIds) {
    if (!Array.isArray(pageIds)) return [];
    return pageIds.filter(function (pid) {
      return !PAGE_COLLECTIONS[pid];
    });
  }

  window.PAGE_COLLECTIONS = {
    map: PAGE_COLLECTIONS,
    collectionsFor: collectionsFor,
    unmappedPageIds: unmappedPageIds,
  };
})();
