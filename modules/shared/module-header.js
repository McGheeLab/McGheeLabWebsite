/* ================================================================
   module-header.js — Auto-populating navigation header for
   learning module pages. Reads class metadata from Firestore
   to build prev/next/homework navigation.

   Usage: Include in any module HTML page. The page URL must have
   a ?class={scheduleId} query parameter so the header knows
   which class context to load.

   Expects:
     - Firebase App + Firestore SDKs loaded
     - firebase-config.js loaded (sets up McgheeLab.db)
     - <header id="module-header"></header> in the page
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.ModuleHeader = (() => {
  function esc(s) {
    const el = document.createElement('div');
    el.textContent = s ?? '';
    return el.innerHTML;
  }

  /** Extract ?class= param from the current page URL.
      V3.793 — a page that belongs to exactly one class may declare it as
      `<header id="module-header" data-class="bme295c">`, so a direct link
      (no query string) still gets the full header with the class back-link. */
  function getClassId() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('class')) return params.get('class');
    const header = document.getElementById('module-header');
    return (header && header.dataset && header.dataset.class) || null;
  }

  /** Extract current filename from the URL path */
  function getCurrentFile() {
    const path = window.location.pathname;
    const parts = path.split('/');
    return parts[parts.length - 1] || null;
  }

  /* V3.716 — ?mod= is the modules[] *placement* id the viewer opened. A class
     may hold the same lesson file in two Learning Modules sections, and it may
     hold two different folders' overview.html, so matching on filename alone
     picked the wrong row (first match wins). The placement id disambiguates
     both. Absent when a module is opened by direct link — then we fall back to
     the filename match, i.e. exactly the old behaviour. */
  function getModuleRef() {
    const params = new URLSearchParams(window.location.search);
    return params.get('mod') || null;
  }

  /* V3.803 — module types. A modules[] entry may carry `type`; homework,
     homework_key, report and test are LISTED on their own tab (Homeworks /
     Reports & Tests) rather than in the lesson stack. Notes never are. */
  const TYPE_HOME  = { homework: 'hw', homework_key: 'hw', report: 'rt', test: 'rt' };
  const TYPE_LABEL = { pretest: 'Pretest', homework: 'Homework', homework_key: 'Homework key', report: 'Report', test: 'Test' };
  /* An entry with no `type` reads as its guess from the file name / title —
     the same rules as guessModuleType() in class-builder.js. */
  function guessType(htmlFile, title) {
    const s = (htmlFile || '') + ' ' + (title || '');
    const hwWord = /\b(?:hw|homework|assignment|problem[- ]?set)\b|\bhw-?\d/i;
    if (/\b(?:solutions?|answer[- ]?key)\b/i.test(s) || (/\bkey\b/i.test(s) && hwWord.test(s))) return 'homework_key';
    if (/pre-?test|diagnostic/i.test(s)) return 'pretest';
    if (hwWord.test(s)) return 'homework';
    if (/\breports?\b/i.test(s)) return 'report';
    if (/\b(?:test|exam|midterm|final|quiz)\b/i.test(s)) return 'test';
    return 'module';
  }
  function typeOf(m) {
    if (!m) return 'module';
    if (m.type === 'module' || TYPE_LABEL[m.type]) return m.type;
    return guessType(m.htmlFile, m.title);
  }
  function homeOf(m) { return (!m || m.kind === 'notes') ? null : (TYPE_HOME[typeOf(m)] || null); }
  /* "Lesson 3 of 7" counts only plain modules; the pretest and notes are named;
     a listed type reads "Homework key · 2 of 5". Same rule as class-builder.js. */
  function progressLabel(current, siblings, idx) {
    if (current && current.kind === 'notes') return 'Instructor notes';
    const type = typeOf(current);
    if (type === 'pretest') return 'Pretest';
    if (type !== 'module') return TYPE_LABEL[type] + ' · ' + (idx + 1) + ' of ' + siblings.length;
    const isLesson = (m) => m.kind !== 'notes' && typeOf(m) === 'module';
    return 'Lesson ' + siblings.slice(0, idx + 1).filter(isLesson).length
         + ' of ' + siblings.filter(isLesson).length;
  }

  /** Derive the base URL for navigating back to the SPA class page */
  function getClassUrl(classId) {
    // Module pages live at /modules/{classId}/lesson.html
    // The SPA root is two levels up: ../../
    const pathParts = window.location.pathname.split('/');
    const modulesIdx = pathParts.indexOf('modules');
    // Build relative path back to repo root
    const depth = pathParts.length - 1 - modulesIdx; // levels below modules/
    const prefix = '../'.repeat(depth);
    return prefix + '#/classes/' + encodeURIComponent(classId);
  }

  /** Build a link to a sibling module, preserving the class param.
      V3.716 — also carries the sibling's placement id, so stepping through a
      section's lessons stays in that section (and lands on the right row when
      two placements share a filename). */
  function moduleLink(mod, classId) {
    return mod.htmlFile + '?class=' + encodeURIComponent(classId)
         + (mod.id ? '&mod=' + encodeURIComponent(mod.id) : '');
  }

  async function init() {
    /* V3.736 — embedded in the whiteboard (?embed=T.S): no class header */
    if (/(?:^|[?&])embed=\d+\.\d+/.test(window.location.search)) return;
    const header = document.getElementById('module-header');
    if (!header) return;

    const classId = getClassId();
    const currentFile = getCurrentFile();

    // If no class context, show minimal header
    if (!classId) {
      header.innerHTML = buildMinimalHeader();
      return;
    }

    // Wait for Firebase to be ready
    const db = McgheeLab.db;
    if (!db) {
      header.innerHTML = buildMinimalHeader(classId);
      return;
    }

    try {
      const doc = await db.collection('schedules').doc(classId).get();
      if (!doc.exists) {
        header.innerHTML = buildMinimalHeader(classId);
        return;
      }

      const schedule = doc.data();
      const modules = (schedule.modules || [])
        .filter(m => m.published)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      // V3.716 — placement id first, filename second.
      const modRef = getModuleRef();
      const current = (modRef && modules.find(m => m.id === modRef))
                   || modules.find(m => m.htmlFile === currentFile)
                   || null;

      /* Prev/next walk the placement's own section so the header agrees with
         the section list the student came from. Same adoption rule as the
         class page: an entry with no sectionId belongs to the first Learning
         Modules section, so a class whose doc has not been re-saved since
         V3.716 still navigates correctly. A teacher-class has no modules
         section, so homeSectionId is null and this degrades to the whole
         published list — the pre-V3.716 behaviour. */
      const homeSectionId = (schedule.tabs || [])
        .flatMap(t => t.sections || [])
        .find(s => s.key === 'modules')?.id || null;
      const sectionRank = new Map((schedule.tabs || [])
        .flatMap(t => t.sections || []).filter(s => s.key === 'modules').map((s, i) => [s.id, i]));
      const sectionOf = (m) => m.sectionId || homeSectionId;
      /* V3.803 — listed types (homework, homework_key, report, test) navigate
         within their own list, in the order their tab shows them; the lesson
         stack's prev/next skip them. Mirrors moduleHomeKey() and the viewer
         in class-builder.js — keep the two in step. */
      const siblings = homeOf(current)
        ? modules.filter(m => homeOf(m) === homeOf(current))
            .sort((a, b) => ((sectionRank.get(sectionOf(a)) ?? 0) - (sectionRank.get(sectionOf(b)) ?? 0))
                         || ((a.order ?? 0) - (b.order ?? 0)))
        : sectionOf(current || {})
          ? modules.filter(m => !homeOf(m) && sectionOf(m) === sectionOf(current))
          : modules.filter(m => !homeOf(m));
      const currentIdx = current ? siblings.findIndex(m => m.id === current.id) : -1;
      const prev = currentIdx > 0 ? siblings[currentIdx - 1] : null;
      const next = (currentIdx >= 0 && currentIdx < siblings.length - 1) ? siblings[currentIdx + 1] : null;

      // Resolve homework URL if linked
      let homeworkUrl = null;
      if (current?.homeworkFileId) {
        try {
          const fDoc = await db.collection('classFiles').doc(current.homeworkFileId).get();
          if (fDoc.exists) homeworkUrl = fDoc.data().fileUrl || null;
        } catch (e) { /* skip */ }
      }

      header.innerHTML = buildFullHeader({
        classTitle: schedule.title || classId,
        classId,
        // V3.793 — a page the class doc doesn't list (opened by direct link)
        // shows its own <title> (up to the " — Course" suffix), not "lesson-01.html".
        moduleTitle: current?.title || (document.title || '').split(' — ')[0].trim() || currentFile,
        moduleNumber: currentIdx >= 0 ? currentIdx + 1 : null,
        totalModules: siblings.length,
        progressText: currentIdx >= 0 ? progressLabel(current, siblings, currentIdx) : '',
        prev,
        next,
        homeworkUrl
      });

    } catch (err) {
      console.warn('[ModuleHeader] Failed to load class data:', err);
      header.innerHTML = buildMinimalHeader(classId);
    }
  }

  function buildFullHeader(data) {
    const classUrl = getClassUrl(data.classId);
    const progressText = data.progressText
      || (data.moduleNumber ? `Lesson ${data.moduleNumber} of ${data.totalModules}` : '');

    const prevBtn = data.prev
      ? `<a href="${moduleLink(data.prev, data.classId)}" class="mod-nav-btn" title="${esc(data.prev.title)}">&larr; Prev</a>`
      : '<span class="mod-nav-btn mod-nav-disabled">&larr; Prev</span>';

    const nextBtn = data.next
      ? `<a href="${moduleLink(data.next, data.classId)}" class="mod-nav-btn" title="${esc(data.next.title)}">Next &rarr;</a>`
      : '<span class="mod-nav-btn mod-nav-disabled">Next &rarr;</span>';

    const hwBtn = data.homeworkUrl
      ? `<a href="${esc(data.homeworkUrl)}" target="_blank" rel="noopener" class="mod-nav-btn mod-nav-hw">Homework</a>`
      : '';

    return `
      <div class="mod-header-inner">
        <a href="${classUrl}" class="mod-header-back">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          ${esc(data.classTitle)}
        </a>
        <div class="mod-header-center">
          ${progressText ? `<span class="mod-header-progress">${progressText}</span>` : ''}
          <h1 class="mod-header-title">${esc(data.moduleTitle)}</h1>
        </div>
        <div class="mod-header-nav">
          ${prevBtn}
          ${hwBtn}
          ${nextBtn}
        </div>
      </div>
    `;
  }

  function buildMinimalHeader(classId) {
    if (classId) {
      const classUrl = getClassUrl(classId);
      return `
        <div class="mod-header-inner">
          <a href="${classUrl}" class="mod-header-back">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            Back to Class
          </a>
          <div class="mod-header-center">
            <h1 class="mod-header-title">Learning Module</h1>
          </div>
          <div class="mod-header-nav"></div>
        </div>
      `;
    }
    // No class context at all
    return `
      <div class="mod-header-inner">
        <div class="mod-header-center">
          <h1 class="mod-header-title">Learning Module</h1>
        </div>
      </div>
    `;
  }

  // Auto-init when DOM is ready — but skip if loaded inside an iframe
  // (the SPA module viewer provides its own header above the iframe)
  if (window.parent !== window) {
    // Running inside iframe — don't render the standalone header.
    // V3.672 — instead, feed the viewer's engagement beacon: a rail-anchor
    // navigation inside the module reports the section id to the parent via
    // the ml-module protocol (the viewer origin-checks and dedupes against
    // its own IntersectionObserver stream). No-ops harmlessly when the
    // parent isn't listening; never fires standalone (parent === window).
    window.addEventListener('hashchange', () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      try {
        window.parent.postMessage({ source: 'ml-module', type: 'section', id: id },
          window.location.origin);
      } catch (e) { /* cross-origin parent — not our viewer */ }
    });
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Small delay to ensure firebase-config.js has initialized
      setTimeout(init, 100);
    });
  } else {
    setTimeout(init, 100);
  }

  return { init };
})();
