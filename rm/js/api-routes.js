/* api-routes.js — registers Firestore routes for migrated JSON paths.
 *
 * Loaded after api-firestore-adapter.js. Each entry tells the adapter how to
 * map api.load("settings/category_schema.json") (and friends) onto Firestore.
 *
 * `shadowJson: true` means the adapter:
 *   - reads Firestore primary, but falls back to legacy /api/data/{path}
 *     when Firestore is empty (handles "not migrated yet" state)
 *   - on save, writes BOTH Firestore and the JSON file
 * Once a path is stable in Firestore for ~7 days (verified via the admin
 * migrate page), flip `shadowJson` to false to drop the JSON write.
 *
 * Single-doc routes carry `doc:` and store the file's whole top-level object
 * as one Firestore doc.
 *
 * Collection routes shard each row of the file's top-level array into its
 * own Firestore doc keyed by `id`. `wrapKey` is the original JSON top-level
 * key so reads return `{ <wrapKey>: [...] }` and existing call sites work.
 *
 * Discriminated collections (projects, funding, compliance, inventory) merge
 * multiple JSON files into one Firestore collection, separated by a `where`
 * clause on a `kind`/`type`/`protocolType` field. The `discriminator`
 * stamps that field on every row at write time.
 */

(function () {
  if (typeof api === 'undefined' || typeof api.registerRoute !== 'function') {
    console.warn('[api-routes] adapter not loaded; skipping route registration.');
    return;
  }

  /* Cache TTL presets — applied via `cache: SHORT/MEDIUM/LONG` on routes that
   * are loaded frequently and tolerate a few minutes of staleness. The adapter
   * (api-firestore-adapter.js) reads from IndexedDB when the entry is fresh,
   * refreshes in the background when stale, and clears the cache on save.
   *
   * Choose by data shape:
   *   SHORT  (5 min)  — rarely-edited but updated often (live sync handles
   *                     edits within the session via api.save's invalidation)
   *   MEDIUM (30 min) — mostly-static lab-shared collections
   *   LONG   (4 hr)   — almost-never-changes (taxonomy, important people)
   *
   * User-scope routes get caching too; LOCAL_CACHE prefixes keys with the
   * uid so different accounts can't see each other's cache. */
  var SHORT  = { ttlMs: 5 * 60 * 1000 };
  var MEDIUM = { ttlMs: 30 * 60 * 1000 };
  var LONG   = { ttlMs: 4 * 60 * 60 * 1000 };

  /* ── SHARED data (Phase 2) ────────────────────────────────── */

  // Categories — single docs, no wrap key (file content === doc data).
  // Schema rarely changes; cache long. Seeds (per-user category extensions)
  // load on every category-bearing page render.
  api.registerRoute('settings/category_schema.json', {
    scope: 'lab', collection: 'labConfig', doc: 'categorySchema',
    shadowJson: true, cache: LONG,
  });
  api.registerRoute('settings/category_seeds.json', {
    scope: 'lab', collection: 'labConfig', doc: 'categorySeeds',
    shadowJson: true, cache: MEDIUM,
  });

  // People — `people` collection, kind=member|alumni
  api.registerRoute('people/roster.json', {
    scope: 'lab', collection: 'people', wrapKey: 'members',
    where: ['kind', '==', 'member'],
    discriminator: { field: 'kind', value: 'member' },
    shadowJson: true,
    cache: MEDIUM,
  });
  api.registerRoute('people/alumni.json', {
    scope: 'lab', collection: 'people', wrapKey: 'alumni',
    where: ['kind', '==', 'alumni'],
    discriminator: { field: 'kind', value: 'alumni' },
    shadowJson: true,
    cache: LONG,
  });

  // Projects — single `projects` collection with type discriminator
  api.registerRoute('projects/papers.json', {
    scope: 'lab', collection: 'projects', wrapKey: 'papers',
    where: ['type', '==', 'paper'],
    discriminator: { field: 'type', value: 'paper' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('projects/courses.json', {
    scope: 'lab', collection: 'projects', wrapKey: 'courses',
    where: ['type', '==', 'course'],
    discriminator: { field: 'type', value: 'course' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('projects/infrastructure.json', {
    scope: 'lab', collection: 'projects', wrapKey: 'infrastructure',
    where: ['type', '==', 'infrastructure'],
    discriminator: { field: 'type', value: 'infrastructure' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('projects/tools.json', {
    scope: 'lab', collection: 'projects', wrapKey: 'tools',
    where: ['type', '==', 'tool'],
    discriminator: { field: 'type', value: 'tool' },
    shadowJson: true, cache: MEDIUM,
  });

  // Funding — single `funding` collection with kind discriminator
  api.registerRoute('funding/proposals.json', {
    scope: 'lab', collection: 'funding', wrapKey: 'proposals',
    where: ['kind', '==', 'proposal'],
    discriminator: { field: 'kind', value: 'proposal' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('funding/awards.json', {
    scope: 'lab', collection: 'funding', wrapKey: 'awards',
    where: ['kind', '==', 'award'],
    discriminator: { field: 'kind', value: 'award' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('funding/accounts.json', {
    scope: 'lab', collection: 'funding', wrapKey: 'accounts',
    where: ['kind', '==', 'account'],
    discriminator: { field: 'kind', value: 'account' },
    shadowJson: true, cache: MEDIUM,
  });

  // Compliance — single `compliance` collection with protocolType discriminator
  api.registerRoute('compliance/iacuc.json', {
    scope: 'lab', collection: 'compliance', wrapKey: 'protocols',
    where: ['protocolType', '==', 'iacuc'],
    discriminator: { field: 'protocolType', value: 'iacuc' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('compliance/irb.json', {
    scope: 'lab', collection: 'compliance', wrapKey: 'protocols',
    where: ['protocolType', '==', 'irb'],
    discriminator: { field: 'protocolType', value: 'irb' },
    shadowJson: true, cache: MEDIUM,
  });

  // Important people — each file is a heterogeneous doc (context + contacts)
  // so store the whole file as one Firestore doc.
  ['collaborators', 'donors', 'initiatives', 'regents'].forEach(function (key) {
    api.registerRoute('important-people/' + key + '.json', {
      scope: 'lab', collection: 'importantPeople', doc: key,
      shadowJson: true, cache: LONG,
    });
  });

  // Service activities — committees, conferences, reviews, outreach.
  ['committees', 'conferences', 'reviews', 'outreach'].forEach(function (key) {
    api.registerRoute('service/' + key + '.json', {
      scope: 'lab', collection: 'labConfig', doc: 'service-' + key,
      shadowJson: true, cache: MEDIUM,
    });
  });

  // Inventory — `inventory` collection with kind discriminator (item|chemical).
  // Items.json: 3,481 docs ≈ 1+ MB on the wire, the most-impactful cacheable.
  api.registerRoute('inventory/items.json', {
    scope: 'lab', collection: 'inventory', wrapKey: 'items',
    where: ['kind', '==', 'item'],
    discriminator: { field: 'kind', value: 'item' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('inventory/chemicals.json', {
    scope: 'lab', collection: 'inventory', wrapKey: 'chemicals',
    where: ['kind', '==', 'chemical'],
    discriminator: { field: 'kind', value: 'chemical' },
    shadowJson: true, cache: MEDIUM,
  });
  api.registerRoute('inventory/taxonomy.json', {
    scope: 'lab', collection: 'labConfig', doc: 'inventoryTaxonomy',
    shadowJson: true, cache: LONG,
  });

  // Items (root unified items.json — papers, grants, courses, tools).
  api.registerRoute('items.json', {
    scope: 'lab', collection: 'items', wrapKey: 'items',
    shadowJson: true, cache: MEDIUM,
  });

  // V3.206 — library-list fast path. The library page only needs paper
  // items, not grants/courses/tools, and never the abstract / references
  // bulk on the list view. Server-side `where('type','==','paper')` cuts
  // the read to library-relevant docs; library-extras.js handles abstract
  // + references via a per-item subdoc. LONG cache because the cheap
  // MAX(updatedAt) probe handles staleness on the route's collection,
  // so a 4-hour TTL just amortizes the probe across many visits.
  api.registerRoute('library/papers.json', {
    scope: 'lab', collection: 'items', wrapKey: 'papers',
    where: ['type', '==', 'paper'],
    discriminator: { field: 'type', value: 'paper' },
    shadowJson: true, cache: LONG,
  });

  // V3.363 — lab-shared library groups (the library page's groups shelf).
  // Admin-published, every lab member reads. New collection with no
  // legacy JSON, so no shadowJson. Rules: librarySharedGroups → read
  // isLabMember, write isAdmin. Per-user groups don't come through here —
  // they live in userSettings/{uid}.library (LIBRARY_PREFS).
  api.registerRoute('library/shared_groups.json', {
    scope: 'lab', collection: 'librarySharedGroups', wrapKey: 'groups',
    cache: MEDIUM,
  });

  // Lab roster — full users collection cached MEDIUM (30 min). Pre-Phase B
  // ~9 pages each called firebridge.getAll('users') independently → ~9
  // redundant collection reads per session. Now: one cached fetch shared by
  // all call sites (lab-tasks, projects, pmr, dashboard, people, cv-overview,
  // task-assign, activity-summary, tasks-buckets). Consumers filter
  // client-side for role !== 'guest' as needed; we deliberately do NOT add
  // a Firestore where('role','!=','guest') because (1) Firestore !=
  // excludes docs missing the field, and (2) some pages legitimately need
  // the full roster (admin user-management). MAX(updatedAt) probe still
  // applies — role/category changes invalidate the cache on next probe.
  api.registerRoute('lab/users.json', {
    scope: 'lab', collection: 'users', wrapKey: 'users',
    cache: MEDIUM,
  });

  // Schedulers (V3.47 — ported from /apps/scheduler/'s "My Schedulers" tab).
  // Lab-scope; the rules at firestore.rules:189 allow public read (so guest
  // invite links resolve unauthenticated). Caching the full list is fine —
  // small lab won't have hundreds of schedulers, and the My Schedulers tab
  // filters client-side to ownerUid===uid (admin sees all). MEDIUM cache;
  // LIVE_SYNC keeps the list current within a session. Editor view bypasses
  // this route and does direct getDoc() / where('scheduleId','==',id) so it
  // sees writes from other users immediately without invalidating the
  // cached list.
  api.registerRoute('scheduler/list.json', {
    scope: 'lab', collection: 'schedules', wrapKey: 'schedules',
    cache: MEDIUM,
  });

  // Procurement tickets (V3.44) — unified request → order → receive →
  // place → inventory lifecycle. SHORT cache because pipeline state
  // changes often (every transition is a write); LIVE_SYNC keeps the
  // page current within a session. Lab-scope; shadowJson off (this is
  // a new collection, no JSON shadow).
  api.registerRoute('procurement/tickets.json', {
    scope: 'lab', collection: 'procurementTickets', wrapKey: 'tickets',
    cache: SHORT,
  });

  // Lab Meetings (V3.41 — ported from /apps/meetings/). Both collections were
  // Firestore-only from day one (the lab app wrote direct), so shadowJson is
  // off (default). MEDIUM cache for the list — meetings are added in batches
  // by the semester-generate flow and lightly mutated thereafter (agenda
  // toggles, action items, presenter assignments); LIVE_SYNC keeps active
  // editing in real time. LONG cache for the singleton config doc, which
  // changes only when an admin edits semester defaults / rotation order.
  api.registerRoute('meetings/list.json', {
    scope: 'lab', collection: 'meetings', wrapKey: 'meetings',
    cache: MEDIUM,
  });
  api.registerRoute('meetings/config.json', {
    scope: 'lab', collection: 'meetingConfig', doc: 'settings',
    cache: LONG,
  });

  // Protocols (V3.113) — protocols.io-style lab protocol authoring. New
  // top-level `protocols` collection; no JSON shadow (born in Firestore).
  // The list view loads list rows from this route; the editor reads/writes
  // the full protocol doc directly via firebridge.db().collection('protocols')
  // because it pairs with Yjs subcollections at protocols/{id}/yjs_*.
  // MEDIUM cache: protocols are edited in bursts; LIVE_SYNC keeps the open
  // list current within a session.
  api.registerRoute('protocols/list.json', {
    scope: 'lab', collection: 'protocols', wrapKey: 'protocols',
    cache: MEDIUM,
  });

  /* ── PERSONAL data (Phase 3) ──────────────────────────────────
   * Stored under userData/{uid}/<subcollection> — strictly owner read/write
   * per firestore.rules. Admin has NO blanket read; users opt into sharing
   * by setting `sharedWithUids[]` on individual docs.
   *
   * shadowJson is intentionally OMITTED on user-scope routes after the
   * initial migration completed. Reason: shadow-writing per-user data into
   * lab-shared `data/<file>.json` is a privacy bug — postdoc saves would
   * overwrite Alex's local archive. Once Firestore is the source of truth
   * for personal data (which it is post-Phase 3), the legacy JSON should
   * be read-only / archive-only.  Reads still work because empty-Firestore
   * fallback only kicks in when shadowJson is set. With it off, an empty
   * subcollection just returns [] — which is correct for new users.
   */

  // Tasks — buckets tree + flat tasks. Bucket-based current model lives in
  // userData/{uid}/buckets (each task builder = doc). Legacy flat tasks
  // (inbox, daily/weekly/monthly/annual archives) merge into
  // userData/{uid}/tasks with a `bucket` discriminator so they're queryable
  // as one timeline. Tasks routes use MEDIUM cache because live-sync
  // (api.subscribe) already keeps active editing in real time — cache
  // invalidation happens via api.save AND via the onSnapshot listener.
  // SHORT (5 min) was too aggressive, forcing a full ~80 KB buckets fetch
  // on every page nav after each edit.
  // Note: wrapKey was renamed `projects` → `taskBuilders` in V3.128 to free
  // "project" for the actual research-projects model in projects/*.json.
  api.registerRoute('tasks/buckets.json', {
    scope: 'user', subcollection: 'buckets', wrapKey: 'taskBuilders',
    cache: MEDIUM,
  });
  // 'assigned' is Phase 8 cross-user task assignment — when a teammate
  // creates a task in your queue, it lands here. Schema (createdByUid +
  // assignedToUid + rules) is ready today; the UI picker lands later.
  ['inbox', 'daily', 'weekly', 'monthly', 'annual', 'assigned'].forEach(function (bucket) {
    api.registerRoute('tasks/' + bucket + '.json', {
      scope: 'user', subcollection: 'tasks', wrapKey: 'tasks',
      where: ['bucket', '==', bucket],
      discriminator: { field: 'bucket', value: bucket },
      cache: MEDIUM,
    });
  });
  // V3.313 — Task marketplace board (FuturePlan 04). Lab-scope, one doc
  // per cross-user post (offer / request / handoff). Registered so the
  // explorer + migrate tooling can see the collection; the board page
  // itself (rm/js/task-market.js) uses direct per-doc firebridge.db()
  // writes because the rules enforce per-post status transitions that a
  // whole-list api.save would violate. No JSON shadow (born-Firestore).
  api.registerRoute('tasks/market.json', {
    scope: 'lab', collection: 'taskMarket', wrapKey: 'posts',
    cache: SHORT,
  });
  api.registerRoute('tasks/email_tasks.json', {
    scope: 'user', subcollection: 'emailTasks', wrapKey: 'email_tasks',
    cache: LONG,  // 3,446 historical entries — rarely changes
  });
  api.registerRoute('tasks/pinned_buckets.json', {
    scope: 'user', subcollection: 'pinnedBuckets', wrapKey: 'buckets',
    cache: MEDIUM,
  });

  // Calendar — deadlines, archive (calendar_archive subtree migrates later).
  api.registerRoute('calendar/deadlines.json', {
    scope: 'user', subcollection: 'calendarDeadlines', wrapKey: 'deadlines',
    cache: SHORT,
  });

  // Activity ledger — high-volume append-only. Hundreds of KB on a typical
  // account; was the silent 440 KB read on every email-review boot. MEDIUM
  // cache + adapter probe means subsequent loads are 1 read instead of N.
  api.registerRoute('activity_ledger.json', {
    scope: 'user', subcollection: 'activityLedger', wrapKey: 'activities',
    cache: MEDIUM,
  });
  // Activity links — single doc, complex object structure.
  api.registerRoute('activity_links.json', {
    scope: 'user', subcollection: 'profile', doc: 'activityLinks',
    cache: MEDIUM,
  });

  // Year review — one doc per year + an index + overrides. Each file's whole
  // top-level object becomes the Firestore doc data. Year list spans 2024 (the
  // earliest year with data) through (current year + 1) so the list always
  // includes the current planning year without requiring annual edits to this
  // file. The +1 lookahead lets the user start filling in next year's plan
  // before Jan 1.
  var _yrEnd = new Date().getFullYear() + 1;
  for (var _yr = 2024; _yr <= _yrEnd; _yr++) {
    (function (yr) {
      api.registerRoute('year_review/' + yr + '.json', {
        scope: 'user', subcollection: 'yearReview', doc: yr,
        cache: MEDIUM,
      });
    })(String(_yr));
  }
  api.registerRoute('year_review/index.json', {
    scope: 'user', subcollection: 'yearReview', doc: 'index',
    cache: MEDIUM,
  });
  api.registerRoute('year_review/overrides.json', {
    scope: 'user', subcollection: 'yearReview', doc: 'overrides',
    cache: SHORT,
  });

  // Career — tenure dossier (single doc, multi-key object).
  api.registerRoute('career/tenure_dossier.json', {
    scope: 'user', subcollection: 'career', doc: 'tenureDossier',
    cache: MEDIUM,
  });

  // PMR — Project Management Reports, one Firestore doc per (researcher, period).
  // The index is pre-registered; individual period docs are registered lazily
  // by js/pmr.js via api.registerRoute('pmr/<periodId>.json', { scope:'user',
  // subcollection:'pmr', doc:'<periodId>' }) so arbitrary semester / rotation /
  // custom-range ids don't have to be enumerated upfront.
  api.registerRoute('pmr/_index.json', {
    scope: 'user', subcollection: 'pmr', doc: '_index',
    cache: SHORT,
  });

  // Lab Notebook (ELN) — per-user notebook entries. Same shape as PMR: a
  // single `_index` doc holds the lightweight summary list for the left
  // rail (single-read load), and each entry doc lives at
  // userData/{uid}/notebook/{entryId}. Entry IDs are kebab slugs
  // (`nb-YYYY-MM-DD-...`), unbounded, so per-entry routes are registered
  // lazily by js/lab-notebook.js via
  //   api.registerRoute('notebook/<entryId>.json',
  //     { scope:'user', subcollection:'notebook', doc:'<entryId>' });
  // The `_index` doc lives in the same `notebook` subcollection — entry
  // IDs always start with `nb-` so they can never collide with `_index`.
  api.registerRoute('notebook/_index.json', {
    scope: 'user', subcollection: 'notebook', doc: '_index',
    cache: SHORT,
  });

  // My Day (V3.526) — per-user day plans + distribution prefs. Item docs
  // live at userData/{uid}/dayPlans/{itemId} and are read/written directly
  // by js/day-distribute.js (task-pmr-sync pattern — direct firebridge.db()
  // refs, so host pages don't need this route table). Only the prefs doc is
  // registered here, for admin-migrate visibility + consistency.
  api.registerRoute('my_day/prefs.json', {
    scope: 'user', subcollection: 'dayPlans', doc: '_prefs',
    cache: SHORT,
  });

  // Settings / integrations — moved per-user. Each user has their own list
  // of email/calendar/repo connections. The legacy lab-shared
  // data/settings/connections.json is read-only after migration.
  api.registerRoute('settings/connections.json', {
    scope: 'user', subcollection: 'connections', wrapKey: 'connections',
    cache: MEDIUM,
  });

  // Finance — personal receipts / travel / spending project tracking. Each
  // user has their own reimbursement queue.
  api.registerRoute('finance/receipts.json', {
    scope: 'user', subcollection: 'financeReceipts', wrapKey: 'receipts',
    cache: MEDIUM,
  });
  api.registerRoute('finance/travel.json', {
    scope: 'user', subcollection: 'financeTravel', wrapKey: 'trips',
    cache: MEDIUM,
  });
  api.registerRoute('finance/projects.json', {
    scope: 'user', subcollection: 'financeProjects', wrapKey: 'projects',
    cache: MEDIUM,
  });

  // Library preferences — per-user highlight color palette.
  api.registerRoute('library/highlight_colors.json', {
    scope: 'user', subcollection: 'libraryPrefs', doc: 'highlightColors',
    cache: LONG,
  });

  // Email archive per-user state — ratings, dispositions, category overrides,
  // and trash all live per-user. The email body archive itself
  // (summary.json + by_year/{year}.json + predictions / suggestions) stays
  // lab-global JSON until Phase 7 per-user Gmail OAuth ships. These four
  // single-doc routes are what enables live tab-to-tab sync of email
  // triage actions (star ratings, actionable/info-pill dispositions, etc.).
  api.registerRoute('email_archive/ratings.json', {
    scope: 'user', subcollection: 'emailArchive', doc: 'ratings',
    cache: SHORT,
  });
  api.registerRoute('email_archive/dispositions.json', {
    scope: 'user', subcollection: 'emailArchive', doc: 'dispositions',
    cache: SHORT,
  });
  api.registerRoute('email_archive/category_overrides.json', {
    scope: 'user', subcollection: 'emailArchive', doc: 'categoryOverrides',
    cache: SHORT,
  });
  api.registerRoute('email_archive/trash.json', {
    scope: 'user', subcollection: 'emailArchive', doc: 'trash',
    cache: SHORT,
  });
  // V3.292: labeled training set for the in-browser email-category classifier
  // (email-classifier.js). One doc, { examples: { <emailId>: {label, sub, s,
  // subj, snip, ts} } } — a feature snapshot per hand-categorized email, so the
  // classifier (and the API-page review) need only this doc, not a join with
  // emailMessages. Mirrors categoryOverrides but carries the features.
  api.registerRoute('email_archive/classifier_training.json', {
    scope: 'user', subcollection: 'emailArchive', doc: 'classifierTraining',
    cache: SHORT,
  });
  // V3.293: per-user classifier weights/thresholds (Classifier Settings page).
  // { minExamples, minPerClass, minConfidence, alpha, weights:{from,dom,s,b} }.
  api.registerRoute('email_archive/classifier_settings.json', {
    scope: 'user', subcollection: 'emailArchive', doc: 'classifierSettings',
    cache: SHORT,
  });

  // Phase 7: per-user Gmail messages, written by the Cloud Function scraper
  // (functions/gmail-scraper.js + scrape-now.js). Each row is one Gmail
  // message with metadata (no body) — id, from/to/subject/date/snippet/labels.
  api.registerRoute('email_archive/messages.json', {
    scope: 'user', subcollection: 'emailMessages', wrapKey: 'messages',
    orderBy: 'internalDate', orderDir: 'desc',
    // Scraper writes once every 15 min — LONG TTL is safe; the email page
    // also runs a MAX(internalDate) probe to short-circuit re-fetches.
    cache: LONG,
  });

  // Calendar archive per-user state — same pattern as email-archive. Ratings,
  // category overrides, and trash are per-user. The lab-global summary and
  // by_year/{year}.json bodies stay JSON until Phase 7 per-user calendar
  // OAuth ships.
  api.registerRoute('calendar_archive/ratings.json', {
    scope: 'user', subcollection: 'calendarArchive', doc: 'ratings',
    cache: SHORT,
  });
  api.registerRoute('calendar_archive/category_overrides.json', {
    scope: 'user', subcollection: 'calendarArchive', doc: 'categoryOverrides',
    cache: SHORT,
  });
  api.registerRoute('calendar_archive/trash.json', {
    scope: 'user', subcollection: 'calendarArchive', doc: 'trash',
    cache: SHORT,
  });

  // Phase 7: per-user Calendar events, written by the Cloud Function scraper.
  api.registerRoute('calendar_archive/events.json', {
    scope: 'user', subcollection: 'calendarEvents', wrapKey: 'events',
    orderBy: 'start_at', orderDir: 'asc',
    // Scraper writes once every 30 min (Google) / 30 min (ICS) — LONG TTL.
    cache: LONG,
  });

  // Phase 13: pre-aggregated per-user stats. One tiny doc per (kind, year)
  // in userData/{uid}/stats/{kind}-{year}. Backfill via
  // scripts/build_user_stats.py; live updates via Cloud Function trigger
  // functions/stats-updater.js. These docs hold counts + breakdowns
  // (byMonth, byCategory, bySender, ...) so graphs can render full-year
  // totals without paginating through raw collections.
  //
  // LONG cache (4h) — stats change slowly (once per minute at most via
  // scrape-driven increments) and the page can tolerate several hours of
  // staleness for graph rendering. The Cloud Function trigger keeps the
  // doc current; clients refresh on TTL expiry or on user click.
  for (var _y = 2024; _y <= new Date().getFullYear() + 1; _y++) {
    (function (year) {
      api.registerRoute('stats/email-' + year + '.json', {
        scope: 'user', subcollection: 'stats', doc: 'email-' + year,
        cache: LONG,
      });
      api.registerRoute('stats/calendar-' + year + '.json', {
        scope: 'user', subcollection: 'stats', doc: 'calendar-' + year,
        cache: LONG,
      });
    })(_y);
  }

  /* ── V3.63: Workflow-driven UX redesign ─────────────────────────
   *
   * Two new routes back the workflow feature. Per-user page-access grants
   * (the admin matrix) live at `userPermissions/{uid}` and are read/written
   * via direct firebridge.db() calls from admin-permissions.js + the
   * canAccessPage helper — they're small per-doc reads that don't need the
   * api layer's wrap-key / discriminator machinery.
   *
   *   - labConfig/defaultWorkflows  — admin-edited list of the 5 default
   *     workflows (page bundles). Lab-scope, LONG cache (admins rarely
   *     edit). Existing labConfig/{docId} rule (firestore.rules:464)
   *     already gates write to admin. shadowJson off — net-new doc.
   *   - userData/{uid}/customWorkflows — per-user saved workflows.
   *     Owner read+write per the existing userData/{uid}/{collection}
   *     rule. SHORT cache, shadowJson off.
   */
  api.registerRoute('workflows/defaults.json', {
    scope: 'lab', collection: 'labConfig', doc: 'defaultWorkflows',
    cache: LONG,
  });
  api.registerRoute('workflows/custom.json', {
    scope: 'user', subcollection: 'customWorkflows', wrapKey: 'workflows',
    cache: SHORT,
  });
})();
