/* research-publish.js — V3.553 (Research Foci: publish to the lab website)
 *
 * "Publish" copies a SNAPSHOT of a focus card's public-facing fields —
 * title/level/one-liner/overview blocks + only the media those blocks
 * reference — into publicFoci/{fociId} (public read, admin write;
 * firestore.rules V3.553). The public SPA's #/projects page renders
 * publicFoci, so lab-internal edits never leak until an explicit
 * re-publish (the stories publish-gate idea, PI-only so no review flow).
 * Media download URLs were stored at upload time (research-media.js), so
 * unauthenticated visitors can load them directly.
 *
 * Globals: window.RESEARCH_PUBLISH.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;

  function snapshot(f) {
    var blocks = (f.overview_blocks || []).map(function (b) { return Object.assign({}, b); });
    var usedMediaIds = {};
    blocks.forEach(function (b) { if (b.media_id) usedMediaIds[b.media_id] = 1; });
    var media = (f.media || []).filter(function (m) { return usedMediaIds[m.id]; })
      .map(function (m) { return Object.assign({}, m); });
    return {
      id: f.id,
      level: f.level,
      title: f.title,
      abbr: f.abbr || '',
      icon: f.icon || '',
      color: f.color || '',
      one_liner: f.one_liner || '',
      overview_blocks: blocks,
      media: media,
      order: typeof f.order === 'number' ? f.order : 0,
      published_at: new Date().toISOString(),
      schema_version: 1,
    };
  }

  async function publish(f) {
    if (!RD.isAdmin()) throw new Error('Only the PI can publish.');
    if (!(f.overview_blocks || []).length) throw new Error('Build an overview first — there is nothing to publish.');
    var snap = snapshot(f);
    await firebridge.db().collection('publicFoci').doc(f.id).set(snap);
    await RD.update(f.id, { published: true, published_at: snap.published_at });
  }

  async function unpublish(f) {
    if (!RD.isAdmin()) throw new Error('Only the PI can unpublish.');
    await firebridge.db().collection('publicFoci').doc(f.id).delete();
    await RD.update(f.id, { published: false, published_at: null });
  }

  window.RESEARCH_PUBLISH = { publish: publish, unpublish: unpublish, snapshot: snapshot };
})();
