/* library-tags.js — colon-delimited multi-tag helpers for paper items.
 *
 * Tags are free-form strings like 'research:papers:2026:GELS' stored on
 * `meta.library.tags: string[]`. Filtering uses prefix-match: searching
 * for 'research:papers:2026' matches both 'research:papers:2026:GELS' and
 * 'research:papers:2026:CARDIO'. No fixed depth, no closed vocabulary.
 *
 * Public API (window.LIBRARY_TAGS):
 *   normalize(tag)              → canonical form (lowercase, trimmed segments)
 *   parse(commaSeparated)       → string[] of normalized tags
 *   getTags(item)               → string[] of an item's tags (always an array)
 *   setTags(item, tags)         → mutates item, returns array of normalized tags
 *   buildIndex(items)           → { allTags: Set, prefixes: Set, byTag: Map<tag, itemId[]> }
 *   matchPrefix(itemTags, q)    → bool: does any item tag start with q?
 *   filterItems(items, query)   → items[] whose tags contain query (prefix match)
 *   suggestions(prefix, index)  → string[] up to 8, sorted by usage
 *   children(prefix, index)     → string[] of next-level segments below prefix
 */

(function () {
  function normalize(tag) {
    return String(tag || '')
      .toLowerCase()
      .split(':')
      .map(s => s.trim().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean)
      .join(':');
  }

  function parse(commaSeparated) {
    if (Array.isArray(commaSeparated)) {
      return Array.from(new Set(commaSeparated.map(normalize).filter(Boolean)));
    }
    const raw = String(commaSeparated || '');
    return Array.from(new Set(
      raw.split(/[,\n]/).map(normalize).filter(Boolean)
    ));
  }

  function getTags(item) {
    if (!item || !item.meta || !item.meta.library) return [];
    const t = item.meta.library.tags;
    return Array.isArray(t) ? t : [];
  }

  function setTags(item, tags) {
    if (!item) return [];
    item.meta = item.meta || {};
    item.meta.library = item.meta.library || {};
    const normalized = parse(tags);
    item.meta.library.tags = normalized;
    return normalized;
  }

  // True if any of the item's tags is exactly `q` or has `q:` as a prefix.
  // Bare prefix without trailing colon is allowed: 'research:papers:2026'
  // matches 'research:papers:2026:GELS' and 'research:papers:2026'.
  function matchPrefix(itemTags, q) {
    const needle = normalize(q);
    if (!needle) return false;
    if (!Array.isArray(itemTags) || !itemTags.length) return false;
    for (const t of itemTags) {
      if (t === needle) return true;
      if (t.startsWith(needle + ':')) return true;
    }
    return false;
  }

  function filterItems(items, query) {
    const needle = normalize(query);
    if (!needle) return items.slice();
    return items.filter(it => matchPrefix(getTags(it), needle));
  }

  // Walk every item, every tag, and accumulate three indexes:
  //  - allTags: every tag verbatim (for autocomplete)
  //  - prefixes: every prefix segment (for hierarchical browsing)
  //  - byTag: tag → list of item ids that carry it (for fast filter)
  function buildIndex(items) {
    const allTags = new Set();
    const prefixes = new Set();
    const byTag = new Map();
    const usage = new Map();   // tag → count, for ranking suggestions
    for (const it of (items || [])) {
      const tags = getTags(it);
      for (const t of tags) {
        if (!t) continue;
        allTags.add(t);
        usage.set(t, (usage.get(t) || 0) + 1);
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t).push(it.id);
        // Add every prefix segment (e.g. 'a:b:c' → 'a', 'a:b', 'a:b:c')
        const parts = t.split(':');
        for (let i = 1; i <= parts.length; i++) {
          prefixes.add(parts.slice(0, i).join(':'));
        }
      }
    }
    return { allTags, prefixes, byTag, usage };
  }

  // Up-to-8 tag completions for `prefix` from the index, ranked by usage
  // count desc then alphabetically. Includes both exact-prefix tags and
  // partial children. Used by the tag input autocomplete.
  function suggestions(prefix, index, limit = 8) {
    if (!index || !index.allTags) return [];
    const needle = normalize(prefix);
    const scored = [];
    for (const t of index.allTags) {
      if (!needle || t.startsWith(needle)) {
        scored.push({ tag: t, count: index.usage.get(t) || 0 });
      }
    }
    // Also include prefix-only segments (so typing 'research' suggests
    // 'research:papers' as a step, even if no item carries that exact tag).
    for (const p of index.prefixes) {
      if (index.allTags.has(p)) continue;
      if (!needle || p.startsWith(needle)) {
        scored.push({ tag: p, count: 0 });
      }
    }
    scored.sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
    return scored.slice(0, limit).map(s => s.tag);
  }

  // Direct children of `prefix` (next colon segment). Useful for a
  // breadcrumb-style filter widget that shows "research:papers > 2026".
  function children(prefix, index) {
    if (!index) return [];
    const needle = normalize(prefix);
    const out = new Set();
    const parts = needle ? needle.split(':') : [];
    const depth = parts.length;
    const all = new Set([...(index.allTags || []), ...(index.prefixes || [])]);
    for (const t of all) {
      if (depth === 0) {
        // top-level segment
        const head = t.split(':')[0];
        if (head) out.add(head);
        continue;
      }
      if (!t.startsWith(needle + ':')) continue;
      const rest = t.slice(needle.length + 1).split(':')[0];
      if (rest) out.add(needle + ':' + rest);
    }
    return Array.from(out).sort();
  }

  window.LIBRARY_TAGS = {
    normalize,
    parse,
    getTags,
    setTags,
    matchPrefix,
    filterItems,
    buildIndex,
    suggestions,
    children,
  };
})();
