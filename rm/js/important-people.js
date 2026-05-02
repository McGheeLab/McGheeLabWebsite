/* important-people.js — dossier view for key contacts and stakeholders */

const CATEGORIES = [
  { key: 'regents', label: 'Board of Regents', file: 'important-people/regents.json' },
  { key: 'donors', label: 'Donors', file: 'important-people/donors.json' },
  { key: 'initiatives', label: 'Initiatives & Cores', file: 'important-people/initiatives.json' },
  { key: 'collaborators', label: 'Collaborators', file: 'important-people/collaborators.json' },
];

const CONTACT_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'photo_url', label: 'Photo URL', type: 'text' },
  { key: 'title', label: 'Title / Role', type: 'text' },
  { key: 'organization', label: 'Organization', type: 'text' },
  { key: 'role_detail', label: 'Role Detail', type: 'text' },
  { key: 'website', label: 'Website (initiatives only)', type: 'text' },
  { key: 'mission', label: 'Mission (initiatives only)', type: 'textarea' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'office', label: 'Office', type: 'text' },
  { key: 'initiative_link', label: 'Linked Initiative ID', type: 'text', placeholder: 'e.g. ffccs' },
  { key: 'background', label: 'Background', type: 'textarea' },
  { key: 'education', label: 'Education', type: 'text' },
  { key: 'cancer_engineering_relevance', label: 'Cancer Engineering Relevance', type: 'select', options: ['high', 'moderate-high', 'moderate', 'low-moderate', 'low'] },
  { key: 'relevance_notes', label: 'Relevance Notes', type: 'textarea' },
  { key: 'priority', label: 'Priority (1 = highest)', type: 'number' },
  { key: 'priority_reason', label: 'Priority Reason', type: 'text' },
  { key: 'event', label: 'Event', type: 'text' },
  { key: 'event_date', label: 'Event Date', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

let activeTab = 'regents';
let activeFilter = 'all';

function currentCategory() {
  return CATEGORIES.find(c => c.key === activeTab) || CATEGORIES[0];
}

async function loadAndRender() {
  const cat = currentCategory();
  const data = await api.load(cat.file);
  const contacts = data.contacts || [];
  const context = data.context || {};

  // Render tabs
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  CATEGORIES.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (activeTab === c.key ? ' active' : '');
    btn.textContent = c.label;
    btn.onclick = () => { activeTab = c.key; activeFilter = 'all'; loadAndRender(); };
    tabs.appendChild(btn);
  });

  // Render context banner
  const contextArea = document.getElementById('context-area');
  if (context.event || (context.strategic_context && context.strategic_context.length)) {
    let html = '<div class="context-banner">';
    if (context.event) {
      html += `<h2>${context.event}</h2>`;
      html += `<p style="font-size:13px;color:var(--text-muted);">${context.event_dates || ''} &mdash; ${context.location || ''}</p>`;
    }
    if (context.strategic_context && context.strategic_context.length) {
      html += '<div class="dossier-section"><div class="dossier-section-label">Strategic Context</div><ul>';
      context.strategic_context.forEach(s => { html += `<li>${s}</li>`; });
      html += '</ul></div>';
    }
    if (context.general_talking_points && context.general_talking_points.length) {
      html += '<div class="dossier-section" style="margin-top:12px;"><div class="dossier-section-label">General Talking Points</div><ul>';
      context.general_talking_points.forEach(s => { html += `<li>${s}</li>`; });
      html += '</ul></div>';
    }
    html += '</div>';
    contextArea.innerHTML = html;
  } else {
    contextArea.innerHTML = '';
  }

  // Collect relevance levels present in this dataset
  const presentLevels = new Set(contacts.map(c => c.cancer_engineering_relevance || 'low'));
  const allLevels = ['all', 'high', 'moderate-high', 'moderate', 'low-moderate', 'low'];
  const relevanceLevels = allLevels.filter(l => l === 'all' || presentLevels.has(l));

  // Render filter bar
  const filters = document.getElementById('filters');
  filters.innerHTML = '';
  relevanceLevels.forEach(level => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (activeFilter === level ? ' active' : '');
    btn.textContent = level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1) + ' Relevance';
    btn.onclick = () => { activeFilter = level; loadAndRender(); };
    filters.appendChild(btn);
  });

  // Filter and sort contacts
  let filtered = contacts;
  if (activeFilter !== 'all') {
    filtered = contacts.filter(c => c.cancer_engineering_relevance === activeFilter);
  }
  filtered.sort((a, b) => (a.priority || 99) - (b.priority || 99));

  const content = document.getElementById('content');

  if (filtered.length === 0) {
    content.innerHTML = '<div class="empty-state">No contacts match this filter. Click "+ Add Contact" to get started.</div>';
    return;
  }

  let html = '<div class="dossier-grid">';

  filtered.forEach((c, i) => {
    const rel = c.cancer_engineering_relevance || 'low';
    html += `<div class="dossier-card ${rel}">`;

    // Header with photo
    html += '<div class="dossier-header">';
    if (c.photo_url) {
      html += `<img class="dossier-photo" src="${c.photo_url}" alt="${c.name}" onerror="this.style.display='none'">`;
    }
    html += '<div class="dossier-header-text">';
    html += `<div class="dossier-name">${c.name}</div>`;
    html += `<div class="dossier-title">${c.title || ''}${c.role_detail ? ' — ' + c.role_detail : ''}</div>`;
    html += `<div style="margin-top:6px;"><span class="relevance-badge ${rel}">${rel} relevance</span>`;
    if (c.priority_reason) {
      html += `<span style="font-size:12px;color:var(--text-muted);margin-left:8px;">${c.priority_reason}</span>`;
    }
    html += '</div>';
    html += '</div>';
    html += `<div class="dossier-priority" title="Priority #${c.priority}">${c.priority || '—'}</div>`;
    html += '</div>';

    // Conversation Script (collapsible)
    if (c.conversation_script) {
      const cs = c.conversation_script;
      html += '<details class="convo-details">';
      html += '<summary>How to Talk to Them</summary>';
      html += '<div class="convo-body">';
      if (cs.opener) {
        html += `<div class="convo-step"><span class="convo-label">Open with:</span> <em>"${cs.opener}"</em></div>`;
      }
      if (cs.bridge_to_research) {
        html += `<div class="convo-step"><span class="convo-label">Bridge to your research:</span> ${cs.bridge_to_research}</div>`;
      }
      if (cs.dual_mandate) {
        html += `<div class="convo-step"><span class="convo-label">The dual mandate:</span> ${cs.dual_mandate}</div>`;
      }
      if (cs.tailored_hook) {
        html += `<div class="convo-step"><span class="convo-label">Hook for this person:</span> ${cs.tailored_hook}</div>`;
      }
      if (cs.ask) {
        html += `<div class="convo-step"><span class="convo-label">Your ask:</span> <em>"${cs.ask}"</em></div>`;
      }
      html += '</div>';
      html += '</details>';
    }

    // Website (initiatives)
    if (c.website) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Website</div>';
      html += `<p><a href="${c.website}" target="_blank" rel="noopener">${c.website}</a></p>`;
      html += '</div>';
    }

    // Mission (initiatives)
    if (c.mission) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Mission</div>';
      html += `<p>${c.mission}</p>`;
      html += '</div>';
    }

    // Background
    if (c.background) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Background</div>';
      html += `<p>${c.background}</p>`;
      html += '</div>';
    }

    // Education
    if (c.education) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Education</div>';
      html += `<p>${c.education}</p>`;
      html += '</div>';
    }

    // Leadership (initiatives)
    if (c.leadership && c.leadership.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Leadership</div>';
      html += '<ul>';
      c.leadership.forEach(l => {
        const linkRef = l.id ? ` <small style="color:var(--text-muted);">(see Collaborators → ${l.id})</small>` : '';
        const mailto = l.email ? ` &mdash; <a href="mailto:${l.email}">${l.email}</a>` : '';
        html += `<li><strong>${l.name}</strong>${l.role ? ' — ' + l.role : ''}${mailto}${linkRef}</li>`;
      });
      html += '</ul>';
      html += '</div>';
    }

    // Partner institutions (initiatives)
    if (c.partner_institutions && c.partner_institutions.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Partner Institutions</div>';
      html += '<ul>';
      c.partner_institutions.forEach(p => { html += `<li>${p}</li>`; });
      html += '</ul>';
      html += '</div>';
    }

    // Funding sources (initiatives)
    if (c.funding_sources && c.funding_sources.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Funding Sources</div>';
      html += '<ul>';
      c.funding_sources.forEach(f => { html += `<li>${f}</li>`; });
      html += '</ul>';
      html += '</div>';
    }

    // Research capabilities (initiatives) / research focus (collaborators)
    if (c.research_capabilities && c.research_capabilities.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Research Capabilities</div>';
      html += '<ul>';
      c.research_capabilities.forEach(r => { html += `<li>${r}</li>`; });
      html += '</ul>';
      html += '</div>';
    }
    if (c.research_focus && c.research_focus.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Research Focus</div>';
      html += '<ul>';
      c.research_focus.forEach(r => { html += `<li>${r}</li>`; });
      html += '</ul>';
      html += '</div>';
    }

    // Key publications (collaborators)
    if (c.key_publications && c.key_publications.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Key Publications</div>';
      html += '<ul>';
      c.key_publications.forEach(p => { html += `<li>${p}</li>`; });
      html += '</ul>';
      html += '</div>';
    }

    // Lab contribution opportunities (initiatives)
    if (c.lab_contribution_opportunities && c.lab_contribution_opportunities.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">How the McGhee Lab Can Contribute</div>';
      html += '<ul>';
      c.lab_contribution_opportunities.forEach(op => {
        if (typeof op === 'string') {
          html += `<li>${op}</li>`;
        } else {
          html += `<li><strong>${op.title}</strong>${op.description ? ' — ' + op.description : ''}</li>`;
        }
      });
      html += '</ul>';
      html += '</div>';
    }

    // Initiative link (collaborators)
    if (c.initiative_link) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Linked Initiative</div>';
      html += `<p><a href="#" onclick="goToInitiative('${c.initiative_link}'); return false;">${c.initiative_link}</a> <small style="color:var(--text-muted);">(switch to Initiatives tab)</small></p>`;
      html += '</div>';
    }

    // Phone / Office (collaborators)
    if (c.phone || c.office) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Direct Contact</div>';
      if (c.phone) html += `<p>${c.phone}</p>`;
      if (c.office) html += `<p style="color:var(--text-muted);font-size:12px;">${c.office}</p>`;
      html += '</div>';
    }

    // Term / Appointed by
    if (c.term || c.appointed_by) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Appointment</div>';
      html += `<p>${c.term || ''}${c.appointed_by ? ' — Appointed by ' + c.appointed_by : ''}</p>`;
      html += '</div>';
    }

    // Relevance notes
    if (c.relevance_notes) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Cancer Engineering Relevance</div>';
      html += `<p>${c.relevance_notes}</p>`;
      html += '</div>';
    }

    // Talking points
    if (c.talking_points && c.talking_points.length) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Quick Talking Points</div>';
      html += '<ul>';
      c.talking_points.forEach(tp => { html += `<li>${tp}</li>`; });
      html += '</ul>';
      html += '</div>';
    }

    // Email
    if (c.email) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Contact</div>';
      html += `<p><a href="mailto:${c.email}">${c.email}</a></p>`;
      html += '</div>';
    }

    // Notes
    if (c.notes) {
      html += '<div class="dossier-section">';
      html += '<div class="dossier-section-label">Notes</div>';
      html += `<p>${c.notes}</p>`;
      html += '</div>';
    }

    // Actions
    html += `<div class="dossier-section" style="margin-top:16px;border-top:1px solid var(--border,#e0e0e0);padding-top:12px;">`;
    html += `<button onclick="editContact(${i})" style="font-size:12px;margin-right:8px;">Edit</button>`;
    html += `<button onclick="deleteContact(${i})" style="font-size:12px;">Delete</button>`;
    html += '</div>';

    html += '</div>';
  });

  html += '</div>';
  content.innerHTML = html;
}

/* ---- Cross-tab navigation ---- */

window.goToInitiative = function (id) {
  activeTab = 'initiatives';
  activeFilter = 'all';
  loadAndRender().then(function () {
    const el = document.querySelector('.dossier-card');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
};

/* ---- CRUD ---- */

function _ipToastError(label) {
  return function (err) {
    console.error('[important-people] ' + label + ' failed:', err);
    if (window.TOAST) TOAST.error('Save failed: ' + label, { detail: err.message });
  };
}

window.editContact = async function (index) {
  const cat = currentCategory();
  const data = await api.load(cat.file);
  const item = data.contacts[index];

  openForm({
    title: 'Edit Contact',
    fields: CONTACT_FIELDS,
    values: item,
    onSave: (vals) => {
      Object.assign(data.contacts[index], vals);
      data.contacts[index].id = slugify(vals.name);
      // Optimistic: re-paint from in-memory data, fire save in background
      loadAndRender();
      api.save(cat.file, data).catch(_ipToastError('edit contact'));
    },
  });
};

window.deleteContact = async function (index) {
  if (!confirm('Remove this contact?')) return;
  const cat = currentCategory();
  const data = await api.load(cat.file);
  data.contacts.splice(index, 1);
  loadAndRender();
  api.save(cat.file, data).catch(_ipToastError('delete contact'));
};

document.getElementById('add-contact').onclick = () => {
  openForm({
    title: 'Add Contact',
    fields: CONTACT_FIELDS,
    onSave: async (vals) => {
      const cat = currentCategory();
      const data = await api.load(cat.file);
      vals.id = slugify(vals.name);
      vals.talking_points = [];
      data.contacts.push(vals);
      loadAndRender();
      api.save(cat.file, data).catch(_ipToastError('add contact'));
    },
  });
};

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) await firebridge.whenAuthResolved();
  await loadAndRender();
  // No LIVE_SYNC.attach: rarely-edited contact lists; cached api.load handles
  // cross-tab updates on reload.
})();
