#!/usr/bin/env node
/* migrate_user_permissions_add_collections.js
 *
 * V3.212 — one-shot migration that walks every userPermissions/{uid}
 * doc in Firestore and writes an `allowedCollections` array derived
 * from the doc's existing `allowedPageIds` via the page → collection
 * mapping below.
 *
 * MUST RUN BEFORE V3.213 RULES DEPLOY. V3.213 will start gating reads
 * with `collabMay(coll)`, and any collaborator without a populated
 * `allowedCollections` array would lose all data access on the deploy.
 *
 * Usage:
 *   # 1. Dry run (no writes; prints what it would do)
 *   node scripts/migrate_user_permissions_add_collections.js
 *
 *   # 2. Commit (actually writes)
 *   node scripts/migrate_user_permissions_add_collections.js --commit
 *
 * Prerequisites:
 *   - npm install firebase-admin   (in this directory, or globally)
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a Firebase
 *     service account JSON for the mcgheelab-f56cc project, OR drop
 *     service-account.json in this scripts/ dir (gitignored).
 *
 * The script writes ONLY the new `allowedCollections` field via
 * .set({...}, {merge:true}). Existing `allowedPageIds` is untouched.
 * Worst case (bug in the mapping): re-run after fixing the mapping;
 * no destructive ops.
 *
 * KEEP IN SYNC: this mapping is a hand-mirror of
 * `rm/js/page-collections.js`'s PAGE_COLLECTIONS. The
 * "Recompute all collaborator grants" admin button in
 * admin-permissions.html does the same denormalization at runtime
 * using the browser-loaded map; this script does it server-side for
 * the initial backfill before any rules-deploy. If you edit the
 * browser map, mirror the change here and re-run with --commit. */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

/* ── page → collection map (mirrors rm/js/page-collections.js) ─── */

const PAGE_COLLECTIONS = {
  // Library + papers
  'library':                  ['items', 'labConfig'],
  'library__tab__comments':   ['items', 'papers', 'labConfig'],
  'library-paper':            ['items', 'papers', 'labConfig'],
  'sharing':                  ['papers', 'labConfig'],
  'paper-builder':            ['drafts', 'draftAuthors', 'items', 'labConfig', 'paperTemplates', 'papers', 'projects'],

  // Lab operations
  'chat':                     ['chatChannels', 'chatConfig', 'chatMessages', 'chatReadState', 'chatUserMeta', 'labConfig'],
  'lab-notebook':             ['inventory', 'labConfig', 'projects', 'protocols'],
  'meetings':                 ['labConfig', 'meetingConfig', 'meetings'],
  'pmr':                      ['labConfig', 'papers', 'projects', 'protocols'],
  'protocols':                ['labConfig', 'protocols'],
  'tasks':                    ['labConfig'],

  // Research mgmt
  'compliance':               ['compliance', 'complianceSubmissions', 'labConfig'],
  'equipment':                ['equipment', 'equipmentBookings', 'equipmentSettings', 'equipmentTraining', 'labConfig'],
  'funding':                  ['funding', 'labConfig', 'projects'],
  'inventory':                ['inventory', 'labConfig', 'projects'],
  'procurement':              ['inventory', 'labConfig', 'procurementTickets'],
  'projects':                 ['items', 'labConfig', 'projects'],
  'scheduler':                ['labConfig', 'schedules'],

  // Grants
  'biosketch':                ['biosketches', 'cvData', 'labConfig'],
  'facilities-doc':           ['facilitiesDocs', 'labConfig'],
  'grant-doc':                ['grantDrafts', 'funding', 'labConfig', 'paperTemplates', 'projects'],
  'grants':                   ['funding', 'grantDrafts', 'labConfig', 'projects'],

  // Roster / overview
  'dashboard':                ['compliance', 'funding', 'importantPeople', 'inventory', 'items', 'labConfig', 'projects'],
  'people':                   ['labConfig'],

  // Calendar / activity (mostly user-scoped — owner-locked subcollections excluded)
  'activity-overview':                ['labConfig'],
  'activity-overview__tab__tracker':  ['labConfig'],
  'activity-overview__tab__email':    ['labConfig'],
  'calendar':                         ['labConfig'],

  // User-scoped utilities (own data is owner-locked already)
  'cv-editor':                        ['labConfig'],
  'profile':                          ['labConfig'],
  'settings':                         ['labConfig'],
  'finance':                          ['labConfig'],

  // Standup / huddle
  'huddle':                           ['huddleConfig', 'huddleHelpRequests', 'huddlePlans', 'huddleRundown', 'labConfig'],

  // Misc operational
  'chemicals':                        ['inventory', 'labConfig'],
  'split-view':                       ['labConfig'],

  // Training: V3.162 curriculum (mostly static placeholders)
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

function collectionsFor(pageIds) {
  if (!Array.isArray(pageIds)) return [];
  const set = new Set();
  for (const pid of pageIds) {
    const colls = PAGE_COLLECTIONS[pid];
    if (!colls) continue;
    for (const c of colls) set.add(c);
  }
  return Array.from(set).sort();
}

/* ── bootstrap ──────────────────────────────────────────────────── */

const DRY_RUN = !process.argv.includes('--commit');

function initFirebase() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return;
  }
  const localKey = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(localKey)) {
    admin.initializeApp({
      credential: admin.credential.cert(require(localKey)),
    });
    return;
  }
  console.error(
    'No credentials. Set GOOGLE_APPLICATION_CREDENTIALS or drop\n' +
    'a service-account.json in scripts/ (gitignored).'
  );
  process.exit(1);
}

async function main() {
  initFirebase();
  const db = admin.firestore();

  console.log('Mode: ' + (DRY_RUN ? 'DRY RUN (no writes)' : 'COMMIT (writing)'));
  console.log('---');

  const snap = await db.collection('userPermissions').get();
  let touched = 0, unchanged = 0, skipped = 0, unmappedWarn = 0;

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const pageIds = Array.isArray(data.allowedPageIds) ? data.allowedPageIds : [];
    if (!pageIds.length) {
      skipped++;
      console.log('[skip ] ' + doc.id + ' — no allowedPageIds');
      continue;
    }

    const unmapped = pageIds.filter(p => !PAGE_COLLECTIONS[p]);
    if (unmapped.length) {
      unmappedWarn++;
      console.warn('[warn ] ' + doc.id + ' — unmapped pageIds: ' + unmapped.join(', '));
    }

    const computed = collectionsFor(pageIds);
    const existing = Array.isArray(data.allowedCollections)
      ? data.allowedCollections.slice().sort()
      : [];
    const same = computed.length === existing.length
      && computed.every((c, i) => c === existing[i]);
    if (same) {
      unchanged++;
      console.log('[same ] ' + doc.id + ' — collections already match (' + computed.length + ')');
      continue;
    }

    console.log('[' + (DRY_RUN ? 'DRY  ' : 'WRITE') + '] ' + doc.id +
      ' — pages=' + pageIds.length + ' → collections=' + computed.length);
    console.log('         ' + JSON.stringify(computed));

    if (!DRY_RUN) {
      await doc.ref.set({
        allowedCollections: computed,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    touched++;
  }

  console.log('---');
  console.log('Done. touched=' + touched + ' unchanged=' + unchanged +
    ' skipped=' + skipped + ' unmapped-warnings=' + unmappedWarn);
  console.log('Mode: ' + (DRY_RUN ? 'DRY RUN' : 'COMMIT'));
  if (DRY_RUN) {
    console.log('\nRe-run with --commit to actually write.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
