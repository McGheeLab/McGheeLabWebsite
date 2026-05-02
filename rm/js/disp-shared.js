/* disp-shared.js — 3-way email-disposition vocabulary shared across pages.
 *
 * - Constants: shape + colour for actionable / reminder / info.
 * - renderDispositionGlyph(value): tiny HTML snippet for at-a-glance badges
 *   (circle/triangle/square in the importance colour).
 * - loadDispositionMap(): fetches email_archive/dispositions.json once;
 *   returns { <email_id>: { value, source, ... } }.
 * - bestDispositionForEmails(ids, map): most-severe value across a list of
 *   email IDs — used by tasks (which link to multiple emails) to pick one
 *   glyph to display.
 *
 * Importance order: actionable (3) > reminder (2) > info (1) > none (0).
 * A task whose evidence emails are mixed takes the most-severe value so a
 * single lingering "actionable" email isn't masked by a pile of FYIs.
 */
(function () {
  const OPTIONS = [
    { value: 'actionable', label: 'Actionable', shape: '\u25CF', color: '#dc2626', bg: '#fee2e2', border: '#dc2626' },
    { value: 'reminder',   label: 'Reminder',   shape: '\u25B2', color: '#f59e0b', bg: '#fef3c7', border: '#f59e0b' },
    { value: 'info',       label: 'Info',       shape: '\u25A0', color: '#6b7280', bg: '#e5e7eb', border: '#9ca3af' },
  ];
  const SEVERITY = { actionable: 3, reminder: 2, info: 1 };

  function optionByValue(v) { return OPTIONS.find(o => o.value === v) || null; }

  function glyph(value, opts) {
    const o = optionByValue(value);
    if (!o) return '';
    const size = (opts && opts.size) || 12;
    const margin = (opts && 'marginRight' in opts) ? opts.marginRight : 4;
    const titleText = (opts && opts.title) || o.label;
    // Inline style so it works everywhere without additional CSS.
    return `<span class="disp-glyph" aria-label="${o.label}" title="${titleText}" `
      + `style="display:inline-block;color:${o.color};font-size:${size}px;`
      + `line-height:1;margin-right:${margin}px;vertical-align:middle">`
      + `${o.shape}</span>`;
  }

  async function loadMap() {
    if (typeof api === 'undefined' || !api.load) return {};
    try {
      const j = await api.load('email_archive/dispositions.json');
      const out = {};
      for (const [id, d] of Object.entries(j.dispositions || {})) out[id] = d;
      return out;
    } catch {
      return {};
    }
  }

  // Most-severe disposition across a list of email IDs. Returns null if
  // none are in the map.
  function bestForEmails(emailIds, map) {
    if (!emailIds || !emailIds.length || !map) return null;
    let bestVal = null; let bestSev = 0;
    for (const id of emailIds) {
      const d = map[id];
      if (!d) continue;
      const sev = SEVERITY[d.value] || 0;
      if (sev > bestSev) { bestVal = d.value; bestSev = sev; }
    }
    return bestVal;
  }

  window.DISPOSITION = {
    options: OPTIONS,
    severity: SEVERITY,
    optionByValue,
    glyph,
    loadMap,
    bestForEmails,
  };
})();
