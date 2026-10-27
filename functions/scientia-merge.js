/* ================================================================
   scientia-merge.js — V3.932 — two people's edits to one card, kept
   together where they belong
   ================================================================
   Alex: "if both have edited the same block, then the merge will attempt
   to keep the users edits together but in the same context. for example
   if there is a list of items, and there was an edit to the list or an
   addition to the list then those changes are made to that list, but if
   there are non contextual changes then they just go at the end of the
   card." Plan: CodeLog/ClaudesPlan/V3.932_scientia_contextual_merge.md

   A card's text is lines (a list item, a paragraph, a step). Each side's
   edit is worked out against the version both started from (diff3 on
   lines):
     - an edit only one side made goes in where it was made;
     - both sides adding at the same place (two new list items) → both,
       the one already there first;
     - both changing the same lines differently → both versions, one
       after the other, in that place;
     - an edit whose place the other side removed (no context left) →
       the end of the card, under a line saying whose it is.
   With no common version (a computer and the cloud meeting for the first
   time) the lines both hold are the common version, so nothing is lost.
   Marks (structures, terms, cites, formatting: {id, type, from, to})
   follow their lines; one either side removed stays removed.
   ================================================================ */
'use strict';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_CELLS = 4e6;   // LCS table bound; a bigger text is treated as one changed run

/** Longest common subsequence of two line arrays: pairs [i, j]. */
function lcs(a, b) {
  const n = a.length, m = b.length;
  let s = 0; while (s < n && s < m && a[s] === b[s]) s++;
  let e = 0; while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
  const A = a.slice(s, n - e), B = b.slice(s, m - e), out = [];
  for (let i = 0; i < s; i++) out.push([i, i]);
  if (A.length && B.length && A.length * B.length <= MAX_CELLS) {
    const N = A.length, M = B.length, T = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    for (let i = 0, j = 0; i < N && j < M;) { if (A[i] === B[j]) { out.push([s + i, s + j]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) i++; else j++; }
  }
  for (let k = 0; k < e; k++) out.push([n - e + k, m - e + k]);
  return out;
}

/** What `side` did to `base`: hunks {s, e, from, to} — base lines [s, e) became side lines [from, to). Plus the line map. */
function hunks(base, side) {
  const pairs = lcs(base, side), out = [], map = new Map();   // base i → side j for kept lines
  let bi = 0, si = 0;
  for (const [i, j] of pairs.concat([[base.length, side.length]])) {
    if (i > bi || j > si) out.push({ s: bi, e: i, from: si, to: j });
    if (i < base.length) map.set(i, j);
    bi = i + 1; si = j + 1;
  }
  return { hunks: out, map };
}

/**
 * Merge two texts against their common version. Lines are '\n'-separated.
 * Returns { text, lines: [{side, i}] (where each merged line came from: 'base' | 'mine' | 'cur', its index there),
 *           placed: n (edits put in place), together: n (both kept side by side), atEnd: n (lines moved to the end) }.
 */
function mergeLines(baseText, mineText, curText, opts) {
  const o = opts || {}, mine = String(mineText == null ? '' : mineText).split('\n'), cur = String(curText == null ? '' : curText).split('\n');
  let base;
  if (baseText == null) base = lcs(mine, cur).map(([i]) => mine[i]);   // no common version: what both hold is common
  else base = String(baseText).split('\n');
  const M = hunks(base, mine), C = hunks(base, cur);
  const all = M.hunks.map(h => Object.assign({ who: 'mine' }, h)).concat(C.hunks.map(h => Object.assign({ who: 'cur' }, h))).sort((x, y) => x.s - y.s || x.e - y.e);
  // group hunks that touch the same base lines (or insert at the same point)
  const groups = [];
  for (const h of all) {
    const g = groups[groups.length - 1];
    const meets = g && (h.s < g.e || (h.s === g.s && h.e === h.s && g.e === g.s) || (h.s === g.e && h.e === h.s && g.hs.some(x => x.e === x.s && x.s === h.s)));
    if (meets) { g.e = Math.max(g.e, h.e); g.hs.push(h); } else groups.push({ s: h.s, e: h.e, hs: [h] });
  }
  const out = [], atEnd = [], stat = { placed: 0, together: 0, atEnd: 0 };
  const take = (who, from, to) => { const src = who === 'mine' ? mine : cur; for (let k = from; k < to; k++) out.push({ t: src[k], side: who, i: k }); };
  const sideOf = (g, who) => {   // the side's lines for the group's base span [g.s, g.e)
    const hs = g.hs.filter(h => h.who === who), map = who === 'mine' ? M.map : C.map, src = who === 'mine' ? mine : cur, res = [];
    let b = g.s;
    for (const h of hs) { for (; b < h.s; b++) if (map.has(b)) res.push({ t: src[map.get(b)], side: who, i: map.get(b) }); for (let k = h.from; k < h.to; k++) res.push({ t: src[k], side: who, i: k }); b = Math.max(b, h.e); }
    for (; b < g.e; b++) if (map.has(b)) res.push({ t: src[map.get(b)], side: who, i: map.get(b) });
    return res;
  };
  let b = 0;
  for (const g of groups) {
    for (; b < g.s; b++) out.push({ t: base[b], side: 'base', i: b });
    const whos = new Set(g.hs.map(h => h.who));
    if (whos.size === 1) { const who = [...whos][0]; for (const x of sideOf(g, who)) out.push(x); stat.placed++; }
    else {
      const m = sideOf(g, 'mine'), c = sideOf(g, 'cur'), same = m.length === c.length && m.every((x, k) => x.t === c[k].t);
      if (same) { for (const x of c) out.push(x); stat.placed++; }
      else if (!m.length || !c.length) {   // one side removed these lines, the other changed them: no place left for the change
        const kept = m.length ? m : c, base0 = base.slice(g.s, g.e);
        const changed = kept.filter(x => !base0.includes(x.t));
        if (changed.length) { atEnd.push(...kept); stat.atEnd += kept.length; }
      } else {   // both changed the same place: both, side by side — what is already there first, then the other's new lines
        const seen = new Set(c.map(x => x.t));
        for (const x of c) out.push(x);
        for (const x of m) if (!seen.has(x.t)) out.push(x);
        stat.together++;
      }
    }
    b = Math.max(b, g.e);
  }
  for (; b < base.length; b++) out.push({ t: base[b], side: 'base', i: b });
  if (atEnd.length) {
    while (out.length && out[out.length - 1].t === '' && out.length > 1) out.pop();
    out.push({ t: '', side: 'note', i: -1 }, { t: o.endLabel || ((o.mineName || 'The other copy') + '’s edit (its place was removed):'), side: 'note', i: -1 });
    for (const x of atEnd) out.push(x);
  }
  const baseToMine = M.map, baseToCur = C.map;
  return { text: out.map(x => x.t).join('\n'), lines: out, baseToMine, baseToCur, placed: stat.placed, together: stat.together, atEnd: stat.atEnd, clean: !stat.together && !stat.atEnd };
}

/** Offset → [line, column] in a text. */
function lineCol(text, off) {
  const ls = String(text).split('\n'); let p = 0;
  for (let i = 0; i < ls.length; i++) { if (off <= p + ls[i].length) return [i, off - p]; p += ls[i].length + 1; }
  return [ls.length - 1, ls[ls.length - 1].length];
}

/**
 * Merge a {text, marks} body (a card, a note's synthesis). base may be null (no common version).
 * Returns { body, clean } — clean: every edit found its place.
 */
function mergeBody(base, mine, cur, opts) {
  const B = isObj(base) ? base : null, Mn = isObj(mine) ? mine : {}, Cu = isObj(cur) ? cur : {};
  const r = mergeLines(B ? B.text : null, Mn.text, Cu.text, opts);
  // where each side's line landed
  const starts = []; let p = 0; for (const x of r.lines) { starts.push(p); p += x.t.length + 1; }
  const at = { mine: new Map(), cur: new Map() };
  r.lines.forEach((x, k) => {
    if (x.side === 'mine' || x.side === 'cur') { if (!at[x.side].has(x.i)) at[x.side].set(x.i, k); }
    else if (x.side === 'base') { const mj = r.baseToMine.get(x.i), cj = r.baseToCur.get(x.i); if (mj !== undefined) at.mine.set(mj, k); if (cj !== undefined) at.cur.set(cj, k); }
  });
  const moved = (who, text, m) => {
    if (!isObj(m) || typeof m.from !== 'number' || typeof m.to !== 'number') return null;
    const [l0, c0] = lineCol(text, m.from), [l1, c1] = lineCol(text, m.to), a = at[who].get(l0), z = at[who].get(l1);
    if (a === undefined || z === undefined) return null;
    const from = starts[a] + c0, to = starts[z] + c1;
    return to < from ? null : Object.assign({}, m, { from, to });
  };
  const ids = list => new Set((Array.isArray(list) ? list : []).filter(isObj).map(m => m.id).filter(Boolean));
  const was = B ? ids(B.marks) : null, inMine = ids(Mn.marks), inCur = ids(Cu.marks);
  const keep = id => !id || !was || !was.has(id) || (inMine.has(id) && inCur.has(id));   // one either side removed stays removed
  const marks = [], seen = new Set();
  for (const [who, src] of [['cur', Cu], ['mine', Mn]]) for (const m of Array.isArray(src.marks) ? src.marks : []) {
    const id = isObj(m) && m.id; if (id && (seen.has(id) || !keep(id))) continue;
    const x = moved(who, src.text || '', m); if (!x) continue;
    if (id) seen.add(id); else if (marks.some(y => y.type === x.type && y.ref === x.ref && y.from === x.from && y.to === x.to)) continue;
    marks.push(x);
  }
  marks.sort((x, y) => x.from - y.from || x.to - y.to);
  const body = Object.assign({}, Cu, Mn, { text: r.text, marks });
  for (const k of Object.keys(body)) if (k !== 'text' && k !== 'marks') { const v = mergeValue(B ? B[k] : undefined, Mn[k], Cu[k]); if (v.ok) body[k] = v.v; else body[k] = Cu[k]; }
  return { body, clean: r.clean, together: r.together, atEnd: r.atEnd };
}

const isBody = v => isObj(v) && typeof v.text === 'string' && (v.marks === undefined || Array.isArray(v.marks));
const MISSING = undefined;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** A value both changed: {ok, v}. Objects field by field, text bodies by line; anything else is not ok. */
function mergeValue(p, m, c, opts) {
  if (same(m, c) || same(m, p)) return { ok: true, v: c };
  if (same(c, p)) return { ok: true, v: m };
  if (isBody(m) && isBody(c)) { const r = mergeBody(isBody(p) ? p : null, m, c, opts); return { ok: true, v: r.body }; }
  if (typeof m === 'string' && typeof c === 'string' && (m.includes('\n') || c.includes('\n'))) return { ok: true, v: mergeLines(typeof p === 'string' ? p : null, m, c, opts).text };
  if (isObj(m) && isObj(c)) {
    const P = isObj(p) ? p : {}, out = Object.assign({}, c);
    for (const k of new Set([...Object.keys(m), ...Object.keys(c), ...Object.keys(P)])) {
      const r = mergeValue(P[k], m[k], c[k], opts); if (!r.ok) return { ok: false };
      if (r.v === MISSING) delete out[k]; else out[k] = r.v;
    }
    return { ok: true, v: out };
  }
  return { ok: false };
}

/* Fields of a card that are its place on the canvas, not its content: when both moved it, where it is now stays. */
const LAYOUT = new Set(['x', 'y', 'w', 'h', 'z', 'collapsed']);

/**
 * The fields merge3 could not settle on one record, settled where they can be: blocks and notes merge their text by line,
 * a card's place stays where it is, and a card's name both changed goes at the end of the card. Returns
 * { merged, bad } — `bad` the fields still for a person to decide.
 */
function settle(store, prev, mine, cur, merged, bad, opts) {
  const P = isObj(prev) ? prev : {}, out = Object.assign({}, merged), left = [], tail = [];
  for (const k of bad) {
    if (store === 'blocks' && LAYOUT.has(k)) continue;   // stays where it is now
    const r = mergeValue(P[k], mine[k], cur[k], opts);
    if (r.ok) { if (r.v === MISSING) delete out[k]; else out[k] = r.v; continue; }
    if (store === 'blocks' && k === 'label' && typeof mine[k] === 'string' && isBody(out.body)) { if (mine[k].trim()) tail.push((opts && opts.mineName ? opts.mineName + '’s' : 'The other') + ' name for this card: ' + mine[k]); continue; }
    left.push(k);
  }
  if (tail.length) out.body = Object.assign({}, out.body, { text: (out.body.text ? out.body.text.replace(/\n+$/, '') + '\n\n' : '') + tail.join('\n') });
  return { merged: out, bad: left };
}

module.exports = { lcs, hunks, mergeLines, mergeBody, mergeValue, settle, LAYOUT };
