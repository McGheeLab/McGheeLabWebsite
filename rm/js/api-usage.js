/* API Usage page.
 *
 * Flow:
 *   1. On load, POST /api/suggest-tasks/plan — runs both LLM scripts with
 *      --dry-run and returns counts + estimated tokens + estimated cost.
 *   2. Render the plan so the user knows exactly what would happen.
 *   3. On Run, POST /api/suggest-tasks/start — returns a run_id.
 *   4. Poll /api/suggest-tasks/status?run_id=... every 2s for progress +
 *      live token totals + log tail. Show a Stop button while running.
 *   5. On Stop, POST /api/suggest-tasks/stop with {run_id}.
 */

const $ = (id) => document.getElementById(id);  // util.js already owns `el`

let currentRunId = null;
let pollTimer = null;
let currentPlan = null;
// Model choice per LLM step — populated from /plan response on first load.
// Script keys match the backend: email_classify_llm, suggest_tasks.
let chosenModels = {
  email_classify_llm: 'claude-haiku-4-5',
  suggest_tasks:      'claude-haiku-4-5',
};
let availableModels = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];

document.addEventListener('DOMContentLoaded', async () => {
  $('btn-plan').addEventListener('click', loadPlan);
  $('btn-run').addEventListener('click', startRun);
  $('btn-stop').addEventListener('click', stopRun);
  $('btn-tr-reload').addEventListener('click', loadTraining);
  $('tr-limit').addEventListener('change', loadTraining);

  // If there's already a recent run (maybe left running in another tab), show it.
  const r = await fetch('/api/suggest-tasks/status').then(r => r.json()).catch(() => null);
  if (r && r.ok && r.run_id) {
    const status = (r.state || {}).status;
    if (status === 'running') {
      currentRunId = r.run_id;
      $('btn-run').disabled = true;
      $('btn-stop').style.display = '';
      showRunning();
      startPolling();
      loadTraining();  // async, doesn't block
      return;
    } else if (status) {
      // Show the last run's result so the user has context, but still fetch a plan.
      currentRunId = r.run_id;
      renderStatus(r);
    }
  }
  loadPlan();
  loadTraining();
});

function setStatus(txt, cls) {
  const s = $('api-status');
  s.textContent = txt;
  s.className = 'api-status ' + (cls || '');
}

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtCost(usd) {
  if (usd == null) return '—';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return '$' + usd.toFixed(3);
  return '$' + usd.toFixed(2);
}

async function loadPlan() {
  setStatus('checking plan (no API calls)…', 'running');
  $('btn-run').disabled = true;
  $('plan-body').innerHTML = '<span class="muted">Dry-running both LLM scripts…</span>';
  try {
    const r = await fetch('/api/suggest-tasks/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classify_model: chosenModels.email_classify_llm,
        suggest_model:  chosenModels.suggest_tasks,
      }),
    }).then(r => r.json());
    if (!r.ok) {
      setStatus('plan failed — see log below', 'err');
    }
    if (Array.isArray(r.available_models) && r.available_models.length) {
      availableModels = r.available_models;
    }
    currentPlan = r;
    renderPlan(r);
    if (r.ok) {
      $('btn-run').disabled = false;
      setStatus('plan ready — review then click Run', '');
    }
  } catch (e) {
    setStatus('plan error: ' + e.message, 'err');
  }
}

function renderPlan(plan) {
  const steps = plan.steps || [];
  const nonLlm = plan.non_llm_steps || [];
  const t = plan.total_tokens || {};
  const cost = plan.est_cost_usd;

  const llmBlocks = steps.map((s, i) => renderLlmStepRow(s, i)).join('');

  const localBlocks = nonLlm.map((s, i) => `
    <div class="step-row">
      <div class="idx">${steps.length + i + 1}</div>
      <div class="lbl">${escapeHtml(s.label)} <span class="kind local">local</span>
        <div class="muted" style="font-size:12px;margin-top:3px">No API calls — runs locally.</div></div>
      <div class="muted" style="font-size:12px">—</div>
      <div></div>
    </div>`).join('');

  const metrics = `<div class="api-grid" style="margin-bottom:14px">
    <div class="api-metric"><div class="lbl">Total input</div><div class="big">${fmt(t.input)}</div><div class="sub">tokens</div></div>
    <div class="api-metric"><div class="lbl">Total output</div><div class="big">${fmt(t.output)}</div><div class="sub">tokens</div></div>
    <div class="api-metric"><div class="lbl">Cache read / write</div><div class="big">${fmt(t.cache_read)} / ${fmt(t.cache_write)}</div><div class="sub">tokens</div></div>
    <div class="api-metric"><div class="lbl">Estimated cost</div><div class="big cost">${fmtCost(cost)}</div><div class="sub">selected models, USD</div></div>
  </div>`;

  const pricing = renderPricingFooter(plan.pricing_table || {});

  $('plan-body').innerHTML = metrics + llmBlocks + localBlocks + pricing;

  // Wire up per-step model <select> change → re-plan. Show an immediate
  // "recalculating…" hint so the user sees feedback before the subprocess
  // dry-run returns (~500ms).
  $('plan-body').querySelectorAll('select[data-step]').forEach(sel => {
    sel.addEventListener('change', (ev) => {
      const step = ev.target.getAttribute('data-step');
      chosenModels[step] = ev.target.value;
      setStatus('model changed → recalculating…', 'running');
      $('plan-body').querySelectorAll('.api-metric .big.cost').forEach(node => {
        node.textContent = '…';
      });
      loadPlan();
    });
  });
}

function renderLlmStepRow(s, i) {
  if (!s.plan) {
    return `<div class="step-row"><div class="idx">${i + 1}</div>
      <div class="lbl">${escapeHtml(s.key)} <span class="kind">llm</span>
        <div class="muted" style="font-size:12px;margin-top:3px">no plan — ${escapeHtml(s.stderr_tail || 'dry-run failed')}</div>
        ${renderModelPicker(s.key, s.model)}
      </div>
      <div></div><div></div></div>`;
  }
  const p = s.plan;
  let detail = '';
  let expandLabel = 'Show prompt + sample batch';
  if (s.key === 'email_classify_llm') {
    detail = `<b>${p.pending_emails}</b> pending emails of ${p.total_emails} total (${p.already_done} already classified). `
           + `${p.batches} batches × ${p.batch_size} emails, concurrency ${p.concurrency}.`;
    expandLabel = `What each Haiku call will see (system prompt + ${p.sample_size || p.batch_size} sample emails)`;
  } else if (s.key === 'suggest_tasks') {
    const src = p.bundles_by_source || {};
    const srcHtml = Object.keys(src).length
      ? `<div class="src-split">${Object.entries(src).map(([k, v]) => `<span>${v} ${k}</span>`).join('')}</div>`
      : '';
    detail = `<b>${p.bundles}</b> task bundles to refine. `
           + `${p.batches} batches × ${p.batch_size} bundles, concurrency ${p.concurrency}. `
           + `Every bundle is re-refined each run (no per-bundle cache).`
           + srcHtml;
    expandLabel = `What each call will see (system prompt + ${p.sample_size || p.batch_size} sample bundles)`;
  }
  const priceTag = s.est_cost_usd != null
    ? `<span class="muted" style="font-size:12px;margin-left:6px">· ${fmtCost(s.est_cost_usd)}</span>`
    : '';
  return `<div class="step-row">
    <div class="idx">${i + 1}</div>
    <div class="lbl">${escapeHtml(p.script || s.key)} <span class="kind">${escapeHtml(s.model || p.model || 'llm')}</span>${priceTag}
      <div class="muted" style="font-size:12px;margin-top:3px">${detail}</div>
      ${renderModelPicker(s.key, s.model || p.model)}
      <details class="step-details">
        <summary>${escapeHtml(expandLabel)}</summary>
        <div class="detail-lbl">System prompt (${p.system_prompt ? p.system_prompt.length : 0} chars; cached after first call)</div>
        <pre>${escapeHtml(p.system_prompt || '(none)')}</pre>
        <div class="detail-lbl">Sample user message — one batch (${p.sample_user_message ? p.sample_user_message.length : 0} chars)</div>
        <pre>${escapeHtml(p.sample_user_message || '(no pending items to sample)')}</pre>
      </details>
    </div>
    <div class="muted" style="font-size:12px">
      in: ${fmt(p.est_input_tokens)} · out: ${fmt(p.est_output_tokens)}<br>
      cache rd/wr: ${fmt(p.est_cache_read_tokens)}/${fmt(p.est_cache_write_tokens)}
    </div>
    <div></div>
  </div>`;
}

function renderModelPicker(stepKey, selected) {
  const value = selected || chosenModels[stepKey] || availableModels[0];
  chosenModels[stepKey] = value;
  const opts = availableModels.map(m => `<option value="${escapeHtml(m)}"${m === value ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
  return `<label class="model-picker">Model:
    <select data-step="${escapeHtml(stepKey)}">${opts}</select>
  </label>`;
}

function renderPricingFooter(table) {
  const rows = Object.entries(table).map(([m, p]) => {
    return `<div>${escapeHtml(m)}: in $${p.input}, out $${p.output}, cache rd $${p.cache_read}, cache wr $${p.cache_write}</div>`;
  }).join('');
  return `<div class="pricing-footer"><b>Pricing per 1M tokens (estimate, 4 chars/token):</b>${rows}</div>`;
}

async function startRun() {
  const msg = 'Start the suggester?\n\n'
    + '  classify model: ' + chosenModels.email_classify_llm + '\n'
    + '  suggest model:  ' + chosenModels.suggest_tasks + '\n'
    + '  estimated cost: ' + fmtCost(currentPlan?.est_cost_usd);
  if (!confirm(msg)) return;
  setStatus('starting run…', 'running');
  $('btn-run').disabled = true;
  try {
    const r = await fetch('/api/suggest-tasks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classify_model: chosenModels.email_classify_llm,
        suggest_model:  chosenModels.suggest_tasks,
      }),
    }).then(r => r.json());
    if (!r.ok) {
      setStatus('start failed: ' + (r.error || 'unknown'), 'err');
      $('btn-run').disabled = false;
      return;
    }
    currentRunId = r.run_id;
    $('btn-stop').style.display = '';
    showRunning();
    startPolling();
  } catch (e) {
    setStatus('start error: ' + e.message, 'err');
    $('btn-run').disabled = false;
  }
}

async function stopRun() {
  if (!currentRunId) return;
  if (!confirm('Stop the current run? In-progress batches may complete before the script exits.')) return;
  $('btn-stop').disabled = true;
  try {
    await fetch('/api/suggest-tasks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: currentRunId }),
    });
    setStatus('stop requested…', 'running');
  } catch (e) {
    setStatus('stop error: ' + e.message, 'err');
  } finally {
    $('btn-stop').disabled = false;
  }
}

function showRunning() {
  $('run-card').style.display = '';
  $('log-card').style.display = '';
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStatus, 2000);
  pollStatus();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollStatus() {
  if (!currentRunId) return;
  try {
    const r = await fetch('/api/suggest-tasks/status?run_id=' + encodeURIComponent(currentRunId)).then(r => r.json());
    if (!r.ok) return;
    renderStatus(r);
    const s = (r.state || {}).status;
    if (s === 'done' || s === 'failed' || s === 'stopped') {
      stopPolling();
      $('btn-stop').style.display = 'none';
      $('btn-run').disabled = false;
      const msg = s === 'done' ? 'Run complete.' : s === 'stopped' ? 'Run stopped.' : 'Run failed — see log.';
      setStatus(msg, s === 'done' ? 'done' : s === 'failed' ? 'err' : '');
    } else if (s === 'running') {
      setStatus('running — polling every 2s', 'running');
    }
  } catch (e) {
    // Transient network issue — keep polling.
  }
}

function renderStatus(r) {
  showRunning();
  const state = r.state || {};
  const steps = state.steps || [];
  const progress = r.progress_by_script || {};
  const t = r.totals || {};
  const cost = r.actual_cost_usd;

  const stepRows = steps.map((s, i) => {
    const key = s.key;
    const kind = s.llm
      ? `<span class="kind">${escapeHtml(s.model || 'llm')}</span>`
      : '<span class="kind local">local</span>';
    let bar = '';
    let costChip = '';
    if (s.llm && progress[key]) {
      const p = progress[key];
      const pct = p.total_batches ? Math.min(100, (p.batches_done / p.total_batches) * 100) : 0;
      bar = `<div class="prog"><span style="width:${pct.toFixed(1)}%"></span></div>
             <div class="muted" style="font-size:11px;margin-top:3px">${p.batches_done}/${p.total_batches} batches · ${p.items_done}/${p.total_items} items · ${fmtCost(p.est_cost_usd)}</div>`;
      costChip = fmtCost(p.est_cost_usd);
    }
    return `<div class="step-row">
      <div class="idx">${i + 1}</div>
      <div class="lbl">${escapeHtml(s.label)} ${kind}
        <div class="muted" style="font-size:12px;margin-top:3px">
          ${s.started_at ? 'started ' + s.started_at : 'waiting'}${s.ended_at ? ' · ended ' + s.ended_at : ''}
        </div>
        ${bar}
      </div>
      <div class="muted" style="font-size:12px">${costChip}${s.returncode != null ? '<br>rc=' + s.returncode : ''}</div>
      <div><span class="stat ${s.status}">${s.status}</span></div>
    </div>`;
  }).join('');

  const metrics = `<div class="api-grid" style="margin-bottom:14px">
    <div class="api-metric"><div class="lbl">Status</div><div class="big">${state.status || '—'}</div><div class="sub">run ${state.run_id || ''}</div></div>
    <div class="api-metric"><div class="lbl">Actual input</div><div class="big">${fmt(t.input_tokens)}</div><div class="sub">tokens used</div></div>
    <div class="api-metric"><div class="lbl">Actual output</div><div class="big">${fmt(t.output_tokens)}</div><div class="sub">tokens used</div></div>
    <div class="api-metric"><div class="lbl">Cache rd / wr</div><div class="big">${fmt(t.cache_read_input_tokens)} / ${fmt(t.cache_creation_input_tokens)}</div><div class="sub">tokens</div></div>
    <div class="api-metric"><div class="lbl">Actual cost</div><div class="big cost">${fmtCost(cost)}</div><div class="sub">so far, USD</div></div>
  </div>`;

  $('run-body').innerHTML = metrics + stepRows;

  const log = state.log_tail || '';
  $('log-body').textContent = log || '(no output yet)';
  $('log-body').scrollTop = $('log-body').scrollHeight;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* --------------- Training set editor --------------- */

async function loadTraining() {
  const limit = $('tr-limit').value || 100;
  $('tr-summary').textContent = 'Loading…';
  try {
    const r = await fetch('/api/training/list?limit=' + encodeURIComponent(limit)).then(r => r.json());
    if (!r.ok) {
      $('tr-summary').textContent = 'failed to load training set';
      return;
    }
    renderTraining(r);
  } catch (e) {
    $('tr-summary').textContent = 'error: ' + e.message;
  }
}

function renderTraining(r) {
  $('tr-summary').innerHTML =
    `<b>${r.total}</b> total entries · showing ${r.shown} most-recent `
    + `· <b>last ${r.llm_context_size}</b> are fed into the suggester's prompt each run `
    + `(<span style="color:var(--primary);font-weight:600">IN PROMPT</span> badge)`;

  const head = `<div class="tr-head">
    <div>Timestamp</div>
    <div>Action</div>
    <div>Title / source</div>
    <div>Category : sub</div>
    <div>Hours</div>
    <div></div>
  </div>`;

  const rows = (r.entries || []).map(e => {
    const ctx = e.in_llm_context ? '<span class="ctx-badge">IN PROMPT</span>' : '';
    const src = e.source ? `<span class="src">· ${escapeHtml(e.source)}</span>` : '';
    const title = escapeHtml(e.title || e.task_id || '(no title)');
    const cat = e.category || '';
    const sub = e.sub_category || '';
    const hrs = (e.hours != null && e.hours !== '') ? e.hours : '';
    const actCls = (e.action || '').toLowerCase();
    return `<div class="tr-row" data-ts="${escapeHtml(e.ts)}">
      <div class="ts">${escapeHtml(e.ts)}</div>
      <div><span class="act ${escapeHtml(actCls)}">${escapeHtml(e.action || '')}</span></div>
      <div class="title" title="${title}">${title}${src}${ctx}</div>
      <div class="catsub">
        <input type="text" data-field="category"     value="${escapeHtml(cat)}" placeholder="research">
        <input type="text" data-field="sub_category" value="${escapeHtml(sub)}" placeholder="grant">
      </div>
      <div><input type="number" step="0.05" data-field="hours" value="${escapeHtml(String(hrs))}" placeholder=""></div>
      <div style="display:flex;gap:4px;justify-content:flex-end">
        <button class="btn-save" data-act="save" title="Save changes">Save</button>
        <button class="btn-del"  data-act="del"  title="Delete this training entry">Del</button>
      </div>
    </div>`;
  }).join('');

  $('tr-list').innerHTML = head + rows;

  // Wire row actions
  $('tr-list').querySelectorAll('.tr-row').forEach(row => {
    const ts = row.getAttribute('data-ts');
    row.querySelector('[data-act="save"]').addEventListener('click', async () => {
      const inputs = row.querySelectorAll('input[data-field]');
      const patch = { ts };
      inputs.forEach(i => {
        const f = i.getAttribute('data-field');
        if (f === 'hours') {
          if (i.value !== '') patch.hours = parseFloat(i.value);
        } else {
          patch[f] = i.value;
        }
      });
      await saveTraining(patch);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm('Delete this training entry?\n\n' + ts + '\nThis modifies training.md (LLM prompt context) and training.jsonl. A .bak is written.')) return;
      await deleteTraining(ts);
    });
  });
}

async function saveTraining(patch) {
  try {
    const r = await fetch('/api/training/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(r => r.json());
    if (!r.ok) { alert('save failed: ' + (r.error || 'unknown')); return; }
    loadTraining();
  } catch (e) {
    alert('save error: ' + e.message);
  }
}

async function deleteTraining(ts) {
  try {
    const r = await fetch('/api/training/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts }),
    }).then(r => r.json());
    if (!r.ok) { alert('delete failed: ' + (r.error || 'unknown')); return; }
    loadTraining();
  } catch (e) {
    alert('delete error: ' + e.message);
  }
}
