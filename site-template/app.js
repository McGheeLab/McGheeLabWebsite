/* =====================================================================================
   SPA Template (Vanilla JS)
   - Persistent top (banner + hero) never reloads
   - Body swaps by hash router (#/home, #/about, #/projects, #/team, #/contact)
   - Content loaded from content.json
   - Mobile: bottom tab bar + hamburger drawer
   - Scrollspy, lazy images, reveal animations
   ===================================================================================== */

(() => {
  // ---- Persistent containers
  const appEl     = document.getElementById('app');
  const menuBtn   = document.getElementById('menuBtn');
  const navDrawer = document.getElementById('site-nav');

  // ---- State
  const state = {
    data: null,              // normalized content
    observers: [],           // IntersectionObservers to clean up
    cleanups: [],            // event unbinders per page
    bannerHeight: 64         // computed sticky top height
  };

  /* ===========================
     BOOTSTRAP
     =========================== */
  document.addEventListener('DOMContentLoaded', async () => {
    // Year in footer
    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    // Navigation
    setupMenu();

    // Load + normalize content
    const raw = await safeFetchJSON('content.json');
    state.data = normalizeData(raw);

    // Hero text
    const heroEl = document.getElementById('heroText');
    if (heroEl) heroEl.textContent = state.data.site.tagline || '';

    // Footer
    const fa = document.getElementById('footerAbout');
    const fc = document.getElementById('footerContact');
    if (fa) fa.textContent = state.data.site.tagline || '';
    if (fc) fc.innerHTML = formatContact(state.data.site.contact);

    // Sticky offsets
    updateBannerHeight();
    window.addEventListener('resize', debounce(updateBannerHeight, 150));

    // Router
    window.addEventListener('hashchange', onRouteChange);
    onRouteChange();

    // Reduced-motion: stop hero video
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const v = document.getElementById('heroVideo');
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    }
  });

  /* ===========================
     DATA LOADING / NORMALIZATION
     =========================== */

  async function safeFetchJSON(url) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.warn('Failed to fetch content.json, using fallback:', e?.message || e);
      return {
        site: { name: 'My Website', tagline: 'Welcome.', contact: { address: '', email: '', phone: '' } },
        home: [], about: [], projects: [], team: [], contact: { heading: '', body: '' }
      };
    }
  }

  function normalizeData(raw) {
    const safe = (v, def) => (v === undefined || v === null ? def : v);
    const site = safe(raw.site, {});
    site.name    = safe(site.name, 'My Website');
    site.tagline = safe(site.tagline, 'Welcome.');
    site.contact = safe(site.contact, { address: '', email: '', phone: '' });

    return {
      site,
      home:     toArray(raw.home),
      about:    toArray(raw.about),
      projects: toArray(raw.projects),
      team:     toArray(raw.team).map(normalizePerson),
      contact:  safe(raw.contact, { heading: '', body: '' })
    };
  }

  function normalizePerson(p) {
    return {
      name:  str(p?.name),
      role:  str(p?.role),
      photo: str(p?.photo),
      bio:   str(p?.bio)
    };
  }

  const str = (v) => (v === undefined || v === null ? '' : String(v));
  const toArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);

  /* ===========================
     ROUTER
     =========================== */
  function onRouteChange() {
    const hash = window.location.hash || '#/home';
    const parts = hash.slice(2).split('/');
    const page = (parts[0] || 'home').toLowerCase();
    render(page);
    setActiveNav(page);
    closeMenu();
  }

  function setActiveNav(page) {
    // Desktop nav
    document.querySelectorAll('#desktop-nav a[data-route]').forEach(a => {
      a.setAttribute('aria-current', a.dataset.route === page ? 'page' : 'false');
    });
    // Mobile bottom tabs
    document.querySelectorAll('#bottom-tabs .tab-item').forEach(item => {
      const isActive = item.dataset.route === page;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
    // Drawer nav
    document.querySelectorAll('#site-nav a[data-route]').forEach(a => {
      a.setAttribute('aria-current', a.dataset.route === page ? 'page' : 'false');
    });
  }

  /* ===========================
     PAGE RENDERER
     =========================== */
  function render(page) {
    // Clean previous page observers/listeners
    state.observers.forEach(o => o.disconnect()); state.observers = [];
    state.cleanups.forEach(fn => { try { fn(); } catch {} }); state.cleanups = [];

    let view;
    try {
      switch (page) {
        case 'home':     view = renderSections(state.data.home, 'home');       break;
        case 'about':    view = renderSections(state.data.about, 'about');     break;
        case 'projects': view = renderProjects();                               break;
        case 'team':     view = renderTeam();                                   break;
        case 'contact':  view = renderContact();                                break;
        default:         view = renderNotFound();
      }
    } catch (err) {
      console.error('Render error on page "' + page + '":', err);
      view = sectionEl();
      view.innerHTML = '<div class="info-box"><p>Something went wrong loading this page. Please try refreshing.</p></div>';
    }

    appEl.innerHTML = '';
    appEl.appendChild(view);
    appEl.focus({ preventScroll: true });

    // Scroll to top of content
    window.scrollTo({ top: headerBottom(), behavior: 'smooth' });

    // Reveal + Lazy images
    enableReveal();
    enableLazyImages();
  }

  /* ===========================
     PAGE BUILDERS
     =========================== */

  // Generic sections renderer (for home, about, etc.)
  function renderSections(sections, pageId) {
    const wrap = sectionEl();
    if (!sections || !sections.length) {
      wrap.innerHTML = '<div class="info-box"><p>No content yet. Edit content.json to add sections.</p></div>';
      return wrap;
    }
    sections.forEach((s, i) => {
      const block = div('content-block reveal' + (i % 2 ? ' reverse' : ''));
      block.innerHTML = `
        <div class="text-col">
          <h2>${esc(s.title || '')}</h2>
          <p>${esc(s.body || '')}</p>
          ${s.points ? '<ul>' + s.points.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' : ''}
        </div>
        ${s.image ? `<div class="img-col"><img data-src="${esc(s.image)}" alt="${esc(s.imageAlt || '')}" class="lazy" loading="lazy" /></div>` : ''}
      `;
      wrap.appendChild(block);
    });
    return wrap;
  }

  function renderProjects() {
    const wrap = sectionEl();
    const projects = state.data.projects;
    wrap.innerHTML = '<h2 class="page-title reveal">Projects</h2>';

    if (!projects.length) {
      wrap.innerHTML += '<div class="info-box"><p>No projects yet. Add them in content.json.</p></div>';
      return wrap;
    }

    const grid = div('card-grid');
    projects.forEach(p => {
      const card = div('card reveal');
      card.innerHTML = `
        ${p.image ? `<img data-src="${esc(p.image)}" alt="${esc(p.imageAlt || '')}" class="lazy card-img" loading="lazy" />` : ''}
        <h3>${esc(p.title || 'Untitled')}</h3>
        <p>${esc(p.body || '')}</p>
      `;
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function renderTeam() {
    const wrap = sectionEl();
    const team = state.data.team;
    wrap.innerHTML = '<h2 class="page-title reveal">Team</h2>';

    if (!team.length) {
      wrap.innerHTML += '<div class="info-box"><p>No team members yet. Add them in content.json.</p></div>';
      return wrap;
    }

    const grid = div('card-grid');
    team.forEach(m => {
      const card = div('card team-card reveal');
      card.innerHTML = `
        ${m.photo ? `<img data-src="${esc(m.photo)}" alt="${esc(m.name)}" class="lazy team-photo" loading="lazy" />` : '<div class="team-photo-placeholder"></div>'}
        <h3>${esc(m.name)}</h3>
        <p class="role">${esc(m.role)}</p>
        ${m.bio ? `<p class="bio">${esc(m.bio)}</p>` : ''}
      `;
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function renderContact() {
    const wrap = sectionEl();
    const c = state.data.contact;
    const site = state.data.site;
    wrap.innerHTML = `
      <div class="content-block reveal">
        <div class="text-col">
          <h2>${esc(c.heading || 'Contact')}</h2>
          <p>${esc(c.body || '')}</p>
          <address>${formatContact(site.contact)}</address>
        </div>
      </div>
    `;
    return wrap;
  }

  function renderNotFound() {
    const wrap = sectionEl();
    wrap.innerHTML = '<div class="info-box"><h2>Page not found</h2><p><a href="#/home">Back to home</a></p></div>';
    return wrap;
  }

  /* ===========================
     HELPERS
     =========================== */

  function sectionEl() {
    const el = document.createElement('section');
    el.className = 'max-w page-section';
    return el;
  }

  function div(cls) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    return el;
  }

  function esc(s) {
    const el = document.createElement('span');
    el.textContent = s;
    return el.innerHTML;
  }

  function formatContact(c) {
    if (!c) return '';
    const parts = [];
    if (c.address) parts.push(esc(c.address));
    if (c.email) parts.push(`<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
    if (c.phone) parts.push(`<a href="tel:${c.phone.replace(/\D/g, '')}">${esc(c.phone)}</a>`);
    return parts.join('<br/>');
  }

  function headerBottom() {
    const header = document.getElementById('site-header');
    return header ? header.offsetHeight : 0;
  }

  function updateBannerHeight() {
    const banner = document.querySelector('.top-banner');
    if (banner) {
      state.bannerHeight = banner.offsetHeight;
      document.documentElement.style.setProperty('--banner-height', state.bannerHeight + 'px');
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ===========================
     NAVIGATION
     =========================== */

  function setupMenu() {
    if (!menuBtn || !navDrawer) return;
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') === 'true';
      menuBtn.setAttribute('aria-expanded', !open);
      navDrawer.setAttribute('aria-hidden', open);
      navDrawer.classList.toggle('open', !open);
    });
    // Close drawer on link click
    navDrawer.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', closeMenu);
    });
    // Close drawer on outside click
    document.addEventListener('click', (e) => {
      if (!navDrawer.contains(e.target) && !menuBtn.contains(e.target)) {
        closeMenu();
      }
    });
  }

  function closeMenu() {
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    if (navDrawer) {
      navDrawer.setAttribute('aria-hidden', 'true');
      navDrawer.classList.remove('open');
    }
  }

  /* ===========================
     LAZY IMAGES & REVEAL
     =========================== */

  function enableLazyImages() {
    const imgs = appEl.querySelectorAll('img.lazy[data-src]');
    if (!imgs.length) return;
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const img = e.target;
        img.src = img.dataset.src;
        img.classList.remove('lazy');
        obs.unobserve(img);
      });
    }, { rootMargin: '200px' });
    imgs.forEach(img => io.observe(img));
    state.observers.push(io);
  }

  function enableReveal() {
    const els = appEl.querySelectorAll('.reveal');
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1 });
    els.forEach(el => io.observe(el));
    state.observers.push(io);
  }

})();
