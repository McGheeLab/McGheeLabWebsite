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

    // Hamburger
    setupMenu();

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

    // Reduced-motion: stop hero video
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const v = document.getElementById('heroVideo');
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    }
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
        classes: { intro: "", courses: [] }
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
      intro:   str(classesSrc.intro),
      courses: toArray(classesSrc.courses).map(c => ({
        title: str(c?.title),
        description: str(c?.description),
        level: str(c?.level),
        when:  str(c?.when),
        registrationLink: str(c?.registrationLink)
      }))
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
  }

  function setActiveTopNav(page){
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
        case 'classes':  view = renderClasses();  break;
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
        case 'admin': {
          const html = window.McgheeLab?.renderAdmin?.();
          if (html) { view = sectionEl(); view.innerHTML = html; } else view = renderNotFound();
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

    // Wire subnav (desktop clicks + touch/pen swipe)
    wireUpSubnav(view);

    // Start the body just under hero on route change
    window.scrollTo({ top: headerBottom(), behavior: 'smooth' });

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
          } else {
            await window.McgheeLab?.wireDashboard?.();
          }
          break;
        case 'opportunities': await window.McgheeLab?.wireOpportunities?.(); break;
        case 'admin':     await window.McgheeLab?.wireAdmin?.(); break;
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
          feedEl.innerHTML = '<p class="error-text">Failed to load stories.</p>';
          console.warn('Stories feed error:', e);
        }
      }
    }

    // Overlay registered user profiles onto team page cards
    if (page === 'team' && window.McgheeLab?.DB) {
      Promise.all([
        McgheeLab.DB.getClaimedProfiles(),
        McgheeLab.DB.getAllUsers()
      ]).then(([claimed, users]) => {
        // Build a map: claimed teamProfile name → registered user data
        const userMap = {};
        const matchedUids = new Set();
        users.forEach(u => { if (u.claimedProfileId) userMap[u.claimedProfileId] = u; });

        // Update existing content.json cards with Firestore data
        claimed.forEach(profile => {
          const user = userMap[profile.id];
          if (!user) return;

          const cards = appEl.querySelectorAll('.card.person');
          cards.forEach(card => {
            const nameEl = card.querySelector('strong');
            if (!nameEl) return;
            const cardName = nameEl.textContent.trim().toLowerCase();
            const profileName = (profile.name || '').trim().toLowerCase();
            if (cardName !== profileName) return;

            matchedUids.add(user.id);
            const photoSrc = user.photo?.medium || user.photo?.full || profile.photo?.medium || '';
            card.innerHTML = `
              ${photoSrc ? `<img src="${esc(photoSrc)}" alt="Photo of ${esc(user.name)}" loading="lazy" />` : '<div></div>'}
              <div><strong>${esc(user.name || profile.name)}</strong></div>
              ${user.category ? `<div class="role">${esc(user.category)}</div>` : ''}
              ${user.bio ? `<p>${esc(user.bio)}</p>` : ''}
            `;
          });
        });

        // Add Firestore-only users (not in content.json) to their category sections
        const unmatched = users.filter(u => !matchedUids.has(u.id) && u.name && u.category);
        if (!unmatched.length) return;

        // Category label map for section headings
        const catLabels = {
          pi: 'Principal Investigator', postdoc: 'Postdoctoral', grad: 'Graduate',
          undergrad: 'Undergraduate', highschool: 'High School', alumni: 'Alumni'
        };
        // Category display order
        const catOrder = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni'];

        // Group unmatched users by category
        const byCat = {};
        unmatched.forEach(u => {
          const cat = u.category || 'undergrad';
          if (!byCat[cat]) byCat[cat] = [];
          byCat[cat].push(u);
        });

        catOrder.forEach(cat => {
          const catUsers = byCat[cat];
          if (!catUsers) return;

          // Try to find an existing section for this category
          let grid = null;
          const sections = appEl.querySelectorAll('.section');
          sections.forEach(sec => {
            const h2 = sec.querySelector('h2');
            if (h2 && h2.textContent.trim() === catLabels[cat]) {
              grid = sec.querySelector('.grid');
            }
          });

          // If no section exists for this category, create one
          if (!grid) {
            const section = div('section reveal');
            section.innerHTML = `<div class="max-w"><h2>${esc(catLabels[cat])}</h2></div>`;
            grid = div('max-w grid grid-fit-250');
            section.appendChild(grid);

            // Insert in correct order: find the first section that comes after this category
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
              // Append at end (but before any non-section content)
              const container = allSections.length ? allSections[0].parentNode : appEl;
              container.appendChild(section);
            }
          }

          catUsers.forEach(u => {
            const photoSrc = u.photo?.medium || u.photo?.full || '';
            const card = div('card person');
            card.innerHTML = `
              ${photoSrc ? `<img src="${esc(photoSrc)}" alt="Photo of ${esc(u.name)}" loading="lazy" />` : '<div></div>'}
              <div><strong>${esc(u.name)}</strong></div>
              ${u.category ? `<div class="role">${esc(u.category)}</div>` : ''}
              ${u.bio ? `<p>${esc(u.bio)}</p>` : ''}
            `;
            grid.appendChild(card);
          });
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
    } catch (e) { console.warn('Stories for project:', e); }

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

      const grid = div('max-w grid grid-fit-250');
      people.forEach(person=>{
        const card = div('card person');
        card.innerHTML = `
          ${imageHTML(person.photo, `Photo of ${esc(person.name)}`)}
          <div><strong>${esc(person.name || 'Name')}</strong></div>
          ${person.role ? `<div class="role">${esc(person.role)}</div>` : ''}
          ${person.bio  ? `<p>${esc(person.bio)}</p>` : ''}
        `;
        grid.appendChild(card);
      });

      section.appendChild(grid);
      wrap.appendChild(section);
    });

    if (!existing.length){
      wrap.appendChild(infoBox('Add team members in content.json → "team": { "highschool": [], ... }'));
    }

    return wrap;
  }

  function renderClasses(){
    const c = state.data.classes || {};
    const wrap = sectionEl();

    const links = [];
    if (c.intro) links.push({ id: uniqueId('classes-intro'), label: 'Overview' });
    links.push(...toArray(c.courses).map(course => ({ id: uniqueId(slugify(course.title || 'course')), label: course.title || 'Course' })));
    if (links.length) wrap.appendChild(buildSubnav(links));

    if (c.intro){
      const intro = div('section card reveal'); intro.id = links[0].id;
      intro.innerHTML = `<div class="max-w"><h2>Classes</h2><p>${esc(c.intro)}</p></div>`;
      wrap.appendChild(intro);
    }

    const grid = div('max-w grid grid-fit-250');
    toArray(c.courses).forEach((course, idx)=>{
      const id = (c.intro ? links[idx+1] : links[idx])?.id || uniqueId(slugify(course.title || 'course'));
      const card = div('card class-item reveal'); card.id = id;
      card.innerHTML = `
        <h3>${esc(course.title || 'Untitled')}</h3>
        ${course.description ? `<p>${esc(course.description)}</p>` : ''}
        <p>
          ${course.level ? `<span class="badge">${esc(course.level)}</span>` : ''}
          ${course.when  ? ` <span class="badge">${esc(course.when)}</span>` : ''}
        </p>
        ${course.registrationLink ? `<p><a href="${esc(course.registrationLink)}" target="_blank" rel="noopener">Register</a></p>` : ''}
      `;
      grid.appendChild(card);
    });

    if (!isNonEmptyArray(c.courses)){
      grid.appendChild(infoBox('Add courses in content.json → "classes.courses": [ ... ]'));
    }

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
      members.push({ ...team.author, teamRole: 'Author' });
    }
    if (isNonEmptyArray(team.contributors)) {
      team.contributors.forEach(c => members.push({ ...c, teamRole: 'Contributor' }));
    }
    if (team.mentor) {
      members.push({ ...team.mentor, teamRole: 'Mentor' });
    }
    if (!members.length) return '';

    return `
      <div class="story-team">
        <h4 class="story-team-heading">Team</h4>
        <div class="story-team-grid">
          ${members.map(m => `
            <div class="story-team-member">
              ${m.photo
                ? `<img src="${esc(m.photo)}" alt="${esc(m.name || '')}" class="story-team-photo" loading="lazy">`
                : `<div class="story-team-photo story-team-photo-placeholder">${esc((m.name || '?')[0])}</div>`}
              <div class="story-team-info">
                <span class="story-team-name">${esc(m.name || 'Unknown')}</span>
                <span class="story-team-role">${esc(m.teamRole)}</span>
              </div>
            </div>
          `).join('')}
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
})();
