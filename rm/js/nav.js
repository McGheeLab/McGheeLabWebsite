/* nav.js — renders shared top navigation with dropdown groups.
 *
 * Per-item access gating: each nav item may carry a `gate` field:
 *   - 'admin'      → only visible when firebridge.isAdmin() is true
 *   - 'lab-member' → only visible when firebridge.isLabMember() is true
 *                    (any non-guest signed-in user)
 *   - undefined    → always visible
 *
 * Items without a gate render for everyone, including signed-out users.
 * Guests are covered by the global pending-access overlay (in firebase-bridge.js)
 * so nav-level hiding for them is secondary; the gate machinery exists mainly
 * to keep grad students / undergrads from seeing PI-only links like Email
 * Triage and the lab-shared Calendar.
 *
 * Gating is applied AFTER initial render — nav appears immediately so the
 * page never flashes empty. firebridge.onAuth then hides gated entries; if
 * every child of a group ends up hidden, the group itself is hidden.
 */

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/rm/index.html' },
  { label: 'Activity', href: '/rm/pages/activity-overview.html', children: [
    { label: 'Overview', href: '/rm/pages/activity-overview.html' },
    { label: 'Calendar', href: '/rm/pages/calendar.html' },
    { label: 'Email',    href: '/rm/pages/email-review.html' },
    { label: 'Task',     href: '/rm/pages/tasks.html' },
    { label: 'Year',     href: '/rm/pages/year-review.html' },
  ]},
  { label: 'Research', href: '/rm/pages/projects.html', children: [
    { label: 'Projects', href: '/rm/pages/projects.html' },
    { label: 'Library',  href: '/rm/pages/library.html' },
    { label: 'Comments', href: '/rm/pages/library-comments.html' },
    { label: 'Papers',   href: '/rm/pages/paper-builder.html' },
  ]},
  { label: 'Teaching', href: '/rm/pages/teaching.html' },
  { label: 'Service',  href: '/rm/pages/service.html' },
  { label: 'Inventory', href: '/rm/pages/inventory.html' },
  { label: 'Finance', children: [
    { label: 'Grant Accounts',    href: '/rm/pages/projects-grants.html' },
    { label: 'Procurement',       href: '/rm/pages/receipts.html' },
    { label: 'Purchase Requests', href: '/rm/pages/purchase-requests.html' },
    { label: 'Budget',            href: '/rm/pages/budget.html' },
    { label: 'Analytics',         href: '/rm/pages/analytics.html' },
    { label: 'Travel',            href: '/rm/pages/finance.html' },
  ]},
  { label: 'People', children: [
    { label: 'Lab Members',       href: '/rm/pages/people.html' },
    { label: 'Important People',  href: '/rm/pages/important-people.html' },
    { label: 'Activity',          href: '/rm/pages/activity-summary.html', gate: 'admin' },
  ]},
  { label: 'Admin', gate: 'lab-member', children: [
    { label: 'Compliance',       href: '/rm/pages/compliance.html' },
    { label: 'Chemical Safety',  href: '/rm/pages/chemicals.html' },
    { label: 'Career & Tenure',  href: '/rm/pages/career.html' },
    { label: 'CV Overview',      href: '/rm/pages/cv-overview.html' },
    { label: 'CV Editor',        href: '/rm/pages/cv-editor.html' },
    { label: 'Profile',          href: '/rm/pages/profile.html' },
    { label: 'Settings',         href: '/rm/pages/settings.html' },
  ]},
];

function renderNav() {
  const nav = document.createElement('nav');
  nav.className = 'top-nav';

  const brand = document.createElement('a');
  brand.className = 'brand';
  brand.href = '/rm/index.html';
  brand.textContent = 'McGhee Lab';
  nav.appendChild(brand);

  const currentPath = window.location.pathname;
  const isActive = (href) =>
    currentPath === href || (currentPath === '/' && href === '/rm/index.html');

  NAV_ITEMS.forEach(item => {
    if (item.href && !item.children) {
      // Pure direct link (Dashboard).
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (item.gate) a.dataset.gate = item.gate;
      if (isActive(item.href)) a.classList.add('active');
      nav.appendChild(a);
      return;
    }

    // Dropdown group — may also carry its own href, in which case clicking
    // the trigger navigates to the group's landing page (e.g. Activity →
    // Overview) while hovering still reveals the sub-menu.
    const wrapper = document.createElement('div');
    wrapper.className = 'nav-dropdown';
    if (item.gate) wrapper.dataset.gate = item.gate;

    const trigger = item.href
      ? document.createElement('a')
      : document.createElement('button');
    trigger.className = 'nav-dropdown-trigger';
    trigger.textContent = item.label;
    if (item.href) trigger.href = item.href;

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';

    let groupActive = false;
    item.children.forEach(child => {
      const a = document.createElement('a');
      a.href = child.href;
      a.textContent = child.label;
      if (child.gate) a.dataset.gate = child.gate;
      if (isActive(child.href)) {
        a.classList.add('active');
        groupActive = true;
      }
      menu.appendChild(a);
    });

    if (groupActive || (item.href && isActive(item.href))) {
      trigger.classList.add('active');
    }

    if (item.href) {
      // Navigating item: default anchor behavior handles the click. Hover
      // opens the dropdown so users can still branch to sibling pages.
      wrapper.addEventListener('mouseenter', () => {
        document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
        wrapper.classList.add('open');
      });
      wrapper.addEventListener('mouseleave', () => {
        wrapper.classList.remove('open');
      });
    } else {
      // Non-navigating group: click toggles the dropdown.
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = wrapper.classList.contains('open');
        document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!wasOpen) wrapper.classList.add('open');
      });
    }

    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    nav.appendChild(wrapper);
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-dropdown.open').forEach(d => d.classList.remove('open'));
  });

  document.body.prepend(nav);
  // Apply current auth state immediately (likely a no-op if firebridge hasn't
  // fired yet — onAuth will re-call it).
  applyNavGates();
}

/* Show/hide nav entries based on the signed-in user's permissions. Called
 * once at render and again from firebridge.onAuth whenever auth state
 * changes (sign in, sign out, role promotion via live profile snapshot). */
function applyNavGates() {
  const isAdmin     = (typeof firebridge !== 'undefined') && firebridge.isAdmin && firebridge.isAdmin();
  const isLabMember = (typeof firebridge !== 'undefined') && firebridge.isLabMember && firebridge.isLabMember();
  const allowed = (gate) => {
    if (!gate) return true;
    if (gate === 'admin') return !!isAdmin;
    if (gate === 'lab-member') return !!isLabMember;
    return true;
  };

  // Hide individual items whose gate is unmet.
  document.querySelectorAll('.top-nav [data-gate]').forEach(el => {
    el.style.display = allowed(el.dataset.gate) ? '' : 'none';
  });

  // Hide a dropdown group whose visible children are all hidden — keeps the
  // nav from showing an empty "Activity ▾" with no entries inside.
  document.querySelectorAll('.top-nav .nav-dropdown').forEach(group => {
    if (group.dataset.gate && !allowed(group.dataset.gate)) {
      group.style.display = 'none';
      return;
    }
    const links = group.querySelectorAll('.dropdown-menu > a');
    if (!links.length) return;
    let anyVisible = false;
    links.forEach(a => {
      if (a.style.display !== 'none') anyVisible = true;
    });
    if (!anyVisible) group.style.display = 'none';
    else if (!group.dataset.gate || allowed(group.dataset.gate)) group.style.display = '';
  });
}

document.addEventListener('DOMContentLoaded', renderNav);

// Re-apply gates whenever firebridge auth state changes. firebridge.onAuth
// is registered via window.addEventListener so we don't depend on script load
// order — it'll exist by the time the listener runs.
window.addEventListener('DOMContentLoaded', () => {
  if (typeof firebridge !== 'undefined' && firebridge.onAuth) {
    firebridge.onAuth(() => applyNavGates());
  }
});
