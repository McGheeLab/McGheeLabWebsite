#!/usr/bin/env node
/* seed_gels_career_references.js
 *
 * V3.721 — put the CAREER grant's bibliography ON the grant.
 *
 * V3.718 briefly gave references their own card and their own `reference`
 * level. Alex wanted them inside the grant instead ("if i click on it i see
 * all the aims, outputs people etc, and I want a new section in this with the
 * references cited"), which is simpler, is one fewer doc to keep in step, and
 * removes the card that a pre-V3.718 build misfiled into the Concepts band.
 *
 * So this: stamps `ref_source` onto researchFoci/gels-career, then deletes the
 * now-redundant gels-career-references card. The card holds no unique data —
 * only the same pointer — so nothing is lost.
 *
 * The 103 references stay exactly where they are: in the lab library (`items`,
 * type 'paper', each carrying meta.library.cited_in_drafts). Nothing is copied
 * and nothing is deleted there.
 *
 * Usage:
 *   node scripts/seed_gels_career_references.js            # dry run
 *   node scripts/seed_gels_career_references.js --commit
 *
 * Idempotent: safe to re-run.
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const COMMIT = process.argv.includes('--commit');
const GRANT_ID = 'gels-career';
const OLD_CARD_ID = 'gels-career-references';
const DRAFT_ID = 'career-understanding-cell-driven-remodeling-and-self-assembly-of-granular-microgel-scaffolds';

function initFirestore() {
  const local = path.join(__dirname, 'service-account.json');
  admin.initializeApp(fs.existsSync(local)
    ? { credential: admin.credential.cert(require(local)) }
    : { credential: admin.credential.applicationDefault() });
  return admin.firestore();
}

(async () => {
  const db = initFirestore();
  const coll = db.collection('researchFoci');

  const grantSnap = await coll.doc(GRANT_ID).get();
  if (!grantSnap.exists) throw new Error('Grant "' + GRANT_ID + '" not found.');
  const grant = grantSnap.data();

  const items = await db.collection('items').where('type', '==', 'paper').get();
  const cited = items.docs.filter(d => {
    const L = (d.data().meta && d.data().meta.library) || {};
    return L.is_library_entry && (L.cited_in_drafts || []).includes(DRAFT_ID);
  });

  const oldSnap = await coll.doc(OLD_CARD_ID).get();

  console.log(COMMIT ? '=== COMMIT ===' : '=== DRY RUN (no writes; pass --commit) ===');
  console.log('Grant                : ' + GRANT_ID);
  console.log('  ref_source now     : ' + JSON.stringify(grant.ref_source || null));
  console.log('  ref_source will be : {"kind":"draft_citations","draft_id":"' + DRAFT_ID.slice(0, 30) + '…"}');
  console.log('References in library: ' + cited.length + ' cited by this draft (untouched)');
  console.log('Old standalone card  : ' + (oldSnap.exists
    ? OLD_CARD_ID + ' — will be DELETED (holds no unique data; the pointer moves to the grant)'
    : 'already gone'));

  if (!COMMIT) { console.log('\nDry run — nothing written.'); process.exit(0); }

  const now = new Date().toISOString();
  await coll.doc(GRANT_ID).update({
    ref_source: { kind: 'draft_citations', draft_id: DRAFT_ID },
    updated_by: grant.updated_by || grant.created_by || null,
    updated_at: now,
  });
  console.log('\nupdate ' + GRANT_ID + ' — ref_source set (' + cited.length + ' references resolve)');

  // Delete only AFTER the grant carries the pointer, so a failure above
  // cannot leave the bibliography unreachable from anywhere.
  if (oldSnap.exists) {
    await coll.doc(OLD_CARD_ID).delete();
    console.log('delete ' + OLD_CARD_ID + ' — the standalone card is redundant now');
  }
  console.log('Done.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
