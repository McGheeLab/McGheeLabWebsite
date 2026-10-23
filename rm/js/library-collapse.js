/* library-collapse.js — V3.639: collapsible sections on the library page.
 *
 * Alex: "these sections and all sections on the library page can be
 * collapsed." The library page had grown a tall stack of always-open
 * blocks (extension card, dropzone, groups shelf, the papers table) and
 * V3.639 adds a readings block on top of that — so every top-level block
 * now gets a clickable header that folds it away.
 *
 * Reuses the shelf's visual + persistence pattern from library-groups.js
 * (.lg-section / .lg-sec-head / .lg-caret / .lg-sec-body / .lg-collapsed,
 * styled in css/library-groups.css) so the new headers look native rather
 * than like a second collapse system. State is per-device in localStorage
 * under its own key, so it can't collide with the shelf's inner state.
 *
 * Two ways to use it:
 *   1. Static blocks already in the HTML — LIBRARY_COLLAPSE.register(el, …)
 *      wraps the element in a section + header at runtime, so library.html
 *      keeps its plain structure and nothing else has to know.
 *   2. Dynamic markup (js/library-readings.js re-renders its sections on
 *      every change) — build the header with LIBRARY_COLLAPSE.headHtml()
 *      and open the wrapper with sectionOpen(). The delegated click handler
 *      below toggles the DOM directly, so a re-render is never required
 *      just to fold a section.
 *
 * Public API: window.LIBRARY_COLLAPSE
 *   register(elOrSel, {id, icon, label, count?, mirrorHidden?}) → section el
 *   headHtml(id, icon, label, count?, toolsHtml?) → string
 *   sectionOpen(id, extraClass?) → string  (opening <section> tag)
 *   isCollapsed(id) → bool
 *   setCount(id, n)
 */

(function () {
  const KEY = 'rm_lib_sections_collapsed';

  let _collapsed = _load();

  function _load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function _persist() {
    try { localStorage.setItem(KEY, JSON.stringify(_collapsed)); }
    catch (_) { /* private mode — collapse state just won't stick */ }
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // V3.828 — a section may start FOLDED (register({ defaultCollapsed: true }));
  // a person's own click is stored as an explicit true/false and wins.
  const _defaults = {};
  function isCollapsed(id) {
    return Object.prototype.hasOwnProperty.call(_collapsed, id) ? !!_collapsed[id] : !!_defaults[id];
  }

  function headHtml(id, icon, label, count, toolsHtml) {
    const c = isCollapsed(id);
    const showCount = (count !== undefined && count !== null && count !== '');
    return '<div class="lg-sec-head" data-lib-sec-toggle="' + _esc(id) + '">' +
      '<span class="lg-caret">' + (ICON.svg(c ? 'chevron-right' : 'chevron-down')) + '</span>' +
      '<span class="lg-sec-title">' + (icon ? ICON.render(icon) + ' ' : '') + _esc(label) + '</span>' +
      '<span class="lg-sec-count" data-lib-sec-count="' + _esc(id) + '"' +
        (showCount ? '' : ' style="display:none;"') + '>' + (showCount ? _esc(count) : '') + '</span>' +
      '<span class="lg-sec-tools">' + (toolsHtml || '') + '</span>' +
    '</div>';
  }

  function sectionOpen(id, extraClass) {
    return '<section class="lg-section lib-sec' + (extraClass ? ' ' + extraClass : '') +
      (isCollapsed(id) ? ' lg-collapsed' : '') + '" data-sec="' + _esc(id) + '">';
  }

  function setCount(id, n) {
    document.querySelectorAll('[data-lib-sec-count="' + id + '"]').forEach(function (el) {
      const show = (n !== undefined && n !== null && n !== '');
      el.textContent = show ? String(n) : '';
      el.style.display = show ? '' : 'none';
    });
  }

  /* Wrap a static block in a collapsible section, in place.
   *
   * mirrorHidden: some blocks manage their own visibility (the groups
   * shelf ships display:none and library-groups.js reveals it). Without
   * this we'd leave a header floating above an empty body. A style-attribute
   * observer mirrors the child's display:none onto the section so the
   * header disappears with it. */
  function register(elOrSel, opts) {
    opts = opts || {};
    const el = (typeof elOrSel === 'string') ? document.querySelector(elOrSel) : elOrSel;
    if (!el || el.dataset.libSecWrapped === '1') return null;
    const id = opts.id;
    if (!id) { console.warn('[library-collapse] register() needs an id'); return null; }
    if (opts.defaultCollapsed) _defaults[id] = true;   // V3.828

    const sec = document.createElement('section');
    sec.className = 'lg-section lib-sec' + (isCollapsed(id) ? ' lg-collapsed' : '');
    sec.setAttribute('data-sec', id);
    sec.innerHTML = headHtml(id, opts.icon, opts.label, opts.count, opts.toolsHtml);

    const body = document.createElement('div');
    body.className = 'lg-sec-body lib-sec-body';

    el.parentNode.insertBefore(sec, el);
    body.appendChild(el);          // moves el out of the flow into the body
    sec.appendChild(body);
    el.dataset.libSecWrapped = '1';

    if (opts.mirrorHidden) {
      const sync = function () {
        const hidden = (el.style.display === 'none');
        sec.style.display = hidden ? 'none' : '';
      };
      sync();
      try {
        new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['style'] });
      } catch (_) { /* no MutationObserver — header just stays visible */ }
    }
    return sec;
  }

  /* One delegated handler for every collapsible section on the page,
   * static or dynamic.
   *
   * The `nearest === head` guard matters: the groups shelf renders its OWN
   * .lg-sec-head elements inside the block we wrapped. Without the guard,
   * a click on an inner shelf header would walk up to our outer header and
   * fold the whole shelf instead of the sub-section the user aimed at. */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    const head = e.target.closest('[data-lib-sec-toggle]');
    if (!head) return;
    const nearest = e.target.closest('.lg-sec-head');
    if (nearest !== head) return;
    // Let buttons parked in the header (tools) act without folding.
    if (e.target.closest('.lg-sec-tools')) return;

    const id = head.getAttribute('data-lib-sec-toggle');
    const now = !isCollapsed(id);
    _collapsed[id] = now;   // V3.828 — explicit, so a default-folded section stays open once opened
    _persist();

    const sec = head.closest('.lg-section');
    if (sec) sec.classList.toggle('lg-collapsed', now);
    const caret = head.querySelector('.lg-caret');
    if (caret) caret.textContent = now ? '▸' : '▾';
  });

  window.LIBRARY_COLLAPSE = {
    register: register,
    headHtml: headHtml,
    sectionOpen: sectionOpen,
    isCollapsed: isCollapsed,
    setCount: setCount,
  };
})();
