#!/usr/bin/env python3
"""journal_style.py — measure each journal's look from labelled pages (V3.909).

    python3 scripts/paper-lab/journal_style.py                 # report, all journals
    python3 scripts/paper-lab/journal_style.py --source proposals   # before any labelling
    python3 scripts/paper-lab/journal_style.py --journal PNAS --look # draft a template `look`

Reads the JOURNAL-STYLE label set from the figure-training harness
(ResearchManagement/data/figure-training: manifest-journals.json,
labels-journals.json, proposals-journals.json — labelled in
harness.html?set=journals) and the PDFs it points at. For every labelled
region it measures, from the PDF text layer:

  font (family name, size, bold / italic / upper-case share), leading
  (baseline pitch), alignment (justified / ragged / centred), first-line
  indent, space above and below (headings), caption label format
  ("Fig. 1 |", "Figure 1.", "FIG. 1."), reference label style
  ("1.", "[1]", "(1)", superscript)

and for every page the text block (margins), the column count and gutter.
Per journal the measurements are pooled across its papers (medians), and
written to <corpus>/_styles/journal-profiles.json plus a readable report.
`--look` turns a profile into a draft `look` block for a paper-builder
template (rm/data/paper-templates/<id>.json) — the same structure
rm/js/paper-look.js renders, so a labelled journal can become a template.

Source of boxes: `labels` (yours, the ground truth; default), `proposals`
(the propose_journal.py guesses), or `both` (labels where a page has any,
else proposals).
"""
import argparse
import collections
import json
import os
import re
import statistics

import pdfplumber

FT = '/Users/alexmcghee/Documents/GitHub/ResearchManagement/data/figure-training'
HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'PaperLab-corpus'))

TEXTY = ('title', 'authors', 'affiliation', 'abstract', 'keywords', 'h1', 'h2', 'h3', 'text', 'caption',
         'tcaption', 'reference', 'footnote', 'header', 'footer', 'sidebar', 'box', 'backmatter')


def med(xs, nd=2):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), nd) if xs else None


def base_font(fn):
    f = (fn or '').split('+')[-1]
    return re.sub(r'[-,](Bold|BoldItalic|Italic|It|Regular|Roman|Medium|Semibold|Smbd|Light|Book|Bd|BdIt|Oblique)$', '', f, flags=re.I)


def is_bold(fn):
    f = (fn or '').lower()
    return any(k in f for k in ('bold', '-bd', 'black', 'semibold', 'heavy', '.b', ',b', 'medi', 'smbd'))


def is_italic(fn):
    f = (fn or '').lower()
    return any(k in f for k in ('italic', 'oblique', '-it', 'ital', '.i', ',i'))


def chars_in(page, b):
    H = page.height
    out = []
    for c in page.chars:
        if not c['text'].strip() or not c.get('upright', True):
            continue
        cx, cy = (c['x0'] + c['x1']) / 2, (c['top'] + c['bottom']) / 2
        if b['x'] <= cx <= b['x'] + b['w'] and b['y'] <= cy <= b['y'] + b['h']:
            m = c.get('matrix')
            c['base'] = (H - m[5]) if m else c['bottom']
            out.append(c)
    return out


def lines_from(chars):
    if not chars:
        return []
    main = statistics.median(c['size'] for c in chars)
    lines = []
    for c in sorted(chars, key=lambda c: (round(c['base']), c['x0'])):
        if lines and abs(lines[-1]['base'] - c['base']) <= 0.45 * main:
            lines[-1]['chars'].append(c)
        else:
            lines.append({'base': c['base'], 'chars': [c]})
    for l in lines:
        full = [c for c in l['chars'] if c['size'] >= 0.8 * main] or l['chars']
        l['x0'] = min(c['x0'] for c in full)
        l['x1'] = max(c['x1'] for c in full)
        l['base'] = statistics.median(c['base'] for c in full)
    return sorted(lines, key=lambda l: l['base'])


def measure_box(page, b):
    cs = chars_in(page, b)
    if len(cs) < 2:
        return None
    sizes = [c['size'] for c in cs]
    main = statistics.median(sizes)
    body = [c for c in cs if abs(c['size'] - main) < 0.6] or cs
    fonts = collections.Counter(base_font(c['fontname']) for c in body)
    letters = [c for c in body if c['text'].isalpha()]
    lines = lines_from(cs)
    pitches = [y['base'] - x['base'] for x, y in zip(lines, lines[1:]) if 0 < y['base'] - x['base'] < 2.2 * main]
    m = {
        'n_chars': len(cs), 'n_lines': len(lines),
        'font': fonts.most_common(1)[0][0], 'size': round(main, 2),
        'bold': round(sum(is_bold(c['fontname']) for c in body) / len(body), 2),
        'italic': round(sum(is_italic(c['fontname']) for c in body) / len(body), 2),
        'upper': round(sum(c['text'].isupper() for c in letters) / len(letters), 2) if letters else None,
        'leading': med(pitches),
        'x0': round(min(l['x0'] for l in lines), 1), 'x1': round(max(l['x1'] for l in lines), 1),
        'top': round(min(c['top'] for c in cs), 1), 'bottom': round(max(c['bottom'] for c in cs), 1),
        'first_base': round(lines[0]['base'], 1), 'last_base': round(lines[-1]['base'], 1),
    }
    color = collections.Counter(str(c.get('non_stroking_color')) for c in body).most_common(1)[0][0]
    m['color'] = color
    # alignment
    if len(lines) >= 3:
        L, R = m['x0'], m['x1']
        inner = lines[:-1]
        right_flush = sum(1 for l in inner if R - l['x1'] < 1.5) / len(inner)
        left_flush = sum(1 for l in lines if l['x0'] - L < 1.5) / len(lines)
        centred = sum(1 for l in lines if abs((l['x0'] + l['x1']) / 2 - (L + R) / 2) < 2) / len(lines)
        m['align'] = 'justify' if right_flush > 0.7 and left_flush > 0.5 else 'center' if centred > 0.8 else 'left'
        # first-line indents (paragraph starts) inside running text
        ind = [round(l['x0'] - L, 1) for l in lines if 3 < l['x0'] - L < 3.5 * main]
        m['indent'] = med(ind, 1)
    elif len(lines) >= 1:
        m['align'] = None
    txt = ''.join(c['text'] for c in sorted(lines[0]['chars'], key=lambda c: c['x0']))
    m['first_text'] = txt[:40]
    return m


def neighbours(boxes, b):
    """Gap (pt) from a heading box to the nearest text above / below in its column."""
    above = [o for o in boxes if o is not b and o['x'] < b['x'] + b['w'] and b['x'] < o['x'] + o['w'] and o['y'] + o['h'] <= b['y'] + 1]
    below = [o for o in boxes if o is not b and o['x'] < b['x'] + b['w'] and b['x'] < o['x'] + o['w'] and o['y'] >= b['y'] + b['h'] - 1]
    up = min((b['y'] - (o['y'] + o['h']) for o in above), default=None)
    dn = min((o['y'] - (b['y'] + b['h']) for o in below), default=None)
    return up, dn


CAP_PAT = re.compile(r'^\s*((?:supplementary\s+)?(?:fig(?:ure)?\.?|FIG\.?|Figure|Scheme|Table|TABLE))\s*(\d+)\s*([.:|—–-]?)', re.I)
REF_PAT = [('bracket', re.compile(r'^\s*\[\d+\]')), ('paren', re.compile(r'^\s*\(\d+\)')),
           ('dot', re.compile(r'^\s*\d+\.\s')), ('plain', re.compile(r'^\s*\d+\s+[A-Z]'))]


def profile_paper(meta, boxes_by_page):
    pdf_path = os.path.join(FT, meta['file'])
    out = {'regions': collections.defaultdict(list), 'pages': []}
    with pdfplumber.open(pdf_path) as pdf:
        for pg, boxes in boxes_by_page.items():
            page = pdf.pages[int(pg) - 1]
            W, H = page.width, page.height
            texts = []
            for b in boxes:
                t = b.get('t')
                if t not in TEXTY and t not in ('figure', 'table', 'equation'):
                    continue
                if t in ('figure', 'table', 'equation'):
                    out['regions'][t].append({'w': round(b['w'], 1), 'h': round(b['h'], 1), 'x': round(b['x'], 1),
                                              'page_w': W, 'span': 'page' if b['w'] > 0.6 * W else 'column'})
                    continue
                m = measure_box(page, b)
                if not m:
                    continue
                if t in ('h1', 'h2', 'h3'):
                    up, dn = neighbours([x for x in boxes if x.get('t') in TEXTY], b)
                    m['space_above'] = round(up, 1) if up is not None else None
                    m['space_below'] = round(dn, 1) if dn is not None else None
                if t in ('caption', 'tcaption'):
                    mm = CAP_PAT.match(m['first_text'])
                    if mm:
                        m['label'] = mm.group(1)
                        m['sep'] = mm.group(3) or ' '
                        cs = sorted(chars_in(page, b), key=lambda c: (round(c.get('base', c['bottom'])), c['x0']))[:len(mm.group(0).strip())]
                        m['label_bold'] = round(sum(is_bold(c['fontname']) for c in cs) / max(1, len(cs)), 2)
                if t == 'reference':
                    for name, rx in REF_PAT:
                        if rx.match(m['first_text']):
                            m['ref_label'] = name
                            break
                out['regions'][t].append(m)
                if t == 'text':
                    texts.append(b)
            if texts:
                x0 = min(b['x'] for b in texts)
                x1 = max(b['x'] + b['w'] for b in texts)
                top = min(b['y'] for b in texts)
                bot = max(b['y'] + b['h'] for b in texts)
                mid = (x0 + x1) / 2
                left = [b for b in texts if b['x'] + b['w'] < mid + 4]
                right = [b for b in texts if b['x'] > mid - 4]
                cols = 2 if left and right else 1
                gap = (min(b['x'] for b in right) - max(b['x'] + b['w'] for b in left)) if cols == 2 else 0
                out['pages'].append({'page': int(pg), 'W': W, 'H': H, 'x0': x0, 'x1': x1, 'top': top, 'bottom': bot,
                                     'cols': cols, 'gap': round(gap, 1), 'first': int(pg) == 1})
    return out


def pool(papers):
    """Median profile across a journal's papers."""
    regions = collections.defaultdict(list)
    pages = []
    for p in papers:
        for t, ms in p['regions'].items():
            regions[t].extend(ms)
        pages.extend(p['pages'])
    prof = {'regions': {}, 'page': {}}
    for t, ms in regions.items():
        if t in ('figure', 'table', 'equation'):
            prof['regions'][t] = {'n': len(ms), 'span_page_share': round(sum(m['span'] == 'page' for m in ms) / len(ms), 2)}
            continue
        r = {'n': len(ms)}
        for k in ('size', 'leading', 'bold', 'italic', 'upper', 'indent', 'space_above', 'space_below', 'label_bold'):
            v = med([m.get(k) for m in ms])
            if v is not None:
                r[k] = v
        for k in ('font', 'align', 'label', 'sep', 'ref_label'):
            c = collections.Counter(m.get(k) for m in ms if m.get(k))
            if c:
                r[k] = c.most_common(1)[0][0]
        prof['regions'][t] = r
    body = [p for p in pages if not p['first']] or pages
    if body:
        W, H = med([p['W'] for p in body], 1), med([p['H'] for p in body], 1)
        prof['page'] = {'w': W, 'h': H,
                        'margins': {'left': med([p['x0'] for p in body], 1), 'right': round(W - med([p['x1'] for p in body], 1), 1),
                                    'top': med([p['top'] for p in body], 1), 'bottom': round(H - med([p['bottom'] for p in body], 1), 1)},
                        'columns': collections.Counter(p['cols'] for p in body).most_common(1)[0][0],
                        'colsep': med([p['gap'] for p in body if p['cols'] == 2], 1) or 0}
    return prof


FONT_MAP = [  # PDF face (as journals embed it) → the open look font that matches it best
    (re.compile(r'times|nimbusrom|termes|stix|minion|ptm|tinos', re.I), 'termes'),
    (re.compile(r'helvetica|arial|nimbussan|heros|myriad|frutiger|univers|gotham|harding.*sans|roboto|source ?sans', re.I), 'heros'),
    (re.compile(r'garamond|arno|sabon|minion', re.I), 'garamond'),
    (re.compile(r'lmroman|cmr|computer ?modern|latin ?modern', re.I), 'lm'),
]


def look_from(prof, journal):
    """A draft `look` block (paper-look.js structure) from a pooled profile."""
    R = prof['regions']
    pg = prof['page']
    body = R.get('text', {})

    def fam(r):
        f = (r or {}).get('font') or ''
        for rx, name in FONT_MAP:
            if rx.search(f):
                return 'sans' if name == 'heros' else 'text'
        return 'text'

    def st(r, default_size):
        r = r or {}
        s = r.get('size') or default_size
        return {'family': fam(r), 'size': s, 'lead': r.get('leading') or round(s * 1.2, 1),
                'weight': 'bold' if (r.get('bold') or 0) > 0.5 else 'normal',
                **({'style': 'italic'} if (r.get('italic') or 0) > 0.5 else {}),
                **({'case': 'upper'} if (r.get('upper') or 0) > 0.8 else {}),
                'align': r.get('align') if r.get('align') in ('center', 'left') else 'left'}

    bsize = body.get('size') or 10
    text_font = 'libertinus'
    for rx, name in FONT_MAP:
        if rx.search(body.get('font') or ''):
            text_font = name if name != 'heros' else 'libertinus'
            break
    look = {
        'engine': 'spec', 'name': journal + ' (published page)',
        'measured_from': 'journal_style.py — labelled pages of ' + journal,
        'page': {'w': pg.get('w', 612), 'h': pg.get('h', 792)},
        'margins': pg.get('margins', {}),
        'columns': pg.get('columns', 1), 'colsep': pg.get('colsep', 0),
        'fonts': {'text': text_font, 'sans': 'heros'},
        'body': {'size': bsize, 'lead': body.get('leading') or round(bsize * 1.2, 1), 'indent': body.get('indent') or bsize,
                 'parskip': 0, 'flushbottom': pg.get('columns', 1) == 2},
        'title': dict(st(R.get('title'), bsize * 2), after=10),
        'authors': dict(st(R.get('authors'), bsize), after=4),
        'affiliations': dict(st(R.get('affiliation'), bsize * 0.8), where='front', after=10),
        'abstract': dict(st(R.get('abstract'), bsize), mode='span', label=None, indent=0, after=14),
        'h1': dict(st(R.get('h1'), bsize), before=(R.get('h1') or {}).get('space_above') or 10,
                   after=(R.get('h1') or {}).get('space_below') or 4),
        'h2': dict(st(R.get('h2'), bsize), before=(R.get('h2') or {}).get('space_above') or 7,
                   after=(R.get('h2') or {}).get('space_below') or 2),
        'h3': dict(st(R.get('h3'), bsize), runin=True, before=4, after=0),
        'caption': {'family': fam(R.get('caption')), 'size': (R.get('caption') or {}).get('size') or bsize * 0.85,
                    'lead': (R.get('caption') or {}).get('leading') or bsize, 'label_fig': (R.get('caption') or {}).get('label') or 'Figure',
                    'label_tab': 'Table', 'label_weight': 'bold' if ((R.get('caption') or {}).get('label_bold') or 0) > 0.5 else 'normal',
                    'sep': (((R.get('caption') or {}).get('sep') or '.') + ' ').replace('  ', ' '), 'align': 'justify', 'skip': 6},
        'bib': {'size': (R.get('reference') or {}).get('size') or bsize * 0.85, 'lead': (R.get('reference') or {}).get('leading') or bsize,
                'label': (R.get('reference') or {}).get('ref_label') or 'bracket', 'sep': 0.5, 'head': 'References'},
    }
    return look


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default='labels', choices=['labels', 'proposals', 'both'])
    ap.add_argument('--journal')
    ap.add_argument('--look', action='store_true')
    a = ap.parse_args()
    man = json.load(open(os.path.join(FT, 'manifest-journals.json')))
    labels = {}
    props = {}
    try:
        labels = json.load(open(os.path.join(FT, 'labels-journals.json')))
    except Exception:
        pass
    try:
        props = json.load(open(os.path.join(FT, 'proposals-journals.json')))
    except Exception:
        pass
    by_journal = collections.defaultdict(list)
    counts = {}
    for m in man:
        if a.journal and a.journal.lower() not in m['journal'].lower():
            continue
        lab_pages = (labels.get(m['id']) or {}).get('pages') or {}
        prop_pages = (props.get(m['id']) or {}).get('pages') or {}
        boxes = {}
        for pg in set(list(lab_pages) + list(prop_pages)):
            if a.source in ('labels', 'both') and lab_pages.get(pg):
                boxes[pg] = lab_pages[pg]
            elif a.source in ('proposals', 'both') and prop_pages.get(pg):
                boxes[pg] = prop_pages[pg]
        counts[m['id']] = sum(len(v) for v in boxes.values())
        if not boxes:
            continue
        family = re.split(r'\s+[—(]', m['journal'])[0].strip()
        by_journal[family].append(profile_paper(m, boxes))
    profiles = {j: pool(ps) for j, ps in by_journal.items()}
    os.makedirs(os.path.join(CORPUS, '_styles'), exist_ok=True)
    outp = os.path.join(CORPUS, '_styles', 'journal-profiles-%s.json' % a.source)
    json.dump(profiles, open(outp, 'w'), indent=1)
    if a.look:
        for j, p in profiles.items():
            print('// ' + j)
            print(json.dumps(look_from(p, j), indent=2))
        return
    for j, p in sorted(profiles.items()):
        pg = p.get('page', {})
        print('\n== %s  (%d papers)' % (j, len(by_journal[j])))
        if pg:
            print('   page %sx%s  margins %s  cols %s gap %s' % (pg.get('w'), pg.get('h'), pg.get('margins'), pg.get('columns'), pg.get('colsep')))
        for t in ('title', 'authors', 'affiliation', 'abstract', 'h1', 'h2', 'h3', 'text', 'caption', 'tcaption', 'reference', 'footnote', 'header', 'footer'):
            r = p['regions'].get(t)
            if not r:
                continue
            print('   %-11s %-26s %5s/%-5s b%.1f i%.1f up%s %s%s%s%s' % (
                t, (r.get('font') or '')[:26], r.get('size'), r.get('leading'), r.get('bold', 0), r.get('italic', 0),
                r.get('upper'), r.get('align') or '',
                (' indent %s' % r['indent']) if r.get('indent') else '',
                (' above %s below %s' % (r.get('space_above'), r.get('space_below'))) if t in ('h1', 'h2', 'h3') else '',
                (' label "%s"%s bold%.1f' % (r.get('label'), r.get('sep'), r.get('label_bold', 0))) if t in ('caption', 'tcaption') else
                (' style %s' % r.get('ref_label')) if t == 'reference' else ''))
    print('\nwrote', outp)


if __name__ == '__main__':
    main()
