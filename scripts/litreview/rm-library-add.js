#!/usr/bin/env node
/* rm-library-add.js — put a lit review's papers in the lab library (RM `items`, type 'paper'), the way the
   library importer does (rm/js/library-metadata.js buildPaperItem + library-upload.js uploadPdf):

   - a paper whose DOI is already in the library is REUSED (its id is used for cites); if it has no PDF and we
     have one, the PDF is attached (meta.library.pdf was null — the same thing RM's "Find PDF" does);
   - a new paper becomes `items/{first-author-year-two-title-words}` with meta.library filled from Europe PMC and
     its PDF at Storage papers/{id}/{sha256[:16]}.pdf (with a download token, as RM's getDownloadURL needs);
   - every paper the review touches gets the tag `litreview:<slug>` (meta.library.tags, arrayUnion);
   - writes a manifest (what was created / attached / tagged) so it can be undone.

   node rm-library-add.js <spec.json> --by <email> --out libids.json --manifest manifest.json [--commit]
*/
'use strict';
/* V3.889: on a slow network Google's endpoints take longer than Node's 250 ms happy-eyeballs attempt (ETIMEDOUT) */
require('net').setDefaultAutoSelectFamilyAttemptTimeout(3000);
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');   // the McGheeLabWebsite repo
const admin = require(ROOT + '/node_modules/firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require(ROOT + '/scripts/service-account.json')), storageBucket: 'mcgheelab-f56cc.firebasestorage.app' });
const db = admin.firestore(), bucket = admin.storage().bucket();
const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
const COMMIT = argv.includes('--commit');
const spec = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
const TAG = 'litreview:' + spec.slug, BY = opt('--by') || process.env.LITREVIEW_BY, TODAY = new Date().toISOString().slice(0, 10);
/* V3.891: one request for an 18 MB PDF is dropped on a home network (EPIPE): big files go up resumable, and a dropped
   connection is tried again */
async function upload(f, bytes, metadata, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await f.save(bytes, { contentType: 'application/pdf', resumable: bytes.length > 5e6, metadata: { metadata } }); }
    catch (e) { if (i >= tries) throw e; console.log(`  upload ${f.name}: ${e.code || e.message} — try ${i + 1} of ${tries}`); await new Promise(r => setTimeout(r, 3000 * i)); }
  }
}

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'or', 'to', 'with', 'from', 'by', 'as', 'at', 'is', 'are', 'be', 'this', 'that', 'using', 'via', 'over', 'under', 'between', 'into']);
const safeSlug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const titleWords = (t, n) => String(t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).slice(0, n).join('');

if (!BY) { console.error('say who is adding the papers: --by <lab Google account email> (or LITREVIEW_BY)'); process.exit(2); }
(async () => {
  const snap = await db.collection('items').where('type', '==', 'paper').get();
  const byDoi = new Map(), ids = new Set();
  snap.docs.forEach(d => { ids.add(d.id); const doi = (((d.data().meta || {}).library || {}).doi || '').toLowerCase(); if (doi) byDoi.set(doi, d); });
  const all = await db.collection('items').select().get(); all.docs.forEach(d => ids.add(d.id));
  const libids = {}, manifest = { slug: spec.slug, at: new Date().toISOString(), created: [], attachedPdf: [], tagged: [], reused: [] };
  for (const [key, p] of Object.entries(spec.papers)) {
    const doi = String(p.doi || '').toLowerCase();
    const ex = doi && byDoi.get(doi);
    let pdfInfo = null;
    const needPdf = p.pdf && (!ex || !((ex.data().meta || {}).library || {}).pdf);
    let id;
    if (ex) { id = ex.id; manifest.reused.push({ key, id }); }
    else {
      const first = (p.authors && p.authors[0]) || {};
      let base = safeSlug([first.family, p.year, titleWords(p.title, 1)].filter(Boolean).join('-')) || safeSlug(p.title);
      id = base; let k = 2; while (ids.has(id)) id = base + '-' + (k++);
      ids.add(id);
    }
    if (needPdf) {
      const bytes = fs.readFileSync(p.pdf), full = crypto.createHash('sha256').update(bytes).digest('hex'), path = `papers/${id}/${full.slice(0, 16)}.pdf`;
      pdfInfo = { storage_path: path, hash: full.slice(0, 16), full_hash: full, filename_safe: id + '.pdf', size_bytes: bytes.length, uploaded_at: TODAY, uploaded_by: BY };
      if (p.pdfVersion && p.pdfVersion !== 'published') pdfInfo.version = p.pdfVersion;   // 'preprint' | 'author manuscript'
      if (COMMIT) {
        const f = bucket.file(path); const [there] = await f.exists();
        if (!there) await upload(f, bytes, { uploadedBy: BY, fullHash: full, firebaseStorageDownloadTokens: crypto.randomUUID() });
      }
    }
    if (ex) {
      const upd = { 'meta.library.tags': admin.firestore.FieldValue.arrayUnion(TAG), updated_at: TODAY };
      if (pdfInfo) { upd['meta.library.pdf'] = pdfInfo; manifest.attachedPdf.push({ key, id, storage_path: pdfInfo.storage_path }); }
      manifest.tagged.push({ key, id });
      if (COMMIT) await db.collection('items').doc(id).update(upd);
    } else {
      const first = (p.authors && p.authors[0]) || {};
      const item = { id, type: 'paper', category: 'research', title: p.title, status: 'published', description: '', related_ids: [], repo_path: '', repo_org: '', repo_parsed: null, repo_parsed_at: '',
        personnel: [], funding_account_ids: [], tags: [], subtasks: [], notes: '', created_at: TODAY, updated_at: TODAY,
        meta: { target_journal: p.journal || '', lead_author: [first.given, first.family].filter(Boolean).join(' '), submission_target: '', projected_submission_date: '',
          library: { is_library_entry: true, is_lab_draft: false, citation_key: `${safeSlug(first.family || 'anon').replace(/-/g, '')}${String(p.year || 'nd').slice(0, 4)}${titleWords(p.title, 1) || 'untitled'}`,
            doi, pmid: p.pmid ? String(p.pmid) : '', arxiv_id: '', authors: p.authors || [], year: String(p.year || ''), journal: p.journal || '', journal_iso: p.journalIso || '', issn: p.issn || '',
            volume: p.volume || '', issue: p.issue || '', pages: p.pages || '', abstract: p.abstract || '', url: doi ? 'https://doi.org/' + doi : '', source: 'europepmc',
            captured_via: 'litreview', captured_by: BY, captured_at_iso: new Date().toISOString(), pdf: pdfInfo, folders: [], labels: [], tags: [TAG], starred: false, date_added: TODAY,
            annotation_count: 0, evidence_count: 0, cited_in_drafts: [], public: false, public_url: '', shared_at_iso: '', shared_by: '' } } };
      manifest.created.push({ key, id, storage_path: pdfInfo && pdfInfo.storage_path });
      if (COMMIT) await db.collection('items').doc(id).set(item);
    }
    libids[key] = id;
    console.log(`${ex ? 'reuse ' : 'create'} ${id.padEnd(46)} ${pdfInfo ? '+pdf' : (p.pdf ? ' (has pdf)' : ' no pdf')}  ${doi}`);
  }
  fs.writeFileSync(opt('--out') || 'libids.json', JSON.stringify(libids, null, 1));
  fs.writeFileSync(opt('--manifest') || 'manifest.json', JSON.stringify(manifest, null, 1));
  console.log(`${COMMIT ? 'WROTE' : 'dry run'}: ${manifest.created.length} new, ${manifest.reused.length} reused, ${manifest.attachedPdf.length} PDFs attached to existing entries`);
})().catch(e => { console.error(e); process.exit(1); });
