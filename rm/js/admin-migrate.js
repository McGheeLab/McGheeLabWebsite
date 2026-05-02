/* admin-migrate.js — admin-only page that walks the api-routes.js registry
 * and lets the admin migrate each JSON path's contents into Firestore.
 *
 * Browser-side migration runs as the signed-in admin user. The Firestore
 * security rules (lab-write=admin) gate writes per-collection — the page
 * UI doesn't enforce admin; the rules do. We still hide the UI for non-
 * admins to avoid a confusing "everything fails" experience.
 */

(function () {
  var $gate = document.getElementById('mig-gate');
  var $content = document.getElementById('mig-content');
  var $tbodyUser = document.getElementById('mig-tbody-user');
  var $tbodyLab = document.getElementById('mig-tbody-lab');
  var $sharedHeading = document.getElementById('mig-shared-heading');
  var $sharedTable = document.getElementById('mig-table-shared');
  var $log = document.getElementById('mig-log');

  function log(msg, level) {
    var ts = new Date().toLocaleTimeString();
    var line = '[' + ts + '] ' + msg;
    var prefix = level === 'err' ? '❌ ' : level === 'ok' ? '✅ ' : '   ';
    $log.textContent = prefix + line + '\n' + $log.textContent;
  }

  function gateMessage(html) {
    $gate.style.display = '';
    $gate.innerHTML = html;
    $content.style.display = 'none';
  }

  function showContent() {
    $gate.style.display = 'none';
    $content.style.display = '';
  }

  /* ── Per-row state machine ────────────────────────────────── */

  function routeTargetLabel(route) {
    if (route.scope === 'lab' && route.doc) return route.collection + '/' + route.doc;
    if (route.scope === 'lab') {
      var w = route.where ? ' where ' + route.where[0] + '==' + JSON.stringify(route.where[2]) : '';
      return route.collection + w;
    }
    if (route.scope === 'user' && route.doc) return 'userData/{uid}/' + route.subcollection + '/' + route.doc;
    return 'userData/{uid}/' + route.subcollection;
  }

  /* Counts rows in a JSON wrapper object — handles top-level array,
   * top-level wrapKey array, or nested object (returns 1 for "exists"). */
  function jsonRowCount(json, route) {
    if (!json) return 0;
    if (route.doc) return 1; // single-doc routes count as 1
    var key = route.wrapKey;
    if (key && Array.isArray(json[key])) return json[key].length;
    if (Array.isArray(json)) return json.length;
    // Try first array we find
    for (var k in json) {
      if (Array.isArray(json[k])) return json[k].length;
    }
    return 0;
  }

  async function firestoreRowCount(route) {
    if (route.scope === 'lab') {
      if (route.doc) {
        var doc = await firebridge.getDoc(route.collection, route.doc);
        return doc ? 1 : 0;
      }
      var ref = firebridge.collection(route.collection);
      if (route.where) ref = ref.where(route.where[0], route.where[1], route.where[2]);
      var snap = await ref.get();
      return snap.size;
    }
    if (route.scope === 'user') {
      var u = firebridge.getUser && firebridge.getUser();
      if (!u) return null; // not signed in — can't count user data
      var basePath = 'userData/' + u.uid + '/' + route.subcollection;
      if (route.doc) {
        var udoc = await firebridge.db().doc(basePath + '/' + route.doc).get();
        return udoc.exists ? 1 : 0;
      }
      var uref = firebridge.db().collection(basePath);
      if (route.where) uref = uref.where(route.where[0], route.where[1], route.where[2]);
      var usnap = await uref.get();
      return usnap.size;
    }
    return null;
  }

  async function refreshRow(path, tr) {
    var route = api.getRoute(path);
    var jsonCell = tr.querySelector('.col-json');
    var fsCell = tr.querySelector('.col-fs');
    var statusCell = tr.querySelector('.col-status');
    jsonCell.textContent = '…';
    fsCell.textContent = '…';
    statusCell.textContent = '';
    try {
      var jsonData = await api.legacy.load(path);
      var jc = jsonRowCount(jsonData, route);
      jsonCell.textContent = jc;
      tr._jsonData = jsonData;
    } catch (err) {
      jsonCell.textContent = '—';
      tr._jsonData = null;
      statusCell.innerHTML = '<span class="mig-warn">JSON missing</span>';
    }
    try {
      var fc = await firestoreRowCount(route);
      fsCell.textContent = fc == null ? '—' : fc;
      tr._fsCount = fc;
    } catch (err) {
      fsCell.textContent = '—';
      statusCell.innerHTML = '<span class="mig-err">FS read failed: ' + err.message + '</span>';
      return;
    }
    if (statusCell.textContent) return; // existing warning wins
    if (tr._jsonData == null && tr._fsCount === 0) {
      statusCell.innerHTML = '<span class="mig-warn">no data</span>';
    } else if (tr._fsCount > 0 && jsonRowCount(tr._jsonData, route) === tr._fsCount) {
      statusCell.innerHTML = '<span class="mig-ok">in sync</span>';
    } else if (tr._fsCount === 0) {
      statusCell.innerHTML = '<span class="mig-warn">not migrated</span>';
    } else {
      statusCell.innerHTML = '<span class="mig-warn">drift</span>';
    }
  }

  async function migrateRow(path, tr, opts) {
    var route = api.getRoute(path);
    if (!tr._jsonData) {
      log('migrate ' + path + ': no JSON data loaded; refresh first', 'err');
      return;
    }
    var jc = jsonRowCount(tr._jsonData, route);
    if (!opts || !opts.skipConfirm) {
      var prompt = 'Migrate ' + path + ' → ' + routeTargetLabel(route) + '?\n\n' +
                   jc + ' rows from JSON will be written to Firestore. Existing docs in this slice will be ' +
                   'replaced. JSON file is untouched.';
      if (!confirm(prompt)) {
        log('migrate ' + path + ': skipped by user');
        return;
      }
    }
    var btn = tr.querySelector('.btn-migrate');
    btn.disabled = true;
    btn.textContent = 'Migrating…';
    var statusCell = tr.querySelector('.col-status');
    statusCell.innerHTML = '<span class="mig-warn">migrating…</span>';
    try {
      // Bypass shadow JSON write — we're SOURCING from JSON, no need to re-write it.
      // Temporarily swap api.legacy.save with a no-op so the adapter's shadow
      // pass is silent.
      var origSave = api.legacy.save;
      api.legacy.save = async function () { return { ok: true, skipped: 'admin-migrate' }; };
      var result;
      try {
        result = await api.save(path, tr._jsonData);
      } finally {
        api.legacy.save = origSave;
      }
      var summary = jc + ' rows';
      if (result && result.written != null && result.source_rows != null && result.written !== result.source_rows) {
        summary = result.source_rows + ' src → ' + result.written + ' written';
      }
      if (result && result.duplicate_ids && result.duplicate_ids.length) {
        log('migrated ' + path + ' (' + summary + ') → ' + routeTargetLabel(route) +
            '  ⚠ ' + result.duplicate_ids.length + ' duplicate id(s) collapsed: ' +
            result.duplicate_ids.slice(0, 3).join(', ') +
            (result.duplicate_ids.length > 3 ? '…' : ''), 'ok');
      } else {
        log('migrated ' + path + ' (' + summary + ') → ' + routeTargetLabel(route), 'ok');
      }
      await refreshRow(path, tr);
    } catch (err) {
      log('migrate ' + path + ' failed: ' + err.message, 'err');
      statusCell.innerHTML = '<span class="mig-err">failed</span>';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Migrate';
    }
  }

  function buildRow(path) {
    var route = api.getRoute(path);
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="mig-path">' + path + '</td>' +
      '<td class="mig-path">' + routeTargetLabel(route) + (route.shadowJson ? ' <span style="color:#a3a3a3;font-size:11px;">(shadow)</span>' : '') + '</td>' +
      '<td class="mig-num col-json">—</td>' +
      '<td class="mig-num col-fs">—</td>' +
      '<td class="col-status"></td>' +
      '<td>' +
        '<button class="btn" type="button" data-act="refresh">Refresh</button> ' +
        '<button class="btn btn-primary btn-migrate" type="button" data-act="migrate">Migrate</button>' +
      '</td>';
    tr.querySelector('[data-act="refresh"]').addEventListener('click', function () {
      refreshRow(path, tr);
    });
    tr.querySelector('[data-act="migrate"]').addEventListener('click', function () {
      migrateRow(path, tr);
    });
    return tr;
  }

  /* ── Bootstrap ─────────────────────────────────────────────── */

  function allRowTrs() {
    var rows = [];
    for (var i = 0; i < $tbodyUser.children.length; i++) rows.push($tbodyUser.children[i]);
    for (var j = 0; j < $tbodyLab.children.length; j++) rows.push($tbodyLab.children[j]);
    return rows;
  }

  function init() {
    var routes = api.listRoutes ? api.listRoutes() : {};
    var allPaths = Object.keys(routes).sort();
    var userPaths = allPaths.filter(function (p) { return routes[p].scope === 'user'; });
    var labPaths = allPaths.filter(function (p) { return routes[p].scope === 'lab'; });

    if (!allPaths.length) {
      gateMessage('<p class="mig-warn">No routes are registered. Check that <code>js/api-routes.js</code> loaded.</p>');
      return;
    }
    userPaths.forEach(function (p) { $tbodyUser.appendChild(buildRow(p)); });
    labPaths.forEach(function (p) { $tbodyLab.appendChild(buildRow(p)); });

    // Hide the lab section for non-admins (writes would just fail on the
    // rules; better not to show migrate buttons that can't succeed).
    if (!firebridge.isAdmin()) {
      $sharedHeading.style.display = 'none';
      $sharedTable.style.display = 'none';
    }

    document.getElementById('mig-refresh-all').addEventListener('click', async function () {
      log('refresh all started');
      var rows = allRowTrs();
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        var path = tr.querySelector('.mig-path').textContent;
        await refreshRow(path, tr);
      }
      log('refresh all done', 'ok');
    });

    document.getElementById('mig-migrate-all').addEventListener('click', async function () {
      var rows = allRowTrs();
      if (!confirm('Migrate ALL ' + rows.length + ' paths to Firestore? Each row will prompt for confirmation.')) {
        return;
      }
      log('migrate all started');
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        var path = tr.querySelector('.mig-path').textContent;
        if (!tr._jsonData) await refreshRow(path, tr);
        await migrateRow(path, tr);
      }
      log('migrate all done', 'ok');
    });

    showContent();
    // Fire an initial refresh-all in the background so the page lands warm.
    document.getElementById('mig-refresh-all').click();
  }

  firebridge.onAuth(function (user, profile) {
    if (!user) {
      gateMessage('<p class="mig-err">Not signed in. <a href="/rm/index.html">Go home</a> and sign in first.</p>');
      return;
    }
    if (!profile) {
      // Bootstrap pending — wait for refreshProfile()
      return;
    }
    if ($content.dataset.inited === '1') {
      return; // already up
    }
    $content.dataset.inited = '1';
    init();
  });
})();
