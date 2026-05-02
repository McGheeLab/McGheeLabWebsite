/* explorer-detail.js — shared "open this item inline" renderer.
 *
 * Used by:
 *   - js/item-explorer.js  (By Item view on the Explorer page)
 *   - js/activity-overview.js  (cx-* item-body on Category Explorer)
 *
 * Goal: opening a task or activity inline should look identical to the
 * task-list page (uses TASK_EDITOR.render for tasks; mirrors .yr-detail
 * markup for activities). Opening an email should show the actual rendered
 * email — preferring sandboxed HTML when text/plain looks like a degraded
 * dump of the HTML (Outlook-VML stylesheets, raw entities, etc.).
 *
 * Public API:
 *   EXPLORER_DETAIL.render(kind, detail, ctx) → HTMLElement
 *
 * ctx is optional and per-kind:
 *   tasks: {save, hoursLogged?, onTaskChange?, onReschedule?} — same shape
 *          tasks-inbox.js passes to TASK_EDITOR.render. If `save` is missing
 *          we synthesize a load-mutate-save against tasks/inbox.json so the
 *          inline editor still works on pages that haven't loaded the inbox.
 */
(function () {
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'style') node.style.cssText = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function section(label, body) {
    return el('div', { class: 'section' }, [
      el('div', { class: 'label', text: label }),
      typeof body === 'string'
        ? el('div', { class: 'body', text: body })
        : body,
    ]);
  }

  // ---- Email body cleanup ------------------------------------------------
  // Some senders' clients ship a text/plain alternative that is actually a
  // half-converted HTML dump: VML stylesheet rules, mso-* properties, raw
  // entities. When we detect that, prefer body_html in a sandboxed iframe so
  // the user sees the real rendered message instead of the junk.

  function isJunkyTextBody(s) {
    if (!s) return false;
    let signals = 0;
    if (/\bbehavior:\s*url\(/i.test(s)) signals += 2;
    if (/&nbsp;|&amp;|&lt;|&gt;/.test(s)) signals += 1;
    if (/\bv\\:|\bo\\:|\bw\\:/.test(s)) signals += 2;
    if (/mso-[a-z-]+:/i.test(s)) signals += 2;
    if (/<\/?[a-z][a-z0-9]*\b[^>]*>/i.test(s)) signals += 1;
    if (/\.shape\s*\{/i.test(s)) signals += 2;
    return signals >= 2;
  }

  function decodeBasicEntities(s) {
    return String(s || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // ---- Rendering ---------------------------------------------------------

  function renderEmail(d) {
    const wrap = el('div', { class: 'yr-detail' });
    const full = d.full || {};
    const headers = [
      ['Subject', full.subject || d.subject],
      ['From', full.from || (Array.isArray(d.from) ? d.from.map(f => f.email || f.name || '').filter(Boolean).join(', ') : '')],
      ['To', full.to || (Array.isArray(d.to) ? d.to.map(t => t.email || t.name || '').filter(Boolean).join(', ') : '')],
      ['Cc', full.cc || ''],
      ['Date', full.date || d.date || ''],
    ].filter(([, v]) => v);
    if (headers.length) {
      const hdr = el('div', { class: 'expdet-headers' });
      for (const [k, v] of headers) {
        hdr.appendChild(el('div', { class: 'expdet-row' }, [
          el('span', { class: 'expdet-label', text: k }),
          el('span', { class: 'expdet-value', text: String(v) }),
        ]));
      }
      wrap.appendChild(hdr);
    }

    // Body: pick the best-looking source. If text is junky, use HTML iframe;
    // if neither exists, surface the search-time preview.
    const text = full.body_text || '';
    const html = full.body_html || '';
    const useHtml = html && (!text || isJunkyTextBody(text));
    if (useHtml) {
      const ifr = el('iframe', { class: 'expdet-iframe' });
      ifr.sandbox = '';
      ifr.srcdoc = html;
      wrap.appendChild(ifr);
    } else if (text) {
      wrap.appendChild(el('pre', { class: 'expdet-text', text }));
    } else if (d.body_preview) {
      wrap.appendChild(el('pre', { class: 'expdet-text', text: d.body_preview + '\n\n(preview only — full body unavailable)' }));
    } else {
      wrap.appendChild(el('div', { class: 'expdet-empty', text: 'No body available.' }));
    }

    const atts = full.attachments || [];
    if (atts.length) {
      const ah = el('div', { class: 'expdet-attachments' });
      ah.appendChild(el('div', { class: 'expdet-section', text: `Attachments (${atts.length})` }));
      for (const a of atts) {
        const link = el('a', {
          class: 'expdet-attachment',
          href: a.url, target: '_blank', rel: 'noopener',
        });
        const sizeKb = a.size_bytes ? ` · ${(a.size_bytes / 1024).toFixed(1)} KB` : '';
        link.textContent = `📎 ${a.filename}${sizeKb}`;
        ah.appendChild(link);
      }
      wrap.appendChild(ah);
    }
    return wrap;
  }

  // ---- Task: defer to TASK_EDITOR so the explorer matches the task-list page

  // Lazy inbox loader — only fetched when the caller doesn't supply a save
  // context. Cached at module scope so multiple expanded tasks share it.
  let _inboxPromise = null;
  function loadInboxOnce() {
    if (!_inboxPromise) {
      _inboxPromise = window.api.load('tasks/inbox.json')
        .then(j => j && Array.isArray(j.tasks) ? j : { tasks: [] })
        .catch(() => ({ tasks: [] }));
    }
    return _inboxPromise;
  }

  async function defaultTaskSave(taskRef) {
    const inbox = await loadInboxOnce();
    const i = (inbox.tasks || []).findIndex(t => t.id === taskRef.id);
    if (i === -1) {
      // Task isn't in the inbox file (could be archived/ledger). The detail
      // is still mutated in memory, but persistence is up to the caller.
      return;
    }
    inbox.tasks[i] = taskRef;
    inbox.generated_at = new Date().toISOString();
    await window.api.save('tasks/inbox.json', inbox);
  }

  function renderTask(d, ctx) {
    const wrap = el('div', { class: 'yr-detail' });
    if (window.TASK_EDITOR && typeof window.TASK_EDITOR.render === 'function') {
      const eCtx = Object.assign({
        save: () => defaultTaskSave(d),
        hoursLogged: () => 0,
      }, ctx || {});
      try {
        wrap.appendChild(window.TASK_EDITOR.render(d, eCtx));
        return wrap;
      } catch (e) {
        // Fall through to manual render if the editor errors (e.g. on archived
        // tasks the editor doesn't support).
        wrap.appendChild(el('div', { class: 'expdet-err', text: `task editor error: ${e.message || e}` }));
      }
    }
    // Manual fallback — same .section / .label / .body structure the task
    // list uses, so the look matches even without TASK_EDITOR available.
    return renderTaskManual(d);
  }

  function renderTaskManual(d) {
    const wrap = el('div', { class: 'yr-detail' });
    if (d.description) wrap.appendChild(section('Description', d.description));
    const meta = [
      ['Status', d.done ? 'done' : 'open'],
      ['Due', d.due_date || ''],
      ['Priority', d.priority || ''],
      ['Hours estimate', d.hours_estimate || ''],
      ['Created', d.created_at || d.created || ''],
    ].filter(([, v]) => v !== '' && v != null);
    if (meta.length) {
      const list = el('div', { class: 'expdet-headers' });
      for (const [k, v] of meta) {
        list.appendChild(el('div', { class: 'expdet-row' }, [
          el('span', { class: 'expdet-label', text: k }),
          el('span', { class: 'expdet-value', text: String(v) }),
        ]));
      }
      wrap.appendChild(list);
    }
    if (Array.isArray(d.action_items) && d.action_items.length) {
      wrap.appendChild(el('div', { class: 'label', text: 'Action items' }));
      const ul = el('ul', { style: 'margin:4px 0 8px 18px;padding:0' });
      for (const a of d.action_items) {
        const txt = typeof a === 'string' ? a : (a?.text || a?.title || JSON.stringify(a));
        ul.appendChild(el('li', { text: txt }));
      }
      wrap.appendChild(ul);
    }
    return wrap;
  }

  function renderActivity(d) {
    const wrap = el('div', { class: 'yr-detail' });
    if (d.description) wrap.appendChild(section('Description', d.description));
    const meta = [
      ['When', d.when || d.date || d.completed_at || ''],
      ['Hours', d.hours || ''],
      ['Source', d.from_task_id ? `task ${d.from_task_id}` : (d.source || '')],
      ['Month', d.month || ''],
    ].filter(([, v]) => v !== '' && v != null);
    if (meta.length) {
      const list = el('div', { class: 'expdet-headers' });
      for (const [k, v] of meta) {
        list.appendChild(el('div', { class: 'expdet-row' }, [
          el('span', { class: 'expdet-label', text: k }),
          el('span', { class: 'expdet-value', text: String(v) }),
        ]));
      }
      wrap.appendChild(list);
    }
    if (d.evidence) {
      const ev = d.evidence;
      const counts = [
        Array.isArray(ev.email_ids) && ev.email_ids.length ? `${ev.email_ids.length} email${ev.email_ids.length === 1 ? '' : 's'}` : '',
        Array.isArray(ev.event_ids) && ev.event_ids.length ? `${ev.event_ids.length} event${ev.event_ids.length === 1 ? '' : 's'}` : '',
        Array.isArray(ev.item_ids) && ev.item_ids.length ? `${ev.item_ids.length} item${ev.item_ids.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ');
      if (counts) wrap.appendChild(section('Evidence', counts));
    }
    return wrap;
  }

  function renderEvent(d) {
    const wrap = el('div', { class: 'yr-detail' });
    const meta = [
      ['Title', d.title],
      ['Start', d.start],
      ['End', d.end],
      ['Duration', d.duration_min ? `${d.duration_min} min` : ''],
      ['Location', d.location],
      ['Organizer', typeof d.organizer === 'object' ? (d.organizer?.email || d.organizer?.name || '') : d.organizer],
      ['Recurring', d.recurring ? 'yes' : ''],
      ['All day', d.all_day ? 'yes' : ''],
    ].filter(([, v]) => v !== '' && v != null);
    if (meta.length) {
      const list = el('div', { class: 'expdet-headers' });
      for (const [k, v] of meta) {
        list.appendChild(el('div', { class: 'expdet-row' }, [
          el('span', { class: 'expdet-label', text: k }),
          el('span', { class: 'expdet-value', text: String(v) }),
        ]));
      }
      wrap.appendChild(list);
    }
    if (Array.isArray(d.attendees) && d.attendees.length) {
      const list = d.attendees
        .map(a => typeof a === 'object' ? (a.email || a.name || '') : a)
        .filter(Boolean).join(', ');
      if (list) wrap.appendChild(section(`Attendees (${d.attendees.length})`, list));
    }
    if (d.description) wrap.appendChild(section('Description', d.description));
    return wrap;
  }

  function renderPaper(d) {
    const wrap = el('div', { class: 'yr-detail' });
    const lib = (d.meta && d.meta.library) || null;
    const meta = [
      ['Status', d.status || ''],
      ['Title', d.title || ''],
      ['Authors', lib && Array.isArray(lib.authors)
        ? lib.authors.map(a => [a.given, a.family].filter(Boolean).join(' ')).join('; ')
        : ''],
      ['Year', lib ? lib.year : ''],
      ['Journal', lib ? lib.journal : (d.meta && d.meta.target_journal) || ''],
      ['Volume / Issue / Pages', lib
        ? [lib.volume && `Vol ${lib.volume}`, lib.issue && `Iss ${lib.issue}`, lib.pages]
            .filter(Boolean).join(' · ')
        : ''],
      ['DOI', lib && lib.doi ? lib.doi : ''],
      ['PMID', lib && lib.pmid ? lib.pmid : ''],
      ['arXiv', lib && lib.arxiv_id ? lib.arxiv_id : ''],
      ['Citation key', lib && lib.citation_key ? lib.citation_key : ''],
      ['Repo', d.repo_path || ''],
    ].filter(([, v]) => v !== '' && v != null);

    if (meta.length) {
      const list = el('div', { class: 'expdet-headers' });
      for (const [k, v] of meta) {
        list.appendChild(el('div', { class: 'expdet-row' }, [
          el('span', { class: 'expdet-label', text: k }),
          el('span', { class: 'expdet-value', text: String(v) }),
        ]));
      }
      wrap.appendChild(list);
    }

    if (lib && lib.abstract) {
      wrap.appendChild(section('Abstract', lib.abstract));
    }

    // Action buttons row — Read (in-app pdf.js viewer), DOI link.
    const actions = el('div', { class: 'expdet-actions', style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' });
    if (lib && lib.pdf && lib.pdf.storage_path) {
      actions.appendChild(el('a', {
        class: 'btn btn-sm',
        href: `/pages/library-paper.html?id=${encodeURIComponent(d.id)}`,
        text: 'Read',
        title: 'Open in the in-browser PDF viewer',
      }));
    }
    if (lib && lib.doi) {
      actions.appendChild(el('a', {
        class: 'btn btn-sm', href: `https://doi.org/${lib.doi}`,
        target: '_blank', rel: 'noopener', text: 'DOI ↗',
      }));
    }
    if (lib && lib.url && (!lib.doi || !lib.url.includes('doi.org'))) {
      actions.appendChild(el('a', {
        class: 'btn btn-sm', href: lib.url,
        target: '_blank', rel: 'noopener', text: 'Source ↗',
      }));
    }
    if (actions.childElementCount) wrap.appendChild(actions);

    if (d.notes) wrap.appendChild(section('Notes', d.notes));

    // Every paper item gets a Claims panel — both lab drafts and library
    // entries can host claims (a published paper can have its own claims
    // that other papers' annotations support or refute).
    if (window.CLAIMS_PANEL) {
      const claimsHost = el('div', { class: 'expdet-claims', style: 'margin-top:14px' });
      wrap.appendChild(claimsHost);
      setTimeout(() => window.CLAIMS_PANEL.mount(claimsHost, d.id), 0);
    }
    return wrap;
  }

  function render(kind, detail, ctx) {
    if (kind === 'email')    return renderEmail(detail);
    if (kind === 'event')    return renderEvent(detail);
    if (kind === 'task')     return renderTask(detail, ctx);
    if (kind === 'activity') return renderActivity(detail);
    if (kind === 'paper' || (detail && detail.type === 'paper'))
      return renderPaper(detail);
    // Generic JSON fallback for unknown kinds.
    const wrap = el('div', { class: 'yr-detail' });
    wrap.appendChild(el('pre', { class: 'expdet-text', text: JSON.stringify(detail, null, 2) }));
    return wrap;
  }

  window.EXPLORER_DETAIL = {
    render,
    renderEmail,
    renderEvent,
    renderTask,
    renderActivity,
    renderPaper,
    isJunkyTextBody,
    decodeBasicEntities,
  };
})();
