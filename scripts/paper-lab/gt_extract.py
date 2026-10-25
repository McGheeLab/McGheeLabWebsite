#!/usr/bin/env python3
"""gt_extract.py — dump a journal PDF as reading-order text for rebuilding it
as a paper-builder bundle (Paper Lab ground truth, V3.906).

    python3 scripts/paper-lab/gt_extract.py paper.pdf [--pages 1-6] > dump.txt

Per page it prints the text block in READING ORDER (full-width lines first,
then left column, then right column — column split detected per page), one
line per output line, prefixed with the font size, so headings and captions
are easy to spot:

    p3 L 9.0 | The cytoskeleton generates forces that are^{12,13} transmitted
    p3 L 9.0 | through focal adhesions ...
    p3 R 8.0B| Fig. 2. Traction maps ...

Markup inside lines:
    ^{...}   superscript run (citations in Nature/PNAS/ACS styles, exponents)
    _{...}   subscript run
    **...**  bold run
    *...*    italic run (only when --italics; noisy in math-heavy papers)

Coordinates are PDF points from the page's top-left (pdfplumber convention),
the same space gt_crop.py takes, so a figure can be cropped from the
positions printed with --boxes.
"""
import argparse
import re
import statistics
import sys

import pdfplumber

LIG = {'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
       '‐': '-', '­': ''}


def fix(s):
    for k, v in LIG.items():
        s = s.replace(k, v)
    return s


def parse_pages(spec, n):
    if not spec:
        return list(range(1, n + 1))
    out = []
    for part in spec.split(','):
        if '-' in part:
            a, b = part.split('-')
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return [p for p in out if 1 <= p <= n]


def is_bold(fontname):
    f = (fontname or '').lower()
    return any(k in f for k in ('bold', '-bd', 'black', 'semibold', 'heavy', ',b', 'medi'))


def is_italic(fontname):
    f = (fontname or '').lower()
    return any(k in f for k in ('italic', 'oblique', '-it', 'ital', ',i'))


def lines_of(chars):
    """Group chars into visual lines. Full-size chars define baselines;
    small chars (super/subscripts) attach to the nearest line covering them."""
    if not chars:
        return []
    sizes = sorted(c['size'] for c in chars)
    body = sizes[len(sizes) // 2]
    big = [c for c in chars if c['size'] >= 0.8 * body]
    small = [c for c in chars if c['size'] < 0.8 * body]
    lines = []
    for c in sorted(big, key=lambda c: (c['bottom'], c['x0'])):
        tol = 0.3 * c['size']
        best = None
        for ln in lines[-8:]:
            if abs(ln['base'] - c['bottom']) <= tol and abs(ln['size0'] - c['size']) < 0.6 * c['size']:
                best = ln
        if best is None:
            best = {'chars': [], 'base': c['bottom'], 'size0': c['size']}
            lines.append(best)
        best['chars'].append(c)
    # small-size lines (footnotes, captions in small type) form their own lines
    # when nothing big is near; otherwise they attach as scripts.
    orphans = []
    for c in small:
        cx = (c['x0'] + c['x1']) / 2
        best, bd = None, 1e9
        for ln in lines:
            xs = [q['x0'] for q in ln['chars']] + [q['x1'] for q in ln['chars']]
            if not (min(xs) - 3 * c['size'] <= cx <= max(xs) + 3 * c['size']):
                continue
            d = c['bottom'] - ln['base']
            if -0.75 * ln['size0'] <= d <= 0.45 * ln['size0'] and abs(d) < bd:
                best, bd = ln, abs(d)
        if best is not None:
            best['chars'].append(c)
        else:
            orphans.append(c)
    for c in sorted(orphans, key=lambda c: (c['bottom'], c['x0'])):
        tol = 0.3 * c['size']
        best = None
        for ln in lines[-12:]:
            if ln.get('smallline') and abs(ln['base'] - c['bottom']) <= tol:
                best = ln
        if best is None:
            best = {'chars': [], 'base': c['bottom'], 'size0': c['size'], 'smallline': True}
            lines.append(best)
        best['chars'].append(c)
    out = []
    for ln in lines:
        ln['chars'].sort(key=lambda c: c['x0'])
        # split a baseline group into runs at big horizontal gaps (two columns
        # whose baselines coincide, or a label far from the text)
        run = [ln['chars'][0]]
        runs = [run]
        for c in ln['chars'][1:]:
            if c['x0'] - run[-1]['x1'] > 1.0 * max(c['size'], run[-1]['size'], ln['size0']):
                run = [c]
                runs.append(run)
            else:
                run.append(c)
        for r in runs:
            sz = [c['size'] for c in r if c['text'].strip()]
            out.append({'chars': r, 'top': min(c['top'] for c in r), 'bottom': ln['base'],
                        'x0': min(c['x0'] for c in r), 'x1': max(c['x1'] for c in r),
                        'size': statistics.median(sz) if sz else 0, 'h': ln['size0']})
    return out


def find_gutter(lines, W):
    """x-range of the column gutter (from line runs), or None (1 column).
    Full-width lines (title, spanning abstract) cross the gutter, so the
    gutter is the x where FEW runs are present relative to the busiest x."""
    runs = [ln for ln in lines if ln['size'] >= 6 and (ln['x1'] - ln['x0']) > 20]
    if len(runs) < 8:
        return None
    lo, hi = int(W * 0.3), int(W * 0.7)
    cov = [0] * (hi - lo + 1)
    for ln in runs:
        a, b = max(lo, int(ln['x0'])), min(hi, int(ln['x1']))
        for x in range(a, b + 1):
            cov[x - lo] += 1
    peak = max(cov) or 1
    floor = min(cov)
    if floor > 0.35 * peak:
        return None
    thr = floor + 0.02 * peak
    best = None
    i = 0
    while i < len(cov):
        if cov[i] <= thr:
            j = i
            while j + 1 < len(cov) and cov[j + 1] <= thr:
                j += 1
            if j - i >= 2 and (best is None or (j - i) > (best[1] - best[0])):
                best = (i + lo, j + lo)
            i = j + 1
        else:
            i += 1
    # a real gutter has text on both sides
    if best:
        left = sum(1 for ln in runs if ln['x1'] <= best[1] + 1)
        right = sum(1 for ln in runs if ln['x0'] >= best[0] - 1)
        if left < 4 or right < 4:
            return None
    return best


def render_line(ln, italics=False):
    """Text of one line with ^{} _{} ** markup, spaces from gaps."""
    base = ln['size'] or 10
    full = [c for c in ln['chars'] if c['size'] >= 0.85 * base and c['text'].strip()]
    base_bottom = statistics.median([c['bottom'] for c in full]) if full else ln['bottom']
    out = []
    mode = None  # '^' | '_' | None
    bold = False
    ital = False
    prev = None
    for c in ln['chars']:
        t = fix(c['text'])
        if prev is not None:
            gap = c['x0'] - prev['x1']
            if gap > 0.18 * min(prev['size'], c['size']) and not (out and out[-1].endswith(' ')):
                if mode:
                    out.append('}')
                    mode = None
                out.append(' ')
        small = c['size'] < 0.82 * base and t.strip()
        m = None
        if small:
            if c['bottom'] < base_bottom - 0.18 * base:
                m = '^'
            elif c['bottom'] > base_bottom + 0.08 * base:
                m = '_'
        if m != mode:
            if mode:
                out.append('}')
            if m:
                out.append(m + '{')
            mode = m
        b = is_bold(c.get('fontname')) and bool(t.strip())
        if t.strip() and b != bold and not mode:
            out.append('**')
            bold = b
        if italics:
            i = is_italic(c.get('fontname')) and bool(t.strip())
            if t.strip() and i != ital and not mode:
                out.append('*')
                ital = i
        out.append(t)
        prev = c
    if mode:
        out.append('}')
    if bold:
        out.append('**')
    if ital:
        out.append('*')
    s = ''.join(out)
    s = re.sub(r'\*\*(\s*)\*\*', r'\1', s)
    s = re.sub(r'[ \t]+', ' ', s).strip()
    return s


def split_columns(lines, gutter):
    """Classify lines: full-width (F), left (L), right (R), single (S)."""
    if gutter is None:
        return [('S', ln) for ln in lines]
    g0, g1 = gutter
    out = []
    for ln in lines:
        if ln['x1'] <= g1 + 1:
            out.append(('L', ln))
        elif ln['x0'] >= g0 - 1:
            out.append(('R', ln))
        else:
            out.append(('F', ln))
    return out


def dump(pdf_path, pages, boxes=False, italics=False):
    with pdfplumber.open(pdf_path) as pdf:
        n = len(pdf.pages)
        print('# %s — %d pages' % (pdf_path, n))
        for pno in parse_pages(pages, n):
            page = pdf.pages[pno - 1]
            W, H = page.width, page.height
            print('\n=== page %d  (%.1f x %.1f pt) ===' % (pno, W, H))
            if boxes:
                for im in page.images:
                    print('  [image] x0=%.1f top=%.1f x1=%.1f bottom=%.1f  (%dx%d px)' % (
                        im['x0'], im['top'], im['x1'], im['bottom'],
                        im.get('srcsize', (0, 0))[0], im.get('srcsize', (0, 0))[1]))
            chars = [c for c in page.chars if c.get('upright', True) and c['text'].strip()
                     and c['size'] >= 3.5]
            for c in chars:
                # true baseline from the text matrix: bbox bottoms differ by
                # font (ligatures, dashes, symbols) and split lines otherwise
                m = c.get('matrix')
                if m:
                    c['bottom'] = H - m[5]
            # margin furniture (rotated journal banners, line numbers) lives
            # outside the text block; keep chars that sit between 3% and 97%
            body_chars = [c for c in chars if W * 0.03 < c['x0'] < W * 0.97]
            lines = lines_of(body_chars)
            gutter = find_gutter(lines, W)
            classified = split_columns(lines, gutter)
            order = {'F': 0, 'S': 0, 'L': 1, 'R': 2}
            # Full-width lines that sit BELOW column text (footers, page-
            # spanning figures' captions) keep their vertical position: sort
            # F lines among themselves by top, then L, then R — and print F
            # lines located after the columns' first line at the end.
            col_tops = [ln['top'] for k, ln in classified if k in ('L', 'R')]
            first_col = min(col_tops) if col_tops else 1e9
            head = [(k, ln) for k, ln in classified if k in ('F', 'S') and ln['top'] < first_col]
            tail = [(k, ln) for k, ln in classified if k in ('F', 'S') and ln['top'] >= first_col]
            left = [(k, ln) for k, ln in classified if k == 'L']
            right = [(k, ln) for k, ln in classified if k == 'R']
            for group in (head, left, right, tail):
                for k, ln in sorted(group, key=lambda kl: kl[1]['top']):
                    txt = render_line(ln, italics)
                    if not txt:
                        continue
                    b = 'B' if all(is_bold(c.get('fontname')) for c in ln['chars'] if c['text'].strip()) else ' '
                    pos = (' @%.0f,%.0f' % (ln['x0'], ln['top'])) if boxes else ''
                    print('p%d %s %4.1f%s|%s %s' % (pno, k, ln['size'], b, pos, txt))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--pages')
    ap.add_argument('--boxes', action='store_true', help='print image boxes and line positions (pt)')
    ap.add_argument('--italics', action='store_true')
    a = ap.parse_args()
    dump(a.pdf, a.pages, a.boxes, a.italics)
