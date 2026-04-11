/* =====================================================================================
   McGheeLab SPA (robust edition)
   - Persistent top (banner + hero) never reloads
   - Body swaps by hash router (#/mission, #/research, #/projects, #/team, #/classes, #/contact)
   - Content loaded from a simplified content.json (with backward compatibility)
   - Mobile: chip subnav swipeable via touch/pen only (mouse clicks never blocked)
   - Clicking a chip scrolls its section to the MIDDLE of the visible area
   - Scrollspy highlights the section nearest the visible center line
   - Research/Projects "stories": expandable multi-block details (images + text)
   - Strong input normalization so minor JSON mistakes don't crash the site
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
    bannerHeight: 64,        // computed sticky top height
    idCounters: Object.create(null) // for unique ids per page
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
    setupBottomTabs();
    setupDesktopDropdowns();

    // Load + normalize content
    const raw = await safeFetchJSON('content.json');
    state.data = normalizeData(raw);

    // Hero mission (pink phrase + period)
    applyMissionText(state.data.site.mission);

    // Footer
    const fm = document.getElementById('footerMission');
    const fc = document.getElementById('footerContact');
    if (fm) fm.textContent = state.data.site.mission || '';
    if (fc) fc.innerHTML = formatContact(state.data.site.contact);

    // Sticky offsets
    updateBannerHeight();
    window.addEventListener('resize', debounce(updateBannerHeight, 150));
    window.addEventListener('orientationchange', updateBannerHeight);
    window.addEventListener('load', updateBannerHeight);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(updateBannerHeight);
    }

    // Router
    window.addEventListener('hashchange', onRouteChange);
    onRouteChange();

    // Re-render current page when auth state resolves or changes
    let lastAuthUid = null;
    if (window.McgheeLab?.Auth?.onChange) {
      window.McgheeLab.Auth.onChange((user) => {
        const uid = user?.uid || null;
        const hash = window.location.hash || '';
        const page = hash.slice(2).split('/')[0]?.toLowerCase();
        // Always re-render apps page on auth change (even same uid) to resolve loading states
        if (page === 'apps') { lastAuthUid = uid; onRouteChange(); return; }
        if (uid === lastAuthUid) return; // same user, skip
        lastAuthUid = uid;
        if (page === 'dashboard' || page === 'admin' || page === 'login' || page === 'cv') onRouteChange();

        // Proactive push prompt for installed PWA on first launch
        if (user) maybePromptPushPermission(user);
      });
    }

    // Reduced-motion: stop hero video
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const v = document.getElementById('heroVideo');
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    }

    // PWA setup
    setupPWA();
  });

  /* ===========================
     DATA LOADING / NORMALIZATION
     =========================== */

  async function safeFetchJSON(url){
    try{
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }catch(e){
      console.warn('Failed to fetch content.json, using fallback:', e?.message || e);
      // Minimal safe fallback to keep site usable
      return {
        site: {
          name: "McGheeLab",
          mission: "We build in vitro models to study the mechanisms driving metastasis.",
          contact: { address: "", email: "", phone: "" }
        },
        mission: [],
        team: { highschool: [], undergrad: [], grad: [], postdoc: [], alumni: [] },
        classes: { intro: "" }
      };
    }
  }

  // Accepts either the new simplified schema or older "pages.*" variants.
  function normalizeData(raw){
    const safe = (v, def) => (v === undefined || v === null ? def : v);

    // Site
    const site = safe(raw.site, {});
    site.name    = safe(site.name, 'McGheeLab');
    site.mission = safe(site.mission, 'We build in vitro models to study the mechanisms driving metastasis.');
    site.contact = safe(site.contact, { address: '', email: '', phone: '' });

    // New simple shape, with fallback to old:
    const mission = toArray(raw.mission?.length ? raw.mission : raw?.pages?.missionPage?.sections);

    const teamSrc = raw.team || raw?.pages?.team || {};
    const team = {
      highschool: toArray(teamSrc.highschool).map(normalizePerson),
      undergrad:  toArray(teamSrc.undergrad).map(normalizePerson),
      grad:       toArray(teamSrc.grad).map(normalizePerson),
      postdoc:    toArray(teamSrc.postdoc).map(normalizePerson),
      alumni:    toArray(teamSrc.alumni).map(normalizePerson)
    };

    const classesSrc = raw.classes || raw?.pages?.classesPage || {};
    const classes = {
      intro: str(classesSrc.intro)
    };

    return { site, mission, team, classes };
  }

  function normalizePerson(p){
    return {
      name: str(p?.name),
      role: str(p?.role),
      photo: str(p?.photo),
      bio: str(p?.bio)
    };
  }

  const str = (v) => (v === undefined || v === null ? '' : String(v));
  const toArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  const isNonEmptyArray = (v) => Array.isArray(v) && v.length > 0;

  /* ===========================
     ROUTER
     =========================== */
  function onRouteChange(){
    const hash = window.location.hash || '#/mission';
    const parts = hash.slice(2).split('/');
    const page = (parts[0] || 'mission').toLowerCase().split('?')[0];
    render(page, parts.slice(1));
    setActiveTopNav(page);
    closeAllSheets();
    closeAllDropdowns();
  }

  // Route-to-group mapping for nav highlighting
  const NAV_GROUPS = {
    research: 'research', projects: 'research', news: 'research',
    team: 'people', opportunities: 'people',
    classes: 'classes'
  };

  function setActiveTopNav(page){
    const group = NAV_GROUPS[page] || null;

    // Desktop dropdown links
    document.querySelectorAll('#desktop-nav a[data-route]').forEach(a => {
      a.setAttribute('aria-current', a.dataset.route === page ? 'page' : 'false');
    });
    // Desktop group buttons — highlight when any child route is active
    document.querySelectorAll('#desktop-nav .nav-group-btn').forEach(btn => {
      const hasActive = btn.closest('.nav-group')?.querySelector(`a[data-route="${page}"]`);
      btn.classList.toggle('group-active', !!hasActive);
    });

    // Mobile bottom tabs — highlight by group
    document.querySelectorAll('#bottom-tabs .tab-item').forEach(item => {
      let isActive = false;
      if(item.dataset.route){
        // Direct link tab (Classes)
        isActive = item.dataset.route === page;
      } else if(item.dataset.group){
        if(item.dataset.group === 'more'){
          // "More" tab: active for auth-only pages
          isActive = !group && page !== 'mission';
        } else {
          isActive = group === item.dataset.group;
        }
      }
      item.classList.toggle('active', isActive);
      if(item.dataset.route) item.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    // Sheet links
    document.querySelectorAll('.group-sheet a[data-route]').forEach(a => {
      a.setAttribute('aria-current', a.dataset.route === page ? 'page' : 'false');
    });

    // Old drawer (fallback)
    document.querySelectorAll('#site-nav a[data-route]').forEach(a => {
      a.setAttribute('aria-current', a.dataset.route === page ? 'page' : 'false');
    });
  }

  /* ===========================
     PAGE RENDERER
     =========================== */
  async function render(page, subParts){
    subParts = subParts || [];
    // Clean previous page observers/listeners
    state.observers.forEach(o => o.disconnect()); state.observers = [];
    state.cleanups.forEach(fn => { try{ fn(); }catch{} }); state.cleanups = [];
    state.idCounters = Object.create(null); // reset id counters per page

    let view;
    try {
      switch (page){
        case 'mission':  view = renderMission();  break;
        case 'research': view = renderResearch(); break;
        case 'projects': view = renderProjects(); break;
        case 'team':     view = renderTeam();     break;
        case 'classes': {
          const classSlug = (subParts[0] || '').split('?')[0];
          if (classSlug && subParts[1] === 'modules' && subParts[2]) {
            // Module viewer: #/classes/{classId}/modules/{filename}
            const moduleFile = decodeURIComponent(subParts[2].split('?')[0]);
            const html = window.McgheeLab?.renderModuleViewer?.(classSlug, moduleFile);
            if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          } else if (classSlug) {
            const html = window.McgheeLab?.renderClassPage?.(classSlug);
            if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          } else {
            view = renderClasses();
          }
          break;
        }
        case 'news':     view = renderNews();     break;
        case 'opportunities': {
          const html = window.McgheeLab?.renderOpportunities?.();
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'login': {
          const html = window.McgheeLab?.renderLogin?.();
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'dashboard': {
          let html;
          if (subParts[0] === 'story' && subParts[1]) {
            html = window.McgheeLab?.renderStoryEditor?.(subParts[1]);
          } else if (subParts[0] === 'project' && subParts[1]) {
            html = window.McgheeLab?.renderProjectEditor?.(subParts[1]);
          } else if (subParts[0] === 'news' && subParts[1]) {
            html = window.McgheeLab?.renderNewsEditor?.(subParts[1]);
          } else if (subParts[0] === 'scheduler' && subParts[1]) {
            html = window.McgheeLab?.renderSchedulerEditor?.(subParts[1]);
          } else {
            html = window.McgheeLab?.renderDashboard?.();
          }
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'guide': {
          const html = window.McgheeLab?.renderGuide?.();
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'cv': {
          const html = window.McgheeLab?.renderCV?.();
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'admin': {
          const html = window.McgheeLab?.renderAdmin?.();
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'apps': {
          let html;
          const appSlug = (subParts[0] || '').split('?')[0];
          if (appSlug) {
            html = window.McgheeLab?.renderLabApp?.(appSlug);
          } else {
            html = window.McgheeLab?.renderLabApps?.();
          }
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          break;
        }
        case 'schedule': {
          const schedSlug = (subParts[0] || '').split('?')[0];
          if (schedSlug) {
            const html = window.McgheeLab?.renderSchedulePage?.(schedSlug);
            if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
          } else {
            view = renderNotFound();
          }
          break;
        }
        case 'contact':
          window.location.hash = '#/opportunities'; return;
        case 'logout':
          if (window.McgheeLab?.Auth?.logout) { McgheeLab.Auth.logout(); return; }
          window.location.hash = '#/mission'; return;
        default:         view = renderNotFound();
      }
    } catch (err) {
      console.error('Render error on page "' + page + '":', err);
      view = sectionEl();
      view.appendChild(infoBox('Something went wrong loading this page. Please try refreshing.'));
    }

    appEl.innerHTML = '';
    appEl.appendChild(view);
    appEl.focus({ preventScroll: true });

    // CV builder, module viewer, and lab apps use their own full layout — hide hero
    const heroEl = document.querySelector('.hero');
    const footerEl = document.querySelector('.site-footer');
    const isModuleViewer = page === 'classes' && subParts[1] === 'modules' && subParts[2];
    const isAppsEnv = page === 'apps';
    const isAppEmbedded = isAppsEnv && !!(subParts[0] || '').split('?')[0];
    const hideHero = page === 'cv' || isModuleViewer || isAppsEnv;
    const hideFooter = isAppsEnv;
    if (heroEl) heroEl.style.display = hideHero ? 'none' : '';
    if (footerEl) footerEl.style.display = hideFooter ? 'none' : '';
    // Body classes for CSS to hide parent chrome in apps environment
    document.body.classList.toggle('apps-env', isAppsEnv);
    document.body.classList.toggle('apps-embedded', isAppEmbedded);

    // Wire subnav (desktop clicks + touch/pen swipe)
    wireUpSubnav(view);

    // Start the body just under hero on route change
    if (hideHero) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else {
      window.scrollTo({ top: headerBottom(), behavior: 'smooth' });
    }

    // Reveal + Lazy images
    enableReveal();
    enableLazyImages();

    // Wire user-system pages (auth, dashboard, story editor, admin)
    try {
      switch (page) {
        case 'login':     window.McgheeLab?.wireLogin?.(); break;
        case 'dashboard':
          if (subParts[0] === 'story' && subParts[1]) {
            await window.McgheeLab?.wireStoryEditor?.(subParts[1]);
          } else if (subParts[0] === 'project' && subParts[1]) {
            await window.McgheeLab?.wireProjectEditor?.(subParts[1]);
          } else if (subParts[0] === 'news' && subParts[1]) {
            await window.McgheeLab?.wireNewsEditor?.(subParts[1]);
          } else if (subParts[0] === 'scheduler' && subParts[1]) {
            await window.McgheeLab?.wireSchedulerEditor?.(subParts[1]);
          } else {
            await window.McgheeLab?.wireDashboard?.();
          }
          break;
        case 'opportunities': await window.McgheeLab?.wireOpportunities?.(); break;
        case 'cv':        await window.McgheeLab?.wireCV?.(); break;
        case 'admin':     await window.McgheeLab?.wireAdmin?.(); break;
        case 'apps': {
          const wireAppSlug = (subParts[0] || '').split('?')[0];
          if (wireAppSlug) await window.McgheeLab?.wireLabApp?.(wireAppSlug);
          else await window.McgheeLab?.wireLabApps?.();
          break;
        }
        case 'guide':     window.McgheeLab?.wireGuide?.(); break;
        case 'classes': {
          const wireSlug = (subParts[0] || '').split('?')[0];
          if (wireSlug && subParts[1] === 'modules' && subParts[2]) {
            const wireModFile = decodeURIComponent(subParts[2].split('?')[0]);
            await window.McgheeLab?.wireModuleViewer?.(wireSlug, wireModFile);
          } else if (wireSlug) {
            await window.McgheeLab?.wireClassPage?.(wireSlug);
          }
          break;
        }
        case 'schedule': {
          const wireSchedSlug = (subParts[0] || '').split('?')[0];
          if (wireSchedSlug) await window.McgheeLab?.wireSchedulePage?.(wireSchedSlug);
          break;
        }
      }
    } catch (err) { console.warn('User system wiring error:', err); }

    // Load Firestore-driven projects page
    if (page === 'projects' && window.McgheeLab?.DB) {
      const stackEl = appEl.querySelector('#projects-stack');
      if (stackEl) {
        try {
          const projects = await McgheeLab.DB.getPublishedProjects();
          if (!projects.length) {
            stackEl.innerHTML = '<div class="empty-state-card"><p>No projects published yet.</p></div>';
          } else {
            stackEl.innerHTML = '';
            for (const p of projects) {
              const card = await buildProjectStackCard(p);
              stackEl.appendChild(card);
            }
            enableReveal();
            enableLazyImages();
          }
        } catch (e) {
          stackEl.innerHTML = '<p class="error-text">Failed to load projects.</p>';
          console.warn('Projects load error:', e);
        }
      }
    }

    // Load Firestore-driven research stories feed
    if (page === 'research' && window.McgheeLab?.DB) {
      const feedEl = appEl.querySelector('#stories-feed');
      if (feedEl) {
        try {
          const stories = await McgheeLab.DB.getPublishedStories();
          if (!stories.length) {
            feedEl.innerHTML = '<div class="empty-state-card"><p>No research stories published yet.</p></div>';
          } else {
            feedEl.innerHTML = '';
            for (const s of stories) {
              feedEl.appendChild(buildStoryFeedCard(s));
            }
            enableReveal();
            enableLazyImages();
            wireStoryFeedInteractions(feedEl);
          }
        } catch (e) {
          feedEl.innerHTML = '<p class="error-text">Failed to load stories: ' + (e.message || e) + '</p>';
          console.warn('Stories feed error:', e);
        }
      }
    }

    // Load Firestore-driven news feed
    if (page === 'news' && window.McgheeLab?.DB) {
      const feedEl = appEl.querySelector('#news-feed');
      if (feedEl) {
        try {
          const posts = await McgheeLab.DB.getPublishedNews();
          if (!posts.length) {
            feedEl.innerHTML = '<div class="empty-state-card"><p>No news posted yet.</p></div>';
          } else {
            feedEl.innerHTML = '';
            for (const p of posts) {
              feedEl.appendChild(buildNewsFeedCard(p));
            }
            enableReveal();
            enableLazyImages();
            wireNewsFeedInteractions(feedEl);
          }
        } catch (e) {
          feedEl.innerHTML = '<p class="error-text">Failed to load news: ' + (e.message || e) + '</p>';
          console.warn('News feed error:', e);
        }
      }
    }

    // Load Firestore-driven classes listing
    if (page === 'classes' && window.McgheeLab?.DB) {
      const gridEl = appEl.querySelector('#classes-grid');
      if (gridEl) {
        try {
          const courses = await McgheeLab.DB.getPublishedClasses();
          if (!courses.length) {
            gridEl.innerHTML = '<div class="empty-state-card"><p>No classes listed yet.</p></div>';
          } else {
            gridEl.innerHTML = '';
            for (const course of courses) {
              const card = div('card class-item reveal');
              const cd = course.classDates || {};
              const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
              const daysStr = (cd.daysOfWeek || []).map(d => dayNames[d]).join(', ');
              const timeStr = cd.startTime && cd.endTime ? `${cd.startTime} - ${cd.endTime}` : '';
              const dateRange = cd.startDate && cd.endDate
                ? new Date(cd.startDate + 'T00:00').toLocaleDateString('en-US', {month:'short',day:'numeric'}) + ' - ' + new Date(cd.endDate + 'T00:00').toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'})
                : '';
              const schedLine = [daysStr, timeStr, cd.frequency && cd.frequency !== 'weekly' ? cd.frequency : ''].filter(Boolean).join(' &middot; ');

              card.innerHTML = `
                <h3>${course.detailPage ? `<a href="#/classes/${esc(course.detailPage)}">${esc(course.title || 'Untitled')}</a>` : esc(course.title || 'Untitled')}</h3>
                ${course.description ? `<p>${esc(course.description)}</p>` : ''}
                <p>
                  ${course.level ? `<span class="badge">${esc(course.level)}</span>` : ''}
                  ${course.when  ? ` <span class="badge">${esc(course.when)}</span>` : ''}
                </p>
                ${schedLine || dateRange ? `<p class="class-schedule-line" style="font-size:.85rem;color:var(--muted,#a8b3c7);">${schedLine}${schedLine && dateRange ? '<br>' : ''}${dateRange}</p>` : ''}
                ${course.detailPage ? `<p><a href="#/classes/${esc(course.detailPage)}" class="btn">View Class &rarr;</a></p>` : ''}
                ${course.registrationLink ? `<p><a href="${esc(course.registrationLink)}" target="_blank" rel="noopener">Register</a></p>` : ''}
              `;
              gridEl.appendChild(card);
            }
            enableReveal();
          }
        } catch (e) {
          gridEl.innerHTML = '<p class="error-text">Failed to load classes.</p>';
          console.warn('Classes load error:', e);
        }
      }
    }

    // Overlay registered user profiles onto team page cards
    if (page === 'team' && window.McgheeLab?.DB) {
      Promise.all([
        McgheeLab.DB.getClaimedProfiles(),
        McgheeLab.DB.getAllUsers(),
        McgheeLab.DB.getPublishedStories().catch(() => [])
      ]).then(([claimed, users, allStories]) => {
        // Remove loading placeholder
        const loadingEl = document.getElementById('team-loading');
        if (loadingEl) loadingEl.remove();

        // Exclude guests from team page
        const teamUsers = users.filter(u => u.role !== 'guest');

        // Index published stories by authorUid
        const storiesByAuthor = {};
        allStories.forEach(s => {
          if (!s.authorUid) return;
          if (!storiesByAuthor[s.authorUid]) storiesByAuthor[s.authorUid] = [];
          storiesByAuthor[s.authorUid].push(s);
        });

        const matchedUids = new Set();
        const matchedCards = new Set();

        // Badge definitions (from user-system.js)
        const badges = window.McgheeLab?.BADGE_DEFS || [];

        // Build badge row HTML for a team card
        function buildBadgesHTML(user, storyCount) {
          let html = '';
          const items = [
            { key: 'papers',        count: (user.papers || []).length },
            { key: 'posters',       count: (user.posters || []).length },
            { key: 'presentations', count: (user.presentations || []).length },
            { key: 'patents',       count: (user.patents || []).length },
            { key: 'protocols',     count: (user.protocols || []).length },
            { key: 'stories',       count: storyCount },
          ];
          items.forEach(({ key, count }) => {
            if (!count) return;
            const def = badges.find(b => b.key === key);
            if (!def) return;
            html += `<span class="team-badge" title="${def.label}">${def.svg} ${count}</span>`;
          });
          // Presence-only badges (no count)
          if (user.finalWork?.url) {
            const fwDef = badges.find(b => b.key === 'finalWork');
            const fwLabel = user.priorCategory === 'grad' || user.priorCategory === 'postdoc' ? 'Thesis' : 'Final Project';
            if (fwDef) html += `<a href="${esc(user.finalWork.url)}" target="_blank" class="team-badge team-badge-link" title="${fwLabel}">${fwDef.svg}</a>`;
          }
          if (user.cv) {
            const cvDef = badges.find(b => b.key === 'cv');
            if (cvDef) html += `<a href="${esc(user.cv)}" target="_blank" class="team-badge team-badge-link" title="Download CV">${cvDef.svg}</a>`;
          }
          if (user.github) {
            const ghDef = badges.find(b => b.key === 'github');
            if (ghDef) html += `<a href="${esc(user.github)}" target="_blank" class="team-badge team-badge-link" title="GitHub">${ghDef.svg}</a>`;
          }
          if (user.linkedin) {
            const liDef = badges.find(b => b.key === 'linkedin');
            if (liDef) html += `<a href="${esc(user.linkedin)}" target="_blank" class="team-badge team-badge-link" title="LinkedIn">${liDef.svg}</a>`;
          }
          if (user.researchgate) {
            const rgDef = badges.find(b => b.key === 'researchgate');
            if (rgDef) html += `<a href="${esc(user.researchgate)}" target="_blank" class="team-badge team-badge-link" title="ResearchGate">${rgDef.svg}</a>`;
          }
          if (user.googleScholar) {
            const gsDef = badges.find(b => b.key === 'googleScholar');
            if (gsDef) html += `<a href="${esc(user.googleScholar)}" target="_blank" class="team-badge team-badge-link" title="Google Scholar">${gsDef.svg}</a>`;
          }
          return html ? `<div class="team-badges">${html}</div>` : '';
        }

        // Build CV-style expanded HTML for PI cards — collapsible, sorted by year, with citations
        function buildPiExpandedHTML(user) {
          const uid = user.id || user.uid;
          const stories = uid ? (storiesByAuthor[uid] || []) : [];

          // Sort helper: descending year, items without year go last
          const byYear = (a, b) => {
            const ya = parseInt(a.year, 10) || 0;
            const yb = parseInt(b.year, 10) || 0;
            if (ya && yb) return yb - ya;
            if (ya) return -1;
            if (yb) return 1;
            return (a.title || '').localeCompare(b.title || '');
          };

          // Build rich item lists with year + metadata
          const pubItems = (user.papers || []).map(p => ({
            title: p.title, href: p.url, year: p.year || '',
            citations: parseInt(p.citations, 10) || 0,
            meta: [p.journal, p.volume ? ('vol. ' + p.volume) : '', p.issue ? ('(' + p.issue + ')') : '', p.pages].filter(Boolean).join(', ')
          })).sort(byYear);

          const patentItems = (user.patents || []).map(p => ({
            title: p.title, href: p.url, year: p.year || '',
            meta: [p.inventors, p.status].filter(Boolean).join(' — ')
          })).sort(byYear);

          const presItems = (user.presentations || []).map(p => ({
            title: p.title, href: p.url, year: p.year || '',
            meta: [p.event, p.type].filter(Boolean).join(' — ')
          })).sort(byYear);

          const posterItems = (user.posters || []).map(p => ({
            title: p.title, href: p.url, year: p.year || '',
            meta: p.conference || ''
          })).sort(byYear);

          const protoItems = (user.protocols || []).map(p => ({
            title: p.title, href: p.url, year: p.year || '', meta: ''
          })).sort(byYear);

          const storyItems = stories.map(s => ({
            title: s.title || 'Untitled', href: '#/research', year: '',
            meta: '', extra: s.projectTitle ? `<span class="hint">${esc(s.projectTitle)}</span>` : ''
          }));

          const sections = [
            { key: 'publications',    label: 'Publications',     items: pubItems,     showCitations: true },
            { key: 'patents',         label: 'Patents',          items: patentItems,  showCitations: false },
            { key: 'presentations',   label: 'Presentations',    items: presItems,    showCitations: false },
            { key: 'posters',         label: 'Posters',          items: posterItems,  showCitations: false },
            { key: 'protocols',       label: 'Protocols',        items: protoItems,   showCitations: false },
            { key: 'stories',         label: 'Research Stories', items: storyItems,   showCitations: false },
          ];

          const nonEmpty = sections.filter(s => s.items.length > 0);
          if (!nonEmpty.length && !user.cv && !user.github) return '';

          let html = '';

          // Filter bar — only if 2+ sections
          if (nonEmpty.length >= 2) {
            html += `<div class="pi-cv-filter" role="tablist">`;
            html += `<button class="pi-cv-chip is-active" data-filter="all">All</button>`;
            nonEmpty.forEach(s => {
              html += `<button class="pi-cv-chip" data-filter="${s.key}">${s.label} (${s.items.length})</button>`;
            });
            html += `</div>`;
          }

          // Render each section as collapsible <details>
          nonEmpty.forEach((s, i) => {
            const renderItem = (item) => {
              const link = item.href
                ? `<a href="${esc(item.href)}" ${item.href.startsWith('#') ? '' : 'target="_blank"'}>${esc(item.title)}</a>`
                : esc(item.title);
              const yearTag = item.year ? `<span class="pi-cv-year">(${esc(String(item.year))})</span>` : '';
              const citTag = s.showCitations && item.citations > 0
                ? `<span class="pi-cv-citation" title="Citations">${item.citations} cited</span>` : '';
              const metaTag = item.meta ? `<span class="pi-cv-meta">${esc(item.meta)}</span>` : '';
              return `<li>${link} ${yearTag}${citTag}${item.extra || ''}${metaTag}</li>`;
            };

            html += `<details class="team-expanded-section pi-cv-detail-section" data-section="${s.key}">
              <summary><h4>${s.label} (${s.items.length})</h4></summary>
              <ul class="team-stories-list">${s.items.map(renderItem).join('')}</ul>
            </details>`;
          });

          // Links row
          const links = [];
          if (user.cv) links.push(`<a href="${esc(user.cv)}" target="_blank" class="btn btn-secondary btn-small">Download CV</a>`);
          if (user.github) links.push(`<a href="${esc(user.github)}" target="_blank" class="btn btn-secondary btn-small">GitHub</a>`);
          if (links.length) html += `<div class="pi-cv-links">${links.join(' ')}</div>`;

          return html;
        }

        // Wire PI CV filter chips (call after inserting PI expanded HTML into DOM)
        function wirePiCvFilter(container) {
          if (!container) return;
          const chips = container.querySelectorAll('.pi-cv-chip');
          const sections = container.querySelectorAll('.pi-cv-detail-section');
          if (!chips.length) return;
          chips.forEach(chip => {
            chip.addEventListener('click', () => {
              const filter = chip.dataset.filter;
              chips.forEach(c => c.classList.remove('is-active'));
              chip.classList.add('is-active');
              sections.forEach(sec => {
                if (filter === 'all') {
                  sec.style.display = '';
                } else {
                  sec.style.display = sec.dataset.section === filter ? '' : 'none';
                  if (sec.dataset.section === filter) sec.open = true;
                }
              });
            });
          });
        }

        // Build expandable details HTML for non-PI team members
        function buildTeamExpandedHTML(user) {
          const uid = user.id || user.uid;
          const stories = uid ? (storiesByAuthor[uid] || []) : [];
          let html = '';
          // Bio is rendered separately by showDetail() — don't duplicate it here

          // Array association types with <details> for click-to-expand
          const sections = [
            { key: 'stories', label: 'Research Stories', items: stories.map(s => ({
              title: s.title || 'Untitled',
              url: null,
              extra: s.projectTitle ? `<span class="hint">${esc(s.projectTitle)}</span>` : '',
              href: '#/research'
            })) },
            { key: 'papers',        label: 'Papers',        items: (user.papers || []).map(p => ({ title: p.title, href: p.url })) },
            { key: 'posters',       label: 'Posters',       items: (user.posters || []).map(p => ({ title: p.title, href: p.url })) },
            { key: 'presentations', label: 'Presentations', items: (user.presentations || []).map(p => ({ title: p.title, href: p.url })) },
            { key: 'patents',       label: 'Patents',       items: (user.patents || []).map(p => ({ title: p.title, href: p.url })) },
            { key: 'protocols',     label: 'Protocols',     items: (user.protocols || []).map(p => ({ title: p.title, href: p.url })) },
          ];

          sections.forEach(({ key, label, items }) => {
            if (!items.length) return;
            const def = badges.find(b => b.key === key);
            const icon = def ? def.svg + ' ' : '';
            html += `<details class="team-expanded-section">
              <summary><h4>${icon}${label} (${items.length})</h4></summary>
              <ul class="team-stories-list">${items.map(item => {
                const link = item.href
                  ? `<a href="${esc(item.href)}" ${item.href.startsWith('#') ? '' : 'target="_blank"'}>${esc(item.title)}</a>`
                  : esc(item.title);
                return `<li>${link}${item.extra || ''}</li>`;
              }).join('')}</ul>
            </details>`;
          });

          // Final work (thesis / final project) — alumni
          if (user.finalWork?.url) {
            const fwDef = badges.find(b => b.key === 'finalWork');
            const fwLabel = user.priorCategory === 'grad' || user.priorCategory === 'postdoc' ? 'Thesis' : 'Final Project';
            html += `<div class="team-expanded-section"><a href="${esc(user.finalWork.url)}" target="_blank" class="btn btn-secondary btn-small">${fwDef ? fwDef.svg + ' ' : ''}${esc(user.finalWork.title || fwLabel)}</a></div>`;
          }
          if (user.cv) {
            const cvDef = badges.find(b => b.key === 'cv');
            html += `<div class="team-expanded-section"><a href="${esc(user.cv)}" target="_blank" class="btn btn-secondary btn-small">${cvDef ? cvDef.svg + ' ' : ''}Download CV</a></div>`;
          }
          if (user.github) {
            const ghDef = badges.find(b => b.key === 'github');
            html += `<div class="team-expanded-section"><a href="${esc(user.github)}" target="_blank" class="btn btn-secondary btn-small">${ghDef ? ghDef.svg + ' ' : ''}GitHub Profile</a></div>`;
          }

          return html;
        }

        // Helper: get story count for a user
        function getStoryCount(user) {
          const uid = user.id || user.uid;
          return uid ? (storiesByAuthor[uid] || []).length : 0;
        }

        // Helper: update a DOM card with Firestore user data
        function updateCard(card, user) {
          const photoSrc = user.photo?.medium || user.photo?.full || '';
          const badgesHtml = buildBadgesHTML(user, getStoryCount(user));

          if (card.classList.contains('pi-card')) {
            // PI card: CV-style expanded content, bio visible on card
            const piExpanded = buildPiExpandedHTML(user);
            const photoEl = card.querySelector('.pi-photo');
            const infoEl = card.querySelector('.pi-info');
            if (photoEl) {
              photoEl.innerHTML = photoSrc
                ? `<img src="${esc(photoSrc)}" alt="Photo of ${esc(user.name)}" loading="lazy" />`
                : '';
            }
            if (infoEl) {
              infoEl.innerHTML = `
                <div><strong>${esc(user.name)}</strong></div>
                <div class="role">PI</div>
                ${user.bio ? `<div class="pi-bio"><p>${esc(user.bio)}</p></div>` : ''}
                <div class="pi-footer">
                  <button type="button" class="expand-toggle team-expand" aria-expanded="false">Learn More</button>
                  ${badgesHtml}
                </div>
              `;
            }
            const detailContent = card.querySelector('.team-detail-content');
            if (detailContent) {
              detailContent.innerHTML = piExpanded;
              wirePiCvFilter(detailContent);
            }
            const btn = card.querySelector('.expand-toggle');
            if (btn) wireExpandable(btn, card.querySelector('.expandable-details'));
          } else {
            // Regular card: horizontal layout — photo left, info right
            const expanded = buildTeamExpandedHTML(user);
            card.innerHTML = `
              <div class="person-layout">
                <div class="person-photo">
                  ${photoSrc ? `<img src="${esc(photoSrc)}" alt="Photo of ${esc(user.name)}" loading="lazy" />` : '<div></div>'}
                </div>
                <div class="person-info">
                  <div><strong>${esc(user.name)}</strong></div>
                  ${user.category ? `<div class="role">${esc(user.category)}</div>` : ''}
                  ${badgesHtml}
                  <button type="button" class="team-expand team-detail-btn">Learn More</button>
                </div>
              </div>
            `;
            card.dataset.personName = user.name || '';
            // Store expanded HTML for the detail panel to use
            card.dataset.detailHtml = expanded || '';
            card.dataset.detailBio = user.bio || '';
            card.dataset.detailRole = user.category || '';
          }
          matchedCards.add(card);
        }

        // Helper: find a DOM card by name (case-insensitive, trimmed)
        function findCardByName(name) {
          if (!name) return null;
          const target = name.trim().toLowerCase();
          const cards = appEl.querySelectorAll('.card.person');
          for (const card of cards) {
            if (matchedCards.has(card)) continue;
            const nameEl = card.querySelector('strong');
            if (!nameEl) continue;
            if (nameEl.textContent.trim().toLowerCase() === target) return card;
          }
          return null;
        }

        // Pass 1: Match users via claimedProfileId → teamProfile → DOM card
        const claimMap = {};
        teamUsers.forEach(u => { if (u.claimedProfileId) claimMap[u.claimedProfileId] = u; });

        claimed.forEach(profile => {
          const user = claimMap[profile.id];
          if (!user) return;
          const card = findCardByName(profile.name);
          if (card) {
            updateCard(card, user);
            matchedUids.add(user.id);
          }
        });

        // Pass 2: Match remaining users by name (for users without claimedProfileId)
        teamUsers.forEach(user => {
          if (matchedUids.has(user.id)) return;
          const card = findCardByName(user.name);
          if (card) {
            updateCard(card, user);
            matchedUids.add(user.id);
          }
        });

        // Re-wire detail panels after overlay updates
        appEl.querySelectorAll('.team-grid').forEach(g => {
          if (g._rewireDetailPanel) g._rewireDetailPanel();
        });

        // Pass 3: Add Firestore-only users (no content.json match) to their category sections
        const unmatched = teamUsers.filter(u => !matchedUids.has(u.id) && u.name && u.category);
        if (!unmatched.length) { enableReveal(); enableLazyImages(); return; }

        const catLabels = {
          pi: 'Principal Investigator', postdoc: 'Postdoctoral', grad: 'Graduate',
          undergrad: 'Undergraduate', highschool: 'High School', alumni: 'Alumni'
        };
        const catOrder = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni'];

        const byCat = {};
        unmatched.forEach(u => {
          const cat = u.category || 'undergrad';
          if (!byCat[cat]) byCat[cat] = [];
          byCat[cat].push(u);
        });

        catOrder.forEach(cat => {
          const catUsers = byCat[cat];
          if (!catUsers) return;

          let grid = null;
          const sections = appEl.querySelectorAll('.section');
          sections.forEach(sec => {
            const h2 = sec.querySelector('h2');
            if (h2 && h2.textContent.trim() === catLabels[cat]) {
              grid = sec.querySelector('.grid');
            }
          });

          // PI category gets its own structure (no grid, no detail panel)
          if (cat === 'pi') {
            let piSection = null;
            appEl.querySelectorAll('.section').forEach(sec => {
              const h2 = sec.querySelector('h2');
              if (h2 && h2.textContent.trim() === catLabels.pi) piSection = sec;
            });
            if (!piSection) {
              piSection = div('section reveal');
              piSection.innerHTML = `<div class="max-w"><h2>${esc(catLabels.pi)}</h2></div>`;
              const allSections = appEl.querySelectorAll('.section');
              const first = allSections[0];
              if (first) first.parentNode.insertBefore(piSection, first);
              else (allSections.length ? allSections[0].parentNode : appEl).appendChild(piSection);
            }
            let piWrap = piSection.querySelector('.pi-wrap');
            if (!piWrap) {
              piWrap = div('max-w pi-wrap');
              piSection.appendChild(piWrap);
            }
            catUsers.forEach(u => {
              const card = div('card person pi-card');
              const photoSrc = u.photo?.medium || u.photo?.full || '';
              const piExpanded = buildPiExpandedHTML(u);
              const badgesHtml = buildBadgesHTML(u, getStoryCount(u));
              card.innerHTML = `
                <div class="pi-layout">
                  <div class="pi-photo">
                    ${photoSrc ? `<img src="${esc(photoSrc)}" alt="Photo of ${esc(u.name)}" loading="lazy" />` : ''}
                  </div>
                  <div class="pi-info">
                    <div><strong>${esc(u.name)}</strong></div>
                    <div class="role">PI</div>
                    ${u.bio ? `<div class="pi-bio"><p>${esc(u.bio)}</p></div>` : ''}
                    <div class="pi-footer">
                      <button type="button" class="expand-toggle team-expand" aria-expanded="false">Learn More</button>
                      ${badgesHtml}
                    </div>
                  </div>
                </div>
                <div class="expandable-details pi-details" hidden>
                  <div class="team-detail-content">${piExpanded}</div>
                </div>
              `;
              const btn = card.querySelector('.expand-toggle');
              if (btn) wireExpandable(btn, card.querySelector('.expandable-details'));
              wirePiCvFilter(card.querySelector('.team-detail-content'));
              piWrap.appendChild(card);
            });
            return; // skip normal grid flow for PI
          }

          if (!grid) {
            const section = div('section reveal');
            section.innerHTML = `<div class="max-w"><h2>${esc(catLabels[cat])}</h2></div>`;
            grid = div('max-w grid grid-fit-250 team-grid');

            // Create detail panel inside the new grid
            const dp = document.createElement('div');
            dp.className = 'team-detail-panel';
            dp.hidden = true;
            dp.innerHTML = `
              <div class="team-detail-arrow"></div>
              <div class="team-detail-card card">
                <button type="button" class="team-detail-close" aria-label="Close">&times;</button>
                <div class="team-detail-content"></div>
              </div>
            `;
            grid.appendChild(dp);
            section.appendChild(grid);

            const allSections = appEl.querySelectorAll('.section');
            let insertBefore = null;
            const catIdx = catOrder.indexOf(cat);
            allSections.forEach(sec => {
              const h2 = sec.querySelector('h2');
              if (!h2) return;
              const secCatIdx = catOrder.findIndex(c => catLabels[c] === h2.textContent.trim());
              if (secCatIdx > catIdx && !insertBefore) insertBefore = sec;
            });

            if (insertBefore) {
              insertBefore.parentNode.insertBefore(section, insertBefore);
            } else {
              const container = allSections.length ? allSections[0].parentNode : appEl;
              container.appendChild(section);
            }

            // Wire the new grid's detail panel
            wireTeamDetailPanel(grid, dp);
          }

          catUsers.forEach(u => {
            const card = div('card person');
            updateCard(card, u);
            // Insert before the detail panel (which is last child of grid)
            const panelEl = grid.querySelector('.team-detail-panel');
            if (panelEl) grid.insertBefore(card, panelEl);
            else grid.appendChild(card);
          });
        });

        // Re-wire after adding new cards
        appEl.querySelectorAll('.team-grid').forEach(g => {
          if (g._rewireDetailPanel) g._rewireDetailPanel();
        });

        enableReveal();
        enableLazyImages();
      }).catch(e => console.warn('Firestore team overlay unavailable:', e));
    }
  }

  /* ===========================
     VIEWS
     =========================== */
  function renderMission(){
    const wrap = sectionEl();
    const sections = state.data.mission;

    // Subnav from mission sections
    const links = sections.map(s => ({ id: uniqueId(slugify(s.slug || s.title || 'section')), label: s.title || 'Section' }));
    wrap.appendChild(buildSubnav(links));

    // Render cards
    sections.forEach((sec, i) => {
      const id = links[i].id;
      const card = div('section card reveal'); card.id = id;

      card.innerHTML = `
        <div class="max-w">
          <h2>${esc(sec.title || 'Untitled')}</h2>
          <div class="media">
            <div>
              ${sec.body ? `<p>${esc(sec.body)}</p>` : ''}
              ${isNonEmptyArray(sec.points) ? `<ul>${sec.points.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>` : ''}
            </div>
            ${imageHTML(sec.image, sec.imageAlt || sec.title || 'image')}
          </div>
        </div>
      `;
      wrap.appendChild(card);
    });

    if (!sections.length){
      wrap.appendChild(infoBox('Add mission sections in content.json → "mission": [ ... ]'));
    }

    return wrap;
  }

  function renderResearch(){
    const wrap = sectionEl();
    wrap.innerHTML = `
      <div class="max-w">
        <h2>Research Stories</h2>
        <p class="page-subtitle">The latest research from our lab members.</p>
      </div>
      <div class="max-w" id="stories-feed">
        <p class="loading-text">Loading stories\u2026</p>
      </div>
    `;
    return wrap;
  }

  function renderProjects(){
    const wrap = sectionEl();
    wrap.innerHTML = `
      <div class="max-w">
        <h2>Projects</h2>
        <p class="page-subtitle">Active research projects in the McGhee Lab.</p>
      </div>
      <div class="max-w" id="projects-stack">
        <p class="loading-text">Loading projects\u2026</p>
      </div>
    `;
    return wrap;
  }

  /* ── Project stack card (Firestore-driven) ── */
  async function buildProjectStackCard(p) {
    const card = div('card project-stack-card reveal');
    const coverSrc = p.coverImage?.medium || p.coverImage?.full || '';
    const memberCount = (p.team?.contributors?.length || 0) + (p.team?.mentor ? 1 : 0) + 1;

    let relatedStories = [];
    try {
      relatedStories = await McgheeLab.DB.getStoriesByProject(p.id);
    } catch (e) { console.warn('Stories for project ' + p.id + ':', e); }

    const expandedContent = buildProjectExpandedHTML(p, relatedStories);

    card.innerHTML = `
      <div class="project-stack-layout">
        ${coverSrc
          ? `<div class="project-stack-image"><img data-src="${esc(coverSrc)}" alt="${esc(p.title || '')}" loading="lazy"></div>`
          : ''}
        <div class="project-stack-body">
          <h3>${esc(p.title || 'Untitled')}</h3>
          ${p.description ? `<p>${esc(p.description)}</p>` : ''}
          <div class="project-stack-metrics">
            <span class="badge">${memberCount} team member${memberCount !== 1 ? 's' : ''}</span>
            <span class="badge">${relatedStories.length} stor${relatedStories.length !== 1 ? 'ies' : 'y'}</span>
          </div>
          ${expandedContent ? expandableHTML() : ''}
        </div>
      </div>
      ${expandedContent ? `<div class="expandable-details" hidden>${expandedContent}</div>` : ''}
    `;

    const btn = card.querySelector('.expand-toggle');
    if (btn) wireExpandable(btn, card.querySelector('.expandable-details'));
    return card;
  }

  function buildProjectExpandedHTML(p, stories) {
    let html = '';
    if (p.outcomes) {
      html += `<div class="project-expanded-section"><h4>Goals &amp; Outcomes</h4><p>${esc(p.outcomes)}</p></div>`;
    }
    html += buildStoryTeamHTML(p.team);
    html += buildStoryRefsHTML(p.references);
    if (p.link) {
      html += `<p style="padding:.5rem 0"><a class="btn" href="${esc(p.link)}" target="_blank" rel="noopener">View Project Site</a></p>`;
    }
    if (stories.length) {
      html += `<div class="project-stories-section"><h4>Research Stories</h4><div class="project-stories-grid">`;
      stories.forEach(s => {
        html += `<div class="project-story-mini-card">
          <strong>${esc(s.title || 'Untitled')}</strong>
          <span class="hint">by ${esc(s.authorName || '')}</span>
          ${s.description ? `<p>${esc(s.description)}</p>` : ''}
        </div>`;
      });
      html += `</div></div>`;
    }
    return html;
  }

  /* ── Story feed card (Firestore-driven) ── */
  function buildStoryFeedCard(s) {
    const card = div('card story-feed-card reveal');
    card.dataset.storyId = s.id;

    const dateStr = s.publishedAt?.toDate?.()
      ? s.publishedAt.toDate().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

    const authorPhoto = s.team?.author?.photo?.thumb || s.team?.author?.photo || '';
    const storyBlocks = (s.sections || []).map(sec => ({
      text: sec.text || '',
      image: sec.image?.medium || sec.image?.full || '',
      video: sec.video || '',
      imageAlt: sec.imageAlt || ''
    }));
    const expandedContent = buildExpandedHTML(storyBlocks, s);

    card.innerHTML = `
      <div class="story-feed-header">
        ${authorPhoto
          ? `<img src="${esc(authorPhoto)}" alt="" class="story-feed-avatar">`
          : `<div class="story-feed-avatar story-feed-avatar-placeholder">${esc((s.authorName || '?')[0])}</div>`}
        <div class="story-feed-meta">
          <span class="story-feed-author">${esc(s.authorName || 'Unknown')}</span>
          <span class="story-feed-date">${esc(dateStr)}</span>
          ${s.projectTitle ? `<span class="badge story-feed-project">${esc(s.projectTitle)}</span>` : ''}
        </div>
      </div>
      <h3 class="story-feed-title">${esc(s.title || 'Untitled')}</h3>
      ${s.description ? `<p class="story-feed-desc">${esc(s.description)}</p>` : ''}
      ${expandedContent ? `${expandableHTML()}<div class="expandable-details" hidden>${expandedContent}</div>` : ''}
      <div class="story-feed-actions">
        <div class="reaction-bar" data-story-id="${esc(s.id)}"></div>
        <button type="button" class="comment-toggle" data-story-id="${esc(s.id)}" title="Comments">
          <span class="comment-icon">\uD83D\uDCAC</span>
          <span class="comment-count" data-comment-count="${esc(s.id)}">0</span>
        </button>
      </div>
      <div class="comments-section" data-comments-for="${esc(s.id)}" hidden></div>
    `;

    const btn = card.querySelector('.expand-toggle');
    if (btn) wireExpandable(btn, card.querySelector('.expandable-details'));
    return card;
  }

  /* ── Wire reactions + comments on story feed ── */
  function wireStoryFeedInteractions(feedEl) {
    // Load reactions for each story
    feedEl.querySelectorAll('.reaction-bar').forEach(bar => {
      const storyId = bar.dataset.storyId;
      if (window.McgheeLab?.loadReactions) McgheeLab.loadReactions(storyId, bar);
    });

    // Load comment counts
    feedEl.querySelectorAll('.comment-toggle').forEach(btn => {
      const storyId = btn.dataset.storyId;
      const countEl = feedEl.querySelector(`[data-comment-count="${storyId}"]`);
      if (window.McgheeLab?.DB) {
        McgheeLab.DB.getCommentsByStory(storyId).then(comments => {
          if (countEl) countEl.textContent = comments.length || '0';
        }).catch(() => {});
      }

      btn.addEventListener('click', () => {
        const section = feedEl.querySelector(`[data-comments-for="${storyId}"]`);
        if (!section) return;
        const wasHidden = section.hidden;
        section.hidden = !wasHidden;
        if (wasHidden && window.McgheeLab?.loadComments) {
          McgheeLab.loadComments(storyId, section);
        }
      });
    });
  }

  /* ── News page ── */
  function renderNews(){
    const wrap = sectionEl();
    wrap.innerHTML = `
      <div class="max-w">
        <h2>News</h2>
        <p class="page-subtitle">Updates, events, and highlights from the McGhee Lab.</p>
      </div>
      <div class="max-w" id="news-feed">
        <p class="loading-text">Loading news\u2026</p>
      </div>
    `;
    return wrap;
  }

  function buildNewsFeedCard(p) {
    const card = div('card story-feed-card news-feed-card reveal');
    card.dataset.newsId = p.id;

    const dateStr = p.publishedAt?.toDate?.()
      ? p.publishedAt.toDate().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';

    const authorPhoto = p.authorPhoto?.thumb || p.authorPhoto?.medium || '';
    const catLabel = (window.McgheeLab?.NEWS_CATEGORIES || []).find(c => c.value === p.category)?.label || p.category || '';
    const coverSrc = p.coverImage?.medium || p.coverImage?.full || '';

    const newsBlocks = (p.sections || []).map(sec => ({
      text: sec.text || '',
      image: sec.image?.medium || sec.image?.full || '',
      video: sec.video || '',
      imageAlt: sec.imageAlt || ''
    }));
    const expandedContent = buildStoryHTML(newsBlocks);

    const textContent = `
      <div class="story-feed-header">
        ${authorPhoto
          ? `<img src="${esc(authorPhoto)}" alt="" class="story-feed-avatar">`
          : `<div class="story-feed-avatar story-feed-avatar-placeholder">${esc((p.authorName || '?')[0])}</div>`}
        <div class="story-feed-meta">
          <span class="story-feed-author">${esc(p.authorName || 'Unknown')}</span>
          <span class="story-feed-date">${esc(dateStr)}</span>
          ${catLabel ? `<span class="badge news-cat-badge">${esc(catLabel)}</span>` : ''}
        </div>
      </div>
      <h3 class="story-feed-title">${esc(p.title || 'Untitled')}</h3>
      ${p.description ? `<p class="story-feed-desc">${esc(p.description)}</p>` : ''}
      ${expandedContent ? expandableHTML() : ''}`;

    if (coverSrc) {
      card.classList.add('news-has-cover');
      card.innerHTML = `
        <div class="news-cover-layout">
          <div class="news-cover-image">
            <img src="${esc(coverSrc)}" alt="${esc(p.title || '')}" loading="lazy">
          </div>
          <div class="news-cover-body">${textContent}</div>
        </div>
        ${expandedContent ? `<div class="expandable-details" hidden>${expandedContent}</div>` : ''}
        <div class="story-feed-actions">
          <div class="reaction-bar" data-story-id="${esc(p.id)}"></div>
          <button type="button" class="comment-toggle" data-story-id="${esc(p.id)}" title="Comments">
            <span class="comment-icon">\uD83D\uDCAC</span>
            <span class="comment-count" data-comment-count="${esc(p.id)}">0</span>
          </button>
        </div>
        <div class="comments-section" data-comments-for="${esc(p.id)}" hidden></div>`;
    } else {
      card.innerHTML = `
        ${textContent}
        ${expandedContent ? `<div class="expandable-details" hidden>${expandedContent}</div>` : ''}
        <div class="story-feed-actions">
          <div class="reaction-bar" data-story-id="${esc(p.id)}"></div>
          <button type="button" class="comment-toggle" data-story-id="${esc(p.id)}" title="Comments">
            <span class="comment-icon">\uD83D\uDCAC</span>
            <span class="comment-count" data-comment-count="${esc(p.id)}">0</span>
          </button>
        </div>
        <div class="comments-section" data-comments-for="${esc(p.id)}" hidden></div>`;
    }

    const btn = card.querySelector('.expand-toggle');
    if (btn) wireExpandable(btn, card.querySelector('.expandable-details'));
    return card;
  }

  function wireNewsFeedInteractions(feedEl) {
    feedEl.querySelectorAll('.reaction-bar').forEach(bar => {
      const storyId = bar.dataset.storyId;
      if (window.McgheeLab?.loadReactions) McgheeLab.loadReactions(storyId, bar);
    });

    feedEl.querySelectorAll('.comment-toggle').forEach(btn => {
      const storyId = btn.dataset.storyId;
      const countEl = feedEl.querySelector(`[data-comment-count="${storyId}"]`);
      if (window.McgheeLab?.DB) {
        McgheeLab.DB.getCommentsByStory(storyId).then(comments => {
          if (countEl) countEl.textContent = comments.length || '0';
        }).catch(() => {});
      }

      btn.addEventListener('click', () => {
        const section = feedEl.querySelector(`[data-comments-for="${storyId}"]`);
        if (!section) return;
        const wasHidden = section.hidden;
        section.hidden = !wasHidden;
        if (wasHidden && window.McgheeLab?.loadComments) {
          McgheeLab.loadComments(storyId, section);
        }
      });
    });
  }

  function renderTeam(){
    const team = state.data.team || {};
    const wrap = sectionEl();

    const categories = [
      ['pi',         'Principal Investigator'],
      ['postdoc',    'Postdoctoral'],
      ['grad',       'Graduate'],
      ['undergrad',  'Undergraduate'],
      ['highschool', 'High School'],
      ['alumni',     'Alumni']
    ];

    const existing = categories.filter(([k]) => isNonEmptyArray(team[k]));
    const links = existing.map(([k, label]) => ({ id: uniqueId('team-' + k), label }));
    if (links.length) wrap.appendChild(buildSubnav(links));

    existing.forEach(([k, label], i)=>{
      const id = links[i].id;
      const people = toArray(team[k]);
      const section = div('section reveal'); section.id = id;
      section.innerHTML = `<div class="max-w"><h2>${esc(label)}</h2></div>`;

      if (k === 'pi') {
        // PI: horizontal card with bio visible beside photo
        const piWrap = div('max-w');
        people.forEach(person => {
          const card = div('card person pi-card');
          card.innerHTML = `
            <div class="pi-layout">
              <div class="pi-photo">
                ${imageHTML(person.photo, `Photo of ${esc(person.name)}`)}
              </div>
              <div class="pi-info">
                <div><strong>${esc(person.name || 'Name')}</strong></div>
                ${person.role ? `<div class="role">${esc(person.role)}</div>` : ''}
                ${person.bio ? `<div class="pi-bio"><p>${esc(person.bio)}</p></div>` : ''}
                <div class="pi-footer">
                  <button type="button" class="expand-toggle team-expand" aria-expanded="false">Learn More</button>
                </div>
              </div>
            </div>
            <div class="expandable-details pi-details" hidden>
              <div class="team-detail-content" data-person-name="${esc(person.name || '')}"></div>
            </div>
          `;
          const btn = card.querySelector('.expand-toggle');
          if (btn) wireExpandable(btn, card.querySelector('.expandable-details'));
          piWrap.appendChild(card);
        });
        section.appendChild(piWrap);
      } else {
        // Other categories: compact cards with shared detail panel inside the grid
        const grid = div('max-w grid grid-fit-250 team-grid');
        const detailPanel = document.createElement('div');
        detailPanel.className = 'team-detail-panel';
        detailPanel.hidden = true;
        detailPanel.innerHTML = `
          <div class="team-detail-arrow"></div>
          <div class="team-detail-card card">
            <button type="button" class="team-detail-close" aria-label="Close">&times;</button>
            <div class="team-detail-content"></div>
          </div>
        `;

        people.forEach(person => {
          const card = div('card person');
          card.dataset.personName = person.name || '';
          card.dataset.detailBio = person.bio || '';
          card.dataset.detailRole = person.role || '';
          card.innerHTML = `
            <div class="person-layout">
              <div class="person-photo">
                ${imageHTML(person.photo, `Photo of ${esc(person.name)}`)}
              </div>
              <div class="person-info">
                <div><strong>${esc(person.name || 'Name')}</strong></div>
                ${person.role ? `<div class="role">${esc(person.role)}</div>` : ''}
                <button type="button" class="team-expand team-detail-btn">Learn More</button>
              </div>
            </div>
          `;
          grid.appendChild(card);
        });

        // Panel lives inside the grid so it can be repositioned per row
        grid.appendChild(detailPanel);
        wireTeamDetailPanel(grid, detailPanel);

        section.appendChild(grid);
      }

      wrap.appendChild(section);
    });

    if (!existing.length){
      // Show loading state — Firestore overlay will populate team members
      const loading = div('max-w');
      loading.id = 'team-loading';
      loading.innerHTML = '<p class="hint" style="text-align:center;padding:2rem;">Loading team…</p>';
      wrap.appendChild(loading);
    }

    return wrap;
  }

  function wireTeamDetailPanel(grid, panel) {
    const contentEl = panel.querySelector('.team-detail-content');
    const arrow = panel.querySelector('.team-detail-arrow');
    const closeBtn = panel.querySelector('.team-detail-close');
    let activeCard = null;

    // Find the last card in the same visual row as the target card
    function getLastCardInRow(card) {
      const cards = [...grid.querySelectorAll('.card.person')];
      const top = card.offsetTop;
      const rowCards = cards.filter(c => Math.abs(c.offsetTop - top) < 10);
      return rowCards[rowCards.length - 1];
    }

    function showDetail(card) {
      if (activeCard === card) { closeDetail(); return; }

      if (activeCard) activeCard.classList.remove('team-card-active');
      activeCard = card;
      card.classList.add('team-card-active');

      const name = card.dataset.personName || card.querySelector('strong')?.textContent || '';
      const role = card.dataset.detailRole || card.querySelector('.role')?.textContent || '';
      const firestoreHtml = card.dataset.detailHtml || '';
      const bio = card.dataset.detailBio || '';

      contentEl.innerHTML = `
        <h3>${esc(name)}</h3>
        ${role ? `<div class="role">${esc(role)}</div>` : ''}
        ${bio ? `<div class="team-bio"><p>${esc(bio)}</p></div>` : ''}
        ${firestoreHtml}
        ${!bio && !firestoreHtml ? '<p class="hint">No bio available yet.</p>' : ''}
      `;

      // Move panel right after the last card in this row
      const lastInRow = getLastCardInRow(card);
      lastInRow.after(panel);

      positionArrow(card);
      panel.hidden = false;
      setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    }

    function closeDetail() {
      if (activeCard) activeCard.classList.remove('team-card-active');
      activeCard = null;
      panel.hidden = true;
    }

    function positionArrow(card) {
      const gridRect = grid.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const cardCenter = cardRect.left + cardRect.width / 2 - gridRect.left;
      arrow.style.left = cardCenter + 'px';
    }

    function wireButtons() {
      grid.querySelectorAll('.team-detail-btn').forEach(btn => {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', () => {
          showDetail(btn.closest('.card.person'));
        });
      });
    }
    wireButtons();

    // Expose rewire for Firestore overlay to call after updating cards
    grid._rewireDetailPanel = wireButtons;

    if (closeBtn) closeBtn.addEventListener('click', closeDetail);
    window.addEventListener('resize', () => {
      if (activeCard && !panel.hidden) positionArrow(activeCard);
    });
  }

  function renderClasses(){
    const c = state.data.classes || {};
    const wrap = sectionEl();

    if (c.intro){
      const intro = div('section card reveal');
      intro.innerHTML = `<div class="max-w"><h2>Classes</h2><p>${esc(c.intro)}</p></div>`;
      wrap.appendChild(intro);
    }

    const grid = div('max-w grid grid-fit-250');
    grid.id = 'classes-grid';
    grid.innerHTML = '<p class="hint" style="text-align:center;padding:2rem;">Loading classes\u2026</p>';
    wrap.appendChild(grid);
    return wrap;
  }

  // Contact page removed — replaced by #/opportunities (rendered by user-system.js)

  function renderNotFound(){
    const wrap = sectionEl();
    wrap.appendChild(infoBox('Page not found.'));
    return wrap;
  }

  /* ===========================
     SUBNAV (Quick Links)
     =========================== */
  function buildSubnav(items){
    const subnav = document.createElement('nav');
    subnav.className = 'subnav reveal';
    subnav.setAttribute('aria-label', 'Quick links');

    const container = document.createElement('div');
    container.className = 'max-w';

    const ul = document.createElement('ul');
    ul.className = 'track';
    ul.innerHTML = items.map(i => `<li><a href="#" data-scroll="${esc(i.id)}">${esc(i.label)}</a></li>`).join('');

    container.appendChild(ul);
    subnav.appendChild(container);
    return subnav;
  }

  function wireUpSubnav(root){
    const subnav = root.querySelector('.subnav');
    if(!subnav) return;

    const track = subnav.querySelector('.track');

    // Touch/Pen-only drag so desktop mouse clicks always work
    if (track) enableDragScrollForTouchOnly(track);

    // Delegated click (desktop + mobile taps)
    subnav.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-scroll]');
      if (!a) return;
      e.preventDefault();
      activateChip(subnav, track, a);
    });

    // Keyboard activation
    subnav.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const a = e.target.closest('a[data-scroll]');
      if (!a) return;
      e.preventDefault();
      activateChip(subnav, track, a);
    });

    // Scrollspy
    const ids = Array.from(subnav.querySelectorAll('a[data-scroll]')).map(a=>a.getAttribute('data-scroll'));
    initScrollSpy(ids, subnav);
  }

  function activateChip(subnav, track, anchor){
    const id = anchor.getAttribute('data-scroll');

    // Visual state
    subnav.querySelectorAll('a[data-scroll]').forEach(x=>{
      const on = x === anchor;
      x.classList.toggle('is-active', on);
      x.setAttribute('aria-current', on ? 'true' : 'false');
    });

    scrollToSectionCentered(id, subnav);
    centerActiveChip(track, anchor);
  }

  /* ===========================
     STORIES (expand/collapse)
     =========================== */
  function buildStoryHTML(story){
  if (!isNonEmptyArray(story)) return '';

  return story.map(block => {
    const hasImg   = !!(block.image && String(block.image).trim());
    const hasVideo = !!(block.video && String(block.video).trim());
    const hasText  = !!(block.text && String(block.text).trim());
    const textHTML = hasText ? `<p>${esc(block.text)}</p>` : '';

    // With video: two-column layout with video element
    if (hasVideo) {
      return `
        <div class="section" style="margin-top:8px">
          <div class="media">
            <div>${textHTML}</div>
            <video src="${esc(block.video)}" controls playsinline preload="metadata"
              class="story-video" aria-label="${esc(block.imageAlt || 'video')}"></video>
          </div>
        </div>
      `;
    }

    // With image: keep the standard two-column ".media" layout
    if (hasImg) {
      return `
        <div class="section" style="margin-top:8px">
          <div class="media">
            <div>${textHTML}</div>
            ${imageHTML(block.image, block.imageAlt || 'image')}
          </div>
        </div>
      `;
    }

    // No media: make the text span the FULL width of the media grid
    return `
      <div class="section" style="margin-top:8px">
        <div class="media">
          <div style="grid-column: 1 / -1">${textHTML}</div>
        </div>
      </div>
    `;
  }).join('');
}

  /* ===========================
     STORY TEAM & REFERENCES
     =========================== */

  /** Render team members grid (author, contributors, mentor) */
  function buildStoryTeamHTML(team) {
    if (!team) return '';
    const members = [];

    if (team.author) {
      members.push({ ...team.author, teamRole: 'PI' });
    }
    if (isNonEmptyArray(team.contributors)) {
      team.contributors.forEach(c => members.push({ ...c, teamRole: 'Contributor' }));
    }
    if (team.mentor) {
      members.push({ ...team.mentor, teamRole: 'Project Lead' });
    }
    if (!members.length) return '';

    return `
      <div class="story-team">
        <h4 class="story-team-heading">Team</h4>
        <div class="story-team-grid">
          ${members.map(m => {
            const rawPhoto = m.photo;
            let photoSrc = '';
            if (typeof rawPhoto === 'object' && rawPhoto) {
              photoSrc = rawPhoto.thumb || rawPhoto.medium || rawPhoto.full || '';
            } else if (typeof rawPhoto === 'string' && rawPhoto && !rawPhoto.includes('[object')) {
              photoSrc = rawPhoto;
            }
            return `
            <div class="story-team-member">
              ${photoSrc
                ? `<img src="${esc(photoSrc)}" alt="${esc(m.name || '')}" class="story-team-photo" loading="lazy">`
                : `<div class="story-team-photo story-team-photo-placeholder">${esc((m.name || '?')[0])}</div>`}
              <div class="story-team-info">
                <span class="story-team-name">${esc(m.name || 'Unknown')}</span>
                <span class="story-team-role">${esc(m.teamRole)}</span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  /** Render full references section (patents, publications, presentations, posters) */
  function buildStoryRefsHTML(refs) {
    if (!refs) return '';
    const categories = [
      { key: 'publications',   icon: '📄', label: 'Publications' },
      { key: 'patents',        icon: '⚙',  label: 'Patents' },
      { key: 'presentations',  icon: '🎤', label: 'Presentations' },
      { key: 'posters',        icon: '📋', label: 'Posters' }
    ];
    const sections = categories
      .filter(cat => isNonEmptyArray(refs[cat.key]))
      .map(cat => `
        <div class="story-refs-category">
          <h5>${cat.icon} ${cat.label}</h5>
          <ul>
            ${refs[cat.key].map(r => `
              <li>
                ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a>` : esc(r.title || '')}
                ${r.detail ? `<span class="ref-detail"> — ${esc(r.detail)}</span>` : ''}
              </li>
            `).join('')}
          </ul>
        </div>
      `);
    if (!sections.length) return '';
    return `<div class="story-refs"><h4 class="story-refs-heading">References</h4>${sections.join('')}</div>`;
  }

  /** Render compact ref-badge links for unopened cards */
  function buildRefLinksHTML(refs) {
    if (!refs) return '';
    const badges = [
      { key: 'publications',  label: 'Publications' },
      { key: 'patents',       label: 'Patents' },
      { key: 'presentations', label: 'Presentations' },
      { key: 'posters',       label: 'Posters' }
    ];
    const html = badges
      .filter(b => isNonEmptyArray(refs[b.key]))
      .map(b => {
        const first = refs[b.key][0];
        const url = first?.url || '#';
        return `<a href="${esc(url)}" target="_blank" rel="noopener" class="ref-badge" title="${esc(b.label)}">${esc(b.label)}</a>`;
      })
      .join(' ');
    return html ? `<p class="ref-badges">${html}</p>` : '';
  }

  /** Build complete expandable content: team → story sections → references */
  function buildExpandedHTML(storyBlocks, data) {
    const teamHTML = buildStoryTeamHTML(data?.team);
    const storyHTML = buildStoryHTML(storyBlocks);
    const refsHTML = buildStoryRefsHTML(data?.references);
    const combined = teamHTML + storyHTML + refsHTML;
    return combined || '';
  }

  function expandableHTML(){
    return `
      <p>
        <button type="button" class="expand-toggle" aria-expanded="false" aria-controls="">
          Read more
        </button>
      </p>
    `;
  }

  function wireExpandable(button, detailsEl){
    if (!button || !detailsEl) return;
    const uid = 'details-' + Math.random().toString(36).slice(2);
    detailsEl.id = uid;
    button.setAttribute('aria-controls', uid);

    const setState = (expanded) => {
      button.setAttribute('aria-expanded', String(expanded));
      button.textContent = expanded ? 'Show less' : 'Read more';
      detailsEl.hidden = !expanded;
    };

    button.addEventListener('click', () => {
      const now = button.getAttribute('aria-expanded') === 'true';
      setState(!now);
    });

    // Escape to collapse (optional nicety)
    const onKey = (e) => {
      if (e.key === 'Escape' && button.getAttribute('aria-expanded') === 'true'){
        setState(false);
        button.focus();
      }
    };
    detailsEl.addEventListener('keydown', onKey);
    state.cleanups.push(() => detailsEl.removeEventListener('keydown', onKey));
  }

  /* ===========================
     BEHAVIORS
     =========================== */
  function setupMenu(){
    menuBtn?.addEventListener('click', toggleMenu);
    document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') closeMenu(); });

    navDrawer?.addEventListener('click', (e)=>{
      const t = e.target.closest('a[data-route]');
      if(!t) return;
      closeMenu();
    });
  }
  function toggleMenu(){
    const open = navDrawer.classList.toggle('open');
    navDrawer.setAttribute('aria-hidden', String(!open));
    menuBtn.setAttribute('aria-expanded', String(open));
    if(open) navDrawer.querySelector('a')?.focus();
  }
  function closeMenu(){
    navDrawer.classList.remove('open');
    navDrawer.setAttribute('aria-hidden', 'true');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.focus();
  }

  /* ── Mobile bottom tabs + group sheets ── */
  function setupBottomTabs(){
    // Group tab buttons open their respective sheets
    document.querySelectorAll('#bottom-tabs .tab-group-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleGroupSheet(btn.dataset.group));
    });

    // All group sheets: backdrop + link click dismiss
    document.querySelectorAll('.group-sheet').forEach(sheet => {
      sheet.querySelector('.group-sheet-backdrop')
        ?.addEventListener('click', closeAllSheets);
      sheet.addEventListener('click', (e) => {
        if(e.target.closest('a[data-route]')) closeAllSheets();
      });
    });

    // Escape key closes any open sheet
    document.addEventListener('keydown', (e) => {
      if(e.key === 'Escape') closeAllSheets();
    });
  }

  function toggleGroupSheet(name){
    const sheet = document.getElementById(`group-sheet-${name}`);
    if(!sheet) return;
    const isOpen = sheet.classList.contains('open');
    closeAllSheets();
    if(!isOpen){
      sheet.classList.add('open');
      sheet.setAttribute('aria-hidden', 'false');
      const btn = document.querySelector(`#bottom-tabs .tab-group-btn[data-group="${name}"]`);
      btn?.setAttribute('aria-expanded', 'true');
    }
  }

  function closeAllSheets(){
    document.querySelectorAll('.group-sheet.open').forEach(sheet => {
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('#bottom-tabs [aria-expanded="true"]').forEach(btn => {
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  /* ── Desktop dropdown groups ── */
  const dropdownTimers = new WeakMap();
  const clickLocked = new WeakSet();   // Click-opened = stays open until explicit dismiss

  function setupDesktopDropdowns(){
    const groups = document.querySelectorAll('#desktop-nav .nav-group');
    groups.forEach(group => {
      const btn = group.querySelector('.nav-group-btn');
      if(!btn) return;

      // Click to toggle — locks the dropdown open (hover won't close it)
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = group.classList.contains('open') && clickLocked.has(group);
        closeAllDropdowns();
        if(!isOpen){
          openDropdown(group);
          clickLocked.add(group);
        }
      });

      // Hover: open immediately, close with delay (only if not click-locked)
      group.addEventListener('mouseenter', () => {
        clearTimeout(dropdownTimers.get(group));
        if(!clickLocked.has(group)){
          closeAllDropdowns();
          openDropdown(group);
        }
      });
      group.addEventListener('mouseleave', () => {
        if(clickLocked.has(group)) return;  // Click-opened stays open
        const timer = setTimeout(() => closeDropdown(group), 200);
        dropdownTimers.set(group, timer);
      });

      // Close on link click (navigates away)
      group.querySelectorAll('a[data-route]').forEach(a => {
        a.addEventListener('click', closeAllDropdowns);
      });
    });

    // Close on click outside
    document.addEventListener('click', closeAllDropdowns);
  }

  function openDropdown(group){
    group.classList.add('open');
    group.querySelector('.nav-group-btn')?.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown(group){
    clearTimeout(dropdownTimers.get(group));
    clickLocked.delete(group);
    group.classList.remove('open');
    group.querySelector('.nav-group-btn')?.setAttribute('aria-expanded', 'false');
  }

  function closeAllDropdowns(){
    document.querySelectorAll('#desktop-nav .nav-group').forEach(g => {
      closeDropdown(g);
    });
  }

  function enableReveal(){
    const els = appEl.querySelectorAll('.reveal');
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    els.forEach(el => io.observe(el));
    state.observers.push(io);
  }

  function enableLazyImages(){
    const imgs = appEl.querySelectorAll('img[data-src]');
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          const img = entry.target;
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          io.unobserve(img);
        }
      });
    }, { rootMargin: '100px 0px', threshold: 0.01 });
    imgs.forEach(i => io.observe(i));
    state.observers.push(io);
  }

  // Touch/Pen-only drag for chip row (desktop mouse clicks remain native)
  function enableDragScrollForTouchOnly(el){
    if (!('PointerEvent' in window)) return;

    let isDown = false, startX = 0, startLeft = 0, id = 0, moved = 0;
    const threshold = 6; // px 'tap' tolerance

    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      isDown = true; moved = 0;
      startX = e.clientX; startLeft = el.scrollLeft;
      id = e.pointerId;
      try { el.setPointerCapture(id); } catch {}
    }, { passive: true });

    el.addEventListener('pointermove', e => {
      if(!isDown || e.pointerType === 'mouse') return;
      const dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      el.scrollLeft = startLeft - dx;
    }, { passive: true });

    el.addEventListener('pointerup', e => {
      if(!isDown) return;
      isDown = false;
      try { el.releasePointerCapture(id); } catch {}
      if (moved <= threshold){
        const a = e.target.closest('a[data-scroll]');
        if (a){
          const subnav = el.closest('.subnav');
          activateChip(subnav, el, a);
        }
      }
    }, { passive: true });

    el.addEventListener('pointercancel', () => { isDown = false; }, { passive: true });
    el.addEventListener('pointerleave',  () => { isDown = false; }, { passive: true });
  }

  function headerBottom(){
    const hero = document.querySelector('.hero');
    if (!hero) return 0;
    const rect = hero.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    return scrollTop + rect.top + 1;
  }

  function updateBannerHeight(){
    const b = document.querySelector('.top-banner');
    state.bannerHeight = b ? b.getBoundingClientRect().height : 64;
    document.documentElement.style.setProperty('--banner-height', `${state.bannerHeight}px`);
  }

  function scrollToSectionCentered(id, subnavEl){
    const el = document.getElementById(id);
    if(!el) return;

    const subnavH = subnavEl?.getBoundingClientRect()?.height || document.querySelector('.subnav')?.getBoundingClientRect()?.height || 0;
    const offsetTop    = state.bannerHeight + subnavH + 8;
    const visibleH     = Math.max(0, window.innerHeight - offsetTop);
    const targetCenter = offsetTop + (visibleH / 2);

    const r        = el.getBoundingClientRect();
    const elCenter = r.top + (r.height / 2);
    const y        = Math.max(0, window.pageYOffset + elCenter - targetCenter);

    window.scrollTo({ top: y, behavior: 'smooth' });

    // Post-layout correction (fonts/images can shift sizes)
    setTimeout(() => {
      const r2 = el.getBoundingClientRect();
      const elCenter2 = r2.top + (r2.height / 2);
      const delta = elCenter2 - targetCenter;
      if (Math.abs(delta) > 4) {
        window.scrollTo({ top: Math.max(0, window.pageYOffset + delta), behavior: 'smooth' });
      }
    }, 120);
  }

  function initScrollSpy(ids, subnav){
    const track = subnav.querySelector('.track');

    const setActive = (id) => {
      let activeA = null;
      subnav.querySelectorAll('a[data-scroll]').forEach(a=>{
        const on = a.getAttribute('data-scroll') === id;
        a.classList.toggle('is-active', on);
        a.setAttribute('aria-current', on ? 'true' : 'false');
        if (on) activeA = a;
      });
      if (activeA && track) centerActiveChip(track, activeA);
    };

    let ticking = false;
    const update = () => {
      const subnavH = subnav?.getBoundingClientRect()?.height || 0;
      const offsetTop = state.bannerHeight + subnavH + 8;
      const visibleH  = Math.max(0, window.innerHeight - offsetTop);
      const centerLine = offsetTop + (visibleH / 2);

      let bestId = null, bestDist = Infinity;
      ids.forEach(id=>{
        const el = document.getElementById(id);
        if(!el) return;
        const r = el.getBoundingClientRect();
        const elCenter = r.top + (r.height / 2);
        const dist = Math.abs(elCenter - centerLine);
        if (dist < bestDist){ bestDist = dist; bestId = id; }
      });

      if(bestId) setActive(bestId);
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { update(); ticking = false; });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    setTimeout(update, 0);

    state.cleanups.push(() => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    });
  }

  function centerActiveChip(track, a){
    if (!track || !a) return;
    if (track.scrollWidth <= track.clientWidth) return;
    const targetLeft = a.offsetLeft - (track.clientWidth - a.offsetWidth) / 2;
    const clamped = Math.max(0, Math.min(targetLeft, track.scrollWidth - track.clientWidth));
    const leftVisible  = track.scrollLeft;
    const rightVisible = leftVisible + track.clientWidth;
    const chipLeft  = a.offsetLeft, chipRight = chipLeft + a.offsetWidth;
    const outOfView = chipLeft < leftVisible + 8 || chipRight > rightVisible - 8;
    if (outOfView) track.scrollTo({ left: clamped, behavior: 'smooth' });
  }

  /* ===========================
     HERO MISSION HIGHLIGHT
     =========================== */
  function applyMissionText(text){
    const el = document.getElementById('missionText');
    const msg = (text || 'We build in vitro models to study the mechanisms driving metastasis.').trim();
    // Pink phrase + trailing period
    let html = msg.replace(/in vitro models/i, '<span class="hero-highlight">$&</span>');
    html = html.replace(/\.\s*$/, '<span class="hero-highlight">.</span>');
    if (el) el.innerHTML = html;
  }

  /* ===========================
     HELPERS
     =========================== */
  function sectionEl(){ const el = document.createElement('section'); el.className = 'section'; return el; }
  function div(cls=''){ const d=document.createElement('div'); if(cls) d.className=cls; return d; }
  function esc(str){ return (str ?? '').toString().replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s])); }
  function imageHTML(src, alt){
    const s = str(src);
    if(!s) return '<div></div>';
    return `<img data-src="${esc(s)}" alt="${esc(alt || '')}" loading="lazy" />`;
  }
  function infoBox(msg){ const box = div('card class-item reveal'); box.innerHTML = `<div class="max-w"><p>${esc(msg)}</p></div>`; return box; }
  function slugify(s=''){
    return s.toString().toLowerCase().trim()
      .replace(/[^a-z0-9]+/g,'-')
      .replace(/(^-|-$)/g,'');
  }
  // Ensure IDs are unique within a page (append -2, -3, ... if needed)
  function uniqueId(base){
    const b = base || 'section';
    const count = (state.idCounters[b] = (state.idCounters[b] || 0) + 1);
    return count === 1 ? b : `${b}-${count}`;
  }
  function formatContact(c){
    const lines = [
      c?.address ? esc(c.address) : '',
      c?.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '',
      c?.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''
    ].filter(Boolean).join('<br/>');
    return `<address>${lines}</address>`;
  }
  function debounce(fn, ms=150){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

  /* ===========================
     PWA — Install Prompt, Update Notification, Push Init
     =========================== */

  let deferredInstallPrompt = null;

  function setupPWA() {
    // Detect standalone mode (installed PWA)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone === true;
    document.body.classList.toggle('pwa-standalone', isStandalone);

    // Capture install prompt (Chrome/Edge on Android + desktop)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      showInstallButton();
    });

    // Listen for successful install
    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      hideInstallButton();
      console.log('[PWA] App installed.');
    });

    // Service worker update notification
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (!reg) return;
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });
        });
      });
    }

    // Initialize push notifications
    if (window.McgheePush) {
      McgheePush.init();
      McgheePush.onForegroundMessage((payload) => {
        const data = payload.notification || payload.data || {};
        showPushToast(data.title || 'McGheeLab', data.body || '');
      });
    }

    // Clear app icon badge when user returns to the app
    function clearBadgeOnFocus() {
      if (window.McgheePush?.clearBadge) McgheePush.clearBadge();
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) clearBadgeOnFocus();
    });
    window.addEventListener('focus', clearBadgeOnFocus);
    clearBadgeOnFocus(); // clear on initial load
  }

  /* --- Install button (shown on lab apps hub page) --- */

  function showInstallButton() {
    const existing = document.getElementById('pwa-install-banner');
    if (existing) existing.style.display = '';
  }

  function hideInstallButton() {
    const existing = document.getElementById('pwa-install-banner');
    if (existing) existing.style.display = 'none';
  }

  // Called by the install button's onclick
  window.mcgheeInstallPWA = async function() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (result.outcome === 'accepted') hideInstallButton();
  };

  // Renders the install banner HTML (used in lab apps hub)
  function getInstallBannerHTML() {
    const ua = navigator.userAgent;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone === true;
    if (isStandalone) return '';

    // Device detection
    const isIPhone = /iPhone/.test(ua) && !window.navigator.standalone;
    const isIPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isIOS = isIPhone || isIPad;
    const isAndroid = /Android/.test(ua);
    const isSamsung = /SamsungBrowser/.test(ua);
    const isChrome = /Chrome/.test(ua) && !/Edge|Edg|OPR/.test(ua);
    const isFirefox = /Firefox/.test(ua);
    const isSafariDesktop = /Safari/.test(ua) && /Macintosh/.test(ua) && !/Chrome/.test(ua);

    // Build device-specific instruction text
    let instruction = '';
    let actionBtn = '';
    const shareIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
    const menuIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-1px"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';

    if (isIOS) {
      const browser = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : '';
      if (browser) {
        instruction = `Open in <strong>Safari</strong>, tap ${shareIcon} then <strong>Add to Home Screen</strong>`;
      } else {
        instruction = `Tap ${shareIcon} below, then <strong>Add to Home Screen</strong>`;
      }
    } else if (isAndroid) {
      if (isSamsung) {
        instruction = `Tap ${menuIcon} then <strong>Add page to</strong> &rarr; <strong>Home screen</strong>`;
      } else if (isFirefox) {
        instruction = `Tap ${menuIcon} then <strong>Install</strong>`;
      } else {
        instruction = 'Add to your home screen for quick access';
        actionBtn = `<button class="pwa-install-btn" onclick="mcgheeInstallPWA()">Install</button>`;
      }
    } else if (isSafariDesktop) {
      instruction = 'File &rarr; Add to Dock for quick access';
    } else {
      // Desktop Chrome, Edge, etc.
      instruction = 'Install for quick access from your desktop';
      actionBtn = `<button class="pwa-install-btn" onclick="mcgheeInstallPWA()">Install</button>`;
    }

    // For platforms that need beforeinstallprompt, hide until it fires
    const needsPrompt = !isIOS && !isSafariDesktop && !isSamsung && !isFirefox;
    const display = needsPrompt && !deferredInstallPrompt ? ' style="display:none"' : '';

    return `<div class="pwa-install-banner" id="pwa-install-banner"${display}>
      <img src="icons/icon-96.png" alt="" class="pwa-install-icon" />
      <span class="pwa-install-text">${instruction}</span>
      ${actionBtn}
      <button class="pwa-install-dismiss" onclick="this.parentElement.style.display='none'" aria-label="Dismiss">&times;</button>
    </div>`;
  }

  // Expose for use in lab-apps.js
  window.mcgheeGetInstallBanner = getInstallBannerHTML;

  /* --- Proactive push prompt (standalone PWA first launch) --- */

  function maybePromptPushPermission(user) {
    if (!user || !window.McgheePush) return;
    if (!McgheePush.isSupported()) return;
    if (McgheePush.getPermissionState() !== 'default') return;

    // Only prompt proactively in standalone (installed) mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone === true;
    if (!isStandalone) return;

    // Only prompt once per device
    if (localStorage.getItem('mcgheelab-push-prompted')) return;
    localStorage.setItem('mcgheelab-push-prompted', '1');

    // Small delay so the app has time to render first
    setTimeout(async () => {
      const token = await McgheePush.requestPermission(user.uid);
      if (token) {
        showPushToast('Notifications enabled', 'You\'ll receive alerts for lab activity.');
      }
    }, 1500);
  }

  /* --- Notification permission prompt --- */

  window.mcgheeRequestPush = async function() {
    const user = McgheeLab?.Auth?.getUser?.();
    if (!user || !window.McgheePush) return;
    const token = await McgheePush.requestPermission(user.uid);
    if (token) {
      showPushToast('Notifications enabled', 'You\'ll receive alerts for lab activity.');
    }
  };

  function getNotificationPromptHTML() {
    if (!window.McgheePush || !McgheePush.isSupported()) return '';
    if (McgheePush.getPermissionState() !== 'default') return '';
    return `<div class="pwa-notif-prompt" id="pwa-notif-prompt">
      <div class="pwa-notif-content">
        <strong>Enable notifications?</strong>
        <p>Get alerts for new messages, meetings, and bookings</p>
      </div>
      <button class="pwa-notif-btn" onclick="mcgheeRequestPush(); this.parentElement.style.display='none'">Turn on</button>
      <button class="pwa-install-dismiss" onclick="this.parentElement.style.display='none'" aria-label="Dismiss">&times;</button>
    </div>`;
  }

  window.mcgheeGetNotificationPrompt = getNotificationPromptHTML;

  /* --- Toast notifications --- */

  function showUpdateToast() {
    showToast('A new version is available.', 'Refresh', () => location.reload());
  }

  function showPushToast(title, body) {
    showToast(`<strong>${esc(title)}</strong> ${esc(body)}`);
  }

  function showToast(html, actionLabel, actionFn) {
    // Remove existing toast
    const old = document.querySelector('.pwa-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.className = 'pwa-toast';
    toast.innerHTML = `
      <div class="pwa-toast-body">${html}</div>
      <div class="pwa-toast-actions">
        ${actionLabel ? `<button class="pwa-toast-action">${esc(actionLabel)}</button>` : ''}
        <button class="pwa-toast-close" aria-label="Dismiss">&times;</button>
      </div>
    `;

    if (actionFn) {
      toast.querySelector('.pwa-toast-action')?.addEventListener('click', actionFn);
    }
    toast.querySelector('.pwa-toast-close').addEventListener('click', () => toast.remove());

    document.body.appendChild(toast);
    // Auto-dismiss after 8 seconds
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 8000);
  }
})();
