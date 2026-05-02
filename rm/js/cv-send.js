/* cv-send.js — "Send to CV" modal used from year-review (and potentially
 * other pages). Takes a calendar event, an email, or a title-cluster and:
 *   1) heuristically picks the best CV section from its sub_category path,
 *   2) pre-fills the section's form fields,
 *   3) lets the user review/edit, then writes via CVStore.appendEntry.
 *
 * Depends on: firebridge (loaded), cv-schemas.js (CV_SCHEMAS, CVStore).
 */

var CVSend = (function () {

  /* ── sub-category → section heuristics ──
   * Order matters — first match wins. */
  var RULES = [
    { match: /(^|:)seminar($|:)/i,                   section: 'presentations', type: 'Seminar' },
    { match: /(^|:)presentations?($|:)/i,            section: 'presentations', type: 'Invited Talk' },
    { match: /student:presentation/i,                section: 'presentations', type: 'Contributed Talk' },
    { match: /(^|:)honors?($|:)/i,                   section: 'awards' },
    { match: /(^|:)editorial($|:)/i,                 section: 'service',       stype: 'Associate Editor', role: 'Editor' },
    { match: /(^|:)peer-review($|:)/i,               section: 'service',       stype: 'Reviewer',        role: 'Reviewer' },
    { match: /conference:chair/i,                    section: 'service',       stype: 'Program Chair',   role: 'Chair' },
    { match: /committee:PhD student/i,               section: 'students',      degree: 'PhD' },
    { match: /(^|:)committee($|:)/i,                 section: 'service',       stype: 'Committee',       role: 'Member' },
    { match: /student-committee/i,                   section: 'students',      degree: 'PhD' },
    { match: /(^|:)grant-meeting($|:)/i,             section: 'grants' },
    { match: /(^|:)COE($|:)/i,                       section: 'service',       stype: 'University',      role: 'Member' },
    { match: /engagement:advisory-board/i,           section: 'service',       stype: 'Advisory Board',  role: 'Member' },
    { match: /(^|:)engagement($|:)/i,                section: 'service',       stype: 'University',      role: 'Representative' },
    { match: /outreach:media/i,                      section: 'service',       stype: 'Other',           role: 'Media interview' },
    { match: /(^|:)outreach($|:)/i,                  section: 'service',       stype: 'Other',           role: 'Outreach' },
    { match: /class-session|course-admin/i,          section: 'courses' },
    { match: /admissions|design-day|commencement/i,  section: 'service',       stype: 'University',      role: 'Participant' },
  ];

  function suggestSection(subCategory) {
    var path = subCategory || '';
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].match.test(path)) return RULES[i];
    }
    return { section: 'presentations', type: 'Invited Talk' };
  }

  /* Returns a rule iff one explicitly matches the sub-category path. Used by
   * the "CV Summary" panel to decide which rows are CV-worthy (no fallback). */
  function matchRule(subCategory) {
    var path = subCategory || '';
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].match.test(path)) return RULES[i];
    }
    return null;
  }

  function yearOf(dateStr) {
    if (!dateStr) return '';
    var m = String(dateStr).match(/(\d{4})/);
    return m ? Number(m[1]) : '';
  }

  function dateOnly(dateStr) {
    if (!dateStr) return '';
    return String(dateStr).slice(0, 10);
  }

  /* Build field prefills from a calendar event. */
  function prefillFromEvent(ev, rule) {
    var sec = rule.section;
    var y = yearOf(ev.start);
    if (sec === 'presentations') {
      return {
        title: ev.title || '',
        event: ev.location || '',
        location: ev.location || '',
        date: dateOnly(ev.start),
        type: rule.type || 'Invited Talk',
        audience: '',
        notes: ev.description || '',
      };
    }
    if (sec === 'awards') {
      return {
        title: ev.title || '',
        awarding_body: '',
        year: y,
        category: 'Recognition',
        description: ev.description || '',
      };
    }
    if (sec === 'service') {
      return {
        role: rule.role || '',
        organization: ev.title || '',
        type: rule.stype || 'Other',
        start_year: y,
        end_year: y,
        ongoing: false,
        description: ev.description || '',
      };
    }
    if (sec === 'courses') {
      return {
        name: ev.title || '',
        code: '',
        level: 'Undergraduate',
        role: 'Instructor',
        semester: semesterFromDate(ev.start),
        year: y,
        institution: 'University of Arizona',
        description: '',
      };
    }
    if (sec === 'grants') {
      return {
        title: ev.title || '',
        agency: '',
        role: 'PI',
        start_date: dateOnly(ev.start),
        status: 'Active',
        description: ev.description || '',
      };
    }
    if (sec === 'students') {
      return {
        name: ev.title ? ev.title.replace(/.*?:\s*/, '') : '',
        degree: rule.degree || 'PhD',
        start_year: y,
        status: 'Current',
        thesis_title: '',
      };
    }
    return { title: ev.title || '' };
  }

  /* Build field prefills from a cluster (multiple events with same title). */
  function prefillFromCluster(cluster, rule) {
    var first = cluster.activities[0] && cluster.activities[0].event;
    if (!first) return {};
    var earliest = cluster.activities.reduce(function (a, b) {
      return (a.event.start < b.event.start ? a : b);
    }).event.start;
    var latest = cluster.activities.reduce(function (a, b) {
      return (a.event.start > b.event.start ? a : b);
    }).event.start;
    var base = prefillFromEvent(first, rule);
    // Override year-ish fields to span the cluster
    if (rule.section === 'service') {
      base.start_year = yearOf(earliest);
      base.end_year = yearOf(latest);
    } else if (rule.section === 'courses') {
      base.year = yearOf(earliest);
      base.semester = semesterFromDate(earliest);
      base.enrollment = cluster.activities.length;
    } else if (rule.section === 'presentations') {
      base.date = dateOnly(earliest);
      base.notes = (base.notes ? base.notes + '\n\n' : '')
        + '(' + cluster.activities.length + ' instances from '
        + dateOnly(earliest) + ' to ' + dateOnly(latest) + ')';
    }
    return base;
  }

  /* Build field prefills from an email. */
  function prefillFromEmail(m, rule) {
    var y = yearOf(m.date);
    var sec = rule.section;
    if (sec === 'service') {
      return {
        role: rule.role || 'Reviewer',
        organization: (m.from || '').replace(/<.*?>/, '').trim() || (m.subject || ''),
        type: rule.stype || 'Reviewer',
        start_year: y,
        end_year: y,
        description: m.subject || '',
      };
    }
    if (sec === 'presentations') {
      return {
        title: m.subject || '',
        event: '',
        date: dateOnly(m.date),
        type: rule.type || 'Invited Talk',
        notes: '',
      };
    }
    return { title: m.subject || '', year: y };
  }

  /* Build prefill values from a sub-category *summary* (the aggregate stats
   * on a sub-category row, for the currently-viewed year). */
  function prefillFromSummary(source, rule) {
    var row = source.row;
    var sec = rule.section;
    var yearNum = Number(source.year) || '';
    var statsLine = row.event_count + ' event' + (row.event_count === 1 ? '' : 's')
      + ' · ' + row.email_count + ' email' + (row.email_count === 1 ? '' : 's')
      + ' · ' + Number(row.hours_total || 0).toFixed(1) + ' hours';
    var title = source.customTitle || row.title || '';

    if (sec === 'service') {
      return {
        role: rule.role || 'Member',
        organization: title,
        type: rule.stype || 'Other',
        start_year: yearNum,
        end_year: yearNum,
        ongoing: false,
        description: statsLine,
      };
    }
    if (sec === 'courses') {
      return {
        name: title,
        code: '',
        level: 'Undergraduate',
        role: 'Instructor',
        semester: 'Full Year',
        year: yearNum,
        enrollment: row.event_count,
        institution: 'University of Arizona',
        description: statsLine,
      };
    }
    if (sec === 'presentations') {
      var first = (row.activities || [])[0];
      return {
        title: title,
        event: (first && first.event && first.event.location) || '',
        date: (first && first.event && dateOnly(first.event.start)) || (yearNum ? yearNum + '-01-01' : ''),
        type: rule.type || 'Invited Talk',
        audience: '',
        notes: statsLine,
      };
    }
    if (sec === 'awards') {
      return {
        title: title,
        awarding_body: '',
        year: yearNum,
        category: 'Recognition',
        description: statsLine,
      };
    }
    if (sec === 'grants') {
      return {
        title: title,
        agency: '',
        role: 'PI',
        status: 'Active',
        description: statsLine,
      };
    }
    if (sec === 'students') {
      return {
        name: title,
        degree: rule.degree || 'PhD',
        start_year: yearNum,
        status: 'Current',
        thesis_title: '',
        notes: statsLine,
      };
    }
    return { title: title, description: statsLine };
  }

  function semesterFromDate(dateStr) {
    var m = (dateStr || '').match(/-(\d{2})-/);
    if (!m) return 'Fall';
    var mo = Number(m[1]);
    if (mo >= 1 && mo <= 5) return 'Spring';
    if (mo >= 6 && mo <= 7) return 'Summer';
    return 'Fall';
  }

  /* ── modal UI ── */

  function ensureModal() {
    var existing = document.getElementById('cvs-modal');
    if (existing) return existing;
    var back = document.createElement('div');
    back.id = 'cvs-modal';
    back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:none;align-items:flex-start;justify-content:center;padding:30px 12px;overflow-y:auto';
    back.innerHTML =
      '<div id="cvs-panel" style="background:#fff;border-radius:10px;max-width:720px;width:100%;padding:18px 20px;box-shadow:0 20px 40px rgba(0,0,0,.25)">' +
        '<h3 id="cvs-title" style="margin:0 0 6px 0;font-size:15px">Add to CV</h3>' +
        '<div id="cvs-src" style="font-size:12px;color:#6b7280;margin-bottom:10px"></div>' +
        '<label style="display:block;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">' +
          'CV section' +
          '<select id="cvs-section" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;min-width:220px"></select>' +
        '</label>' +
        '<div id="cvs-form"></div>' +
        '<div id="cvs-status" style="font-size:12px;color:#6b7280;margin-top:8px"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid #f1f5f9">' +
          '<button class="btn" id="cvs-cancel">Cancel</button>' +
          '<button class="btn btn-primary" id="cvs-save">Save to CV</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);
    /* Guard the backdrop click so drag-selects and accidental clicks don't
     * wipe the user's draft. Reset on explicit cancel/save/reopen. */
    _modalGuard = safeCloseOnBackdrop(back, document.getElementById('cvs-panel'), close);
    document.getElementById('cvs-cancel').addEventListener('click', function () {
      if (_modalGuard) _modalGuard.reset();
      close();
    });
    return back;
  }

  var _modalGuard = null;

  function close() {
    var m = document.getElementById('cvs-modal');
    if (m) m.style.display = 'none';
  }

  function open(source) {
    // source = { kind: 'event'|'cluster'|'email', ev?, cluster?, email?, subCategory, sourceLabel }
    if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
      alert('Not signed in to the website. Open Settings to sign in.');
      return;
    }
    ensureModal();
    var rule = suggestSection(source.subCategory);
    var sectionSel = document.getElementById('cvs-section');
    sectionSel.innerHTML = CV_SECTION_KEYS.map(function (k) {
      return '<option value="' + k + '"' + (k === rule.section ? ' selected' : '') + '>' + CV_SECTION_LABELS[k] + '</option>';
    }).join('');
    document.getElementById('cvs-src').textContent = source.sourceLabel || '';

    function renderForm() {
      var sec = sectionSel.value;
      var values = computePrefill(source, Object.assign({}, rule, { section: sec }));
      var schema = CV_SCHEMAS[sec];
      var host = document.getElementById('cvs-form');
      host.innerHTML = '';
      var form = document.createElement('div');
      form.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px 12px';
      schema.fields.forEach(function (f) {
        var label = document.createElement('label');
        label.style.cssText = 'display:flex;flex-direction:column;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;gap:3px';
        if (f.span === 2) label.style.gridColumn = '1/-1';
        label.innerHTML = '<span>' + f.label + (f.required ? ' <span style="color:#dc2626">*</span>' : '') + '</span>';
        var input = buildInput(f, values[f.key]);
        label.appendChild(input);
        form.appendChild(label);
      });
      host.appendChild(form);
    }
    sectionSel.onchange = renderForm;
    renderForm();

    var saveBtn = document.getElementById('cvs-save');
    saveBtn.onclick = async function () {
      var sec = sectionSel.value;
      var schema = CV_SCHEMAS[sec];
      var values = {};
      document.querySelectorAll('#cvs-form [data-field-key]').forEach(function (el) {
        var key = el.dataset.fieldKey;
        var type = el.dataset.fieldType;
        if (type === 'checkbox') values[key] = !!el.checked;
        else if (type === 'number') values[key] = el.value === '' ? '' : Number(el.value);
        else values[key] = el.value;
      });
      // Validate required
      for (var i = 0; i < schema.fields.length; i++) {
        var f = schema.fields[i];
        if (f.required && (values[f.key] === '' || values[f.key] === null || values[f.key] === undefined)) {
          setStatus(f.label + ' is required.', 'err');
          return;
        }
      }
      setStatus('Saving…');
      saveBtn.disabled = true;
      try {
        await CVStore.appendEntry(sec, values);
        setStatus('Added to CV.', 'ok');
        setTimeout(close, 700);
      } catch (err) {
        setStatus('Failed: ' + err.message, 'err');
      } finally {
        saveBtn.disabled = false;
      }
    };

    document.getElementById('cvs-modal').style.display = 'flex';
    if (_modalGuard) _modalGuard.reset();
    document.getElementById('cvs-title').textContent =
      'Add to CV: ' + CV_SECTION_LABELS[rule.section];
  }

  function computePrefill(source, rule) {
    if (source.kind === 'event')   return prefillFromEvent(source.ev, rule);
    if (source.kind === 'cluster') return prefillFromCluster(source.cluster, rule);
    if (source.kind === 'email')   return prefillFromEmail(source.email, rule);
    if (source.kind === 'summary') return prefillFromSummary(source, rule);
    return {};
  }

  function buildInput(field, value) {
    var el;
    if (field.type === 'textarea') {
      el = document.createElement('textarea');
      el.style.cssText = 'min-height:70px;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;font-size:13px;color:#111827;text-transform:none;letter-spacing:normal;resize:vertical';
      el.value = value || '';
    } else if (field.type === 'select') {
      el = document.createElement('select');
      el.style.cssText = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;text-transform:none;letter-spacing:normal';
      (field.options || []).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt;
        o.textContent = opt || '(none)';
        if ((value || '') === opt) o.selected = true;
        el.appendChild(o);
      });
    } else if (field.type === 'checkbox') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.checked = !!value;
    } else {
      el = document.createElement('input');
      el.type = field.type === 'number' ? 'number' : (field.type === 'date' ? 'date' : 'text');
      el.style.cssText = 'padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;text-transform:none;letter-spacing:normal';
      if (value !== undefined && value !== null) el.value = value;
    }
    el.dataset.fieldKey = field.key;
    el.dataset.fieldType = field.type;
    return el;
  }

  function setStatus(msg, kind) {
    var el = document.getElementById('cvs-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'ok' ? '#059669' : (kind === 'err' ? '#dc2626' : '#6b7280');
  }

  return {
    open: open,
    suggestSection: suggestSection,
    matchRule: matchRule,
  };
})();
