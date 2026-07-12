/* paper-export-lints.js — pre-flight checks over a built tex+bib bundle.
 *
 * Each lint is a pure function over the bundle returned by
 * PaperExportTex.buildBundle({...}). Run client-side before triggering
 * a Cloud Run compile — saves an invocation for the obvious mistakes.
 *
 * Returns an array of {id, level: 'err'|'warn'|'ok', message, count?}.
 *
 * Inspired by scitex-writer's writer_check_references +
 * writer_check_float_order — same idea, simplified for our scope:
 *
 *   refs        — every \ref{} / \cref{} / \eqref{} has a matching
 *                 \label{} somewhere in the bundle.
 *   citations   — every citation key resolved to a non-commented bib
 *                 entry (commented placeholders are kept distinct).
 *   floatOrder  — figures appear in numerical order (basic monotonic
 *                 check on numeric suffixes when present).
 *   shellEscape — flag enabled addons that require shell-escape (compile
 *                 service decides whether to honor it).
 */

(function () {

  function runAll(bundle, addonIds) {
    var results = [];
    results.push(checkRefs(bundle));
    results.push(checkCitations(bundle));
    results.push(checkFloatOrder(bundle));
    results.push(checkShellEscape(addonIds));
    return results.filter(Boolean);
  }

  /* All file contents concatenated for grep-style scans. */
  function concatAll(bundle) {
    return (bundle.files || []).map(function (f) { return f.content || ''; }).join('\n');
  }

  function checkRefs(bundle) {
    var src = concatAll(bundle);
    var labels = new Set();
    var labelRe = /\\label\{([^}]+)\}/g;
    var m;
    while ((m = labelRe.exec(src))) labels.add(m[1]);

    var dangling = [];
    var refRe = /\\(?:ref|cref|Cref|eqref)\{([^}]+)\}/g;
    while ((m = refRe.exec(src))) {
      var key = m[1];
      if (!labels.has(key)) dangling.push(key);
    }
    if (dangling.length === 0) {
      return { id: 'refs', level: 'ok', message: 'All \\ref / \\cref / \\eqref labels resolve.' };
    }
    var uniq = Array.from(new Set(dangling));
    return {
      id: 'refs',
      level: 'err',
      message: 'Dangling label references: ' + uniq.slice(0, 6).join(', ') +
               (uniq.length > 6 ? ' (+' + (uniq.length - 6) + ' more)' : ''),
      count: uniq.length,
    };
  }

  function checkCitations(bundle) {
    var bibFile = (bundle.files || []).find(function (f) { return /\.bib$/.test(f.relpath); });
    if (!bibFile) return null;
    var bib = bibFile.content || '';
    var missing = [];
    /* Our buildBibtex emits unknown keys as a commented `% @misc{key, ...}`
     * line — that's the pattern we lift to find them. */
    var re = /^% @misc\{([^,]+),/gm;
    var m;
    while ((m = re.exec(bib))) missing.push(m[1].trim());
    if (missing.length === 0) {
      return { id: 'citations', level: 'ok', message: 'All ' + (bundle.citationKeys || []).length + ' citations matched bib entries.' };
    }
    return {
      id: 'citations',
      level: 'err',
      message: 'Bib entries missing from items.json: ' + missing.slice(0, 5).join(', ') +
               (missing.length > 5 ? ' (+' + (missing.length - 5) + ' more)' : ''),
      count: missing.length,
    };
  }

  function checkFloatOrder(bundle) {
    var src = concatAll(bundle);
    var figLabels = [];
    var re = /\\label\{(fig:[^}]+)\}/g;
    var m;
    while ((m = re.exec(src))) figLabels.push(m[1]);
    if (figLabels.length < 2) {
      return { id: 'floatOrder', level: 'ok', message: 'Float order: ' + figLabels.length + ' figure label(s) — nothing to check.' };
    }
    /* Pull a trailing integer if the label ends in one; otherwise skip
     * comparison for that pair (some authors slug by content, not number). */
    var nums = figLabels.map(function (l) {
      var x = l.match(/(\d+)$/);
      return x ? parseInt(x[1], 10) : null;
    });
    var bad = [];
    for (var i = 1; i < nums.length; i++) {
      if (nums[i] != null && nums[i - 1] != null && nums[i] < nums[i - 1]) {
        bad.push(figLabels[i - 1] + ' → ' + figLabels[i]);
      }
    }
    if (bad.length === 0) {
      return { id: 'floatOrder', level: 'ok', message: 'Figures appear in numerical order.' };
    }
    return {
      id: 'floatOrder',
      level: 'warn',
      message: 'Figure labels out of order: ' + bad.slice(0, 3).join('; '),
      count: bad.length,
    };
  }

  function checkShellEscape(addonIds) {
    var registry = (window.PaperExportTex && window.PaperExportTex.ADDON_REGISTRY) || [];
    var enabled = new Set(addonIds || []);
    var needs = registry.filter(function (a) {
      return enabled.has(a.id) && a.requires_shell_escape;
    });
    if (needs.length === 0) return null;
    return {
      id: 'shellEscape',
      level: 'warn',
      message: 'Add-ons need --shell-escape: ' + needs.map(function (a) { return a.id; }).join(', ') +
               '. The Tectonic service must be configured to honor this; otherwise compile will fail.',
    };
  }

  window.PaperExportLints = {
    runAll: runAll,
    checkRefs: checkRefs,
    checkCitations: checkCitations,
    checkFloatOrder: checkFloatOrder,
    checkShellEscape: checkShellEscape,
  };
})();
