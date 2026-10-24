#!/usr/bin/env node
/* Validate the PE-bead protocol imports the way RM will read them.
 *
 *   MATHJS=/path/to/node_modules/mathjs node Research/bead_confocal_protocols/validate.cjs
 *
 * 1. RM's own importer validator (rm/js/protocol-import.js, run in a vm sandbox).
 * 2. The symbol table as rm/js/protocol-formulas.js builds it: inputs first, then outputs in document order,
 *    each output rounded to its `decimals` before later outputs read it. Every output must be a finite number.
 * 3. Builders expanded with "Add all" (cartesian product, as protocol-graph.js does), derived fields evaluated
 *    with the same numeric-string coercion; calculator tables and layout-map cells evaluated per row.
 * 4. Every [!var:name] token resolves; prose has no "~" or "^" (the inline sub/superscript markers) and no
 *    colour emoji.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const math = require(process.env.MATHJS || 'mathjs');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'rm/js/protocol-import.js'), 'utf8'), sandbox);
const RM = sandbox.window.PROTOCOL_IMPORT;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}]/u;
const TOKEN = /\[!var:([a-zA-Z_][a-zA-Z0-9_]*)\]/g;

function coerceRow(row) {
  const out = {};
  for (const [k, v0] of Object.entries(row)) {
    let v = v0;
    if (typeof v === 'string' && v !== '') {
      const n = parseFloat(v);
      if (!isNaN(n) && isFinite(n) && String(n) === v.trim()) v = n;
    }
    out[k] = v;
  }
  return out;
}

function evalIn(expr, table, row) {
  const scope = {};
  for (const [k, s] of Object.entries(table)) if (typeof s.value === 'number') scope[k] = s.value;
  Object.assign(scope, coerceRow(row || {}));
  try { return { value: math.evaluate(expr, scope) }; } catch (e) { return { error: e.message }; }
}

function proseOf(b) {
  const out = [];
  const a = b.attrs || {};
  if (typeof b.body === 'string') out.push(b.body);
  if (a.description) out.push(a.description);
  if (Array.isArray(a.rows) && b.kind === 'table') a.rows.forEach(r => Object.values(r).forEach(v => out.push(String(v))));
  if (Array.isArray(a.items)) a.items.forEach(i => { out.push(i.term || ''); out.push(i.def || ''); });
  if (Array.isArray(a.marks)) a.marks.forEach(m => { out.push(m.at || ''); out.push(m.label || ''); out.push(m.sub || ''); });
  if (Array.isArray(a.rows) && b.kind === 'materials') a.rows.forEach(r => out.push(r.free_text || ''));
  if (a.title) out.push(a.title);
  if (Array.isArray(a.chips)) a.chips.forEach(c => out.push(c.text || ''));
  if (a.label) out.push(a.label);
  ['inputs', 'outputs'].forEach(k => (a[k] || []).forEach(x => { out.push(x.label || ''); out.push(x.unit || ''); out.push(x.rangeHint || ''); }));
  return out;
}

let failures = 0;
const fail = (file, msg) => { failures++; console.log('  FAIL ' + msg); };

const files = fs.readdirSync(HERE).filter(f => f.endsWith('.protocol-import.json')).sort();
for (const f of files) {
  console.log(f);
  const text = fs.readFileSync(path.join(HERE, f), 'utf8');
  const parsed = RM.parseJson(text);
  if (!parsed.ok) { fail(f, parsed.errors.join('; ')); continue; }
  const v = RM.validate(parsed.parsed);
  v.errors.forEach(e => fail(f, 'RM validate: ' + e));
  v.warnings.forEach(w => { console.log('  warn ' + w); });
  const s = RM.summarize(parsed.parsed);
  const blocks = [];
  parsed.parsed.protocol.tree.sections.forEach(sec => sec.children.forEach(b => blocks.push(b)));

  // symbol table: inputs (calculator inputs, formula variables, builder params) first
  const table = {};
  const define = (name, sym) => {
    if (table[name]) fail(f, 'duplicate variable name ' + name);
    table[name] = sym;
  };
  blocks.forEach(b => {
    const a = b.attrs || {};
    if (b.kind === 'calculator') (a.inputs || []).forEach(i => define(i.name, { value: Number(i.default) }));
    if (b.kind === 'formula') (a.variables || []).forEach(i => define(i.name, { value: Number(i.default) }));
    if (b.kind === 'builder') (a.params || []).forEach(i => define(i.name, { value: Number(i.default) }));
  });
  const shown = [];
  blocks.forEach(b => {
    const a = b.attrs || {};
    const outs = b.kind === 'calculator' ? (a.outputs || []).map(o => ({ name: o.name, expr: o.expr, dec: o.decimals, unit: o.unit }))
      : b.kind === 'formula' && a.output ? [{ name: a.output.name, expr: a.expression, dec: a.output.decimals, unit: a.output.unit }] : [];
    outs.forEach(o => {
      const r = evalIn(o.expr, table);
      if (r.error) { fail(f, 'output ' + o.name + ': ' + r.error); define(o.name, { value: null }); return; }
      if (typeof r.value !== 'number' || !isFinite(r.value)) { fail(f, 'output ' + o.name + ' is not a finite number: ' + r.value); define(o.name, { value: null }); return; }
      const dec = typeof o.dec === 'number' ? o.dec : 3;
      const rounded = parseFloat(r.value.toFixed(dec));
      if (rounded === 0 && r.value !== 0) fail(f, 'output ' + o.name + ' rounds to 0 at ' + dec + ' decimals (' + r.value + ')');
      define(o.name, { value: rounded });
      shown.push(o.name + '=' + rounded + (o.unit ? ' ' + o.unit : ''));
    });
  });

  // builders → datasets
  const datasets = {};
  blocks.filter(b => b.kind === 'builder').forEach(b => {
    const a = b.attrs;
    let sets = [{}];
    (a.dims || []).forEach(d => {
      const next = [];
      sets.forEach(s0 => (d.options || []).forEach(opt => next.push(Object.assign({}, s0, { [d.field]: opt }))));
      sets = next;
    });
    const rows = sets.map(ps => {
      const row = Object.assign({}, ps);
      (a.derived || []).forEach(df => {
        const r = evalIn(df.expr, table, row);
        if (r.error) fail(f, 'derived ' + df.field + ' ' + JSON.stringify(ps) + ': ' + r.error);
        row[df.field] = r.error ? null : r.value;
      });
      return row;
    });
    const keys = new Set(rows.map(r => JSON.stringify(r, Object.keys(r).sort())));
    if (keys.size !== rows.length) fail(f, 'builder ' + a.dataset + ': ' + (rows.length - keys.size) + ' rows would merge as duplicates');
    datasets[a.dataset] = rows;
    console.log('  builder ' + a.dataset + ': ' + rows.length + ' rows; first ' + JSON.stringify(rows[0]) + '; last ' + JSON.stringify(rows[rows.length - 1]));
  });
  blocks.filter(b => b.kind === 'calculator' && b.attrs.table && b.attrs.table.dataset).forEach(b => {
    const t = b.attrs.table; const rows = datasets[t.dataset];
    if (!rows) { fail(f, 'calculator table reads missing dataset ' + t.dataset); return; }
    rows.forEach(row => t.columns.forEach(c => { const r = evalIn(c.expr, table, row); if (r.error) fail(f, 'table column ' + c.label + ': ' + r.error); }));
  });
  blocks.filter(b => b.kind === 'layoutMap').forEach(b => {
    const a = b.attrs; const rows = datasets[a.dataset];
    if (!rows) { fail(f, 'layout map reads missing dataset ' + a.dataset); return; }
    if (rows.length > a.rows * a.cols) fail(f, 'layout map overflows: ' + rows.length + ' > ' + a.rows * a.cols);
    rows.forEach(row => [a.cellLabel, a.cellSub].filter(Boolean).forEach(e => { const r = evalIn(e, table, row); if (r.error) fail(f, 'layout cell ' + e + ': ' + r.error); }));
    console.log('  plate ' + a.rows + 'x' + a.cols + ': ' + rows.length + ' filled, ' + (a.rows * a.cols - rows.length) + ' spare');
  });

  // tokens, sub/superscript markers, emoji
  blocks.forEach(b => proseOf(b).forEach(t => {
    let m; TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(t)) !== null) if (!table[m[1]]) fail(f, 'token [!var:' + m[1] + '] has no variable');
    const plain = t.replace(TOKEN, '');
    if (/[~^]/.test(plain)) fail(f, 'prose contains ~ or ^ (read as sub/superscript): ' + plain.slice(0, 80));
    if (EMOJI.test(plain)) fail(f, 'prose contains a colour emoji: ' + plain.slice(0, 80));
  }));
  console.log('  ' + s.sections + ' sections, ' + s.steps + ' steps, ' + s.callouts + ' callouts, ' + s.calculators + ' calculators, ' +
              s.tables + ' tables, ' + s.builders + ' builders, ' + s.layoutMaps + ' plate maps; ' + (text.length / 1024).toFixed(1) + ' KB');
  if (shown.length) console.log('  outputs: ' + shown.join(', '));
}
console.log(failures ? '\n' + failures + ' failure(s)' : '\nall ' + files.length + ' protocols pass');
process.exit(failures ? 1 : 0);
