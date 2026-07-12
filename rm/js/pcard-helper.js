/* pcard-helper.js — focused business-purpose builder for the EBC-N pcard form.
 *
 * Flow: pick expense type (pill) → fill 3–5 fields → copy a 1–3 sentence
 * statement built from the UA What/Why/Who/How/Where/When framework.
 *
 * Self-contained: no Firestore, no API adapter. Click-to-copy defaults render
 * inline at top.
 */

(function () {
  'use strict';

  // ── User defaults — edit here, not in the HTML ──────────────────────────
  const DEFAULTS = {
    name:       'Alexander McGhee',
    email:      'mcgheealex@arizona.edu',
    department: 'Biomedical Engineering-(2328)',
    pcardLast4: '3230',
    affiliation: 'University of Arizona',
    piTitle:    'Dr. Alex McGhee (PI)',
    labName:    'McGhee Lab',
  };

  // ── Templates ───────────────────────────────────────────────────────────
  // Each entry:
  //   label:      Long label (used in tips / aria)
  //   pill:       Short label for the pill button
  //   tip:        optional banner under pills ({text, kind})
  //   fields:     conditional inputs (Step 2)
  //   render:     (values) => 1–3 sentence statement

  function fallback(v, alt) {
    const s = (v || '').trim();
    return s ? s : alt;
  }

  function capFirst(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const EXPENSE_TYPES = {

    'equipment': {
      label: 'Research equipment / capital purchase',
      pill: 'Equipment',
      tip: {
        kind: 'warn',
        text: 'Unit cost ≥ $5,000 with > 1 yr useful life → flag <strong>Capital Asset = Yes</strong>. Used / refurbished may need a <strong>Sole Source Justification</strong> attached.',
      },
      fields: [
        { key: 'item',       label: 'Item', placeholder: 'Nikon Ti-E inverted microscope' },
        { key: 'vendor',     label: 'Vendor', placeholder: 'Boston Industries' },
        { key: 'vendorKind', label: 'Vendor type', hint: 'OEM / authorized distributor / reseller / refurbished', placeholder: 'reseller', value: 'reseller' },
        { key: 'purpose',    label: 'What it enables', hint: 'specific research capability', placeholder: 'imaging platform for microfluidic chip development' },
        { key: 'project',    label: 'Project / grant', placeholder: 'ONR microfluidics award' },
      ],
      render: v => {
        const item     = fallback(v.item, '[item]');
        const vendor   = fallback(v.vendor, '[vendor]');
        const vendKind = (v.vendorKind || '').toLowerCase();
        const vendQual = vendKind && !/oem|authorized/.test(vendKind) ? `, a ${vendKind},` : '';
        const purpose  = fallback(v.purpose, '[research capability]');
        const project  = v.project ? ` on ${v.project}` : '';
        const costBlurb = /reseller|refurb|used/.test(vendKind)
          ? ` Sourcing via ${vendor} provides a cost-effective alternative to new OEM purchase.`
          : '';
        return `Purchase of a ${item} from ${vendor}${vendQual} to serve as the ${purpose} in the ${DEFAULTS.labName}${project}. The equipment supports sponsored research, student training, and instrumentation development, advancing the ${DEFAULTS.affiliation}'s research mission.${costBlurb}`;
      },
    },

    'supplies': {
      label: 'Research supplies / consumables',
      pill: 'Supplies',
      fields: [
        { key: 'item',    label: 'Item(s)', hint: 'specific — not "supplies"', placeholder: 'PDMS Sylgard 184 elastomer kits, 10:1 base:curing agent' },
        { key: 'purpose', label: 'What the supplies are used for', placeholder: 'fabrication of soft-lithography microfluidic chips' },
        { key: 'project', label: 'Project / grant', placeholder: 'ONR-sponsored microfluidic biomechanics work' },
      ],
      render: v => {
        const item    = fallback(v.item, '[item]');
        const purpose = fallback(v.purpose, '[use]');
        const project = fallback(v.project, '[project]');
        return `${item} needed for ${purpose} on ${project} in the ${DEFAULTS.labName}. Materials are consumed during sponsored research activity and directly support the ${DEFAULTS.affiliation}'s research mission.`;
      },
    },

    'conference-travel': {
      label: 'Conference travel — presenting research',
      pill: 'Conference travel',
      tip: {
        kind: 'info',
        text: 'Travel needs a Travel Authorization (TA) number in <em>Additional Comments</em>. City / dates may be skipped here if already on the form.',
      },
      fields: [
        { key: 'attendee',   label: 'Attendee', placeholder: DEFAULTS.piTitle, value: DEFAULTS.piTitle },
        { key: 'conference', label: 'Conference name (full)', placeholder: 'Society for Experimental Mechanics Annual Conference' },
        { key: 'format',     label: 'Presentation format', placeholder: 'oral / poster / invited talk', value: 'oral' },
        { key: 'topic',      label: 'Research topic', placeholder: 'biomechanics / microfluidics / traction force microscopy' },
        { key: 'cityState',  label: 'City, state / country', hint: 'optional — skip if already on form', placeholder: '' },
        { key: 'dates',      label: 'Dates', hint: 'optional — skip if already on form', placeholder: '' },
      ],
      render: v => {
        const attendee = fallback(v.attendee, DEFAULTS.piTitle);
        const conf     = fallback(v.conference, '[CONFERENCE NAME]');
        const where    = v.cityState ? ` in ${v.cityState}` : '';
        const when     = v.dates ? `, ${v.dates},` : '';
        const fmt      = fallback(v.format, 'oral');
        const topic    = fallback(v.topic, '[topic]');
        const article  = /^[aeiou]/i.test(fmt) ? 'an' : 'a';
        return `${attendee} to attend the ${conf}${where}${when} to deliver ${article} ${fmt} presentation on ${DEFAULTS.labName} ${topic} research. Travel supports dissemination of sponsored research findings, professional development, and collaboration with peers, advancing the ${DEFAULTS.affiliation}'s research mission.`;
      },
    },

    'sponsor-review': {
      label: 'Sponsor program review meeting',
      pill: 'Sponsor review',
      tip: {
        kind: 'good',
        text: 'Sponsor-required attendance is a strong "why" — call it out explicitly. Charge to the sponsor account.',
      },
      fields: [
        { key: 'attendee', label: 'Attendee', placeholder: DEFAULTS.piTitle, value: DEFAULTS.piTitle },
        { key: 'sponsor',  label: 'Sponsor agency', placeholder: 'Office of Naval Research (ONR)' },
        { key: 'project',  label: 'Project / award title or number', hint: 'short form OK', placeholder: 'ONR N00014-XX-X-XXXX' },
      ],
      render: v => {
        const attendee = fallback(v.attendee, DEFAULTS.piTitle);
        const sponsor  = fallback(v.sponsor, '[SPONSOR]');
        const proj     = v.project ? ` (${v.project})` : '';
        return `${attendee} to attend the ${sponsor} program review meeting to present progress and deliverables on the ${DEFAULTS.labName}'s sponsored ${sponsor} research project${proj}. Attendance is required by the sponsor, supports continued funding, and enables direct engagement with the program officer and partner investigators, advancing the ${DEFAULTS.affiliation}'s research mission.`;
      },
    },

    'software': {
      label: 'Software / subscription / license',
      pill: 'Software / license',
      fields: [
        { key: 'product', label: 'Product name + license period', placeholder: 'MATLAB academic license, 1-year renewal' },
        { key: 'users',   label: 'User(s) / seats', placeholder: `${DEFAULTS.piTitle} + 2 graduate researchers` },
        { key: 'purpose', label: 'Research use', placeholder: 'image analysis and FEM simulation for traction force microscopy' },
      ],
      render: v => {
        const product = fallback(v.product, '[product / license]');
        const users   = fallback(v.users, '[user(s)]');
        const purpose = fallback(v.purpose, '[research use]');
        return `${product} for ${users} in the ${DEFAULTS.labName} to support ${purpose}. The license enables sponsored research analysis and graduate training, advancing the ${DEFAULTS.affiliation}'s research mission.`;
      },
    },

    'membership': {
      label: 'Professional membership / dues',
      pill: 'Membership',
      fields: [
        { key: 'org',     label: 'Organization (full name)', placeholder: 'Society for Experimental Mechanics' },
        { key: 'year',    label: 'Membership year', placeholder: new Date().getFullYear().toString() },
        { key: 'member',  label: 'Member', value: DEFAULTS.piTitle },
        { key: 'benefit', label: 'How it benefits UA work', placeholder: 'access to journals, conference rates, and the experimental-mechanics research community' },
      ],
      render: v => {
        const org     = fallback(v.org, '[ORG]');
        const year    = fallback(v.year, '[year]');
        const member  = fallback(v.member, DEFAULTS.piTitle);
        const benefit = fallback(v.benefit, 'access to peer community, journals, and conference rates');
        return `${year} ${org} membership for ${member} to provide ${benefit}, supporting ongoing sponsored research and professional engagement on behalf of the ${DEFAULTS.affiliation}.`;
      },
    },

    'business-meal': {
      label: 'Business meal / hospitality',
      pill: 'Business meal',
      tip: {
        kind: 'warn',
        text: 'UA expects an <strong>attendee list</strong> and meeting <strong>agenda</strong> attached. Business meals on sponsored funds are restricted — check sponsor terms.',
      },
      fields: [
        { key: 'event',    label: 'Event description', placeholder: 'Interview dinner / lab strategy lunch / visiting-speaker reception' },
        { key: 'date',     label: 'Date', placeholder: 'MM/DD/YYYY' },
        { key: 'location', label: 'Restaurant / venue', placeholder: '' },
        { key: 'who',      label: 'Attendees (names + roles)', placeholder: 'Dr. McGhee (PI), Dr. X (visiting collaborator from Y University), 3 graduate researchers' },
        { key: 'purpose',  label: 'Business purpose of meeting', placeholder: 'discuss collaboration on ONR microfluidics project' },
      ],
      render: v => {
        const event    = fallback(v.event, '[event]');
        const date     = v.date ? ` on ${v.date}` : '';
        const location = v.location ? ` at ${v.location}` : '';
        const who      = fallback(v.who, '[attendees]');
        const purpose  = fallback(v.purpose, '[purpose]');
        return `${event}${date}${location} with ${who} to ${purpose} on behalf of the ${DEFAULTS.labName}. See attached attendee list and agenda. Activity advances the ${DEFAULTS.affiliation}'s research mission.`;
      },
    },

    'publication': {
      label: 'Publication / page charges / open access',
      pill: 'Publication',
      fields: [
        { key: 'kind',    label: 'Charge type', placeholder: 'open-access fee / page charges / color figure fee', value: 'open-access fee' },
        { key: 'journal', label: 'Journal / publisher', placeholder: 'Journal of Biomechanics (Elsevier)' },
        { key: 'paper',   label: 'Paper title (short)', placeholder: 'Microfluidic traction force assay for vascular smooth muscle cells' },
        { key: 'authors', label: 'Authors', placeholder: `${DEFAULTS.piTitle} et al.` },
        { key: 'project', label: 'Grant / project source', placeholder: 'ONR microfluidics award' },
      ],
      render: v => {
        const journal = fallback(v.journal, '[JOURNAL]');
        const kind    = capFirst(fallback(v.kind, 'open-access fee'));
        const paper   = fallback(v.paper, '[paper title]');
        const authors = fallback(v.authors, DEFAULTS.piTitle);
        const project = v.project ? ` (${v.project})` : '';
        return `${kind} to ${journal} for the paper "${paper}" by ${authors}${project}. Publication disseminates sponsored research findings from the ${DEFAULTS.labName} and advances the ${DEFAULTS.affiliation}'s research mission.`;
      },
    },

    'custom': {
      label: 'Other — custom statement',
      pill: 'Other',
      tip: {
        kind: 'info',
        text: 'Write the full statement yourself. Cover What / Why / Who / How / Where / When (skip anything already captured by other form fields).',
      },
      fields: [
        { key: 'custom', label: 'Business purpose statement', hint: '2–3 sentences', placeholder: '...', textarea: true },
      ],
      render: v => fallback(v.custom, ''),
    },
  };

  // ── State + DOM helpers ─────────────────────────────────────────────────
  const state = {
    type: 'equipment',
    values: {},
  };

  function $(sel) { return document.querySelector(sel); }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2), attrs[k]);
        } else {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
  }

  function renderDefaults() {
    const host = $('#pc-defaults');
    host.innerHTML = '';
    const rows = [
      ['Dept',  DEFAULTS.department],
      ['Name',  DEFAULTS.name],
      ['Email', DEFAULTS.email],
      ['PCard', DEFAULTS.pcardLast4],
    ];
    for (const [label, value] of rows) {
      host.appendChild(el('span', {
        class: 'pc-chip',
        title: 'Click to copy ' + label,
        onclick: () => copyText(value, label),
      },
        el('span', { class: 'pc-chip-label' }, label + ':'),
        el('span', { class: 'pc-chip-value' }, value),
        el('span', { class: 'pc-chip-icon' }, '⧉'),
      ));
    }
  }

  function renderPills() {
    const host = $('#pc-type-pills');
    host.innerHTML = '';
    for (const key in EXPENSE_TYPES) {
      const tpl = EXPENSE_TYPES[key];
      const isActive = key === state.type;
      host.appendChild(el('button', {
        type: 'button',
        class: 'pc-pill' + (isActive ? ' active' : ''),
        title: tpl.label,
        onclick: () => {
          state.type = key;
          renderPills();
          renderFields();
          renderOutput();
        },
      }, tpl.pill));
    }
  }

  function renderFields() {
    const tpl = EXPENSE_TYPES[state.type];

    // Tip banner
    const tipHost = $('#pc-type-tip');
    tipHost.innerHTML = '';
    if (tpl.tip) {
      const cls = tpl.tip.kind === 'warn' ? 'pc-tip warn'
                 : tpl.tip.kind === 'good' ? 'pc-tip good'
                 : 'pc-tip';
      tipHost.appendChild(el('div', { class: cls, html: tpl.tip.text }));
    }

    const host = $('#pc-fields');
    host.innerHTML = '';

    // Seed defaults from template (don't overwrite user edits)
    for (const f of tpl.fields) {
      if (state.values[f.key] == null && f.value != null) {
        state.values[f.key] = f.value;
      }
    }

    for (const f of tpl.fields) {
      const wrap = el('div', { class: 'pc-field' });
      const labelEl = el('label', {},
        f.label,
        f.hint ? el('span', { class: 'pc-hint' }, '— ' + f.hint) : null,
      );
      let inputEl;
      if (f.textarea) {
        inputEl = el('textarea', {
          id: 'pc-f-' + f.key,
          placeholder: f.placeholder || '',
          oninput: e => { state.values[f.key] = e.target.value; renderOutput(); },
        });
      } else {
        inputEl = el('input', {
          type: 'text',
          id: 'pc-f-' + f.key,
          placeholder: f.placeholder || '',
          oninput: e => { state.values[f.key] = e.target.value; renderOutput(); },
        });
      }
      inputEl.value = state.values[f.key] || '';
      wrap.appendChild(labelEl);
      wrap.appendChild(inputEl);
      host.appendChild(wrap);
    }
  }

  function renderOutput() {
    const tpl = EXPENSE_TYPES[state.type];
    const text = tpl.render(state.values || {});
    const out = $('#pc-output');
    out.textContent = text || '—';
    out.classList.toggle('empty', !text);
    const count = $('#pc-count');
    const n = text.length;
    count.textContent = `${n} character${n === 1 ? '' : 's'}`;
    count.classList.toggle('over', n > 500);
  }

  function copyText(text, label) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => flashStatus(`Copied${label ? ' ' + label : ''} ✓`),
        () => flashStatus('Copy failed — select & copy manually', true),
      );
    } else {
      flashStatus('Clipboard API unavailable — select & copy manually', true);
    }
  }

  function flashStatus(msg, isError) {
    let host = document.getElementById('pc-toast');
    if (!host) {
      host = el('div', {
        id: 'pc-toast',
        style: 'position:fixed;top:72px;right:24px;z-index:9999;background:#1f2937;color:white;padding:8px 14px;border-radius:6px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:opacity .2s;',
      });
      document.body.appendChild(host);
    }
    host.style.background = isError ? '#991b1b' : '#16a34a';
    host.textContent = msg;
    host.style.opacity = '1';
    clearTimeout(host._t);
    host._t = setTimeout(() => { host.style.opacity = '0'; }, 1800);
  }

  // ── Wire up ─────────────────────────────────────────────────────────────
  function init() {
    renderDefaults();
    renderPills();
    renderFields();
    renderOutput();

    $('#pc-copy').addEventListener('click', () => {
      copyText($('#pc-output').textContent, 'business purpose');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
