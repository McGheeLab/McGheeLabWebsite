/* external-links.js — Shared "🔗 Linked files" block (V3.234).
 *
 * Phase 1 of the Synology integration. Renders a structured list of
 * external URLs (Synology share links, Drive links, anything) on
 * lab-notebook entries, task project buckets, project/item cards, and
 * paper drafts. Each link carries an optional `private` flag that
 * surfaces a "🔌 VPN" badge — Phase 1 is manual-toggle only; Phase 2
 * will hostname-match against the lab NAS.
 *
 * Usage:
 *   EXTERNAL_LINKS.mount({
 *     container,                              // HTMLElement
 *     getLinks: () => state.doc.externalLinks,
 *     setLinks: (next) => {                   // persist + re-render
 *       state.doc.externalLinks = next;
 *       scheduleSave();
 *     },
 *     readOnly: false,                        // hides Add + Delete
 *     title: '🔗 Linked files',               // optional override
 *   });
 *
 * Each link: { id, url, label, private, addedAt, addedByUid }.
 * The caller owns persistence — this module only mutates the array
 * via setLinks() and re-renders into `container`. Returns a small
 * controller { refresh } for callers that need to redraw after an
 * external state change.
 */
(function () {
  'use strict';

  function newId() {
    return 'lnk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function getMyUid() {
    try {
      return (window.firebridge && window.firebridge.getUser && window.firebridge.getUser() || {}).uid || '';
    } catch (e) { return ''; }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Pull a host substring from a URL for display when the user didn't
   * supply a label. Best-effort — anything we can't parse falls back to
   * the raw string. */
  function hostOf(u) {
    try { return new URL(u).host; } catch (e) {
      var m = String(u || '').match(/^[a-z]+:\/\/([^\/?#]+)/i);
      return m ? m[1] : (u || '');
    }
  }

  function normalizeUrl(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    // If user pasted "nas.lab.local/path" without a scheme, prepend https://.
    if (!/^[a-z][a-z0-9+.\-]*:/i.test(s) && !s.startsWith('//')) {
      s = 'https://' + s;
    }
    return s;
  }

  function mount(opts) {
    opts = opts || {};
    var container = opts.container;
    if (!container) throw new Error('EXTERNAL_LINKS.mount: container required');
    var getLinks = opts.getLinks || function () { return []; };
    var setLinks = opts.setLinks || function () {};
    var readOnly = !!opts.readOnly;
    var title    = opts.title || '🔗 Linked files';

    // Persisted-per-mount collapsed state. Default: collapsed iff empty.
    var initialLinks = getLinks() || [];
    var collapsed = initialLinks.length === 0;

    function render() {
      var links = (getLinks() || []).slice();
      container.innerHTML = '';
      container.classList.add('ext-links');

      var header = document.createElement('div');
      header.className = 'ext-links-header';
      header.innerHTML =
        '<button type="button" class="ext-links-toggle" aria-expanded="' + (!collapsed) + '">' +
          '<span class="ext-links-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
          '<span class="ext-links-title">' + escapeHtml(title) + '</span>' +
          '<span class="ext-links-count">' + (links.length ? '(' + links.length + ')' : '') + '</span>' +
        '</button>';
      header.querySelector('.ext-links-toggle').onclick = function () {
        collapsed = !collapsed;
        render();
      };
      container.appendChild(header);

      if (collapsed) return;

      var body = document.createElement('div');
      body.className = 'ext-links-body';

      if (links.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'ext-links-empty';
        empty.textContent = readOnly ? 'No linked files.' : 'No linked files yet. Paste a Synology share URL, Drive link, or any URL below.';
        body.appendChild(empty);
      } else {
        var list = document.createElement('ul');
        list.className = 'ext-links-list';
        links.forEach(function (lnk, idx) {
          var li = document.createElement('li');
          li.className = 'ext-links-row';
          var labelText = lnk.label || hostOf(lnk.url) || '(no label)';
          var safeUrl = escapeHtml(lnk.url || '');
          var vpnBadge = lnk.private
            ? '<span class="ext-links-vpn" title="Requires UA VPN to access">🔌 VPN</span>'
            : '';
          var delBtn = readOnly
            ? ''
            : '<button type="button" class="ext-links-del" title="Remove link">🗑</button>';
          li.innerHTML =
            '<a class="ext-links-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' +
              '<span class="ext-links-label">' + escapeHtml(labelText) + '</span>' +
              '<span class="ext-links-url">' + escapeHtml(lnk.url || '') + '</span>' +
            '</a>' +
            vpnBadge +
            delBtn;
          if (!readOnly) {
            li.querySelector('.ext-links-del').onclick = function () {
              if (!confirm('Remove this linked file?')) return;
              var next = (getLinks() || []).slice();
              var realIdx = next.findIndex(function (r) { return r && r.id === lnk.id; });
              if (realIdx < 0) realIdx = idx;
              next.splice(realIdx, 1);
              setLinks(next);
              render();
            };
          }
          list.appendChild(li);
        });
        body.appendChild(list);
      }

      if (!readOnly) {
        var form = document.createElement('div');
        form.className = 'ext-links-form';
        form.innerHTML =
          '<input type="url" class="ext-links-input-url" placeholder="https://… (Synology share, Drive, …)" />' +
          '<input type="text" class="ext-links-input-label" placeholder="Label (optional)" />' +
          '<label class="ext-links-private">' +
            '<input type="checkbox" class="ext-links-input-private" /> 🔌 Private (UA VPN)' +
          '</label>' +
          '<button type="button" class="ext-links-add">+ Add</button>';
        body.appendChild(form);

        var urlInput   = form.querySelector('.ext-links-input-url');
        var labelInput = form.querySelector('.ext-links-input-label');
        var privInput  = form.querySelector('.ext-links-input-private');
        var addBtn     = form.querySelector('.ext-links-add');

        function tryAdd() {
          var url = normalizeUrl(urlInput.value);
          if (!url) {
            urlInput.focus();
            return;
          }
          var entry = {
            id: newId(),
            url: url,
            label: (labelInput.value || '').trim(),
            private: !!privInput.checked,
            addedAt: new Date().toISOString(),
            addedByUid: getMyUid(),
          };
          var next = (getLinks() || []).slice();
          next.push(entry);
          setLinks(next);
          urlInput.value = '';
          labelInput.value = '';
          privInput.checked = false;
          collapsed = false;
          render();
        }
        addBtn.onclick = tryAdd;
        function onKey(e) {
          if (e.key === 'Enter') { e.preventDefault(); tryAdd(); }
        }
        urlInput.addEventListener('keydown', onKey);
        labelInput.addEventListener('keydown', onKey);
      }

      container.appendChild(body);
    }

    render();
    return { refresh: render };
  }

  /* Hydrate helper — coerces a possibly-missing externalLinks field to
   * a sanitized array. Callers run this on doc load so existing docs
   * without the field don't crash the render. */
  function hydrate(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(function (r) { return r && typeof r === 'object' && typeof r.url === 'string' && r.url; })
      .map(function (r) {
        return {
          id:         (typeof r.id === 'string' && r.id) ? r.id : newId(),
          url:        String(r.url),
          label:      typeof r.label === 'string' ? r.label : '',
          private:    !!r.private,
          addedAt:    typeof r.addedAt === 'string' ? r.addedAt : new Date().toISOString(),
          addedByUid: typeof r.addedByUid === 'string' ? r.addedByUid : '',
        };
      });
  }

  window.EXTERNAL_LINKS = {
    mount: mount,
    hydrate: hydrate,
    newId: newId,
  };
})();
