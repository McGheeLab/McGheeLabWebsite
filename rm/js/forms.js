/* forms.js — generic modal form builder
 *
 * Usage:
 *   openForm({
 *     title: 'Add Person',
 *     fields: [
 *       { key: 'name', label: 'Name', type: 'text', required: true },
 *       { key: 'role', label: 'Role', type: 'select', options: ['PI','Postdoc','PhD','MS','Undergrad','Staff'] },
 *       { key: 'start', label: 'Start Date', type: 'date' },
 *       { key: 'notes', label: 'Notes', type: 'textarea' },
 *     ],
 *     values: {},               // pre-fill for editing
 *     onSave: async (data) => { ... },
 *   });
 */

/* V3.571 — inside the Ourlab phone app, forms render as the standard
 * fold-up bottom sheet (APP_SHEET) instead of the centered desktop modal.
 * This makes every openForm() call across the app consistent with the My
 * Day / Team Focus composers and, because the sheet forces 16px inputs,
 * kills the iOS focus-zoom. Desktop web is untouched. */
function _ourlabAppForm() {
  try {
    if (document.body && document.body.classList.contains('ourlab-app')) return true;
    if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) return true;
    if (/[?&]mobileShell=1/.test(location.search)) return true;
    return sessionStorage.getItem('ourlab-shell-preview') === '1';
  } catch (e) { return false; }
}

/* Build one field's `.form-group` (label + control). Returns { group, input }.
 * Shared by the desktop modal and the app fold-up so both stay identical. */
function _buildFormField(f, values) {
  const group = document.createElement('div');
  group.className = 'form-group';

  const label = document.createElement('label');
  label.textContent = f.label + (f.required ? ' *' : '');
  group.appendChild(label);

  let input;
  if (f.type === 'select') {
    input = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select —';
    input.appendChild(blank);
    (f.options || []).forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = (f.optionLabels && f.optionLabels[opt]) ? f.optionLabels[opt] : opt.replace(/_/g, ' ');
      if (values[f.key] === opt) o.selected = true;
      input.appendChild(o);
    });
  } else if (f.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 3;
    input.value = values[f.key] || '';
  } else if (f.type === 'checkbox') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!values[f.key];
    input.style.width = 'auto';
  } else if (f.type === 'stars') {
    // 0-5 importance stars. Stores the numeric value on input._starsValue
    // so the save handler picks it up via the standard value collection.
    input = document.createElement('div');
    input._starsValue = Number(values[f.key]) || 0;
    const mount = (val) => {
      input.innerHTML = '';
      const bar = (window.YR_SHARED && window.YR_SHARED.starBar)
        ? window.YR_SHARED.starBar(val, (v) => { input._starsValue = v; mount(v); }, 18)
        : null;
      if (bar) input.appendChild(bar);
    };
    mount(input._starsValue);
  } else {
    input = document.createElement('input');
    input.type = f.type || 'text';
    input.value = values[f.key] != null ? values[f.key] : '';
    if (f.placeholder) input.placeholder = f.placeholder;
  }

  if (f.required) input.required = true;
  group.appendChild(input);
  return { group, input };
}

/* Collect + validate. Returns the data object, or null if a required field
 * is empty (marking its border red — mirrors the original behavior). */
function _collectFormData(fields, inputs) {
  const data = {};
  for (const f of fields) {
    const inp = inputs[f.key];
    if (f.type === 'checkbox') {
      data[f.key] = inp.checked;
    } else if (f.type === 'number') {
      data[f.key] = inp.value ? Number(inp.value) : null;
    } else if (f.type === 'stars') {
      data[f.key] = Number(inp._starsValue) || 0;
    } else {
      data[f.key] = inp.value;
    }
    if (f.required && f.type !== 'stars' && !inp.value) {
      inp.style.borderColor = 'var(--red)';
      return null;
    }
  }
  return data;
}

/* App path: render the form inside the standard fold-up bottom sheet. */
function _openFormSheet({ title, fields, values, onSave }) {
  window.APP_SHEET.open({
    title: title,
    build: function (body, api) {
      const inputs = {};
      fields.forEach(f => {
        const { group, input } = _buildFormField(f, values);
        inputs[f.key] = input;
        body.appendChild(group);
      });

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => api.close();
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = 'Save';
      saveBtn.onclick = async () => {
        const data = _collectFormData(fields, inputs);
        if (data === null) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          await onSave(data);
          api.close();
        } catch (e) {
          alert('Save failed: ' + e.message);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
      };
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      body.appendChild(actions);
    }
  });
}

function openForm({ title, fields, values = {}, onSave }) {
  // App: fold-up bottom sheet (see _openFormSheet). Desktop: centered modal.
  if (_ourlabAppForm() && window.APP_SHEET) {
    _openFormSheet({ title, fields, values, onSave });
    return;
  }

  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  // Modal
  const modal = document.createElement('div');
  modal.className = 'modal';

  const heading = document.createElement('div');
  heading.className = 'modal-title';
  heading.textContent = title;
  modal.appendChild(heading);

  const inputs = {};

  fields.forEach(f => {
    const { group, input } = _buildFormField(f, values);
    inputs[f.key] = input;
    modal.appendChild(group);
  });

  // Actions
  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => overlay.remove();

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const data = _collectFormData(fields, inputs);
    if (data === null) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await onSave(data);
      overlay.remove();
    } catch (e) {
      alert('Save failed: ' + e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  };

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  // Close on overlay click or Escape (both guarded against drag-selects and
  // accidental dismissal that would wipe unsaved draft data).
  const doClose = () => { overlay.remove(); document.removeEventListener('keydown', esc); };
  const guard = safeCloseOnBackdrop(overlay, modal, doClose);
  const esc = e => { if (e.key === 'Escape') guard.confirmClose(doClose); };
  document.addEventListener('keydown', esc);

  document.body.appendChild(overlay);

  // Focus first input
  const firstInput = modal.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
}

/* Confirm dialog */
function confirmAction(message) {
  return window.confirm(message);
}
