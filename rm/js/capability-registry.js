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
    {
      // V3.729 — "Create papers". Lab members (role != guest) can already
      // create a paper row via isLabMember() in the /projects rule; this cap
      // lifts a GUEST or collaborator into the same power, and — because a
      // cap on a page slug implies access to that page (canAccessPage) —
      // opens paper-builder.html for them too. Everything downstream of the
      // row (blocks, yjs, comments) is gated by isPaperAuthor(), which the
      // paper-author-sync function grants to the new lead author.
      //
      // `section: 'papers'` — the admin per-user panel renders this cap at
      // the top of its Papers section (next to coauthor roles), not in the
      // generic Capabilities cards.
      page: 'paper-builder',
      label: 'Paper Builder',
      href: '/rm/pages/paper-builder.html',
      section: 'papers',
      capabilities: [
        {
          id: 'paper-builder:create',
          label: 'Create papers',
          description: 'Start new papers and grants in the Paper Builder as lead author (and open the Paper Builder page). Lab members already have this; grant it to a guest or collaborator who should write with us.',
        },
      ],
    },
    {
      // V3.646 — the FIRST non-library-paper page in this registry.
      //
      // Enforced by isInvMgr() in firestore.rules, which gates the one thing
      // that actually matters: an ordinary lab member may only DECREASE
      // qty_remaining (that is a consumption event), while a manager may set an
      // absolute value (that is a recount, and it is the auditable act).
      //
      // The cap is also the ADDRESSING primitive — functions/inventory-alerts.js
      // finds who to tell with
      //   userPermissions.where('caps','array-contains','inventory:manage')
      // so there is no separate managers[] list to keep in step. Grant it to
      // whoever actually reorders supplies; admins have it implicitly, and with
      // nobody holding it every low-stock alert lands on the PI alone.
      page: 'inventory',
      label: 'Inventory',
      href: '/rm/pages/inventory.html',
      companionPageIds: ['inventory', 'chemicals'],
      capabilities: [
        {
          id: 'inventory:manage',
          label: 'Manage quantities',
          description: 'Correct how much is left (a recount), switch quantity tracking on for an item, set reorder points, and re-parent or retire a storage box. Also receives the low-stock alerts and the daily low-stock digest. Without this, a member can still record what they took \u2014 they just cannot raise a count.',
        },
      ],
    },
    {
      // V3.813 — Procurement v2. Who may decide on a request and who may
      // place the order, without being an admin. firestore.rules'
      // procurementTickets block ORs these into the transition table, and
      // functions/procurement-notify.js addresses "new request" / "ready to
      // order" pushes by querying the same caps — so granting one here is
      // the whole act. Admins hold both implicitly; with nobody else
      // holding them, every request lands on the PI alone.
      page: 'procurement',
      label: 'Procurement',
      href: '/rm/pages/procurement.html',
      companionPageIds: ['procurement', 'inventory'],
      capabilities: [
        {
          id: 'procurement:approve',
          label: 'Approve requests',
          description: 'Approve, deny, or ask a question about purchase requests, and get notified when one comes in. The PI\u2019s decision power, delegable to a lab manager.',
        },
        {
          id: 'procurement:order',
          label: 'Place orders',
          description: 'Mark approved requests ordered (PO number, how it was bought, expected delivery, batch several items on one PO), undo an order, clear a flagged problem. Gets the \u201cready to order\u201d and overdue-order notifications.',
        },
      ],
    },
    {
      // V3.673 — the engagement hub lives on the PUBLIC site, not under
      // /rm/. V3.785: presenters now come through the link-only
      // #/presenters page and ANY signed-in user may browse and request, so
      // neither cap gates anything any more. Kept (not deleted) so existing
      // grants don't dangle; admin blocks a presenter from the Teachers
      // page's Engagement tab instead.
      page: 'engage',
      label: 'Engagement Hub',
      href: '/#/presenters',
      capabilities: [
        {
          id: 'engage:browse',
          label: 'Browse availability',
          description: 'No longer needed (V3.785): anyone signed in through the presenter link (/#/presenters) can see openings. Kept so older grants still read correctly.',
          base: true,
        },
        {
          id: 'engage:request',
          label: 'Request visits',
          description: 'No longer needed (V3.785): anyone signed in through the presenter link can request a visit. To stop someone, Block them on the Teachers page’s Engagement tab.',
          requires: ['engage:browse'],
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
