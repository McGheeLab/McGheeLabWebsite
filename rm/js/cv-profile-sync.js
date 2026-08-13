/* cv-profile-sync.js — mirror CV publication sections onto the public
 * users/{uid} profile so the public Team page stays fresh when the CV is
 * edited from RM.
 *
 * The parent-site cv-builder calls user-system.js syncCVToProfile() on
 * every save; RM pages don't load user-system.js, so this module
 * replicates that mapping VERBATIM. If you change the mapping here, change
 * user-system.js (syncCVToProfile, ~L656-691) to match — the two must
 * produce identical output for identical cvData or the syncs will fight.
 *
 * Mapping (cvData section → users/{uid} array):
 *   journals      → papers        { title, url(doi), year, citations, journal,
 *                                    authors, volume, issue, pages, status }
 *   conferences   → posters       { title, url(doi), year, conference, authors }
 *   presentations → presentations { title, url(slides_url), year(date), event, type }
 *   patents       → patents       { title, url(number), year(grant|filing date),
 *                                    status, inventors }
 *
 * Writes via firebridge.updateDoc('users', uid, ...) — allowed by
 * firestore.rules (owner update with role unchanged), so no rules deploy.
 * Fire-and-forget: a failed sync warns once per session and never blocks
 * or fails the CV save that triggered it.
 */

var CV_PROFILE_SYNC = (function () {
  var DEBOUNCE_MS = 800;
  var _timer = null;
  var _warned = false;

  function stripTags(s) { return (s || '').replace(/<[^>]+>/g, ''); }

  function buildProfilePatch(cvData) {
    var papers = (cvData.journals || []).map(function (j) {
      return {
        title: stripTags(j.title),
        url: j.doi ? 'https://doi.org/' + j.doi : '',
        year: j.year || '',
        citations: j.citations || 0,
        journal: j.journal || '',
        authors: j.authors || '',
        volume: j.volume || '',
        issue: j.issue || '',
        pages: j.pages || '',
        status: j.status || '',
      };
    }).filter(function (p) { return p.title; });

    var posters = (cvData.conferences || []).map(function (c) {
      return {
        title: stripTags(c.title),
        url: c.doi ? 'https://doi.org/' + c.doi : '',
        year: c.year || '',
        conference: c.conference || '',
        authors: c.authors || '',
      };
    }).filter(function (p) { return p.title; });

    var presentations = (cvData.presentations || []).map(function (p) {
      return {
        title: stripTags(p.title),
        url: p.slides_url || '',
        year: p.date ? String(p.date).slice(0, 4) : (p.year || ''),
        event: p.event || '',
        type: p.type || '',
      };
    }).filter(function (p) { return p.title; });

    var patents = (cvData.patents || []).map(function (p) {
      return {
        title: stripTags(p.title),
        url: p.number || '',
        year: p.grant_date ? String(p.grant_date).slice(0, 4)
            : (p.filing_date ? String(p.filing_date).slice(0, 4) : ''),
        status: p.status || '',
        inventors: p.inventors || '',
      };
    }).filter(function (p) { return p.title; });

    return { papers: papers, posters: posters, presentations: presentations, patents: patents };
  }

  async function syncNow(uid, cvData) {
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) return;
    var user = firebridge.getUser();
    if (!user || user.uid !== uid || !cvData) return; // owner-only write
    try {
      await firebridge.updateDoc('users', uid, buildProfilePatch(cvData));
    } catch (err) {
      console.warn('[cv-profile-sync] public profile sync failed:', err.message || err);
      if (!_warned && typeof TOAST !== 'undefined') {
        _warned = true;
        TOAST.warn('Public profile sync failed', { detail: 'CV saved fine — the public Team page copy will refresh on the next successful save.' });
      }
    }
  }

  /* Debounced entry point — call after every CV save that touches a
   * publication section. Bulk imports collapse into one write. */
  function schedule(uid, cvData) {
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(function () {
      _timer = null;
      syncNow(uid, cvData);
    }, DEBOUNCE_MS);
  }

  return { schedule: schedule, syncNow: syncNow, buildProfilePatch: buildProfilePatch };
})();
