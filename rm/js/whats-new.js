/* ================================================================
   whats-new.js — Release history + admin release broadcast (V3.604)
   ================================================================
   Read side (any lab member): lists the `releases` collection newest
   first — the catch-up surface every release notification links to.

   Write side (admin only): compose card that POSTs to the
   releaseAnnounce Cloud Function, which records the release AND
   pushes one notification to every lab member. The send button is
   gated on a GET health probe so this page ships safely before
   `firebase deploy --only functions:releaseAnnounce` (same pattern
   as the equation OCR button).

   Workflow (see CLAUDE.md "Release batching"): small changes collect
   in CodeLog/Updates/PENDING_RELEASE.md; at 5+ entries or on Alex's
   "push", the pending list is pasted here and sent as one batch.
   ================================================================ */

(function () {
  'use strict';

  var ANNOUNCE_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/releaseAnnounce';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ─── Release history ─────────────────────────────────── */

  function fmtDate(ts) {
    try {
      var d = ts && ts.toDate ? ts.toDate() : null;
      if (!d) return '';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) { return ''; }
  }

  async function loadReleases() {
    var host = $('wn-list');
    var snap;
    try {
      snap = await firebridge.db().collection('releases')
        .orderBy('sentAt', 'desc').limit(50).get();
    } catch (e) {
      host.innerHTML = '<div class="empty-state">Could not load releases: ' + esc(e.message || e) + '</div>';
      return;
    }
    if (snap.empty) {
      host.innerHTML = '<div class="empty-state">No releases announced yet — the first batch will appear here.</div>';
      return;
    }
    var admin = firebridge.isAdmin && firebridge.isAdmin();
    var html = '';
    snap.forEach(function (doc) {
      var r = doc.data() || {};
      html +=
        '<div class="wn-release" data-id="' + esc(doc.id) + '">' +
          '<div class="wn-release-head">' +
            '<span class="wn-version">v' + esc(r.version || '?') + '</span>' +
            '<span class="wn-title">' + esc(r.title || 'App update') + '</span>' +
            '<span class="wn-date">' + esc(fmtDate(r.sentAt)) +
              (admin ? ' <button class="wn-del" title="Delete this announcement">' + ICON.svg('x-mark') + '</button>' : '') +
            '</span>' +
          '</div>' +
          (r.summary ? '<div class="wn-summary">' + esc(r.summary) + '</div>' : '') +
          /* The phone app bundles the web tree at build time, so app users
             only have these changes once they install the named build. */
          (r.appBuild
            ? '<div class="wn-appnote">' + ICON.svg('device-phone-mobile') + ' In the phone app from <strong>build ' +
              esc(r.appBuild) + '</strong>' +
              (r.appVersion ? ' (' + esc(r.appVersion) + ')' : '') +
              ' — update from TestFlight if you don\'t see it.</div>'
            : '') +
          (Array.isArray(r.changes) && r.changes.length
            ? '<ul class="wn-changes">' + r.changes.map(function (c) {
                return '<li>' + esc(c) + '</li>';
              }).join('') + '</ul>'
            : '') +
        '</div>';
    });
    host.innerHTML = html;

    host.querySelectorAll('.wn-del').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var row = btn.closest('.wn-release');
        var id = row && row.getAttribute('data-id');
        if (!id) return;
        if (!confirm('Delete this announcement from the history? (Already-sent notifications are not recalled.)')) return;
        try {
          await firebridge.db().collection('releases').doc(id).delete();
          row.remove();
        } catch (e) {
          if (window.TOAST) TOAST.error('Delete failed: ' + (e.message || e));
        }
      });
    });
  }

  /* ─── Admin compose ───────────────────────────────────── */

  /* Pending-ledger lines paste in verbatim, so strip the bookkeeping a lab
     member shouldn't read: list markers, bold markers, the leading
     "[V3.604]" version tag (the release already shows its version), and a
     trailing "*(2026-07-31)*" authoring date. */
  function parseChanges(text) {
    return String(text || '').split('\n')
      .map(function (line) {
        return line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '')
                   .replace(/\*\*/g, '')
                   .replace(/^\s*\[[Vv][\d.]+\]\s*/, '')
                   .replace(/\s*\*?\(\d{4}-\d{2}-\d{2}\)\*?\s*$/, '')
                   .trim();
      })
      .filter(Boolean);
  }

  function setStatus(msg, cls) {
    var el = $('wn-status');
    el.textContent = msg || '';
    el.className = 'wn-status' + (cls ? ' ' + cls : '');
  }

  async function initCompose() {
    $('wn-compose').style.display = '';
    var btn = $('wn-send');

    /* Health probe — disable send until the function is deployed. */
    btn.disabled = true;
    setStatus('Checking announce service…');
    var alive = await fetch(ANNOUNCE_URL, { method: 'GET' })
      .then(function (r) { return r.ok; }).catch(function () { return false; });
    if (!alive) {
      setStatus('releaseAnnounce function not deployed yet — run: firebase deploy --only functions:releaseAnnounce', 'err');
      return;
    }
    btn.disabled = false;
    setStatus('');

    btn.addEventListener('click', async function () {
      var version = $('wn-version').value.trim().replace(/^v/i, '');
      var title = $('wn-title').value.trim();
      var summary = $('wn-summary').value.trim();
      var appBuild = $('wn-appbuild').value.trim();
      var appVersion = $('wn-appversion').value.trim();
      var changes = parseChanges($('wn-changes').value);

      if (!version) { setStatus('Version is required.', 'err'); return; }
      if (!summary && changes.length === 0) { setStatus('Add a summary or at least one change.', 'err'); return; }

      var n = changes.length;
      if (!confirm('Announce v' + version + ' (' + n + ' change' + (n === 1 ? '' : 's') + ')?\n\nThis notifies EVERY lab member.')) return;

      btn.disabled = true;
      setStatus('Sending…');
      try {
        var user = firebase.auth().currentUser;
        var tok = user ? await user.getIdToken() : '';
        var resp = await fetch(ANNOUNCE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + tok,
          },
          body: JSON.stringify({
            version: version, title: title, summary: summary, changes: changes,
            appVersion: appVersion, appBuild: appBuild,
          }),
        });
        var j = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !j.ok) throw new Error(j.error || ('announce failed (' + resp.status + ')'));
        setStatus('Sent — ' + j.pushed + ' push(es) across ' + j.recipients + ' member(s).', 'ok');
        $('wn-version').value = ''; $('wn-title').value = '';
        $('wn-summary').value = ''; $('wn-changes').value = '';
        $('wn-appbuild').value = ''; $('wn-appversion').value = '';
        loadReleases();
      } catch (e) {
        setStatus('Failed: ' + (e.message || e), 'err');
      }
      btn.disabled = false;
    });
  }

  /* ─── Boot ────────────────────────────────────────────── */

  var _booted = false;
  document.addEventListener('DOMContentLoaded', function () {
    // onAuth re-fires on profile updates — boot exactly once per signed-in load.
    firebridge.onAuth(async function (user) {
      if (!user) {
        $('wn-list').innerHTML = '<div class="empty-state">Sign in to see release notes.</div>';
        return;
      }
      if (_booted) return;
      _booted = true;
      loadReleases();
      if (firebridge.isAdmin && firebridge.isAdmin()) initCompose();
    });
  });
})();
