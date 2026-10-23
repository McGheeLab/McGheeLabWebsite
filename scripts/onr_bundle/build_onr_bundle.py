#!/usr/bin/env python3
"""build_onr_bundle.py — stage-1 blocks → a .paperbundle workdir for RM.

Stage 3 of the docx → .paperbundle.zip pipeline. Emits paper.json + assets/
into a working directory that
`.claude/skills/paper-bundle/scripts/build_bundle.py` then validates and zips.
The manifest contract lives in that skill's SKILL.md; this script only fills it.

Three mappings deserve their reasons written down:

  HEADINGS. The docx nests H1→H5, five levels. An RM `subheading` allows only
  level 2 or 3 (paper-schemas.js MAX_SUBHEADING_LEVEL). Rather than flatten and
  lose the outline, one heading level is PROMOTED to a section: every H2 under
  "Technical Approach" and every Aim (an H3) opens its own section. Inside an
  Aim, H4 → level 2 and H5 (the subtasks) → level 3 — an exact fit.

  CAPTIONS. Word wrote "Fig. {SEQ}N." into the caption text. RM numbers figures
  and tables itself (`numbered: true`), so the literal prefix is stripped or
  every figure would read "Figure 3: Fig. 3. …". The prose that referred to
  "Fig. 5" / "Table 1" / "eq.3" becomes [!fig:…] / [!tab:…] / [!eqr:…], which
  also silently fixes the document's own numbering bug: BOTH tables are labelled
  "Table 1" in the docx, and the schedule reference now resolves to Table 2.

  THE GANTT. Its bars are cell background fills (w:shd FFC000) and its three aim
  rows are gridSpan=7 merges. An RM table has neither per-cell shading nor cell
  merging, so a filled cell becomes '●' and a merged row becomes a label in
  column 0. The information survives; the styling does not.

Usage:
  python3 scripts/onr_bundle/build_onr_bundle.py --stage <dir> --out <workdir>
"""

import argparse
import json
import os
import re
import shutil

TITLE = ('Towards the Development of a Periodic Table of Quasistatic '
         'Tissue Mechanical Properties')
SOLICITATION = 'ONR BAA N00014-25-S-B001'

# label, caption-panel detection is automatic; order follows Fig. 1…5.
FIGURE_LABELS = ['overview', 'sample-prep', 'strain-maps', 'raman', 'collab']

SECTION_KIND = {
    'Proposed Research Plan': 'research_strategy',
    'Data Management Plan': 'data_management_plan',
}

# Prose cross-references, applied to every body/caption string. Ordered; each
# is a plain substring swap so it cannot accidentally match a citation marker.
CROSSREFS = [
    ('systematically. Table 1 provides', 'systematically. [!tab:ecm] provides'),
    ('per the timeline shown in Table 1.', 'per the timeline shown in [!tab:schedule].'),
    ('illustrated schematically in Fig. 5,', 'illustrated schematically in [!fig:collab],'),
    ('the central database (Fig. 5)', 'the central database ([!fig:collab])'),
    ('as described by eq.3.', 'as described by [!eqr:eq3].'),
]

CAPTION_RE = re.compile(r'^\s*Fig\.\s*\d+\.\s*')
TABLE_CAP_RE = re.compile(r'^\s*Table\s*\d+\.\s*')
EQ_CELL_RE = re.compile(r'^eq\.\s*\d+$', re.I)
PANEL_RE = re.compile(r'(?:^|[\s(])([A-H])\)')


def sid(prefix, n):
    return '%s%04d' % (prefix, n)


class Builder:
    def __init__(self, stage):
        self.blocks = [json.loads(l) for l in
                       open(os.path.join(stage, 'blocks.ndjson'))]
        self.math = json.load(open(os.path.join(stage, 'math.json')))
        self.refs = json.load(open(os.path.join(stage, 'refs.json')))
        overrides_path = os.path.join(stage, 'doi_overrides.json')
        self.overrides = (json.load(open(overrides_path))
                          if os.path.exists(overrides_path) else {})
        self.media = os.path.join(stage, 'media')
        self.counter = 0
        self.assets = []
        self.fig_n = 0
        self.eq_n = 0
        self.tab_n = 0

    # ── text ──────────────────────────────────────────────────────
    def text(self, raw, keep_images=False):
        """One stage-1 string → an RM body string."""
        s = raw
        # Word splits one bold phrase across several runs; the extractor emits
        # a **…** per run, so adjacent spans abut as '****'. Collapsing that is
        # what turns '**M****icroscope **' back into '**Microscope **'.
        while '****' in s:
            s = s.replace('****', '')
        # Word often parks the space AFTER an inline equation inside the
        # equation itself, as a trailing thin space. normalize_math strips that
        # (a trailing '\' escapes the closing '$'), so put a real space back or
        # the prose reads "T_{50}at fixed".
        def _sub_math(m):
            node = self.math[int(m.group(1))]
            tail = ' ' if re.search(r'[\s\\]$', node['raw']) else ''
            return '$' + node['tex'] + '$' + tail
        s = re.sub(r'@@M(\d+)@@', _sub_math, s)
        if not keep_images:
            s = re.sub(r'@@IMG:[^@]+@@', '', s)
        # A literal dollar sign would open inline math and swallow the rest of
        # the paragraph (paper-editor renderParagraphHtml); \$ is its escape.
        s = re.sub(r'(?<!\\)\$(?=\d)', r'\\$', s)
        for a, b in CROSSREFS:
            s = s.replace(a, b)
        s = s.replace(' ', ' ')
        s = re.sub(r'[ \t]+', ' ', s)
        s = re.sub(r' *\n *', '\n', s)
        return s.strip()

    def block(self, kind, body, attrs=None, skeleton=None):
        self.counter += 1
        b = {
            'id': sid('p-', self.counter),
            'kind': kind,
            'status': 'draft',
            'body': body,
            'attrs': attrs or {},
        }
        if kind == 'paragraph':
            b['skeleton_items'] = skeleton or []
        return b

    # ── figures ───────────────────────────────────────────────────
    def figure(self, target, caption_raw):
        self.fig_n += 1
        label = FIGURE_LABELS[self.fig_n - 1]
        src = os.path.join(self.media, os.path.basename(target))
        ext = os.path.splitext(src)[1].lstrip('.').lower()
        hashname = 'fig%d' % self.fig_n
        storage = 'imports/onr-technical-proposal/%s.%s' % (hashname, ext)
        self.assets.append({
            'hash': hashname, 'ext': ext,
            'storage_path_original': storage,
            'relpath': 'assets/%s.%s' % (hashname, ext),
            '_src': src,
        })
        caption = self.text(CAPTION_RE.sub('', caption_raw))
        panels = []
        seen = set()
        for m in PANEL_RE.finditer(caption):
            p = m.group(1)
            if p not in seen:
                seen.add(p)
                panels.append({'id': 'sf-%s' % p.lower(), 'label': p})
        return self.block('figure', caption, {
            'storage_path': storage, 'download_url': '', 'hash': hashname,
            'mime': 'image/jpeg' if ext in ('jpg', 'jpeg') else 'image/png',
            'width': '\\linewidth', 'placement': 'H', 'centering': True,
            'label': label, 'alt': caption[:180],
            'numbered': True, 'subfigures': panels,
            'anchor': 'flow', 'span': 'column', 'lock': False,
        })

    # ── equations ─────────────────────────────────────────────────
    def equation(self, math_placeholder):
        self.eq_n += 1
        k = int(re.match(r'@@M(\d+)@@', math_placeholder.strip()).group(1))
        return self.block('equation', self.math[k]['tex'], {
            'display': True, 'numbered': True,
            'label': 'eq%d' % self.eq_n, 'span': 'column',
        })

    # ── tables ────────────────────────────────────────────────────
    def table(self, rows, label, caption, align=None):
        self.tab_n += 1
        ncols = max(sum(c['span'] for c in r) for r in rows)
        entries = {}
        for ri, row in enumerate(rows):
            ci = 0
            for cell in row:
                # No cell merging in an RM table: a gridSpan row keeps its text
                # in column 0 and leaves the spanned columns empty.
                txt = self.text(cell['text'])
                if not txt and cell['fill'] and cell['fill'] != 'FFFFFF':
                    txt = '●'          # a Gantt bar, which has no other home
                if txt:
                    entries['%d-%d' % (ri, ci)] = {'__ytype': 'text', 'value': txt}
                ci += cell['span']
        return self.block('table', '', {
            'rows': len(rows), 'cols': ncols,
            'cells': {'__ytype': 'map', 'entries': entries},
            'caption': {'__ytype': 'text', 'value': self.text(caption)},
            'numbered': True, 'label': label,
            'booktabs': True, 'header_row': True,
            'align': align or ('l' + 'c' * (ncols - 1)),
            'anchor': 'flow', 'span': 'column', 'lock': False,
        })

    # ── references ────────────────────────────────────────────────
    def references(self):
        out = []
        for r in self.refs:
            doi = r['doi'] or self.overrides.get(r['citekey'], '')
            out.append({
                'title': r['title'],
                'authors': r['authors'],
                'year': r['year'],
                'journal': r['journal'],
                'volume': r['volume'], 'issue': r['issue'], 'pages': r['pages'],
                'doi': doi,
                'url': ('https://doi.org/' + doi) if doi else r['url'],
                'pmid': r['pmid'], 'arxiv_id': r['arxiv_id'],
                'abstract': '', 'source': 'manual',
            })
        return out


def is_heading(b):
    m = re.match(r'^Heading([1-5])$', b.get('style') or '')
    return int(m.group(1)) if m else 0


def build(stage, out):
    B = Builder(stage)
    blocks = B.blocks
    sections = []
    sec = None
    base_h = 2
    order = 0

    def open_section(label, level):
        nonlocal sec, base_h, order
        order += 1
        kind = SECTION_KIND.get(label, 'custom')
        sec = {'id': sid('sec-', order), 'kind': kind, 'label': label,
               'order': order, 'status': 'draft', 'children': []}
        sections.append(sec)
        base_h = level

    # ── cover page: everything before the table of contents ──
    toc_at = next(i for i, b in enumerate(blocks)
                  if b['kind'] == 'para' and b.get('style') == 'TOCHeading')
    open_section('Proposal Cover Information', 2)
    cover_lines = [B.text(b['text']) for b in blocks[:toc_at]
                   if b['kind'] == 'para' and b['text'].strip()]
    cover_lines = [l for l in cover_lines if l != '**' + TITLE + '**']
    # The cover is a stack of short lines under bold captions ("Prime:",
    # "Technical Contact:"). One paragraph per caption, lines joined by \n
    # (which the editor renders as <br>), keeps the address blocks intact
    # instead of exploding into twenty bullets.
    group = []
    for line in cover_lines:
        if line.startswith('**') and group:
            sec['children'].append(B.block('paragraph', '\n'.join(group)))
            group = []
        group.append(line)
    if group:
        sec['children'].append(B.block('paragraph', '\n'.join(group)))

    # ── body: from the first Heading1 to "References Cited" ──
    start = next(i for i, b in enumerate(blocks) if is_heading(b) == 1)
    pending_list = []
    pending_table_cap = None
    i = start

    def flush_list():
        nonlocal pending_list
        if pending_list:
            sec['children'].append(B.block(
                'list', '\n'.join(pending_list), {'list_type': 'bullet'}))
            pending_list = []

    while i < len(blocks):
        b = blocks[i]

        if b['kind'] == 'table':
            flush_list()
            rows = b['rows']
            if len(rows) == 1 and len(rows[0]) == 3 and EQ_CELL_RE.match(rows[0][2]['text']):
                sec['children'].append(B.equation(rows[0][1]['text']))
            elif len(rows) == 6:
                sec['children'].append(B.table(
                    rows, 'ecm', TABLE_CAP_RE.sub('', pending_table_cap or ''),
                    align='l' + 'l' * 6))
                pending_table_cap = None
            else:
                sec['children'].append(B.table(
                    rows, 'schedule',
                    'Project schedule and milestones. A filled cell (●) marks '
                    'a six-month window in which that subtask is active.'))
            i += 1
            continue

        raw = b['text']
        stripped = raw.strip()
        if not stripped:
            i += 1
            continue
        if stripped == '**References Cited**':
            break

        h = is_heading(b)
        if h:
            flush_list()
            label = B.text(stripped)
            if h == 1 and label == 'Technical Approach':
                i += 1
                continue                          # its H2s carry the content
            if h == 1 or h == 2 or (h == 3 and label.startswith('Aim ')):
                open_section(label, h)
            else:
                lvl = min(3, 2 + (h - base_h - 1))
                sec['children'].append(B.block('subheading', label,
                                               {'level': max(2, lvl)}))
            i += 1
            continue

        # A caption is consumed by the figure that precedes it.
        if CAPTION_RE.match(stripped):
            i += 1
            continue

        # The ECM table's caption is a plain paragraph that precedes the table.
        if TABLE_CAP_RE.match(stripped):
            pending_table_cap = stripped
            i += 1
            continue

        img = re.search(r'@@IMG:([^@]+)@@', raw)
        if img:
            prose = B.text(raw)
            if prose:
                flush_list()
                sec['children'].append(B.block('paragraph', prose))
            caption_raw = ''
            if i + 1 < len(blocks) and blocks[i + 1]['kind'] == 'para' \
                    and CAPTION_RE.match(blocks[i + 1]['text'].strip()):
                caption_raw = blocks[i + 1]['text'].strip()
            flush_list()
            sec['children'].append(B.figure(img.group(1), caption_raw))
            i += 1
            continue

        body = B.text(raw)
        style = b.get('style') or ''
        # A bold-only ListParagraph is one of the BAA's own prompts (Responsibility,
        # Data Management Plan) — a heading, not a bullet.
        if style == 'ListParagraph' and re.fullmatch(r'\*\*.+\*\*', body, re.S):
            flush_list()
            sec['children'].append(B.block('subheading', body[2:-2].strip(),
                                           {'level': 2}))
        elif b.get('list') or style == 'ListParagraph':
            pending_list.append(body)
        else:
            flush_list()
            sec['children'].append(B.block('paragraph', body))
        i += 1

    flush_list()
    order += 1
    sections.append({'id': sid('sec-', order), 'kind': 'references',
                     'label': 'References Cited', 'order': order,
                     'status': 'draft', 'children': []})

    manifest = {
        'bundle_version': 1,
        'exported_at': '2026-09-02T00:00:00.000Z',
        'paper': {
            'title': TITLE,
            'paper_type': 'grant',
            'grant_subtype': None,
            'template_id': 'blank',
            'target_journal': SOLICITATION,
            'repo_path': '', 'repo_org': '',
            'notes': ('Technical volume submitted to ' + SOLICITATION +
                      '. Period of performance 1 January 2026 - 31 December 2028. '
                      'Imported from Data/Grants/ONR Technical Proposal.docx by '
                      'scripts/onr_bundle/.'),
        },
        'config': {
            'templateId': 'blank',
            'paperType': 'grant',
            'addons': [], 'overrides': {},
            'authors': [{'name': 'Alexander McGhee', 'affiliationIdx': 0,
                         'corresponding': True, 'email': 'mcgheealex@arizona.edu'}],
            'affiliations': ['Department of Biomedical Engineering and University '
                             'of Arizona Cancer Center, University of Arizona, '
                             'Tucson, AZ, USA'],
            'buildTarget': 'submission',
            # The proposal numbers its own headings ("2.1", "3.1.1",
            # "Subtask 1.1)"). Auto numbering on top of that would render
            # "3.1 3.1.1 Preliminary Work".
            'sectionNumbering': 'off',
            'graphicalAbstract': None,
        },
        'tree': {'meta': {'title': TITLE}, 'sections': sections},
        'equation_library': [],
        'figure_unplaced': [], 'table_unplaced': [],
        'references': B.references(),
        'assets': [{k: v for k, v in a.items() if k != '_src'} for a in B.assets],
        'grant_docs': [],
    }

    # ── write the workdir ──
    os.makedirs(os.path.join(out, 'assets'), exist_ok=True)
    for a in B.assets:
        shutil.copyfile(a['_src'], os.path.join(out, a['relpath']))
    with open(os.path.join(out, 'paper.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False)
    with open(os.path.join(out, 'comments.json'), 'w') as fh:
        json.dump([], fh)

    # ── census: the counts measured from the docx. A silent drop here is
    # exactly the failure mode this whole pipeline exists to avoid. ──
    kinds = {}
    for s in sections:
        for c in s['children']:
            kinds[c['kind']] = kinds.get(c['kind'], 0) + 1
    expect = {'sections': 16, 'figure': 5, 'equation': 9, 'table': 2,
              'references': 33}
    actual = {'sections': len(sections), 'figure': kinds.get('figure', 0),
              'equation': kinds.get('equation', 0), 'table': kinds.get('table', 0),
              'references': len(manifest['references'])}
    markers = set()
    for s in sections:
        for c in s['children']:
            for m in re.findall(r'\[(\s*\d[\d\s,–-]*)\]', c['body']):
                # Expand ranges the way REFERENCE_IMPORT.rewriteNumericMarkers
                # does, so "[22–28]" counts as seven references and not two.
                for part in m.split(','):
                    part = part.strip()
                    if not part:
                        continue
                    ends = re.split(r'\s*[–-]\s*', part)
                    if len(ends) == 2:
                        markers.update(range(int(ends[0]), int(ends[1]) + 1))
                    else:
                        markers.add(int(part))
    print('census:')
    for k in expect:
        flag = 'ok ' if expect[k] == actual[k] else 'FAIL'
        print('  %-11s %-4s expected %-3d got %d' % (k, flag, expect[k], actual[k]))
    print('  %-11s %-4s %d..%d over %d citations'
          % ('markers', 'ok ' if markers and max(markers) <= 33 else 'FAIL',
             min(markers), max(markers), len(markers)))
    print('  blocks      %s' % ', '.join('%s=%d' % kv for kv in sorted(kinds.items())))
    if expect != actual or max(markers) > 33:
        raise SystemExit('census FAILED — refusing to emit a lossy bundle')
    print('\nwrote %s' % out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    build(args.stage, args.out)
