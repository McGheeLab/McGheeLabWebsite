// capability-registry.js — V3.605
//
// Declares the named per-page "elevated capabilities" an admin can grant to
// individual users from the permissions page (per-user drill-in). Grants are
// stored as a flat string array on userPermissions/{uid}.caps and enforced
// server-side by firestore.rules' hasCap() — this file is UI metadata only.
//
// Cap id format: '<pageSlug>:<capId>'. The pageSlug is the HTML filename
// slug (library-paper ↔ /rm/pages/library-paper.html), NOT a PAGE_REGISTRY
// id — reader pages like library-paper.html aren't nav items, so caps carry
// their own page identity and this file must stay dependency-free (no
// NAV_ITEMS / page-registry.js).
//
// Loaded ONLY by admin-permissions.html. Reader pages never need the
// registry: firebridge.hasCapability() is a plain string-membership check.
//
// Adding a new page later = one entry in PAGES here + hasCap() ORs in
// firestore.rules. The admin UI renders this generically.

(function () {
  'use strict';

  var PAGES = [
    {
      page: 'library-paper',
      label: 'Paper Reader',
      href: '/rm/pages/library-paper.html',
      // Pages worth granting alongside these caps so the user can browse to
      // a paper. Admin-UI nudge only — never auto-written.
      // V3.613 — these caps also cover the Ourlab mobile surfaces
      // (library-mobile.html / library-mobile-paper.html) via the
      // PAGE_ALIASES map in firebase-bridge.js; no separate grant needed.
      companionPageIds: ['library'],
      capabilities: [
        {
          id: 'library-paper:view',
          label: 'Open & read',
          description: 'Open the paper reader and read library papers. Implied by every other capability on this page.',
          base: true,
        },
        {
          id: 'library-paper:annotate',
          label: 'Annotate',
          description: 'Create highlights and notes on library papers.',
          requires: ['library-paper:view'],
        },
        {
          id: 'library-paper:groups',
          label: 'Annotation groups',
          description: 'Create new annotation groups (the "+ New group…" action) without being on the guest-editor email allowlist.',
          requires: ['library-paper:view'],
        },
        {
          id: 'library-paper:capture',
          label: 'Extension capture',
          description: 'Capture papers into the pending queue via the browser extension without being on the extension-members email allowlist.',
          requires: ['library-paper:view'],
        },
      ],
    },
  ];

  var byPage = new Map();
  var byCapId = new Map();
  PAGES.forEach(function (p) {
    byPage.set(p.page, p);
    p.capabilities.forEach(function (c) {
      byCapId.set(c.id, Object.assign({ page: p.page }, c));
    });
  });

  window.CAPABILITY_REGISTRY = {
    pages: PAGES,
    byPage: byPage,
    byCapId: byCapId,
  };
})();
