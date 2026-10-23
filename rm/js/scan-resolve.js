/* scan-resolve.js — a scanned string becomes the right thing happening (V3.646)
 *
 * Two jobs, deliberately separated from capture (rm/js/scan.js): turn a raw
 * string into a resolved record, then hand it to whichever surface wants it.
 *
 * THE PIPELINE, and why each step is in this order:
 *   1. normalize()          — uppercase, fold confusables, degrade a URL to its
 *                             last path segment.
 *   2. CODE_RE shape test   — NO FIRESTORE READ. isValid() is a check-DIGIT test
 *                             and accepts a 2-char body, so ~1 in 32 random
 *                             strings passes it; without the shape gate every
 *                             stray barcode in the lab costs a read and ~3% of
 *                             garbage reports as "unknown code" rather than
 *                             "that isn't one of ours".
 *   3. isValid() check char — a mistyped code fails LOUDLY here instead of
 *                             resolving to somebody else's tube. This is the
 *                             whole reason the check character exists, so the
 *                             message names the remedy.
 *   4. ONE getDoc on labels/{CODE} — the doc id IS the code, so any scan of any
 *                             kind costs exactly one read.
 *   5. hydrate the target with a SINGLE-DOC get.
 *
 * ⚠ STEP 5 IS LOAD-BEARING: never hydrate via api.load('inventory/items.json').
 * api-routes.js records that route as 3,481 docs ≈ 1+ MB; on a phone at a bench
 * that is the difference between a 200 ms scan and a 10-second timeout. api.load
 * is for the picker, where the user is already searching.
 *
 * DISPATCH IS A REGISTRY, NOT A CustomEvent. The rm:split:* events look like the
 * precedent but are a different shape — fire-and-forget commands to one known
 * listener. Scan dispatch needs a RETURN VALUE, because "nobody claimed it, so
 * open the item" differs from "the notebook took it". Smuggling that through a
 * mutable detail.handled is the implicit protocol that rots, and it gives you no
 * way to name which surface claimed it, or to offer a choice when two are live
 * (a notebook open in a split pane beside inventory).
 *
 * Global: window.SCAN_RESOLVE
 */
(function () {
  'use strict';

  var CACHE_MS = 5 * 60 * 1000;
  var LS_KEY = 'rm.scan.lastSeen';     // tiny mirror so a basement scan still names the thing
  var LS_MAX = 60;

  var _cache = {};          // code → { at, label, item }
  var _targets = [];        // most-recently-registered first
  var _fixture = null;      // test seam; see _setFixture

  function ID() { return window.LABEL_ID; }
  function db() {
    if (typeof firebridge === 'undefined' || !firebridge.db) throw new Error('Firestore unavailable');
    return firebridge.db();
  }

  /* ── the offline mirror ──────────────────────────────────────────────────
   * Only the LABEL doc (code + kind + ref + title — tiny), never the item. A
   * scan in a basement freezer room with no signal can still say WHAT the tube
   * is, which is most of the value, and it is honest about being stale. */
  function rememberOffline(code, label) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      all[code] = { title: label.title || '', kind: label.target_kind || '', ref: label.target_id || '', at: Date.now() };
      var keys = Object.keys(all);
      if (keys.length > LS_MAX) {
        keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
        keys.slice(0, keys.length - LS_MAX).forEach(function (k) { delete all[k]; });
      }
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) { /* private mode / quota — the mirror is a bonus, never a requirement */ }
  }
  function recallOffline(code) {
    try { return (JSON.parse(localStorage.getItem(LS_KEY) || '{}'))[code] || null; }
    catch (e) { return null; }
  }

  /* ── resolve ─────────────────────────────────────────────────────────── */

  async function resolve(raw, opts) {
    opts = opts || {};
    var id = ID();
    if (!id) return { ok: false, status: 'malformed', code: '', error: 'label-id.js not loaded' };

    var code = id.normalize(raw);
    if (!code) return { ok: false, status: 'malformed', code: code, raw: raw };

    // Shape first — deliberately before any network call.
    if (!id.CODE_RE.test(code)) {
      return { ok: false, status: 'malformed', code: code, raw: raw };
    }
    if (!id.isValid(code)) {
      return { ok: false, status: 'bad-check', code: code, raw: raw };
    }

    var hit = _cache[code];
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return { ok: true, status: hit.label.retired ? 'retired' : 'ok', code: code,
               label: hit.label, item: hit.item, cached: true };
    }

    if (_fixture) return _fromFixture(code);

    var label, item = null;
    try {
      var snap = await db().collection('labels').doc(code).get();
      if (!snap.exists) return { ok: false, status: 'unknown', code: code };
      label = Object.assign({ code: code }, snap.data());
    } catch (e) {
      if (/permission-denied/i.test(e.message || '')) return { ok: false, status: 'denied', code: code };
      var mem = recallOffline(code);
      return { ok: false, status: 'offline', code: code, stale: true, label: mem, error: e.message };
    }

    rememberOffline(code, label);

    if (label.target_id) {
      try {
        // A SINGLE-DOC get. See the warning in the header.
        var coll = label.target_kind === 'location' ? 'inventoryLocations' : 'inventory';
        var t = await db().collection(coll).doc(label.target_id).get();
        if (t.exists) item = Object.assign({ id: label.target_id }, t.data());
      } catch (e) { /* the label still resolves; the target just isn't readable */ }
    }

    _cache[code] = { at: Date.now(), label: label, item: item };
    return { ok: true, status: label.retired ? 'retired' : 'ok', code: code, label: label, item: item };
  }

  function _fromFixture(code) {
    var f = _fixture[code];
    if (!f) return { ok: false, status: 'unknown', code: code };
    if (f.status && f.status !== 'ok') return Object.assign({ ok: false, code: code }, f);
    return { ok: true, status: f.label && f.label.retired ? 'retired' : 'ok', code: code,
             label: f.label || { code: code }, item: f.item || null };
  }

  /* ── surface registry ────────────────────────────────────────────────── */

  function registerTarget(t) {
    if (!t || typeof t.handle !== 'function') throw new Error('a scan target needs handle()');
    _targets.unshift(t);       // most recent wins
    return function off() { _targets = _targets.filter(function (x) { return x !== t; }); };
  }

  /** Targets that will accept this resolution, most-recently-registered first. */
  function candidates(res) {
    return _targets.filter(function (t) {
      try { return typeof t.accepts === 'function' ? !!t.accepts(res) : true; }
      catch (e) { return false; }
    });
  }

  /**
   * Hand a resolution to a surface.
   *   0 accepting → { claimed:false } and the CALLER decides the default, which
   *     differs by environment: desktop navigates to inventory.html?code=…, but
   *     in the app we render in place, because inventory.html is not a tab and
   *     TabRoute.key(forPath:) would return .misc — stranding the user outside
   *     the tab model with no bottom-bar highlight.
   *   1 → call it.
   *   2+ → return them for a chooser. NEVER silently pick.
   */
  function dispatch(res, opts) {
    opts = opts || {};
    var list = candidates(res);
    if (opts.targetId) {
      var only = list.filter(function (t) { return t.id === opts.targetId; });
      if (only.length) list = only;
    }
    if (!list.length) return { claimed: false, choices: [] };
    if (list.length > 1 && !opts.pick) return { claimed: false, choices: list };
    var t = opts.pick ? (list.filter(function (x) { return x.id === opts.pick; })[0] || list[0]) : list[0];
    var out;
    try { out = t.handle(res); } catch (e) {
      return { claimed: false, choices: [], error: e.message, target: t };
    }
    return { claimed: out !== false, target: t, result: out, choices: [] };
  }

  /* ── binding an unknown code ─────────────────────────────────────────── */

  /**
   * Bind a code to a target, race-free.
   *
   * MUST be a transaction, not firebridge.setDoc: that is a mergeable set, so a
   * read-then-set would silently clobber whoever bound the same code a moment
   * earlier. Rules back this up — `create` fires only when the doc does not
   * exist, so the loser's write is judged an `update` and refused — but the
   * transaction is what turns that into a clean retryable error instead of a
   * bare permission-denied.
   */
  async function bind(code, target) {
    var id = ID();
    var norm = id.normalize(code);
    if (!id.isWellFormed(norm)) throw new Error('That is not a valid label code.');
    var me = firebridge.getUser();
    if (!me) throw new Error('Sign in first.');
    var ref = db().collection('labels').doc(norm);

    await db().runTransaction(async function (t) {
      var snap = await t.get(ref);
      if (snap.exists && !snap.data().retired) {
        var e = new Error('That code is already in use — print a new label.');
        e.code = 'taken';
        throw e;
      }
      t.set(ref, {
        code: norm,
        target_kind: target.kind || '',
        target_id: target.refId || null,
        title: target.title || '',
        snapshot: target.snapshot || null,
        ownerUid: target.ownerUid || me.uid,
        ownerInitials: target.ownerInitials || '',
        printedFrom: target.printedFrom || 'rm',
        printedAt: target.printedAt || null,
        boundBy: me.uid,
        boundAt: firebase.firestore.FieldValue.serverTimestamp(),
        retired: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    delete _cache[norm];
    return norm;
  }

  /** Mint a code that is free, reserving it in the same breath. */
  async function mintAndBind(target, tries) {
    var id = ID();
    var n = tries || 8;
    for (var i = 0; i < n; i++) {
      var code = id.mintId();
      try { return await bind(code, target); }
      catch (e) { if (e.code !== 'taken') throw e; }
    }
    throw new Error('Could not find a free label code — try again.');
  }

  /** Human-readable reason, always naming the remedy. */
  function explain(res) {
    switch (res.status) {
      case 'malformed':  return 'That doesn’t look like a lab label code (they read like MG-A7K2X).';
      case 'bad-check':  return 'That code’s check character doesn’t match — re-read the last character.';
      case 'unknown':    return 'This code isn’t linked to anything yet.';
      case 'retired':    return 'This label was retired' + (res.label && res.label.title ? ' (was: ' + res.label.title + ')' : '') + '.';
      case 'denied':     return 'You don’t have access to look that up.';
      case 'offline':    return res.label
        ? 'Offline — last seen as “' + (res.label.title || res.code) + '”.'
        : 'Offline, and this code hasn’t been seen on this device before.';
      default:           return '';
    }
  }

  window.SCAN_RESOLVE = {
    resolve: resolve,
    registerTarget: registerTarget,
    candidates: candidates,
    dispatch: dispatch,
    bind: bind,
    mintAndBind: mintAndBind,
    explain: explain,
    _clearCache: function () { _cache = {}; },
    /* Test seam: the headless harness runs signed out, so labels reads fail.
     * Set a { code: {label,item,status} } map and resolve() serves from it while
     * still exercising normalize → shape → check-char for real. */
    _setFixture: function (m) { _fixture = m; _cache = {}; },
    _targets: function () { return _targets.slice(); },
  };
})();
