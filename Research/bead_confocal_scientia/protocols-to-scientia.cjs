#!/usr/bin/env node
/* The 13 RM protocol imports (../bead_confocal_protocols/*.protocol-import.json) → protocols.json, the content the
   Scientia project spec turns into protocol notes. Every [!var:x] chip is replaced by its value at the calculator
   defaults, computed exactly as RM does (inputs first, outputs in document order, each rounded to its decimals), so
   the Scientia note reads the same as RM's document view at its defaults.

     MATHJS=/path/to/node_modules/mathjs node Research/bead_confocal_scientia/protocols-to-scientia.cjs

   (mathjs 12, the version RM loads; `npm i mathjs@12` in a scratch folder, as for validate.cjs.) Rerun after
   make_protocols.py changes; the project build reads only protocols.json. */
'use strict';
const fs = require('fs'), path = require('path');
const math = require(process.env.MATHJS || 'mathjs');
const DIR = path.resolve(__dirname, '..', 'bead_confocal_protocols');
const TOKEN = /\[!var:([a-zA-Z_][a-zA-Z0-9_]*)\]/g;

function fmtNum(v, dec) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  const a = Math.abs(v);   // very large or small values (an input such as 1.1e-5) in scientific form, before any rounding
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2).replace(/\.?0+e/, 'e').replace(/e\+?(-?)(\d+)/, (m, s, e) => '×10' + (s ? '⁻' : '') + e.split('').map(c => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join(''));
  const d = typeof dec === 'number' ? dec : 4;
  return parseFloat(v.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d });
}
const show = s => s && s.value != null ? fmtNum(s.value, s.dec) + (s.unit ? ' ' + s.unit : '') : '?';

function convert(file) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')), P = j.protocol;
  const blocks = []; P.tree.sections.forEach(sec => sec.children.forEach(b => blocks.push(Object.assign({ section: sec.label }, b))));
  // symbol table
  const T = {};
  blocks.forEach(b => { const a = b.attrs || {};
    if (b.kind === 'calculator') (a.inputs || []).forEach(i => { T[i.name] = { value: Number(i.default), unit: i.unit || '', dec: null, label: i.label }; });
    if (b.kind === 'formula') (a.variables || []).forEach(i => { T[i.name] = { value: Number(i.default), unit: i.unit || '', label: i.label }; });
    if (b.kind === 'builder') (a.params || []).forEach(i => { T[i.name] = { value: Number(i.default), unit: i.unit || '', label: i.label }; }); });
  const scope = () => Object.fromEntries(Object.entries(T).filter(([, s]) => typeof s.value === 'number').map(([k, s]) => [k, s.value]));
  blocks.forEach(b => { const a = b.attrs || {};
    const outs = b.kind === 'calculator' ? (a.outputs || []) : [];
    outs.forEach(o => { const v = math.evaluate(o.expr, scope()); const dec = typeof o.decimals === 'number' ? o.decimals : 3; T[o.name] = { value: parseFloat(Number(v).toFixed(dec)), unit: o.unit || '', dec, label: o.label }; }); });
  const prose = s => String(s || '').replace(TOKEN, (m, k) => show(T[k])).replace(/\[!pill:[a-z]+:([^\]]+)\]/g, '$1').replace(/`([^`]+)`/g, '$1');
  const out = { file, id: P.id, title: P.title, summary: P.summary, header: '', notes: [], cautions: [], assumptions: [], tables: [], materials: [], calculators: [], procedure: [], analysis: [], decision: [], record: [], timeline: null, plate: null, builder: null };
  for (const b of blocks) {
    const a = b.attrs || {}, sec = b.section.toLowerCase();
    if (b.kind === 'docHeader') out.header = prose(b.body);
    else if (b.kind === 'callout') {
      const t = prose(b.body), type = a.type || 'note';
      if (sec.startsWith('decision')) out.decision.push(t);
      else if (type === 'critical') out.cautions.push({ text: t, where: b.section });
      else if (type === 'assume') out.assumptions.push(t);
      else if (sec === 'procedure') out.procedure.push({ note: t });
      else if (sec === 'analysis') out.analysis.push({ note: t });
      else out.notes.push({ text: t, where: b.section });
    }
    else if (b.kind === 'table') {
      const rows = (a.rows || []).map(r => (a.columns || []).map(c => prose(r[c.key])));
      const tb = { caption: prose(b.body), columns: (a.columns || []).map(c => c.label), rows, where: b.section };
      if (sec.startsWith('decision')) out.record.push(tb); else out.tables.push(tb);
    }
    else if (b.kind === 'kv') out.tables.push({ caption: prose(b.body), columns: ['', ''], rows: (a.items || []).map(i => [prose(i.term), prose(i.def)]), where: b.section });
    else if (b.kind === 'materials') out.materials.push(...(a.rows || []).map(r => [r.qty, r.unit, prose(r.free_text)].filter(Boolean).join(' ').trim()));
    else if (b.kind === 'calculator') out.calculators.push({ label: a.label || 'Calculator', inputs: (a.inputs || []).map(i => ({ label: i.label, value: show(T[i.name]), hint: i.rangeHint || '' })), outputs: (a.outputs || []).map(o => ({ label: o.label, value: show(T[o.name]) })), table: a.table && a.table.dataset ? a.table : null });
    else if (b.kind === 'step') { if (sec === 'analysis') out.analysis.push({ step: prose(b.body) }); else out.procedure.push({ step: prose(b.body) }); }
    else if (b.kind === 'heading') { if (sec === 'analysis') out.analysis.push({ heading: prose(b.body) }); else out.procedure.push({ heading: prose(b.body) }); }
    else if (b.kind === 'timeline') out.timeline = { title: prose(b.body), marks: (a.marks || []).map(m => ({ at: prose(m.at), label: prose(m.label), sub: prose(m.sub), included: m.included !== false })) };
    else if (b.kind === 'builder') {
      let sets = [{}]; (a.dims || []).forEach(d => { const nx = []; sets.forEach(s0 => (d.options || []).forEach(o => nx.push(Object.assign({}, s0, { [d.field]: o })))); sets = nx; });
      const rows = sets.map(ps => { const row = {}; for (const [k, v] of Object.entries(ps)) row[k] = isNaN(+v) ? v : +v; (a.derived || []).forEach(df => { row[df.field] = math.evaluate(df.expr, Object.assign(scope(), row)); }); return row; });
      out.builder = { dataset: a.dataset, rows };
    }
    else if (b.kind === 'layoutMap') out.plate = { label: a.label, dataset: a.dataset, rows: a.rows, cols: a.cols, cellLabel: a.cellLabel, cellSub: a.cellSub, colorField: a.colorField };
  }
  out.values = Object.fromEntries(Object.entries(T).map(([k, s]) => [k, { label: s.label, text: show(s) }]));
  return out;
}
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.protocol-import.json')).sort();
const all = files.map(convert);
fs.writeFileSync(path.join(__dirname, 'protocols.json'), JSON.stringify(all, null, 1));
for (const p of all) console.log(p.id, '| steps', p.procedure.filter(x => x.step).length, '| analysis', p.analysis.length, '| calc', p.calculators.length, '| tables', p.tables.length, p.plate ? '| plate ' + p.builder.rows.length : '', p.timeline ? '| timeline' : '');
