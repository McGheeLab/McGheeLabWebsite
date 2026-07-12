/* section-comments.js — V3.157
 *
 * Threaded comments helper. Generic over (collectionPath, scopeKey) so any
 * page can drop a "💬 conversation" pane onto any data block. Used by PMR
 * to add admin↔student conversation on every section (barriers, weekly
 * entries, project overview, paper-writing, discussion cards).
 *
 * Design lift from rm/js/paper-editor.js:1901-2047 (paper-block comments).
 * Differences:
 *   - the parent is a Firestore *path* (caller-supplied), not hardcoded to
 *     papers/{paperId}/comments
 *   - scopeKey is a free-form filter object: callers pick which fields
 *     scope a thread (e.g. {section_id, target_id})
 *   - parentId-based reply threading is rendered (paper-editor's UI flat-
 *     listed; here we indent one level)
 *
 * Public API (window.SECTION_COMMENTS):
 *   mount(opts)   — attach a comment pane to an element
 *     opts: {
 *       container: HTMLElement,           // where the pane lives
 *       collectionPath: string,           // e.g. 'userData/abc/pmr/2025-fall/comments'
 *       scope: { [field]: value, ... },   // every comment carries these fields
 *       label: string,                    // shown in the heading row
 *       canPost: boolean (default true),  // hide reply input if false
 *     }
 *     returns: { unmount: function }
 */

(function () {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function _whenStr(ts) {
    if (!ts) return '';
    if (ts.toDate) return ts.toDate().toISOString().slice(0, 16).replace('T', ' ');
    if (typeof ts === 'string') return ts.slice(0, 16).replace('T', ' ');
    return '';
  }

  // Build the Firestore reference for a given path string. Splits on '/'
  // and alternates collection/doc — paths must have an odd number of
  // segments to land on a collection (e.g. userData/abc/pmr/X/comments).
  function _refForCollectionPath(db, path) {
    var parts = path.split('/').filter(Boolean);
    if (parts.length % 2 !== 1) {
      throw new Error('[section-comments] collectionPath must have odd segment count: ' + path);
    }
    var ref = db.collection(parts[0]);
    for (var i = 1; i < parts.length; i++) {
      if (i % 2 === 1) ref = ref.doc(parts[i]);
      else            ref = ref.collection(parts[i]);
    }
    return ref;
  }

  // Match a comment doc against the caller's scope object. Used because we
  // can't always combine multiple where-clauses without a Firestore index;
  // we run one scoped where-clause server-side and filter the rest in JS.
  function _scopeMatches(commentData, scope) {
    if (!scope) return true;
    var keys = Object.keys(scope);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var want = scope[k];
      var got = commentData[k];
      // Nullable target_id: scope null/undefined matches comments where the
      // field is absent OR explicitly null.
      if (want == null) {
        if (got != null) return false;
      } else if (got !== want) {
        return false;
      }
    }
    return true;
  }

  function _buildCard(comment, opts, callbacks) {
    var card = document.createElement('div');
    card.className = 'sc-comment' + (comment.resolved ? ' sc-resolved' : '');
    card.style.cssText =
      'background:#fafaf9;border:1px solid #e7e5e4;border-radius:6px;' +
      'padding:6px 8px;font-size:12px;color:#1f2937;' +
      (comment.resolved ? 'opacity:0.6;' : '');

    var meta = document.createElement('div');
    meta.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#6b7280;margin-bottom:2px';
    var who = document.createElement('span');
    who.style.fontWeight = '600';
    who.textContent = comment.authorName || comment.authorUid || 'Unknown';
    var when = document.createElement('span');
    when.textContent = _whenStr(comment.createdAt);
    meta.appendChild(who);
    meta.appendChild(when);
    card.appendChild(meta);

    var body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;line-height:1.4';
    body.textContent = comment.body || '';
    card.appendChild(body);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;margin-top:4px';

    function _btn(label, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title || '';
      b.style.cssText = 'font-size:10px;padding:2px 6px;border:1px solid #e5e7eb;border-radius:3px;background:#fff;cursor:pointer;color:#374151';
      return b;
    }

    if (opts.canPost !== false && opts.canReply !== false) {
      var replyBtn = _btn('↩ reply', 'Reply to this comment');
      replyBtn.addEventListener('click', function () { callbacks.onReply(comment); });
      actions.appendChild(replyBtn);
    }

    var user = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    var isAuthor = user && user.uid === comment.authorUid;
    var isAdmin  = (typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin());

    var resolveBtn = _btn(comment.resolved ? '↺ reopen' : '✓ resolve');
    resolveBtn.addEventListener('click', function () { callbacks.onResolve(comment); });
    actions.appendChild(resolveBtn);

    if (isAuthor || isAdmin) {
      var delBtn = _btn('✕', 'Delete comment');
      delBtn.style.color = '#dc2626';
      delBtn.addEventListener('click', function () {
        if (window.confirm('Delete this comment?')) callbacks.onDelete(comment);
      });
      actions.appendChild(delBtn);
    }

    card.appendChild(actions);
    return card;
  }

  function mount(opts) {
    if (!opts || !opts.container || !opts.collectionPath) {
      throw new Error('[section-comments] mount requires container + collectionPath');
    }
    if (typeof firebridge === 'undefined') {
      console.warn('[section-comments] firebridge not loaded');
      return { unmount: function () {} };
    }

    var pane = document.createElement('div');
    pane.className = 'sc-pane';
    pane.style.cssText =
      'margin-top:8px;padding:8px 10px;border:1px solid #e5e7eb;border-left:3px solid #c7d2fe;' +
      'border-radius:6px;background:#f8fafc';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#475569;margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px;font-weight:600';
    var heading = document.createElement('span');
    heading.textContent = opts.label || 'Discussion';
    head.appendChild(heading);
    var count = document.createElement('span');
    count.style.cssText = 'font-size:10px;color:#9ca3af;font-weight:500;text-transform:none';
    head.appendChild(count);
    pane.appendChild(head);

    var listEl = document.createElement('div');
    listEl.style.cssText = 'display:grid;gap:6px;margin-bottom:6px';
    pane.appendChild(listEl);

    var inputWrap = document.createElement('div');
    inputWrap.style.cssText = 'display:grid;gap:4px';
    var replyToBanner = document.createElement('div');
    replyToBanner.style.cssText = 'font-size:10px;color:#6366f1;display:none';
    inputWrap.appendChild(replyToBanner);
    var ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Add a comment… (⌘/Ctrl+Enter to post)';
    ta.style.cssText = 'font-size:12px;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-family:inherit;resize:vertical;min-height:36px;width:100%;box-sizing:border-box';
    inputWrap.appendChild(ta);
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;align-items:center';
    var statusEl = document.createElement('span');
    statusEl.style.cssText = 'font-size:10px;color:#9ca3af;flex:1';
    btnRow.appendChild(statusEl);
    var clearReplyBtn = document.createElement('button');
    clearReplyBtn.type = 'button';
    clearReplyBtn.textContent = '↺ cancel reply';
    clearReplyBtn.style.cssText = 'font-size:11px;padding:3px 8px;border:1px solid #e5e7eb;border-radius:4px;background:#fff;cursor:pointer;display:none';
    btnRow.appendChild(clearReplyBtn);
    var postBtn = document.createElement('button');
    postBtn.type = 'button';
    postBtn.textContent = 'Post';
    postBtn.style.cssText = 'font-size:11px;padding:3px 10px;border:1px solid #2563eb;border-radius:4px;background:#2563eb;color:#fff;cursor:pointer;font-weight:500';
    btnRow.appendChild(postBtn);
    inputWrap.appendChild(btnRow);
    if (opts.canPost === false) inputWrap.style.display = 'none';
    pane.appendChild(inputWrap);

    opts.container.appendChild(pane);

    /* ── Subscribe ─────────────────────────────────────────── */
    var db = firebridge.db();
    var collRef = _refForCollectionPath(db, opts.collectionPath);
    // Single orderBy query — no where-clause — to avoid needing a Firestore
    // composite index for every (section_id, createdAt) combination. PMR
    // comments per period are small (rarely >100 per period across all
    // sections), so filtering client-side is the right trade-off. If
    // volumes ever climb, add a composite index on section_id+createdAt and
    // re-introduce the where filter here.
    var query = collRef.orderBy('createdAt', 'asc');

    var docs = [];
    var replyTo = null;

    function _renderList() {
      listEl.innerHTML = '';
      var matched = docs.filter(function (d) { return _scopeMatches(d, opts.scope); });
      var open = matched.filter(function (d) { return !d.resolved; }).length;
      count.textContent = matched.length
        ? (open + ' open' + (matched.length > open ? ' / ' + matched.length + ' total' : ''))
        : '';
      if (!matched.length) {
        var empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:#9ca3af;padding:6px 0;font-style:italic';
        empty.textContent = 'No comments yet — start the conversation.';
        listEl.appendChild(empty);
        return;
      }
      // Roots first, then replies under their parent (one level of indent).
      var byParent = {};
      matched.forEach(function (d) {
        var p = d.parentId || '_root';
        (byParent[p] = byParent[p] || []).push(d);
      });
      function _emit(parentKey, depth) {
        (byParent[parentKey] || []).forEach(function (c) {
          var card = _buildCard(c, opts, {
            onReply:   function (parent) { _setReplyTo(parent); },
            onResolve: function (cm) { _resolve(cm); },
            onDelete:  function (cm) { _delete(cm); },
          });
          card.style.marginLeft = (depth * 14) + 'px';
          listEl.appendChild(card);
          _emit(c.id, depth + 1);
        });
      }
      _emit('_root', 0);
    }

    function _setReplyTo(comment) {
      replyTo = comment;
      replyToBanner.textContent = 'Replying to ' + (comment.authorName || comment.authorUid || 'comment');
      replyToBanner.style.display = '';
      clearReplyBtn.style.display = '';
      ta.focus();
    }
    function _clearReplyTo() {
      replyTo = null;
      replyToBanner.style.display = 'none';
      clearReplyBtn.style.display = 'none';
    }
    clearReplyBtn.addEventListener('click', _clearReplyTo);

    var unsub = query.onSnapshot(function (snap) {
      docs = snap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      _renderList();
    }, function (err) {
      console.warn('[section-comments] subscribe error:', err && err.message);
      statusEl.textContent = 'live sync failed';
    });

    /* ── Post ──────────────────────────────────────────────── */
    function _post() {
      var body = (ta.value || '').trim();
      if (!body) return;
      var user = firebridge.getUser && firebridge.getUser();
      if (!user) { statusEl.textContent = 'sign in to comment'; return; }
      var profile = (firebridge.getProfile && firebridge.getProfile()) || {};
      var ts = firebase.firestore.FieldValue.serverTimestamp();
      var payload = Object.assign({}, opts.scope || {}, {
        body: body,
        authorUid:  user.uid,
        authorName: profile.name || user.displayName || user.email || user.uid,
        parentId:   replyTo ? replyTo.id : null,
        createdAt:  ts,
        modifiedAt: ts,
        resolved:   false,
      });
      statusEl.textContent = 'posting…';
      postBtn.disabled = true;
      collRef.add(payload).then(function () {
        ta.value = '';
        _clearReplyTo();
        statusEl.textContent = '';
        postBtn.disabled = false;
      }).catch(function (err) {
        console.error('[section-comments] post failed:', err);
        statusEl.textContent = 'post failed: ' + (err.message || 'check rules');
        postBtn.disabled = false;
      });
    }
    postBtn.addEventListener('click', _post);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); _post(); }
    });

    function _resolve(comment) {
      var ts = firebase.firestore.FieldValue.serverTimestamp();
      collRef.doc(comment.id).update({
        resolved: !comment.resolved,
        modifiedAt: ts,
      }).catch(function (err) { console.warn('[section-comments] resolve failed:', err.message); });
    }
    function _delete(comment) {
      collRef.doc(comment.id).delete()
        .catch(function (err) { console.warn('[section-comments] delete failed:', err.message); });
    }

    return {
      unmount: function () {
        try { unsub(); } catch (_) {}
        if (pane.parentNode) pane.parentNode.removeChild(pane);
      },
    };
  }

  window.SECTION_COMMENTS = { mount: mount };
})();
