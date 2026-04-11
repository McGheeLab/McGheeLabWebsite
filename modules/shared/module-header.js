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

  /** Extract ?class= param from the current page URL */
  function getClassId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('class') || null;
  }

  /** Extract current filename from the URL path */
  function getCurrentFile() {
    const path = window.location.pathname;
    const parts = path.split('/');
    return parts[parts.length - 1] || null;
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

  /** Build a link to a sibling module file, preserving the class param */
  function moduleLink(htmlFile, classId) {
    return htmlFile + '?class=' + encodeURIComponent(classId);
  }

  async function init() {
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

      const currentIdx = modules.findIndex(m => m.htmlFile === currentFile);
      const current = currentIdx >= 0 ? modules[currentIdx] : null;
      const prev = currentIdx > 0 ? modules[currentIdx - 1] : null;
      const next = (currentIdx >= 0 && currentIdx < modules.length - 1) ? modules[currentIdx + 1] : null;

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
        moduleTitle: current?.title || currentFile,
        moduleNumber: currentIdx >= 0 ? currentIdx + 1 : null,
        totalModules: modules.length,
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
    const progressText = data.moduleNumber
      ? `Lesson ${data.moduleNumber} of ${data.totalModules}`
      : '';

    const prevBtn = data.prev
      ? `<a href="${moduleLink(data.prev.htmlFile, data.classId)}" class="mod-nav-btn" title="${esc(data.prev.title)}">&larr; Prev</a>`
      : '<span class="mod-nav-btn mod-nav-disabled">&larr; Prev</span>';

    const nextBtn = data.next
      ? `<a href="${moduleLink(data.next.htmlFile, data.classId)}" class="mod-nav-btn" title="${esc(data.next.title)}">Next &rarr;</a>`
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
    // Running inside iframe — don't render the standalone header
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
