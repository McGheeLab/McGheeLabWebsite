/* rm_usage_pull.js — read-only Firestore pull behind CodeLog/Analysis/rm_page_usage_2026-10-21.md.
 * Run from the repo root:  NODE_PATH=functions/node_modules node CodeLog/Analysis/rm_usage_pull.js <outDir>
 * Needs scripts/service-account.json. Part 1 = roster, page-time tracker entries, config, presence,
 * collection counts. Part 2 = per-row content proxies (chat, huddle, equipment, tasks, notebook, plans…). */
/* Pull RM usage data server-side (read-only). Writes JSON files next to itself. */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const OUT = process.argv[2] || path.dirname(__filename);
const SA = '/Users/alexmcghee/Documents/GitHub/McGheeLabWebsite/scripts/service-account.json';
admin.initializeApp({ credential: admin.credential.cert(require(SA)) });
const db = admin.firestore();

function plain(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof admin.firestore.Timestamp) return v.toDate().toISOString();
  if (v instanceof admin.firestore.DocumentReference) return 'ref:' + v.path;
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === 'object') {
    if (typeof v.toDate === 'function') { try { return v.toDate().toISOString(); } catch (e) {} }
    const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o;
  }
  return v;
}
function save(name, data) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1));
  console.log('wrote', name, Array.isArray(data) ? data.length : Object.keys(data).length);
}

async function main() {
  // 1. users
  const usersSnap = await db.collection('users').get();
  const users = usersSnap.docs.map(d => ({ uid: d.id, ...plain(d.data()) }));
  save('users.json', users);

  // 2. trackerEntries — every uid that has a parent ref (includes missing parents)
  const trackerParents = await db.collection('trackerEntries').listDocuments();
  const uids = new Set([...trackerParents.map(r => r.id), ...users.map(u => u.uid)]);
  const entries = [];
  for (const uid of uids) {
    const snap = await db.collection('trackerEntries').doc(uid).collection('entries').get();
    snap.docs.forEach(d => {
      const x = plain(d.data());
      entries.push({ uid, id: d.id, date: x.date, source: x.source || null, kind: x.kind || null,
        status: x.status || null, text: x.text || null,
        sref_kind: x.source_ref && x.source_ref.kind, sref_id: x.source_ref && x.source_ref.id,
        sref_path: x.source_ref && x.source_ref.path,
        windows: Array.isArray(x.logged_windows) ? x.logged_windows.length : null,
        duration: x.duration ?? null, createdAt: x.createdAt || null, updatedAt: x.updatedAt || null });
    });
    console.log('tracker', uid, snap.size);
  }
  save('tracker_entries.json', entries);

  // 3. labConfig
  const lc = {};
  for (const id of ['pageTracking', 'defaultWorkflows', 'featureFlags']) {
    const s = await db.collection('labConfig').doc(id).get();
    lc[id] = s.exists ? plain(s.data()) : null;
  }
  save('labConfig.json', lc);

  // 4. userPresence snapshot
  const pres = await db.collection('userPresence').get();
  save('userPresence.json', pres.docs.map(d => ({ uid: d.id, ...plain(d.data()) })));

  // 5. workflowPrefs + userData subcollection counts per user
  const userData = {};
  const udParents = await db.collection('userData').listDocuments();
  const udUids = new Set([...udParents.map(r => r.id), ...users.map(u => u.uid)]);
  for (const uid of udUids) {
    const subs = await db.collection('userData').doc(uid).listCollections();
    const rec = { subcollections: {}, workflowPrefs: null };
    for (const c of subs) {
      try { const agg = await c.count().get(); rec.subcollections[c.id] = agg.data().count; }
      catch (e) { rec.subcollections[c.id] = 'err:' + e.message; }
    }
    try {
      const wp = await db.collection('userData').doc(uid).collection('workflowPrefs').get();
      if (!wp.empty) rec.workflowPrefs = wp.docs.map(d => ({ id: d.id, ...plain(d.data()) }));
    } catch (e) {}
    userData[uid] = rec;
    console.log('userData', uid, Object.keys(rec.subcollections).length);
  }
  save('userData.json', userData);

  // 6. top-level collections: count + newest createdAt/updatedAt doc
  const cols = await db.listCollections();
  const top = {};
  for (const c of cols) {
    const rec = { count: null, latest_createdAt: null, latest_updatedAt: null };
    try { rec.count = (await c.count().get()).data().count; } catch (e) { rec.count = 'err:' + e.message; }
    for (const f of ['createdAt', 'updatedAt']) {
      try {
        const s = await c.orderBy(f, 'desc').limit(1).get();
        if (!s.empty) rec['latest_' + f] = plain(s.docs[0].get(f));
      } catch (e) { rec['latest_' + f] = 'err:' + e.message.slice(0, 60); }
    }
    top[c.id] = rec;
    console.log('top', c.id, rec.count);
  }
  save('top_collections.json', top);
}
main().then(part2).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

/* ───────────── Part 2: content-write rows (originally pull2.js) ───────────── */
async function part2() {
  const out = {};
  const spec = {
    chatMessages:      d => ({ uid: d.authorUid, at: iso(d.createdAt), imported: !!d.imported, type: d.type, channel: d.channelId, thread: !!d.threadParentId, file: !!d.file }),
    huddlePlans:       d => ({ uid: d.ownerUid, at: iso(d.createdAt), weekId: d.weekId, status: d.status, joiners: (d.joiners||[]).length, protocol: !!d.protocol }),
    equipmentBookings: d => ({ uid: d.uid, at: iso(d.createdAt), date: d.date, equipment: d.equipmentName, status: d.status }),
    procurementTickets:d => ({ uid: d.requestedBy, at: iso(d.createdAt), status: d.status }),
    meetings:          d => ({ uid: d.createdBy, at: iso(d.createdAt), date: d.date, kind: d.kind, status: d.status, seed: !!d.seed, hasMinutes: !!(d.minutes && String(d.minutes).length>20), updated: iso(d.updatedAt) }),
    meetingTopics:     d => ({ uid: d.suggestedBy, at: iso(d.createdAt), status: d.status }),
    labChores:         d => ({ uid: d.assignedBy, at: iso(d.createdAt), weekId: d.weekId, completions: Object.keys(d.completions||{}).length }),
    schedules:         d => ({ uid: d.ownerUid, at: iso(d.updatedAt), title: d.title, mode: d.mode }),
    taskMarket:        d => ({ uid: d.createdByUid, at: iso(d.createdAt) || d.created_at, status: d.status, kind: d.kind, claimed: !!d.claimedByUid }),
    protocols:         d => ({ uid: d.author_uid || d.ownerUid, at: d.created_at, updated: d.updated_at, status: d.status, title: d.title }),
    papers:            d => ({ uids: d.authorUids, at: iso(d.updatedAt), status: d.status, title: d.title, lib: !!d.is_library_entry }),
    researchFoci:      d => ({ uid: d.created_by, at: d.created_at, updated: d.updated_at, level: d.level, status: d.status }),
    items:             d => ({ type: d.type, status: d.status, at: d.created_at, updated: d.updated_at || iso(d.updatedAt) }),
    projects:          d => ({ type: d.type, status: d.status, updated: iso(d.updatedAt) }),
    equipmentTraining: d => ({ keys: Object.keys(d).join(','), updated: iso(d.updatedAt) }),
    cvData:            d => ({ updated: iso(d.updatedAt) }),
    grantDrafts:       d => ({ at: iso(d.createdAt), updated: iso(d.updatedAt), title: d.title }),
    huddleSeen:        d => ({ updated: iso(d.updatedAt), keys: Object.keys(d).length }),
    userSettings:      d => ({ keys: Object.keys(d).join(',') }),
    trackerData:       d => ({ updated: iso(d.updatedAt), keys: Object.keys(d).join(',') }),
    labThemes:         d => ({ keys: Object.keys(d).slice(0,12).join(','), updated: d.updated_at || iso(d.updatedAt) }),
    chatChannels:      d => ({ at: iso(d.createdAt), name: d.name, type: d.type, members: (d.members||[]).length, last: iso(d.lastMessageAt) }),
  };
  for (const [c, fn] of Object.entries(spec)) {
    const s = await db.collection(c).get();
    out[c] = s.docs.map(d => ({ id: d.id, ...fn(d.data()) }));
    console.log(c, s.size);
  }
  fs.writeFileSync(path.join(OUT, 'top_rows.json'), JSON.stringify(out));
  // per-user subcollections
  const ud = await db.collection('userData').listDocuments();
  const subspec = {
    tasks:        d => ({ at: iso(d.createdAt) || d.created_at, done: !!d.done, bucket: d.bucket, source: d.source, assignedTo: d.assignedToUid, createdBy: d.createdByUid, updated: iso(d.updatedAt) }),
    notebook:     d => ({ n: Array.isArray(d.entries) ? d.entries.length : null, keys: Object.keys(d).join(','), sample: Array.isArray(d.entries) && d.entries[0] ? Object.keys(d.entries[0]).join(',') : null, dates: Array.isArray(d.entries) ? d.entries.map(e => e.date || e.created_at || e.createdAt || null).filter(Boolean).slice(0,500) : [] }),
    dayPlans:     d => ({ at: d.created_at, date: d.date, type: d.type, status: d.status, origin: d.origin, dist: Object.keys(d.distributions||{}).join('|') }),
    focusAreas:   d => ({ at: d.created_at, weekId: d.weekId || null, status: d.status, assigned_by: d.assigned_by, confirmed: !!d.confirmed_at, nTasks: (d.tasks||[]).length, source: d.source }),
    pmr:          d => ({ at: d.created_at, updated: d.updated_at || iso(d.updatedAt), status: d.status, period: d.period, meeting_date: d.meeting_date, submitted: d.submitted_at }),
    customWorkflows: d => ({ at: iso(d.createdAt), label: d.label, basedOn: d.basedOn, pages: (d.pageIds||[]).length }),
    notifications: d => ({ at: iso(d.createdAt), kind: d.kind, app: d.appKey, read: !!d.readAt, url: (d.url||'').split('?')[0] }),
    buckets:      d => ({ keys: Object.keys(d).slice(0,8).join(','), updated: iso(d.updatedAt) || d.updated_at }),
    emailMessages: null, emailTasks: null, calendarEvents: null, activityLedger: null,
    navPrefs:     d => ({ keys: Object.keys(d).join(',') }),
    libraryPrefs: d => ({ keys: Object.keys(d).join(',') }),
  };
  const per = {};
  for (const u of ud) {
    per[u.id] = {};
    for (const [sub, fn] of Object.entries(subspec)) {
      if (!fn) continue;
      const s = await u.collection(sub).get();
      if (s.empty) continue;
      per[u.id][sub] = s.docs.map(d => ({ id: d.id, ...fn(d.data()) }));
    }
    const n = Object.values(per[u.id]).reduce((a, b) => a + b.length, 0);
    if (n) console.log('userData', u.id.slice(0,8), Object.entries(per[u.id]).map(([k,v]) => k + ':' + v.length).join(' '));
  }
  fs.writeFileSync(path.join(OUT, 'user_rows.json'), JSON.stringify(per));
}
