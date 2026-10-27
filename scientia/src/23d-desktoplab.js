/* ==========================================================================
   23d · The lab layer on this computer. The desktop build loads the website's
   lab layer too (rm/scientia/lab-mode.js, unchanged, with window.SIS_DESKTOP
   set), so the app here is the lab's: the pills and Quick cast, Portfolio,
   Lit reviews, RM's library, materials and tasks, the one recorder… Its RM
   calls go through this computer's server to the lab hub; its recordings
   are saved in the notebook folder; RM's own pages open on the site.
   What the lab layer takes away because the website cannot have it, the
   computer keeps: the Activity and Data tabs (folder handles need the
   computer). The ✓ stays this app's own (23b), which works offline — the
   lab's asks the Lab Notebook around it, and there is none here.
   ========================================================================== */
const DESKLAB = {
  on: () => !!window.SIS_DESKTOP,
  KEEP: ['activity', 'data'],
  keep: null
};
if (DESKLAB.on()) {
  document.documentElement.classList.add('sis-desktop');
  DESKLAB.keep = { tabs: TABS.map(t => t.slice()), views: Object.fromEntries(DESKLAB.KEEP.map(id => [id, VIEWS[id]])) };
  /* called by the build right after the lab layer ran, before the first render */
  window.SIS_DESKTOP_AFTER_LAB = () => {
    try {
      for (const id of DESKLAB.KEEP) {
        if (DESKLAB.keep.views[id]) VIEWS[id] = DESKLAB.keep.views[id];
        if (TABS.some(t => t[0] === id)) continue;
        const orig = DESKLAB.keep.tabs, i = orig.findIndex(t => t[0] === id); if (i < 0) continue;
        let at = TABS.length;                                   // after the nearest tab that came before it
        for (let j = i - 1; j >= 0; j--) { const k = TABS.findIndex(t => t[0] === orig[j][0]); if (k >= 0) { at = k + 1; break; } }
        TABS.splice(at, 0, orig[i].slice());
      }
    } catch (e) { console.warn('[desktop lab]', e); }
  };
}
