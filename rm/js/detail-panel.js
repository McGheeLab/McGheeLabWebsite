/* detail-panel.js — shared expandable row with subtask management
 *
 * Usage in page JS:
 *
 *   // 1. When building table rows, use expandableRow() instead of raw <tr>:
 *   html += expandableRow(i, colCount, cellsHtml, item, metaFields, dataPath, dataKey);
 *
 *   // 2. After setting innerHTML, call bindExpandableRows()
 */

const SUBTASK_FIELDS = [
  { key: 'title', label: 'Task', type: 'text', required: true },
  { key: 'deadline', label: 'Deadline', type: 'date' },
  { key: 'scheduled', label: 'Scheduled For', type: 'date' },
  { key: 'status', label: 'Status', type: 'select', options: ['pending', 'in_progress', 'completed'] },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

/* Track which row index is expanded (-1 = none) */
let _expandedIndex = -1;
let _expandContext = null; // { dataPath, dataKey, rerender }

function setExpandContext(dataPath, dataKey, rerender) {
  _expandContext = { dataPath, dataKey, rerender };
  _expandedIndex = -1;
}

/**
 * Build an expandable table row + hidden detail row.
 * @param {number} idx - item index
 * @param {number} colCount - total columns in the table
 * @param {string} cellsHtml - the <td>...</td> cells for the main row (WITHOUT <tr> wrapper)
 * @param {object} item - the data item
 * @param {Array} metaFields - array of {label, value} to show in detail panel metadata grid
 * @returns {string} HTML for both the main row and the hidden detail row
 */
function expandableRow(idx, colCount, cellsHtml, item, metaFields) {
  const subtasks = item.subtasks || [];
  const completedCount = subtasks.filter(s => s.status === 'completed').length;
  const totalCount = subtasks.length;
  const progressBadge = totalCount > 0
    ? ` <span class="chip chip-muted" style="font-size:11px;margin-left:4px">${completedCount}/${totalCount}</span>`
    : '';

  // Inject progress badge into the first <td>
  let augmentedCells = cellsHtml;
  const firstTdEnd = augmentedCells.indexOf('</td>');
  if (firstTdEnd > -1) {
    augmentedCells = augmentedCells.slice(0, firstTdEnd) + progressBadge + augmentedCells.slice(firstTdEnd);
  }

  // Build meta grid
  let metaHtml = '';
  if (metaFields && metaFields.length) {
    metaHtml = '<div class="detail-meta">';
    for (const mf of metaFields) {
      if (mf.value !== undefined && mf.value !== null && mf.value !== '') {
        metaHtml += `<div class="detail-meta-item"><span class="detail-meta-label">${mf.label}</span><span class="detail-meta-value">${mf.value}</span></div>`;
      }
    }
    metaHtml += '</div>';
  }

  // Notes
  const notesHtml = item.notes
    ? `<div class="detail-notes">${item.notes}</div>`
    : '';

  // Subtasks
  let subtaskHtml = `<div class="subtask-header"><h3>Tasks / Next Steps</h3><button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); addSubtask(${idx})">+ Add Task</button></div>`;
  if (subtasks.length === 0) {
    subtaskHtml += '<div class="subtask-empty">No tasks yet. Add one to plan your next steps.</div>';
  } else {
    subtaskHtml += '<ul class="subtask-list">';
    subtasks.forEach((st, si) => {
      const done = st.status === 'completed';
      subtaskHtml += `<li class="subtask-item">
        <input type="checkbox" ${done ? 'checked' : ''} onclick="event.stopPropagation(); toggleSubtask(${idx}, ${si})">
        <span class="subtask-title${done ? ' done' : ''}">${st.title}</span>
        <span class="subtask-dates">`;
      if (st.deadline && st.deadline !== 'TBD') subtaskHtml += `<span>Due: ${formatDate(st.deadline)} ${deadlineChip(st.deadline)}</span>`;
      if (st.scheduled && st.scheduled !== 'TBD') subtaskHtml += `<span>Scheduled: ${formatDate(st.scheduled)}</span>`;
      subtaskHtml += `</span>
        <span class="subtask-actions">
          <button onclick="event.stopPropagation(); editSubtask(${idx}, ${si})">Edit</button>
          <button onclick="event.stopPropagation(); deleteSubtask(${idx}, ${si})">Del</button>
        </span>
      </li>`;
    });
    subtaskHtml += '</ul>';
  }

  return `<tr class="expandable-row" onclick="toggleDetail(${idx})" data-idx="${idx}">${augmentedCells}</tr>
    <tr class="detail-row" id="detail-${idx}"><td colspan="${colCount}"><div class="detail-panel">${metaHtml}${notesHtml}${subtaskHtml}</div></td></tr>`;
}

/* Toggle detail panel visibility */
window.toggleDetail = function(idx) {
  const allRows = document.querySelectorAll('.expandable-row');
  const allDetails = document.querySelectorAll('.detail-row');

  if (_expandedIndex === idx) {
    // Collapse
    allRows.forEach(r => r.classList.remove('expanded'));
    allDetails.forEach(r => r.classList.remove('open'));
    _expandedIndex = -1;
    return;
  }

  // Collapse all, then expand the target
  allRows.forEach(r => r.classList.remove('expanded'));
  allDetails.forEach(r => r.classList.remove('open'));

  const row = document.querySelector(`tr.expandable-row[data-idx="${idx}"]`);
  const detail = document.getElementById(`detail-${idx}`);
  if (row) row.classList.add('expanded');
  if (detail) detail.classList.add('open');
  _expandedIndex = idx;
};

/* Subtask CRUD */

window.addSubtask = function(itemIdx) {
  openForm({
    title: 'Add Task',
    fields: SUBTASK_FIELDS,
    onSave: async (vals) => {
      const ctx = _expandContext;
      const data = await api.load(ctx.dataPath);
      const item = data[ctx.dataKey][itemIdx];
      if (!item.subtasks) item.subtasks = [];
      vals.id = slugify(vals.title);
      item.subtasks.push(vals);
      await api.save(ctx.dataPath, data);
      _expandedIndex = itemIdx;
      ctx.rerender();
    },
  });
};

window.editSubtask = function(itemIdx, subIdx) {
  (async () => {
    const ctx = _expandContext;
    const data = await api.load(ctx.dataPath);
    const sub = data[ctx.dataKey][itemIdx].subtasks[subIdx];
    openForm({
      title: 'Edit Task',
      fields: SUBTASK_FIELDS,
      values: sub,
      onSave: async (vals) => {
        Object.assign(data[ctx.dataKey][itemIdx].subtasks[subIdx], vals);
        await api.save(ctx.dataPath, data);
        _expandedIndex = itemIdx;
        ctx.rerender();
      },
    });
  })();
};

window.toggleSubtask = async function(itemIdx, subIdx) {
  const ctx = _expandContext;
  const data = await api.load(ctx.dataPath);
  const sub = data[ctx.dataKey][itemIdx].subtasks[subIdx];
  sub.status = sub.status === 'completed' ? 'pending' : 'completed';
  await api.save(ctx.dataPath, data);
  _expandedIndex = itemIdx;
  ctx.rerender();
};

window.deleteSubtask = async function(itemIdx, subIdx) {
  if (!confirmAction('Remove this task?')) return;
  const ctx = _expandContext;
  const data = await api.load(ctx.dataPath);
  data[ctx.dataKey][itemIdx].subtasks.splice(subIdx, 1);
  await api.save(ctx.dataPath, data);
  _expandedIndex = itemIdx;
  ctx.rerender();
};
