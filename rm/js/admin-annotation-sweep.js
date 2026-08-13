/* admin-annotation-sweep.js — V3.619 one-off annotation consolidation.
 *
 * Folds the retired bucket_ids field into cite_in_drafts on every
 * papers/{itemId}/annotations doc, backfills annotation_type from color_id,
 * and drops the dead parent_id:null default. Runs as the signed-in admin
 * (rules let admin update any annotation).
 *
 * Why per-item iteration instead of collectionGroup('annotations'): the
 * rules are written for the concrete path papers/{paperId}/annotations/
 * {annId}, which does NOT authorize collection-group queries — and most
 * parent papers/{itemId} docs don't exist anyway (orphan subcollections),
 * so we walk the library items list and query each item's subcollection.
 *
 * Idempotent: re-running finds nothing left to patch.
 */
(function () {
  'use strict';

  var $log = document.getElementById('mig-log');
  var $status = document.getElementById('annsweep-status');

  function log(msg, level) {
    var ts = new Date().toLocaleTimeString();
    var prefix = level === 'err' ? '❌ ' : level === 'ok' ? '✅ ' : '   ';
    if ($log) $log.textContent = prefix + '[' + ts + '] ' + msg + '\n' + $log.textContent;
  }
  function status(msg) { if ($status) $status.textContent = msg; }

  // Mirror of library-paper.js's COLOR_TO_TYPE (single-sourced in V3.620's
  // annotation-colors.js; duplicated here because this sweep is one-off).
  var COLOR_TO_TYPE = {
    yellow: 'note',
    green: 'evidence',
    red: 'limitation',
    blue: 'method',
    purple: 'question',
    orange: 'quote',
  };

  function uniq(arr) { return Array.from(new Set(arr)); }

  /* Build claimId → draftId from drafts/{draftId}/claims for every known
   * paper draft (projects/papers.json). Grant-draft claims are best-effort
   * skipped — nothing consumes them today. */
  async function buildClaimMap() {
    var map = {};
    var papersData;
    try {
      papersData = await api.load('projects/papers.json');
    } catch (e) {
      log('claim map: could not load projects/papers.json (' + e.message + ') — evidence-derived drafts will be skipped', 'err');
      return map;
    }
    var drafts = (papersData && papersData.papers) || [];
    for (var i = 0; i < drafts.length; i++) {
      var draftId = drafts[i].id;
      if (!draftId) continue;
      try {
        var snap = await firebridge.db()
          .collection('drafts').doc(draftId).collection('claims').get();
        snap.forEach(function (d) { map[d.id] = draftId; });
      } catch (e) {
        log('claim map: drafts/' + draftId + '/claims read failed: ' + e.message, 'err');
      }
    }
    return map;
  }

  /* Compute the patch for one annotation doc; null = nothing to do. */
  function patchFor(data, claimMap) {
    var FV = firebase.firestore.FieldValue;
    var patch = {};
    var dirty = false;

    var cites = Array.isArray(data.cite_in_drafts) ? data.cite_in_drafts : [];
    var buckets = Array.isArray(data.bucket_ids) ? data.bucket_ids : [];
    var claimDrafts = (Array.isArray(data.evidence_for_claim_ids) ? data.evidence_for_claim_ids : [])
      .map(function (cid) { return claimMap[cid]; })
      .filter(Boolean);
    var merged = uniq(cites.concat(buckets, claimDrafts));
    if (merged.length !== cites.length) {
      patch.cite_in_drafts = merged;
      dirty = true;
    }
    if ('bucket_ids' in data) {
      patch.bucket_ids = FV.delete();
      dirty = true;
    }
    // parent_id threading never shipped; the null default just wasted a
    // field. A NON-null parent_id is left alone (and logged by the caller)
    // — deleting it would surface a doc that was deliberately hidden.
    if ('parent_id' in data && data.parent_id == null) {
      patch.parent_id = FV.delete();
      dirty = true;
    }
    if (!data.annotation_type && !data.kind) {
      patch.annotation_type = COLOR_TO_TYPE[data.color_id] || 'note';
      dirty = true;
    }
    return dirty ? patch : null;
  }

  async function sweep(dryRun) {
    status(dryRun ? 'Dry run…' : 'Running…');
    log('annotation sweep ' + (dryRun ? 'DRY RUN' : 'LIVE') + ' started');

    var itemsData = await api.load('items.json');
    var items = (itemsData && itemsData.items) || [];
    log('scanning annotations under ' + items.length + ' library items');

    var claimMap = await buildClaimMap();
    log('claim map: ' + Object.keys(claimMap).length + ' claims resolved to drafts');

    var db = firebridge.db();
    var scanned = 0, toPatch = 0, patched = 0, threaded = 0, failedItems = 0;
    var batch = db.batch(), ops = 0;

    async function flush() {
      if (!ops) return;
      await batch.commit();
      patched += ops;
      batch = db.batch();
      ops = 0;
    }

    for (var i = 0; i < items.length; i++) {
      var itemId = items[i].id;
      if (!itemId) continue;
      var snap;
      try {
        snap = await db.collection('papers').doc(itemId).collection('annotations').get();
      } catch (e) {
        failedItems++;
        log('papers/' + itemId + '/annotations read failed: ' + e.message, 'err');
        continue;
      }
      for (var j = 0; j < snap.docs.length; j++) {
        var doc = snap.docs[j];
        scanned++;
        var data = doc.data();
        if (data.parent_id != null) {
          threaded++;
          log('papers/' + itemId + '/annotations/' + doc.id + ' has non-null parent_id — left untouched');
        }
        var patch = patchFor(data, claimMap);
        if (!patch) continue;
        toPatch++;
        if (dryRun) continue;
        batch.update(doc.ref, patch);
        ops++;
        if (ops >= 400) await flush();
      }
      status((dryRun ? 'Dry run' : 'Running') + ' — ' + (i + 1) + '/' + items.length +
             ' items, ' + scanned + ' annotations, ' + toPatch + ' need patching');
    }
    if (!dryRun) await flush();

    var summary = scanned + ' annotations scanned, ' + toPatch + ' need' +
      (dryRun ? '' : 'ed') + ' patching' +
      (dryRun ? '' : ' (' + patched + ' written)') +
      (threaded ? ', ' + threaded + ' threaded docs skipped' : '') +
      (failedItems ? ', ' + failedItems + ' items unreadable' : '');
    status((dryRun ? 'Dry run done: ' : 'Done: ') + summary);
    log('annotation sweep ' + (dryRun ? 'dry run' : 'complete') + ': ' + summary, 'ok');
  }

  function wire(id, dryRun) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', async function () {
      if (!dryRun && !confirm('Run the V3.619 annotation consolidation LIVE?\n\n' +
          'bucket_ids will be folded into cite_in_drafts and deleted, and ' +
          'annotation_type backfilled from color. Idempotent, but run a dry run first.')) {
        return;
      }
      var buttons = [document.getElementById('annsweep-dry'), document.getElementById('annsweep-run')];
      buttons.forEach(function (b) { if (b) b.disabled = true; });
      try {
        await sweep(dryRun);
      } catch (e) {
        status('Failed: ' + e.message);
        log('annotation sweep failed: ' + e.message, 'err');
      } finally {
        buttons.forEach(function (b) { if (b) b.disabled = false; });
      }
    });
  }

  wire('annsweep-dry', true);
  wire('annsweep-run', false);
})();
