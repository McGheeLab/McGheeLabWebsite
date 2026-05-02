/* api-firestore-adapter.js — routes api.load / api.save to Firestore for migrated paths.
 *
 * The 40+ RM modules call `api.load("tasks/inbox.json")` and `api.save(...)`
 * defined in util.js. This adapter wraps those two methods so that migrated
 * paths transparently read/write Firestore via firebridge while unmigrated
 * paths keep falling through to the existing /api/data/ HTTP endpoints
 * (server.py). Module call sites do NOT change.
 *
 * Migration cutover per path:
 *   1. Add a route here with `shadowJson: true` — saves write Firestore +
 *      legacy JSON; reads come from Firestore but fall back to JSON when
 *      Firestore is empty (handles partially-migrated users).
 *   2. Run a seed/migration script to backfill Firestore from JSON.
 *   3. After ~7 days of clean parity (verify_parity.py), flip
 *      `shadowJson: false` — JSON is dropped, Firestore is the only source.
 *   4. Eventually remove the legacy JSON file and the server.py route.
 *
 * Route descriptor shape:
 *   {
 *     scope:        'lab' | 'user',     // 'user' = under userData/{uid}/
 *     collection?:  string,             // for scope:'lab'  top-level coll name
 *     subcollection?: string,           // for scope:'user' subcoll name
 *     doc?:         string,             // single-doc read; absent = whole coll
 *     wrapKey?:     string,             // top-level JSON key for collection reads
 *     shadowJson?:  boolean,            // dual-write & fallback-read to JSON
 *     orderBy?:     string,             // optional Firestore orderBy field
 *     orderDir?:    'asc' | 'desc',
 *     where?:       [field, op, value], // optional Firestore where clause for
 *                                       // kind-discriminated collections
 *                                       // (e.g. ['type','==','paper'])
 *     discriminator?: { field, value }, // on writes, stamp this field/value on
 *                                       // every row so the route's `where`
 *                                       // filter still matches after migration
 *   }
 *
 * The `wrapKey` exists because every RM JSON file wraps an array under a
 * top-level key (e.g. {"tasks": [...]}). Adapter reads return the same
 * shape so call sites that expect `data.tasks` keep working.
 */

(function () {
  if (typeof api === 'undefined') {
    console.warn('[api-firestore-adapter] api not loaded — adapter inactive.');
    return;
  }
  if (typeof firebridge === 'undefined') {
    console.warn('[api-firestore-adapter] firebridge not loaded — adapter inactive.');
    return;
  }

  /* ── Routing table ──
   * Phase 0: empty. Routes are added incrementally as features migrate.
   * Add via api.registerRoute(path, route) or by editing this object directly. */
  var ROUTES = {};

  /* Preserve the original HTTP-based load/save so migrated paths can still
   * shadow-write to JSON and so call sites can opt out via api.legacy.*
   *
   * On the static deploy (mcgheelab.com/rm/) there is no server.py and the
   * `/api/data/...` endpoints don't exist. Wrap the legacy methods so they
   * resolve to an empty payload instead of letting a 404 cascade back into
   * caller code (which then surfaces "Failed to load X.json" errors that
   * spook users on the deploy). On localhost we keep the real fetches so
   * unmigrated paths keep working when running `python3 server.py`. */
  var _origLegacyLoad = api.load.bind(api);
  var _origLegacySave = api.save.bind(api);
  // Skip the legacy fetch when there's no server.py to back it. The probe
  // below resolves once we know whether /api/data is reachable, and every
  // legacy.load awaits it before deciding. This avoids a Promise.all of
  // unmigrated paths each firing its own 404 before the first response
  // returns to flip a flag.
  var _legacyDisabled = false;
  var _probeDone = (function () {
    if (typeof window === 'undefined') { _legacyDisabled = true; return Promise.resolve(); }
    if (window.RM_RUNTIME && window.RM_RUNTIME.isDeploy) {
      _legacyDisabled = true;
      return Promise.resolve();
    }
    // Localhost: probe a tiny path. Server.py serves /api/data/* — if it
    // returns anything (200/404 with content) we're alive; if the connection
    // fails or the response is HTML 404 from -m http.server, disable legacy.
    return fetch('/api/data/_probe.json', { method: 'GET' })
      .then(function (r) {
        // server.py returns either 200 (file exists) or 404 with JSON body
        // (file not found). -m http.server returns 404 with HTML.
        if (r.ok) return;
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('json') < 0) _legacyDisabled = true;
      })
      .catch(function () { _legacyDisabled = true; });
  })();
  function _shouldSkipLegacy() {
    if (_legacyDisabled) return true;
    if (typeof window !== 'undefined' && window.RM_RUNTIME && window.RM_RUNTIME.isDeploy) return true;
    return false;
  }
  function _emptyLegacyResult(path) {
    // Guess the wrap key from the file name so callers like dashboard.js
    // that do `data.committees` etc. still see an empty array. Without a
    // wrap they get an empty object which most callers also handle.
    var base = path.split('/').pop().replace(/\.json$/, '');
    var out = {};
    out[base] = [];
    return out;
  }
  var _legacy = {
    load: async function (path) {
      // Wait for the probe so unmigrated-path Promise.all calls don't each
      // race a 404 before one of them flips the flag.
      await _probeDone;
      if (_shouldSkipLegacy()) return _emptyLegacyResult(path);
      try {
        return await _origLegacyLoad(path);
      } catch (err) {
        var msg = String(err && err.message || err);
        if (/404/.test(msg)) {
          _legacyDisabled = true;
          return _emptyLegacyResult(path);
        }
        throw err;
      }
    },
    save: async function (path, data) {
      await _probeDone;
      if (_shouldSkipLegacy()) return { ok: true, deploy_skipped: true };
      try {
        return await _origLegacySave(path, data);
      } catch (err) {
        var msg = String(err && err.message || err);
        if (/404|405/.test(msg)) {
          _legacyDisabled = true;
          return { ok: true, deploy_skipped: true };
        }
        throw err;
      }
    },
  };

  function _userScopePath(route) {
    var user = firebridge.getUser && firebridge.getUser();
    if (!user) throw new Error('[adapter] User-scoped route requires sign-in: ' + JSON.stringify(route));
    return 'userData/' + user.uid + '/' + route.subcollection;
  }

  /** True when the route requires a signed-in user but none is present. Caller
   * uses this to short-circuit user-scope reads with empty data instead of
   * falling through to legacy JSON (which would serve pre-migration single-
   * tenant data — a privacy regression). Save/subscribe should still throw
   * since those are user-action paths and the user is expected to be signed
   * in by the time they fire. */
  function _userScopeNotSignedIn(route) {
    if (route.scope !== 'user') return false;
    var user = firebridge.getUser && firebridge.getUser();
    return !user;
  }

  async function _loadFirestore(path, route) {
    if (route.scope === 'lab') {
      if (route.doc) {
        var doc = await firebridge.getDoc(route.collection, route.doc);
        if (route.wrapKey) {
          var out = {};
          out[route.wrapKey] = doc || {};
          return out;
        }
        return doc || {};
      }
      var coll = firebridge.collection(route.collection);
      if (route.where) coll = coll.where(route.where[0], route.where[1], route.where[2]);
      if (route.orderBy) coll = coll.orderBy(route.orderBy, route.orderDir || 'asc');
      var snap = await coll.get();
      var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      var wrap = {};
      wrap[route.wrapKey || route.collection] = rows;
      return wrap;
    }
    if (route.scope === 'user') {
      var basePath = _userScopePath(route);
      if (route.doc) {
        var udoc = await firebridge.db().doc(basePath + '/' + route.doc).get();
        var data = udoc.exists ? Object.assign({ id: udoc.id }, udoc.data()) : null;
        if (route.wrapKey) {
          var out2 = {};
          out2[route.wrapKey] = data || {};
          return out2;
        }
        return data || {};
      }
      var ref = firebridge.db().collection(basePath);
      if (route.where) ref = ref.where(route.where[0], route.where[1], route.where[2]);
      if (route.orderBy) ref = ref.orderBy(route.orderBy, route.orderDir || 'asc');
      var usnap = await ref.get();
      var urows = usnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      var wrap2 = {};
      wrap2[route.wrapKey || route.subcollection] = urows;
      return wrap2;
    }
    throw new Error('[adapter] Unknown route.scope: ' + route.scope);
  }

  /* Save a wrapped array { wrapKey: [...rows] } back to Firestore. Strategy:
   *   - For collection routes, replace the collection contents transactionally
   *     by upserting every row (using row.id when present) and deleting any
   *     server-side doc not in the new payload. This matches the JSON file
   *     replacement semantics that RM modules expect.
   *   - For doc routes, set() the doc directly.
   * Lab-scoped writes will fail unless caller is admin (per firestore.rules).
   */
  async function _saveFirestore(path, route, payload) {
    if (route.scope === 'lab' && route.doc) {
      var docPayload = route.wrapKey ? (payload[route.wrapKey] || payload) : payload;
      await firebridge.setDoc(route.collection, route.doc, docPayload, true);
      return { ok: true };
    }
    if (route.scope === 'user' && route.doc) {
      var basePath = _userScopePath(route);
      var u = (route.wrapKey ? (payload[route.wrapKey] || payload) : payload) || {};
      u.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await firebridge.db().doc(basePath + '/' + route.doc).set(u, { merge: true });
      return { ok: true };
    }
    // Collection-scoped save — full replace using a batch.
    var rows = (route.wrapKey && payload[route.wrapKey]) || payload || [];
    if (!Array.isArray(rows)) {
      throw new Error('[adapter] Collection save expects array under wrapKey "' + route.wrapKey + '"');
    }
    var collPath;
    if (route.scope === 'lab') collPath = route.collection;
    else if (route.scope === 'user') collPath = _userScopePath(route);
    else throw new Error('[adapter] Unknown route.scope on save');

    var collRef = (route.scope === 'lab')
      ? firebridge.collection(collPath)
      : firebridge.db().collection(collPath);

    // When the route has a `where` filter (kind-discriminated collection like
    // `funding` with kinds proposal/award/account), only enumerate the slice
    // owned by THIS route so a "save proposals" doesn't delete awards.
    var existingQuery = collRef;
    if (route.where) existingQuery = existingQuery.where(route.where[0], route.where[1], route.where[2]);
    var existing = await existingQuery.get();
    var seenIds = new Set();
    var dupes = [];
    var stamp = firebase.firestore.FieldValue.serverTimestamp();

    // Build a flat ops list, then commit in chunks. Firestore batches cap at
    // 500 writes per commit; we use 400 to leave headroom and avoid surprises.
    var ops = [];
    rows.forEach(function (row) {
      var id = row.id || (row.slug ? slugify(row.slug) : null);
      if (!id) {
        var newRef = collRef.doc();
        id = newRef.id;
      }
      if (seenIds.has(id)) dupes.push(id);
      seenIds.add(id);
      var clean = Object.assign({}, row);
      delete clean.id;
      clean.updatedAt = stamp;
      if (route.discriminator) clean[route.discriminator.field] = route.discriminator.value;
      ops.push({ kind: 'set', id: id, data: clean });
    });
    existing.docs.forEach(function (d) {
      if (!seenIds.has(d.id)) ops.push({ kind: 'delete', id: d.id });
    });

    var CHUNK = 400;
    for (var i = 0; i < ops.length; i += CHUNK) {
      var batch = firebridge.db().batch();
      var slice = ops.slice(i, i + CHUNK);
      slice.forEach(function (op) {
        if (op.kind === 'set') batch.set(collRef.doc(op.id), op.data, { merge: true });
        else                   batch.delete(collRef.doc(op.id));
      });
      await batch.commit();
    }

    var result = { ok: true, written: seenIds.size, source_rows: rows.length };
    if (dupes.length) {
      result.duplicate_ids = dupes;
      console.warn('[adapter] ' + path + ': ' + dupes.length +
                   ' duplicate id(s) in source — later rows overwrote earlier on merge. Examples:',
                   dupes.slice(0, 5));
    }
    return result;
  }

  function _isEmpty(result, route) {
    if (!result) return true;
    var key = route.wrapKey || route.subcollection || route.collection;
    var val = result[key];
    if (val == null) return true;
    if (Array.isArray(val) && val.length === 0) return true;
    if (typeof val === 'object' && Object.keys(val).length === 0) return true;
    return false;
  }

  api.load = async function (path) {
    var route = ROUTES[path];
    if (!route) return _legacy.load(path);
    // User-scope reads while auth is still resolving must NOT fall back to
    // the legacy JSON — that file is single-tenant and would leak Alex's
    // pre-migration data to a different signed-in user. Return empty and
    // let the caller wait on firebridge.whenAuthResolved() before retrying.
    if (_userScopeNotSignedIn(route)) {
      var emptyKey = route.wrapKey || route.subcollection;
      var empty = {};
      empty[emptyKey] = route.doc ? {} : [];
      return empty;
    }

    // Route-level cache (Phase 9) — when a route declares `cache: {ttlMs}`,
    // we serve from IndexedDB if fresh and refresh in the background when
    // stale. Saves Firestore reads on frequently-loaded shared collections
    // (items, projects, people, etc.) without changing call sites. Cache
    // invalidation: api.save below clears the same key after a successful
    // commit. The user-scoped cache key includes uid (via LOCAL_CACHE.scope's
    // built-in prefixing) so signing in as a different user doesn't see
    // someone else's cached data.
    var cacheHandle = _routeCache(path, route);
    if (cacheHandle) {
      try {
        var cached = await cacheHandle.get();
        if (cached && cached.data != null) {
          if (cached.stale) {
            // Background refresh — don't block the caller.
            _refreshRouteCache(path, route, cacheHandle);
          }
          return cached.data;
        }
      } catch (e) { /* IDB unreachable — fall through to network */ }
    }

    try {
      var result = await _loadFirestore(path, route);
      if (route.shadowJson && _isEmpty(result, route)) {
        // Migration in progress — caller's data may still be in JSON.
        var legacyResult = await _legacy.load(path);
        if (cacheHandle) cacheHandle.put(legacyResult);
        return legacyResult;
      }
      if (cacheHandle) cacheHandle.put(result);
      return result;
    } catch (err) {
      console.warn('[adapter] Firestore load failed for ' + path + ', falling back to JSON:', err.message);
      return _legacy.load(path);
    }
  };

  // Build a cache handle for a route, or null if caching not enabled / IDB
  // not available. Cache key is `route::<path>` — LOCAL_CACHE prefixes it
  // with the user's uid automatically.
  function _routeCache(path, route) {
    if (!route || !route.cache || typeof window === 'undefined' || !window.LOCAL_CACHE) return null;
    var ttl = route.cache.ttlMs || 30 * 60 * 1000; // 30 min default
    return window.LOCAL_CACHE.scope('route::' + path, ttl);
  }

  // Re-fetch a cached route in the background and update IDB. Stale-while-
  // revalidate: return cached immediately, then update for the next page load.
  //
  // Smart refresh: before doing a full re-fetch (which can be N reads for a
  // collection of N docs), do a 1-doc query to find the collection's MAX
  // updatedAt. If that's <= the cached `savedAt`, NOTHING has changed since
  // the cache was written and we can refresh the TTL marker without any
  // additional reads. Major read-cost win on routes that don't change often
  // (important-people, taxonomy, alumni, service activities, etc.). For
  // routes without an updatedAt field or queryable collection (e.g. single
  // -doc lab routes, user-scope subcollections), we fall through to the
  // unconditional refetch — same behavior as before.
  async function _refreshRouteCache(path, route, cacheHandle) {
    try {
      // Try the cheap freshness check first.
      if (await _refreshRouteCacheCheap(path, route, cacheHandle)) {
        return;
      }
    } catch (err) {
      // Cheap check failed — fall through to full refetch.
    }
    try {
      var fresh = await _loadFirestore(path, route);
      if (route.shadowJson && _isEmpty(fresh, route)) fresh = await _legacy.load(path);
      cacheHandle.put(fresh);
    } catch (err) {
      // Network blip — keep the stale cache. Will retry on next call.
    }
  }

  // Returns true when the cheap-freshness path served the request (cache was
  // confirmed fresh and TTL has been bumped via re-put), false when we need
  // to fall back to the full refetch.
  async function _refreshRouteCacheCheap(path, route, cacheHandle) {
    // Single-doc routes have no probe shortcut — re-fetching the single doc
    // costs the same 1 read as a probe would.
    if (route.doc) return false;
    if (route.scope !== 'lab' && route.scope !== 'user') return false;
    // User-scope probes need a signed-in user. Lab-scope is fine either way.
    if (route.scope === 'user' && _userScopeNotSignedIn(route)) return false;

    var entry = await cacheHandle.get();
    if (!entry || entry.data == null) return false;
    var savedAt = entry.savedAt || 0;
    if (!savedAt) return false;

    // 1-doc query for the most-recently-touched doc that this route owns.
    // Cost: 1 Firestore read.
    var ref;
    if (route.scope === 'lab') {
      if (!route.collection) return false;
      ref = firebridge.collection(route.collection);
    } else {
      // user-scope subcollection — userData/{uid}/<subcollection>
      if (!route.subcollection) return false;
      ref = firebridge.db().collection(_userScopePath(route));
    }
    if (route.where) ref = ref.where(route.where[0], route.where[1], route.where[2]);
    var snap = await ref.orderBy('updatedAt', 'desc').limit(1).get();
    if (snap.empty) {
      // Empty collection — cache (an empty result) is still valid.
      await cacheHandle.put(entry.data);
      return true;
    }
    var topUpdatedAt = snap.docs[0].data().updatedAt;
    var topMs = (topUpdatedAt && topUpdatedAt.toMillis) ? topUpdatedAt.toMillis() : 0;

    // If the most recent doc's updatedAt is older than (or equal to) when
    // we cached, NOTHING has changed in this route's slice. Re-put the
    // existing data with a fresh `savedAt` so the next call's TTL window
    // starts from now — effectively "extend the lease" without re-fetching.
    if (topMs && topMs <= savedAt) {
      await cacheHandle.put(entry.data);
      return true;
    }
    return false;
  }

  api.save = async function (path, data) {
    var route = ROUTES[path];
    if (!route) return _legacy.save(path, data);
    var primaryResult = await _saveFirestore(path, route, data);
    if (route.shadowJson) {
      // Fire-and-forget the JSON shadow write so the caller (form, page
      // renderer, live-sync wrap) resolves the moment Firestore commits.
      _legacy.save(path, data).catch(function (err) {
        console.warn('[adapter] Shadow JSON save failed for ' + path + ':', err.message);
      });
    }
    // Invalidate the route cache so the next read sees the fresh data
    // instead of pre-save state.
    var cacheHandle = _routeCache(path, route);
    if (cacheHandle) cacheHandle.clear();
    return primaryResult;
  };

  /* Listener registry — every api.subscribe call gets tracked here so the
   * adapter (or beforeunload) can detach them en masse. RM is multi-page and
   * Firebase auto-detaches listeners when a page unloads, so this is mostly
   * defense-in-depth: SPA-style nav (if it ever lands) won't leak listeners,
   * and any page that wants to reset its own subscriptions on a logical
   * route change can call api.detachByPath(path) without tracking the unsub
   * itself. The wrapped unsubscribe returned to the caller still works
   * exactly the same — calling it removes the listener AND removes the
   * registry entry. */
  var _listeners = []; // entries: { path, raw, attachedAt }
  function _trackListener(path, rawUnsub) {
    var entry = { path: path, raw: rawUnsub, attachedAt: Date.now() };
    _listeners.push(entry);
    return function () {
      try { rawUnsub(); } catch (e) {}
      var i = _listeners.indexOf(entry);
      if (i >= 0) _listeners.splice(i, 1);
    };
  }
  api.detachAll = function () {
    var copy = _listeners.slice();
    _listeners.length = 0;
    copy.forEach(function (e) { try { e.raw(); } catch (err) {} });
  };
  api.detachByPath = function (path) {
    var keep = [];
    _listeners.forEach(function (e) {
      if (e.path === path) { try { e.raw(); } catch (err) {} }
      else keep.push(e);
    });
    _listeners.length = 0;
    keep.forEach(function (e) { _listeners.push(e); });
  };
  api.listListeners = function () {
    return _listeners.map(function (e) {
      return { path: e.path, ageMs: Date.now() - e.attachedAt };
    });
  };
  // Auto-cleanup on page unload (belt-and-suspenders; Firebase already does
  // this, but explicit detach prevents pending callbacks from firing during
  // teardown when DOM nodes the callback references are already gone).
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function () { api.detachAll(); });
  }

  /* Subscribe to live updates for a migrated path. For unmigrated paths,
   * degrades to a one-shot load — caller code that wants live updates
   * should be migrated first.
   * Returns an unsubscribe function. */
  api.subscribe = function (path, callback) {
    var route = ROUTES[path];
    if (!route) {
      _legacy.load(path).then(function (data) { callback(data); }).catch(function (err) {
        console.error('[adapter] subscribe fallback load failed for ' + path + ':', err);
      });
      return function () {};
    }
    var key = route.wrapKey || route.subcollection || route.collection;
    var ref;
    var raw;
    // For single-doc routes the snapshot payload must mirror api.load exactly
    // — load returns doc data UNWRAPPED when no wrapKey is set (so callers can
    // treat the doc itself as the result). Wrapping it under route.subcollection
    // here would silently nest the data one level deeper than load gives, and
    // any subscribe consumer that mirrors load's accessors would read undefined.
    if (route.scope === 'lab' && route.doc) {
      ref = firebridge.db().collection(route.collection).doc(route.doc);
      raw = ref.onSnapshot(function (doc) {
        var data = doc.exists ? doc.data() : {};
        if (route.wrapKey) {
          var w = {}; w[route.wrapKey] = data; callback(w);
        } else {
          callback(data);
        }
      });
      return _trackListener(path, raw);
    }
    if (route.scope === 'user' && route.doc) {
      var udocRef = firebridge.db().doc(_userScopePath(route) + '/' + route.doc);
      raw = udocRef.onSnapshot(function (doc) {
        var data = doc.exists ? Object.assign({ id: doc.id }, doc.data()) : {};
        if (route.wrapKey) {
          var w = {}; w[route.wrapKey] = data; callback(w);
        } else {
          callback(data);
        }
      });
      return _trackListener(path, raw);
    }
    if (route.scope === 'lab') {
      ref = firebridge.collection(route.collection);
    } else {
      ref = firebridge.db().collection(_userScopePath(route));
    }
    if (route.where) ref = ref.where(route.where[0], route.where[1], route.where[2]);
    if (route.orderBy) ref = ref.orderBy(route.orderBy, route.orderDir || 'asc');
    raw = ref.onSnapshot(function (snap) {
      var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      var wrap = {};
      wrap[key] = rows;
      callback(wrap);
    });
    return _trackListener(path, raw);
  };

  /* Public helpers for migration scripts and per-page customization. */
  api.registerRoute = function (path, route) { ROUTES[path] = route; };
  api.unregisterRoute = function (path) { delete ROUTES[path]; };
  api.getRoute = function (path) { return ROUTES[path]; };
  api.listRoutes = function () { return Object.assign({}, ROUTES); };
  api.legacy = _legacy;
})();
