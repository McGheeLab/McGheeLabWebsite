// V3.911 — NSF PAPPG rules (paper-grant-rules.js) against the nsf-career look.
// node scripts/tests/paper-grant-rules.test.mjs
import fs from 'fs';
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url).pathname;
const G = require(root + 'rm/js/paper-grant-rules.js');
const L = require(root + 'rm/js/paper-look.js');
let n = 0;
function ok(c, msg) { assert.ok(c, msg); n++; }
const tpl = JSON.parse(fs.readFileSync(root + 'rm/data/paper-templates/nsf-career.json', 'utf8'));
const byId = (list) => Object.fromEntries(list.map((r) => [r.id, r]));

// the template's own look passes every format rule
{
  const look = L.resolve(tpl, {});
  const r = byId(G.check({ template: tpl, look, doc: { key: 'project_description', pages: 15, text: 'plain text',
    headings: [{ text: '9. Broader Impacts', page: 14 }] } }));
  ok(r.paper.level === 'ok' && r.margins.level === 'ok', 'letter, 1 in margins');
  ok(r.size.level === 'ok' && r.lpi.level === 'ok', '11 pt at 12.65 pt pitch is legal');
  ok(r.pages.level === 'ok', '15 of 15 pages');
  ok(r['head-Broader Impacts'].level === 'ok', 'Broader Impacts heading found under its number');
  ok(r.urls.level === 'ok', 'no URLs');
  ok(r['head-Results from Prior NSF Support'].level === 'info', 'prior support is optional');
}
// what NSF would return without review
{
  const look = L.resolve(tpl, { lookOverrides: { 'fonts.text': 'termes', 'body.size': 10.5, 'body.lead': 11.5 } });
  ok(look.fonts.sans === 'termes', 'one face for the document unless sans is chosen too');
  ok(look.h1.size === 10.5, 'headings set at the body size follow it');
  const r = byId(G.check({ template: tpl, look, doc: { key: 'project_description', pages: 16, linesOver: 23,
    text: 'see https://example.org/x for data', headings: [] } }));
  ok(r.size.level === 'error' && /11 pt/.test(r.size.title), 'Times below 11 pt is an error');
  ok(r.lpi.level === 'error', 'more than 6 lines per inch');
  ok(r.pages.level === 'error' && /23 lines/.test(r.pages.detail), 'over the page limit, by lines');
  ok(r['head-Broader Impacts'].level === 'error', 'missing Broader Impacts heading');
  ok(r.urls.level === 'error', 'URL in the project description');
}
// References Cited is checked at the bibliography's type size
{
  const look = L.resolve(tpl, { lookOverrides: { 'fonts.text': 'termes' } });
  const r = byId(G.check({ template: tpl, look, doc: { key: 'references_cited', pages: 9 } }));
  ok(r.size.level === 'error', 'Times at the 10 pt bibliography size is under the 11 pt minimum');
  ok(!r.pages, 'References Cited has no page limit');
}
// a face the PAPPG does not list
{
  const look = L.resolve(tpl, { lookOverrides: { 'fonts.text': 'libertinus' } });
  const r = byId(G.check({ template: tpl, look, doc: { key: 'project_description', pages: 3 } }));
  ok(r.typeface.level === 'error', 'Libertinus is not a PAPPG typeface');
}
// the Project Summary: three headings, one page, Research.gov's character limit
{
  const look = L.resolve(tpl, {});
  const r = byId(G.check({ template: tpl, look, doc: { key: 'project_summary', pages: 1, text: 'x'.repeat(4700),
    headings: [{ text: 'Overview' }, { text: 'Intellectual Merit' }] } }));
  ok(r['head-Broader Impacts'].level === 'error' && r['head-Overview'].level === 'ok', 'three labeled parts');
  ok(r.chars.level === 'error', '4600 characters at most');
}
console.log('paper-grant-rules: ' + n + ' checks · all passed');
