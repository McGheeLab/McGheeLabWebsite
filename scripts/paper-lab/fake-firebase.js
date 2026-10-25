/* fake-firebase.js — an in-memory stand-in for the Firebase compat SDK
 * (app / auth / firestore / storage) so the REAL paper writer pages run on
 * this computer with no Firebase project at all (Paper Lab, V3.906).
 *
 * Loaded by scripts/paper-lab/serve.py in place of the four gstatic
 * firebase-*-compat.js tags. The database lives in memory and is persisted
 * to the Paper Lab workspace through the local server:
 *   GET  /paper-lab/api/db            → whole database (synchronous XHR at load)
 *   POST /paper-lab/api/doc           → {path, data|null} one document write
 *   POST /paper-lab/storage/<path>    → object bytes; served back at the same URL
 *
 * Coverage is what RM's paper pages use: collection/doc refs, where /
 * orderBy / limit / startAfter queries, get / set(merge) / update (dotted
 * paths) / delete / add, onSnapshot (doc + query, with docChanges), batch,
 * runTransaction, collectionGroup, FieldValue (serverTimestamp, arrayUnion,
 * arrayRemove, delete, increment), Timestamp; auth with one signed-in admin;
 * storage put / putString / getDownloadURL / getMetadata / delete.
 * Anything else throws loudly so a gap is visible, not silent.
 */
(function () {
  'use strict';

  var API = '/paper-lab/api';
  var USER = {
    uid: 'paperlab-admin',
    email: 'paperlab@localhost',
    displayName: 'Paper Lab',
    photoURL: null,
    emailVerified: true,
    providerData: [{ providerId: 'google.com' }],
    getIdToken: function () { return Promise.resolve('paper-lab-local-token'); },
    getIdTokenResult: function () { return Promise.resolve({ token: 'paper-lab-local-token', claims: {} }); },
  };

  /* ── values ───────────────────────────────────────────────── */

  function Timestamp(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds || 0;
  }
  Timestamp.prototype.toMillis = function () { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); };
  Timestamp.prototype.toDate = function () { return new Date(this.toMillis()); };
  Timestamp.prototype.isEqual = function (o) { return o && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; };
  Timestamp.prototype.valueOf = function () { return String(this.toMillis()).padStart(16, '0'); };
  Timestamp.prototype.toJSON = function () { return { __ts: this.toMillis() }; };
  Timestamp.fromMillis = function (ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); };
  Timestamp.fromDate = function (d) { return Timestamp.fromMillis(d.getTime()); };
  Timestamp.now = function () { return Timestamp.fromMillis(Date.now()); };

  function Sentinel(kind, arg) { this.__sentinel = kind; this.arg = arg; }
  var FieldValue = {
    serverTimestamp: function () { return new Sentinel('ts'); },
    delete: function () { return new Sentinel('delete'); },
    arrayUnion: function () { return new Sentinel('union', Array.prototype.slice.call(arguments)); },
    arrayRemove: function () { return new Sentinel('remove', Array.prototype.slice.call(arguments)); },
    increment: function (n) { return new Sentinel('inc', n); },
  };
  var DOC_ID = { __docId: true };
  var FieldPath = { documentId: function () { return DOC_ID; } };

  function revive(v) {
    if (v && typeof v === 'object') {
      if (typeof v.__ts === 'number' && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
      if (Array.isArray(v)) return v.map(revive);
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = revive(v[k]); });
      return o;
    }
    return v;
  }
  function clone(v) {
    if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof Date) return Timestamp.fromDate(v);
    if (v instanceof Uint8Array) return v.slice();
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object' && !(v instanceof Sentinel)) {
      var o = {};
      Object.keys(v).forEach(function (k) { if (v[k] !== undefined) o[k] = clone(v[k]); });
      return o;
    }
    return v;
  }
  function eq(a, b) {
    if (a instanceof Timestamp && b instanceof Timestamp) return a.isEqual(b);
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function applySentinel(cur, s) {
    switch (s.__sentinel) {
      case 'ts': return Timestamp.now();
      case 'union': {
        var arr = Array.isArray(cur) ? cur.slice() : [];
        s.arg.forEach(function (x) { if (!arr.some(function (y) { return eq(x, y); })) arr.push(clone(x)); });
        return arr;
      }
      case 'remove': {
        var a2 = Array.isArray(cur) ? cur : [];
        return a2.filter(function (y) { return !s.arg.some(function (x) { return eq(x, y); }); });
      }
      case 'inc': return (typeof cur === 'number' ? cur : 0) + s.arg;
    }
    return cur;
  }
  /* Resolve sentinels in a (possibly nested) value against the current value. */
  function resolveValue(cur, v) {
    if (v instanceof Sentinel) return v.__sentinel === 'delete' ? undefined : applySentinel(cur, v);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Uint8Array)) {
      var o = {};
      Object.keys(v).forEach(function (k) {
        var r = resolveValue(cur && typeof cur === 'object' ? cur[k] : undefined, v[k]);
        if (r !== undefined) o[k] = r;
      });
      return o;
    }
    return clone(v);
  }
  function deepMerge(target, src) {
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v instanceof Sentinel) {
        if (v.__sentinel === 'delete') delete target[k];
        else target[k] = applySentinel(target[k], v);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) &&
                 !(v instanceof Uint8Array)) {
        if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
        deepMerge(target[k], v);
      } else if (v !== undefined) {
        target[k] = clone(v);
      }
    });
    return target;
  }
  function getField(data, path) {
    if (path === DOC_ID) return undefined;
    var parts = String(path).split('.');
    var cur = data;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function setField(data, path, value) {
    var parts = String(path).split('.');
    var cur = data;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    var last = parts[parts.length - 1];
    if (value instanceof Sentinel) {
      if (value.__sentinel === 'delete') delete cur[last];
      else cur[last] = applySentinel(cur[last], value);
    } else {
      cur[last] = resolveValue(cur[last], value);
    }
  }

  /* ── store ────────────────────────────────────────────────── */

  var store = {};          // docPath → data
  (function load() {
    try {
      var x = new XMLHttpRequest();
      x.open('GET', API + '/db', false);
      x.send(null);
      if (x.status === 200) store = revive(JSON.parse(x.responseText || '{}')) || {};
    } catch (e) { console.warn('[fake-firebase] db load failed', e); }
  })();

  var pending = {};
  var flushTimer = null;
  function persist(path) {
    pending[path] = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 30);
  }
  function flush() {
    flushTimer = null;
    var paths = Object.keys(pending);
    pending = {};
    if (!paths.length) return;
    var body = JSON.stringify(paths.map(function (p) { return { path: p, data: store[p] === undefined ? null : store[p] }; }));
    try {
      var x = new XMLHttpRequest();
      x.open('POST', API + '/docs', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(body);
    } catch (e) { console.warn('[fake-firebase] persist failed', e); }
  }
  window.addEventListener('beforeunload', function () {
    var paths = Object.keys(pending);
    if (!paths.length) return;
    var body = JSON.stringify(paths.map(function (p) { return { path: p, data: store[p] === undefined ? null : store[p] }; }));
    try { navigator.sendBeacon(API + '/docs', new Blob([body], { type: 'application/json' })); } catch (e) {}
  });

  function norm(p) { return String(p || '').replace(/^\/+|\/+$/g, ''); }
  function segs(p) { return norm(p).split('/').filter(Boolean); }
  function autoId() {
    var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', s = '';
    for (var i = 0; i < 20; i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  }

  /* ── listeners ────────────────────────────────────────────── */

  var listeners = [];      // {kind:'doc'|'query', path|query, cb, err, last}
  var notifyScheduled = false;
  function scheduleNotify() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    setTimeout(function () {
      notifyScheduled = false;
      listeners.slice().forEach(fire);
    }, 0);
  }
  function fire(l) {
    if (l.dead) return;
    try {
      if (l.kind === 'doc') {
        var d = store[l.path];
        var sig = d === undefined ? '∅' : JSON.stringify(d);
        if (sig === l.lastSig) return;
        l.lastSig = sig;
        l.cb(new DocSnapshot(new DocRef(l.path), d));
      } else {
        var docs = runQuery(l.query);
        var sig2 = JSON.stringify(docs.map(function (x) { return [x.path, store[x.path]]; }));
        if (sig2 === l.lastSig) return;
        var prev = l.lastDocs || [];
        l.lastSig = sig2;
        var snap = new QuerySnapshot(l.query, docs, prev);
        l.lastDocs = docs.map(function (x) { return { path: x.path, sig: JSON.stringify(store[x.path]) }; });
        l.cb(snap);
      }
    } catch (e) {
      console.error('[fake-firebase] listener error', e);
      if (l.err) try { l.err(e); } catch (e2) {}
    }
  }

  /* ── snapshots ────────────────────────────────────────────── */

  var META = { hasPendingWrites: false, fromCache: false, isEqual: function () { return true; } };
  function DocSnapshot(ref, data) {
    this.ref = ref; this.id = ref.id; this.exists = data !== undefined;
    this._data = data; this.metadata = META;
  }
  DocSnapshot.prototype.data = function () { return this._data === undefined ? undefined : clone(this._data); };
  DocSnapshot.prototype.get = function (f) { return this._data === undefined ? undefined : clone(getField(this._data, f)); };

  function QuerySnapshot(query, docs, prev) {
    this.query = query;
    this.docs = docs.map(function (r) { return new DocSnapshot(r, store[r.path]); });
    this.size = this.docs.length;
    this.empty = this.size === 0;
    this.metadata = META;
    var prevMap = {};
    (prev || []).forEach(function (p, i) { prevMap[p.path] = { sig: p.sig, i: i }; });
    var changes = [];
    var seen = {};
    this.docs.forEach(function (d, i) {
      seen[d.ref.path] = 1;
      var p = prevMap[d.ref.path];
      if (!p) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
      else if (p.sig !== JSON.stringify(store[d.ref.path])) changes.push({ type: 'modified', doc: d, oldIndex: p.i, newIndex: i });
    });
    Object.keys(prevMap).forEach(function (path) {
      if (!seen[path]) changes.push({ type: 'removed', doc: new DocSnapshot(new DocRef(path), undefined), oldIndex: prevMap[path].i, newIndex: -1 });
    });
    this._changes = changes;
  }
  QuerySnapshot.prototype.forEach = function (fn, thisArg) { this.docs.forEach(fn, thisArg); };
  QuerySnapshot.prototype.docChanges = function () { return this._changes; };

  /* ── queries ──────────────────────────────────────────────── */

  function cmp(a, b) {
    if (a instanceof Timestamp) a = a.toMillis();
    if (b instanceof Timestamp) b = b.toMillis();
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    if (typeof a !== typeof b) return String(typeof a) < String(typeof b) ? -1 : 1;
    return a < b ? -1 : 1;
  }
  function matches(data, id, f) {
    var v = f.field === DOC_ID ? id : getField(data, f.field);
    var x = f.value;
    switch (f.op) {
      case '==': return f.field === DOC_ID ? v === (x && x.id ? x.id : x) : eq(v, x);
      case '!=': return v !== undefined && !eq(v, x);
      case '<': return v !== undefined && cmp(v, x) < 0;
      case '<=': return v !== undefined && cmp(v, x) <= 0;
      case '>': return v !== undefined && cmp(v, x) > 0;
      case '>=': return v !== undefined && cmp(v, x) >= 0;
      case 'array-contains': return Array.isArray(v) && v.some(function (y) { return eq(y, x); });
      case 'array-contains-any': return Array.isArray(v) && v.some(function (y) { return x.some(function (z) { return eq(y, z); }); });
      case 'in': return x.some(function (z) { return f.field === DOC_ID ? v === z : eq(v, z); });
      case 'not-in': return v !== undefined && !x.some(function (z) { return eq(v, z); });
    }
    throw new Error('[fake-firebase] unsupported where op ' + f.op);
  }
  function runQuery(q) {
    var out = [];
    Object.keys(store).forEach(function (path) {
      var s = segs(path);
      if (s.length % 2) return;
      var colPath = s.slice(0, -1).join('/');
      if (q.group) { if (s[s.length - 2] !== q.group) return; }
      else if (colPath !== q.colPath) return;
      var data = store[path];
      for (var i = 0; i < q.filters.length; i++) if (!matches(data, s[s.length - 1], q.filters[i])) return;
      out.push(new DocRef(path));
    });
    if (q.orders.length) {
      out.sort(function (a, b) {
        for (var i = 0; i < q.orders.length; i++) {
          var o = q.orders[i];
          var va = o.field === DOC_ID ? a.id : getField(store[a.path], o.field);
          var vb = o.field === DOC_ID ? b.id : getField(store[b.path], o.field);
          var c = cmp(va, vb);
          if (c) return o.dir === 'desc' ? -c : c;
        }
        return cmp(a.id, b.id);
      });
      // Firestore drops docs missing an orderBy field
      out = out.filter(function (r) {
        return q.orders.every(function (o) { return o.field === DOC_ID || getField(store[r.path], o.field) !== undefined; });
      });
    } else {
      out.sort(function (a, b) { return cmp(a.id, b.id); });
    }
    if (q._startAfter || q._startAt) {
      var cur = q._startAfter || q._startAt;
      var curVals = cur.values;
      var idx = out.findIndex(function (r) {
        if (cur.doc) return r.path === cur.doc.ref.path;
        var c = 0;
        for (var i = 0; i < q.orders.length && i < curVals.length; i++) {
          c = cmp(getField(store[r.path], q.orders[i].field), curVals[i]);
          if (q.orders[i].dir === 'desc') c = -c;
          if (c) break;
        }
        return q._startAfter ? c > 0 : c >= 0;
      });
      if (cur.doc) { if (idx >= 0) out = out.slice(q._startAfter ? idx + 1 : idx); }
      else out = idx >= 0 ? out.slice(idx) : [];
    }
    if (q._endBefore) {
      var e = q._endBefore;
      var ie = out.findIndex(function (r) { return e.doc ? r.path === e.doc.ref.path : cmp(getField(store[r.path], q.orders[0].field), e.values[0]) >= 0; });
      if (ie >= 0) out = out.slice(0, ie);
    }
    if (q._limitToLast) out = out.slice(Math.max(0, out.length - q._limitToLast));
    if (q._limit) out = out.slice(0, q._limit);
    return out;
  }

  function Query(colPath, opts) {
    opts = opts || {};
    this.colPath = colPath;
    this.group = opts.group || null;
    this.filters = opts.filters || [];
    this.orders = opts.orders || [];
    // underscore fields: the plain names are the chainable METHODS
    this._limit = opts.limit || 0;
    this._limitToLast = opts.limitToLast || 0;
    this._startAfter = opts.startAfter || null;
    this._startAt = opts.startAt || null;
    this._endBefore = opts.endBefore || null;
    this.firestore = db;
  }
  function qcopy(q, patch) {
    var o = {
      group: q.group, filters: q.filters.slice(), orders: q.orders.slice(), limit: q._limit,
      limitToLast: q._limitToLast, startAfter: q._startAfter, startAt: q._startAt, endBefore: q._endBefore,
    };
    Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
    var n = Object.create(Object.getPrototypeOf(q));
    Query.call(n, q.colPath, o);
    if (q.id !== undefined) { n.id = q.id; n.path = q.path; n.parent = q.parent; }
    return n;
  }
  function cursor(args) {
    if (args[0] instanceof DocSnapshot) return { doc: args[0] };
    return { values: Array.prototype.slice.call(args) };
  }
  Query.prototype.where = function (field, op, value) { return qcopy(this, { filters: this.filters.concat([{ field: field, op: op, value: value }]) }); };
  Query.prototype.orderBy = function (field, dir) { return qcopy(this, { orders: this.orders.concat([{ field: field, dir: dir || 'asc' }]) }); };
  Query.prototype.limit = function (n) { return qcopy(this, { limit: n }); };
  Query.prototype.limitToLast = function (n) { return qcopy(this, { limitToLast: n }); };
  Query.prototype.startAfter = function () { return qcopy(this, { startAfter: cursor(arguments) }); };
  Query.prototype.startAt = function () { return qcopy(this, { startAt: cursor(arguments) }); };
  Query.prototype.endBefore = function () { return qcopy(this, { endBefore: cursor(arguments) }); };
  Query.prototype.get = function () {
    var self = this;
    return Promise.resolve().then(function () { return new QuerySnapshot(self, runQuery(self), null); });
  };
  Query.prototype.onSnapshot = function (a, b, c) {
    var cb, err;
    if (typeof a === 'function') { cb = a; err = b; }
    else if (a && typeof a.next === 'function') { cb = a.next.bind(a); err = a.error && a.error.bind(a); }
    else { cb = typeof b === 'function' ? b : b && b.next; err = c; }
    var l = { kind: 'query', query: this, cb: cb, err: err, lastSig: null };
    listeners.push(l);
    setTimeout(function () { fire(l); }, 0);
    return function () { l.dead = true; listeners = listeners.filter(function (x) { return x !== l; }); };
  };
  Query.prototype.isEqual = function (o) { return o === this; };

  function CollectionRef(path) {
    Query.call(this, norm(path), {});
    var s = segs(path);
    this.id = s[s.length - 1];
    this.path = norm(path);
    this.parent = s.length > 1 ? new DocRef(s.slice(0, -1).join('/')) : null;
  }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.doc = function (id) { return new DocRef(this.path + '/' + (id || autoId())); };
  CollectionRef.prototype.add = function (data) {
    var r = this.doc();
    return r.set(data).then(function () { return r; });
  };

  function DocRef(path) {
    var s = segs(path);
    if (s.length % 2) throw new Error('[fake-firebase] not a document path: ' + path);
    this.path = norm(path);
    this.id = s[s.length - 1];
    this.firestore = db;
    Object.defineProperty(this, 'parent', { get: function () { return new CollectionRef(s.slice(0, -1).join('/')); } });
  }
  DocRef.prototype.collection = function (sub) { return new CollectionRef(this.path + '/' + norm(sub)); };
  DocRef.prototype.get = function () {
    var self = this;
    return Promise.resolve().then(function () { return new DocSnapshot(self, store[self.path]); });
  };
  DocRef.prototype._set = function (data, opts) {
    var cur = store[this.path];
    if (opts && (opts.merge || opts.mergeFields)) {
      var base = cur ? clone(cur) : {};
      if (opts.mergeFields) {
        opts.mergeFields.forEach(function (f) { setField(base, f, getField(data, f)); });
        store[this.path] = base;
      } else {
        store[this.path] = deepMerge(base, data);
      }
    } else {
      store[this.path] = resolveValue(undefined, data) || {};
    }
    persist(this.path);
    scheduleNotify();
  };
  DocRef.prototype._update = function (args) {
    var cur = store[this.path];
    if (cur === undefined) {
      var e = new Error('No document to update: ' + this.path);
      e.code = 'not-found';
      throw e;
    }
    var next = clone(cur);
    if (typeof args[0] === 'string' || args[0] === DOC_ID) {
      for (var i = 0; i < args.length; i += 2) setField(next, args[i], args[i + 1]);
    } else {
      Object.keys(args[0]).forEach(function (k) { setField(next, k, args[0][k]); });
    }
    store[this.path] = next;
    persist(this.path);
    scheduleNotify();
  };
  DocRef.prototype._delete = function () {
    if (store[this.path] !== undefined) {
      delete store[this.path];
      persist(this.path);
      scheduleNotify();
    }
  };
  DocRef.prototype.set = function (data, opts) { var s = this; return Promise.resolve().then(function () { s._set(data, opts); }); };
  DocRef.prototype.update = function () { var s = this, a = arguments; return Promise.resolve().then(function () { s._update(a); }); };
  DocRef.prototype.delete = function () { var s = this; return Promise.resolve().then(function () { s._delete(); }); };
  DocRef.prototype.onSnapshot = function (a, b, c) {
    var cb, err;
    if (typeof a === 'function') { cb = a; err = b; }
    else if (a && typeof a.next === 'function') { cb = a.next.bind(a); err = a.error && a.error.bind(a); }
    else { cb = typeof b === 'function' ? b : b && b.next; err = c; }
    var l = { kind: 'doc', path: this.path, cb: cb, err: err, lastSig: null };
    listeners.push(l);
    setTimeout(function () { fire(l); }, 0);
    return function () { l.dead = true; listeners = listeners.filter(function (x) { return x !== l; }); };
  };
  DocRef.prototype.isEqual = function (o) { return o && o.path === this.path; };

  function WriteBatch() { this.ops = []; }
  WriteBatch.prototype.set = function (r, d, o) { this.ops.push(function () { r._set(d, o); }); return this; };
  WriteBatch.prototype.update = function (r) { var a = Array.prototype.slice.call(arguments, 1); this.ops.push(function () { r._update(a); }); return this; };
  WriteBatch.prototype.delete = function (r) { this.ops.push(function () { r._delete(); }); return this; };
  WriteBatch.prototype.commit = function () { var ops = this.ops; return Promise.resolve().then(function () { ops.forEach(function (f) { f(); }); }); };

  var db = {
    collection: function (p) { return new CollectionRef(p); },
    doc: function (p) { return new DocRef(p); },
    collectionGroup: function (id) { var q = new Query('', { group: id }); return q; },
    batch: function () { return new WriteBatch(); },
    runTransaction: function (fn) {
      var b = new WriteBatch();
      var tx = {
        get: function (r) { return r.get(); },
        set: function (r, d, o) { b.set(r, d, o); return tx; },
        update: function () { b.update.apply(b, arguments); return tx; },
        delete: function (r) { b.delete(r); return tx; },
      };
      return Promise.resolve(fn(tx)).then(function (res) { return b.commit().then(function () { return res; }); });
    },
    settings: function () {},
    enablePersistence: function () { return Promise.resolve(); },
    enableNetwork: function () { return Promise.resolve(); },
    disableNetwork: function () { return Promise.resolve(); },
    waitForPendingWrites: function () { return Promise.resolve(); },
    terminate: function () { return Promise.resolve(); },
    // test hooks (Paper Lab driver)
    __dump: function () { return store; },
    __flush: flush,
  };

  /* ── auth ─────────────────────────────────────────────────── */

  var authCbs = [];
  var auth = {
    currentUser: USER,
    onAuthStateChanged: function (cb) {
      authCbs.push(cb);
      setTimeout(function () { cb(USER); }, 0);
      return function () { authCbs = authCbs.filter(function (x) { return x !== cb; }); };
    },
    onIdTokenChanged: function (cb) { setTimeout(function () { cb(USER); }, 0); return function () {}; },
    signInWithPopup: function () { return Promise.resolve({ user: USER }); },
    signInWithRedirect: function () { return Promise.resolve(); },
    getRedirectResult: function () { return Promise.resolve({ user: null }); },
    signInWithCredential: function () { return Promise.resolve({ user: USER }); },
    signOut: function () { return Promise.resolve(); },
    setPersistence: function () { return Promise.resolve(); },
    useDeviceLanguage: function () {},
  };
  function GoogleAuthProvider() { this.addScope = function () {}; this.setCustomParameters = function () {}; }
  GoogleAuthProvider.credential = function () { return {}; };

  /* ── storage ──────────────────────────────────────────────── */

  var STORE_URL = '/paper-lab/storage/';
  function StorageRef(path) {
    this.fullPath = norm(path);
    var s = segs(path);
    this.name = s[s.length - 1] || '';
    this.bucket = 'paper-lab';
  }
  StorageRef.prototype.child = function (p) { return new StorageRef((this.fullPath ? this.fullPath + '/' : '') + norm(p)); };
  StorageRef.prototype.getDownloadURL = function () {
    var self = this;
    return fetch(STORE_URL + self.fullPath, { method: 'HEAD' }).then(function (r) {
      if (!r.ok) { var e = new Error('Object not found: ' + self.fullPath); e.code = 'storage/object-not-found'; throw e; }
      return location.origin + STORE_URL + self.fullPath.split('/').map(encodeURIComponent).join('/');
    });
  };
  StorageRef.prototype.getMetadata = function () {
    var self = this;
    return fetch(STORE_URL + self.fullPath, { method: 'HEAD' }).then(function (r) {
      if (!r.ok) { var e = new Error('Object not found'); e.code = 'storage/object-not-found'; throw e; }
      return { fullPath: self.fullPath, name: self.name, size: +(r.headers.get('content-length') || 0), contentType: r.headers.get('content-type'), customMetadata: {} };
    });
  };
  function uploadTask(ref, blobPromise, meta) {
    var snapshot = { ref: ref, bytesTransferred: 0, totalBytes: 0, state: 'running', metadata: meta || {} };
    var p = Promise.resolve(blobPromise).then(function (blob) {
      snapshot.totalBytes = blob.size;
      return fetch(STORE_URL + ref.fullPath, {
        method: 'POST', body: blob,
        headers: { 'Content-Type': (meta && meta.contentType) || blob.type || 'application/octet-stream' },
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('upload failed ' + r.status);
      snapshot.bytesTransferred = snapshot.totalBytes;
      snapshot.state = 'success';
      return snapshot;
    });
    return {
      snapshot: snapshot,
      then: function (a, b) { return p.then(a, b); },
      catch: function (b) { return p.catch(b); },
      on: function (_ev, next, error, complete) {
        if (next && typeof next === 'object') { error = next.error; complete = next.complete; next = next.next; }
        p.then(function (s) { if (next) next(s); if (complete) complete(); }, function (e) { if (error) error(e); });
        return function () {};
      },
      cancel: function () { return false; }, pause: function () {}, resume: function () {},
    };
  }
  StorageRef.prototype.put = function (blob, meta) { return uploadTask(this, blob, meta); };
  StorageRef.prototype.putString = function (str, format, meta) {
    var blob;
    if (format === 'data_url') blob = fetch(str).then(function (r) { return r.blob(); });
    else if (format === 'base64') {
      var bin = atob(str), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      blob = new Blob([arr], { type: (meta && meta.contentType) || 'application/octet-stream' });
    } else blob = new Blob([str], { type: (meta && meta.contentType) || 'text/plain' });
    return uploadTask(this, blob, meta);
  };
  StorageRef.prototype.delete = function () { return fetch(STORE_URL + this.fullPath, { method: 'DELETE' }).then(function () {}); };
  StorageRef.prototype.listAll = function () { return Promise.resolve({ items: [], prefixes: [] }); };
  var storage = {
    ref: function (p) { return new StorageRef(p || ''); },
    refFromURL: function (u) {
      var i = String(u).indexOf(STORE_URL);
      return new StorageRef(i >= 0 ? decodeURIComponent(String(u).slice(i + STORE_URL.length)) : String(u));
    },
  };

  /* ── app ──────────────────────────────────────────────────── */

  var apps = [];
  function firestoreFn() { return db; }
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = FieldPath;
  firestoreFn.Timestamp = Timestamp;
  firestoreFn.Blob = { fromUint8Array: function (u) { return u; } };
  firestoreFn.CACHE_SIZE_UNLIMITED = -1;
  function authFn() { return auth; }
  authFn.GoogleAuthProvider = GoogleAuthProvider;
  authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  function storageFn() { return storage; }
  storageFn.TaskEvent = { STATE_CHANGED: 'state_changed' };

  window.firebase = {
    apps: apps,
    initializeApp: function (cfg) {
      var app = { name: '[DEFAULT]', options: cfg || {}, firestore: firestoreFn, auth: authFn, storage: storageFn };
      apps.push(app);
      return app;
    },
    app: function () { return apps[0]; },
    firestore: firestoreFn,
    auth: authFn,
    storage: storageFn,
    functions: function () {
      return { httpsCallable: function (name) { return function () { return Promise.reject(new Error('[paper-lab] callable ' + name + ' is not available locally')); }; } };
    },
    messaging: function () { throw new Error('[paper-lab] messaging unavailable'); },
    __paperLab: true,
  };
  window.__PAPER_LAB__ = { db: db, user: USER, flush: flush };
})();
