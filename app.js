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
        research: { topics: [], references: [] },
        projects: [],
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

    const research = (() => {
      const r = raw.research || raw?.pages?.research || {};
      return {
        topics: toArray(r.topics).map(normalizeTopicOrProject),
        references: toArray(r.references).map((ref) => ({
          title:  str(ref?.title),
          authors:str(ref?.authors),
          journal:str(ref?.journal),
          year:   str(ref?.year),
          doi:    str(ref?.doi)
        }))
      };
    })();

    const projects = toArray((raw.projects && !raw.projects.projects) ? raw.projects : raw?.pages?.projects?.projects)
      .map(normalizeTopicOrProject);

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

    return { site, mission, research, projects, team, classes };
  }

  // Normalize Research Topic or Project item
  function normalizeTopicOrProject(item){
    const title = str(item?.title);
    const slug  = slugify(item?.slug || title || 'section');

    const image = item?.image || (isNonEmptyArray(item?.images) ? item.images[0]?.src : '');
    const imageAlt = item?.imageAlt || (isNonEmptyArray(item?.images) ? item.images[0]?.alt : '');

    const storyBlocks = toArray(item?.story?.length ? item.story : item?.details)
      .map(block => {
        if (typeof block === 'string') return { text: block, image: '', imageAlt: '' };
        return {
          text: str(block?.text || block?.content),
          image: str(block?.image || block?.src),
          imageAlt: str(block?.imageAlt || block?.alt)
        };
      });

    const link = str(item?.link || item?.hyperlink || '');   // <— add this

    return {
      slug,
      title,
      summary: str(item?.summary),
      image: str(image),
      imageAlt: str(imageAlt || title),
      keywords: toArray(item?.keywords).map(str),
      tags: toArray(item?.tags).map(str),
      story: storyBlocks,
      link                                   // <— include it
    };
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
    const [, route] = hash.split('/');
    const page = (route || 'mission').toLowerCase();
    render(page);
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
  async function render(page){
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
        case 'contact':  view = renderContact();  break;
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
    const { topics = [], references = [] } = state.data.research || {};
    const wrap = sectionEl();

    const links = [
      ...topics.map(t => ({ id: uniqueId(t.slug), label: t.title || 'Topic' })),
      ...(references.length ? [{ id: uniqueId('references'), label: 'References' }] : [])
    ];
    wrap.appendChild(buildSubnav(links));

    topics.forEach((t, i)=>{
      const id = links[i].id;
      const art = div('section card reveal'); art.id = id;

      const storyHTML = buildStoryHTML(t.story);

      art.innerHTML = `
        <div class="max-w">
          <h2>${esc(t.title || 'Untitled')}</h2>
          <div class="media">
            <div>
              ${t.summary ? `<p>${esc(t.summary)}</p>` : ''}
              ${isNonEmptyArray(t.keywords) ? `<p>${t.keywords.map(k=>`<span class="badge">${esc(k)}</span>`).join(' ')}</p>` : ''}
              ${storyHTML ? expandableHTML() : ''}
            </div>
            ${imageHTML(t.image, t.imageAlt || t.title || 'image')}
          </div>
          ${storyHTML ? `<div class="expandable-details" hidden>${storyHTML}</div>` : ''}
        </div>
      `;

      // Wire expand/collapse if story exists
      const btn = art.querySelector('.expand-toggle');
      if (btn){
        const details = art.querySelector('.expandable-details');
        wireExpandable(btn, details);
      }

      wrap.appendChild(art);
    });

    // References
    if (references.length){
      const refs = div('section card reveal'); refs.id = links.at(-1).id;
      refs.innerHTML = `
        <div class="max-w">
          <h2>Selected References</h2>
          <ol>
            ${references.map(r => `
              <li>
                <strong>${esc(r.title)}</strong>${r.authors ? `<br/><span>${esc(r.authors)}</span>` : ''}
                ${r.journal ? ` <em>${esc(r.journal)}</em>` : ''}${r.year ? ` (${esc(r.year)})` : ''}
                ${r.doi ? ` — <a href="${esc(r.doi)}" target="_blank" rel="noopener">DOI</a>` : ''}
              </li>
            `).join('')}
          </ol>
        </div>
      `;
      wrap.appendChild(refs);
    }

    if (!topics.length && !references.length){
      wrap.appendChild(infoBox('Add research topics in content.json → "research.topics": [ ... ]'));
    }

    return wrap;
  }

  function renderProjects(){
    const projects = state.data.projects || [];
    const wrap = sectionEl();

    const links = projects.map(p => ({ id: uniqueId(p.slug), label: p.title || 'Project' }));
    wrap.appendChild(buildSubnav(links));

    const grid = div('max-w grid grid-fit-250');
    projects.forEach((p, i)=>{
      const id = links[i].id;
      const storyHTML = buildStoryHTML(p.story);
      const item = div('card class-item reveal project-card'); item.id = id;

      item.innerHTML = `
        <div class="thumb">${imageHTML(p.image, p.imageAlt || p.title || 'image')}</div>
        <h3>${esc(p.title || 'Untitled')}</h3>
        ${p.summary ? `<p>${esc(p.summary)}</p>` : ''}
        ${isNonEmptyArray(p.tags) ? `<p>${p.tags.map(t=>`<span class="badge">${esc(t)}</span>`).join(' ')}</p>` : ''}
        ${p.link ? `<p><a class="btn" href="${esc(p.link)}" target="_blank" rel="noopener">View Project Page</a></p>` : ''}
        ${storyHTML ? `${expandableHTML()}<div class="expandable-details" hidden>${storyHTML}</div>` : ''}
      `;

      if (storyHTML){
        const btn = item.querySelector('.expand-toggle');
        const det = item.querySelector('.expandable-details');
        wireExpandable(btn, det);
      }

      grid.appendChild(item);
    });

    if (!projects.length){
      grid.appendChild(infoBox('Add projects in content.json → "projects": [ ... ]'));
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function renderTeam(){
    const team = state.data.team || {};
    const wrap = sectionEl();

    const categories = [
      ['postdoc',    'Postdoctoral'],
      ['grad',       'Graduate'],
      ['undergrad',  'Undergraduate'],
      ['highschool', 'High School'],
      ['alumni', 'Alumni']

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

  function renderContact(){
    const site = state.data.site;
    const wrap = sectionEl();

    // Quick links for the two sections
    const links = [
      { id: uniqueId('contact-form'), label: 'Form' },
      { id: uniqueId('contact-info'), label: 'Info' }
    ];
    wrap.appendChild(buildSubnav(links));

    const block = div('max-w grid');

    const formBox = div('card class-item reveal'); formBox.id = links[0].id;
    formBox.innerHTML = `
      <h2>Contact Us</h2>
      <form id="contactForm" novalidate>
        <label> Name
          <input name="name" type="text" placeholder="Your name" required />
        </label>
        <label> Email
          <input name="email" type="email" placeholder="you@example.com" required />
        </label>
        <label> Message
          <textarea name="message" placeholder="How can we help?" required></textarea>
        </label>
        <button type="submit">Send</button>
      </form>
      <p class="muted">This demo uses <code>mailto:</code>. Replace with your backend or a form service.</p>
    `;

    const infoBoxEl = div('card class-item reveal'); infoBoxEl.id = links[1].id;
    infoBoxEl.innerHTML = `<h2>Info</h2>${formatContact(site.contact)}`;

    block.appendChild(formBox);
    block.appendChild(infoBoxEl);
    wrap.appendChild(block);

    // Simple mailto handler with email validation
    setTimeout(() => {
      const form = document.getElementById('contactForm');
      form?.addEventListener('submit', (e) => {
        e.preventDefault();
        const data = new FormData(form);
        const name = data.get('name'); const email = data.get('email'); const message = data.get('message');
        if(!name || !email || !message){ alert('Please complete all fields.'); return; }
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ alert('Please enter a valid email address.'); return; }
        const mailto = `mailto:${state.data.site.contact.email}?subject=${encodeURIComponent('Website contact from ' + name)}&body=${encodeURIComponent(message + '\n\nFrom: ' + name + ' <' + email + '>')}`;
        window.location.href = mailto;
      });
    }, 0);

    return wrap;
  }

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
    const hasImg  = !!(block.image && String(block.image).trim());
    const hasText = !!(block.text && String(block.text).trim());
    const textHTML = hasText ? `<p>${esc(block.text)}</p>` : '';

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

    // No image: make the text span the FULL width of the media grid
    // (grid-column: 1 / -1 makes this child span all columns)
    return `
      <div class="section" style="margin-top:8px">
        <div class="media">
          <div style="grid-column: 1 / -1">${textHTML}</div>
        </div>
      </div>
    `;
  }).join('');
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
