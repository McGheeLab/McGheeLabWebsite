#!/usr/bin/env python3
"""sync.py — does the Document view break lines and pages where LaTeX does?
(Paper Lab, V3.908)

    python3 scripts/paper-lab/sync.py RUN_DIR

Reads RUN_DIR/preview-lines.json (every typeset line the driver saw, per
sheet) and RUN_DIR/compiled.pdf (body lines via pdfplumber), normalizes both
to letter streams, and reports:
  line_ends   share of compiled line-end positions the preview also ends a
              line at (the Knuth–Plass agreement, whole document)
  page_starts share of pages whose first body words agree
  pages       per-page first words, compiled vs preview, where they differ
"""
import json
import os
import re
import sys
import difflib
import collections

import pdfplumber


def norm(t):
    return re.sub(r'[^a-z0-9]', '', t.lower())


def pdf_lines(pdf_path, body_size):
    out = []
    with pdfplumber.open(pdf_path) as pdf:
        for pi, page in enumerate(pdf.pages):
            H = page.height
            mid = page.width / 2
            chars = [c for c in page.chars if c.get('upright', True) and c['size'] >= 4.5 and c['text'].strip()]
            # column split = the widest empty x-run in the middle of the page
            # (none → one column, e.g. PLOS's single wide-margin column)
            cov = collections.Counter()
            # gutter from body-size text only: a spanning title, affiliation
            # or caption line must not fill it
            body_chars = [c for c in chars if body_size and abs(c['size'] - body_size) < 0.25] or chars
            for c in body_chars:
                for x in range(int(c['x0']), int(c['x1']) + 1):
                    cov[x] += 1
            best, run = (0, 0), 0
            for x in range(int(page.width * 0.3), int(page.width * 0.7)):
                if cov[x] == 0:
                    run += 1
                    if run > best[1] - best[0]:
                        best = (x - run + 1, x + 1)
                else:
                    run = 0
            mid = (best[0] + best[1]) / 2 if best[1] - best[0] >= 6 else 1e9
            # V3.912 — a one-column page with a wrapped figure has an empty
            # strip beside the figure, not a gutter: when most body lines
            # run across the middle, it is one column
            rows = collections.defaultdict(list)
            for c in body_chars:
                rows[round(H - c['matrix'][5], 1)].append(c)
            across = sum(1 for cs in rows.values()
                         if min(c['x0'] for c in cs) < page.width * 0.35 and max(c['x1'] for c in cs) > page.width * 0.65)
            if rows and across > 0.5 * len(rows):
                mid = 1e9
            groups = collections.defaultdict(list)
            for c in chars:
                col = 0 if c['x1'] < mid + 2 else 1
                # one column: smaller type (a wrapped figure's caption beside
                # the text) reads after the body, not interleaved with it
                if mid == 1e9 and body_size and c['size'] < body_size - 0.5:
                    col = 1
                groups[(col, round(H - c['matrix'][5], 1))].append(c)
            # a group of smaller chars sitting just above a line (superscript
            # citations) joins that line
            keys = sorted(groups, key=lambda k: (k[0], k[1]))
            gsize = {k: max(c['size'] for c in groups[k]) for k in keys}
            lines = collections.defaultdict(list)
            for k in keys:
                target = k
                for k2 in keys:
                    d = k2[1] - k[1]   # >0: k sits above k2's baseline (superscript)
                    if (k2[0] == k[0] and gsize[k] < 0.85 * gsize[k2] and
                            (0 < d <= 0.6 * gsize[k2] or -0.4 * gsize[k2] <= d < 0)):
                        target = k2
                        break
                lines[target].extend(groups[k])
            pl = []
            for (col, base), cs in sorted(lines.items(), key=lambda kv: (kv[0][0], kv[0][1])):
                cs.sort(key=lambda c: c['x0'])
                pl.append(''.join(c['text'] for c in cs))
            out.append(pl)
    return out


def main():
    rd = sys.argv[1]
    prev = json.load(open(os.path.join(rd, 'preview-lines.json')))
    # body size: most common char size in the compiled pdf
    with pdfplumber.open(os.path.join(rd, 'compiled.pdf')) as pdf:
        cnt = collections.Counter(round(c['size'], 1) for p in pdf.pages for c in p.chars)
    body = cnt.most_common(1)[0][0]
    comp = pdf_lines(os.path.join(rd, 'compiled.pdf'), body)
    # body lines only (a caption / front-matter / bibliography line carries
    # its zone since V3.909; older runs have none = body)
    pv = [[l['t'] for l in sorted([x for x in pg if x['k'] == 'ln' and x.get('z', 'body') == 'body'],
                                  key=lambda x: (x['col'] if x['col'] >= 0 else 0, x['y']))]
          for pg in prev]
    # letter streams with line-end markers
    def stream(pages):
        s, ends, page_lines = [], set(), []
        for pg in pages:
            spans = []
            for ln in pg:
                n = norm(ln.rstrip('-'))
                if not n:
                    continue
                spans.append((len(s), len(s) + len(n)))
                s.extend(n)
                ends.add(len(s))
            page_lines.append(spans)
        return ''.join(s), ends, page_lines
    cs, cends, cstarts = stream(comp)
    ps, pends, pstarts = stream(pv)
    sm = difflib.SequenceMatcher(None, cs, ps, autojunk=False)
    # map compiled positions → preview positions through matching blocks
    cmap = {}
    for a, b, size in sm.get_matching_blocks():
        for k in range(size + 1):
            cmap[a + k] = b + k
    hits = sum(1 for e in cends if e in cmap and cmap[e] in pends)
    mapped = sum(1 for e in cends if e in cmap)
    # page start = the first BODY line on the page: compiled lines that map
    # into the preview's body stream (captions/labels don't)
    def mapped_line(a, b):
        hits = sum(1 for k in range(a, b) if k in cmap)
        return hits >= 0.8 * (b - a)
    starts_ok = 0
    diffs = []
    npg = min(len(cstarts), len(pstarts))
    for i in range(npg):
        cl = [sp for sp in cstarts[i] if mapped_line(*sp)]
        pl = pstarts[i]
        if not cl or not pl:
            continue
        # the line's first character that maps (its very first may not:
        # a running head or sidebar text set beside it in the PDF, V3.921)
        c0 = next(cmap[k] for k in range(*cl[0]) if k in cmap)
        ok = abs(c0 - pl[0][0]) <= 3
        starts_ok += ok
        if not ok:
            diffs.append((i + 1, cs[cl[0][0]:cl[0][0] + 24], ps[pl[0][0]:pl[0][0] + 24]))
    # per-paragraph line counts: preview lines grouped by block id; TeX's
    # count = compiled line ends that fall inside the paragraph's span
    inv = {}
    for a_, b_, size in sm.get_matching_blocks():
        for k in range(size + 1):
            inv[b_ + k] = a_ + k
    pv_lines = [l for pg in prev for l in sorted([x for x in pg if x['k'] == 'ln' and x.get('z', 'body') == 'body'],
                                                  key=lambda x: (max(0, x['col']), x['y']))]
    paras = collections.OrderedDict()
    pos = 0
    for l in pv_lines:
        nn = norm(l['t'].rstrip('-'))
        if not nn:
            continue
        key = l.get('b') or ('?%d' % pos)
        st = paras.setdefault(key, {'a': pos, 'b': pos, 'n': 0})
        st['b'] = pos + len(nn)
        st['n'] += 1
        pos += len(nn)
    same = tot = 0
    worst = []
    mapped_ends = sorted(cmap[e] for e in cends if e in cmap)
    import bisect
    for key, st in paras.items():
        if st['n'] < 2 or st['a'] not in inv or st['b'] not in inv:
            continue
        # TeX lines of THIS paragraph: compiled line ends whose mapped
        # position falls inside the paragraph (captions never map in)
        tex_n = sum(1 for e in mapped_ends if st['a'] < e <= st['b'] + 1)
        tot += 1
        same += (tex_n == st['n'])
        if tex_n != st['n']:
            worst.append((st['n'] - tex_n, ps[st['a']:st['a'] + 30]))
    rep_counts = {'para_line_counts_equal': '%d/%d' % (same, tot),
                  'para_line_count_diffs': sorted(worst, key=lambda w: -abs(w[0]))[:10],
                  'net_line_diff': sum(w[0] for w in worst)}
    rep = {
        'body_size': body,
        'line_ends': round(hits / max(1, mapped), 3), 'line_ends_n': mapped,
        'text_match': round(sm.ratio(), 3),
        'page_starts': '%d/%d' % (starts_ok, npg),
        'page_start_diffs': diffs[:12],
    }
    rep.update(rep_counts)
    # captions, scored on their own: the share of compiled caption line ends
    # the preview's typeset captions share
    cap = [l['t'] for pg in prev for l in sorted([x for x in pg if x['k'] == 'ln' and x.get('z') == 'cap'],
                                                 key=lambda x: (max(0, x['col']), x['y']))]
    if cap:
        cps, cpends, _ = stream([cap])
        sm2 = difflib.SequenceMatcher(None, cs, cps, autojunk=False)
        cm2 = {}
        for a, b, size in sm2.get_matching_blocks():
            if size < 12:
                continue   # stray letter matches outside the captions
            for k in range(size + 1):
                cm2[a + k] = b + k
        m2 = [e for e in cends if e in cm2]
        rep['caption_line_ends'] = round(sum(1 for e in m2 if cm2[e] in cpends) / max(1, len(m2)), 3)
        rep['caption_line_ends_n'] = len(m2)
    json.dump(rep, open(os.path.join(rd, 'sync.json'), 'w'), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == '__main__':
    main()


def mismatches(rd, n=12):
    """Print the first n compiled lines whose END the preview does not share,
    with the preview line around the same position."""
    prev = json.load(open(os.path.join(rd, 'preview-lines.json')))
    comp = pdf_lines(os.path.join(rd, 'compiled.pdf'), 0)
    clines = [l for pg in comp for l in pg]
    plines = [l['t'] for pg in prev for l in sorted([x for x in pg if x['k'] == 'ln' and x.get('z', 'body') == 'body'], key=lambda x: (max(0, x['col']), x['y']))]
    def build(lines):
        s, spans = [], []
        for ln in lines:
            nn = norm(ln.rstrip('-'))
            spans.append((len(s), len(s) + len(nn), ln))
            s.extend(nn)
        return ''.join(s), spans
    cs, cspans = build(clines)
    ps, pspans = build(plines)
    sm = difflib.SequenceMatcher(None, cs, ps, autojunk=False)
    cmap = {}
    for a, b, size in sm.get_matching_blocks():
        for k in range(size + 1):
            cmap[a + k] = b + k
    pend = {e for _, e, _ in pspans}
    shown = 0
    for a, b, txt in cspans:
        if b - a < 8 or b not in cmap or cmap[b] in pend:
            continue
        pb = cmap[b]
        near = [t for (x, y, t) in pspans if x <= pb <= y]
        print('TeX : ' + txt[-70:])
        print('ours: ' + (near[0][-70:] if near else '?'))
        print()
        shown += 1
        if shown >= n:
            break


if __name__ == '__main__' and len(sys.argv) > 2 and sys.argv[2] == '--show':
    mismatches(sys.argv[1])


def show_para(rd, prefix):
    """Both renderings of the paragraph whose letters start with `prefix`."""
    prev = json.load(open(os.path.join(rd, 'preview-lines.json')))
    comp = pdf_lines(os.path.join(rd, 'compiled.pdf'), 0)
    pv = [l['t'] for pg in prev for l in sorted([x for x in pg if x['k'] == 'ln' and x.get('z', 'body') == 'body'], key=lambda x: (max(0, x['col']), x['y']))]
    cl = [l for pg in comp for l in pg]
    for name, lines in (('TeX', cl), ('ours', pv)):
        idx = next((i for i, l in enumerate(lines) if norm(l).startswith(prefix[:12]) or prefix[:16] in norm(' '.join(lines[i:i + 2]))), None)
        print('---', name)
        if idx is None:
            print('  (not found)')
            continue
        for l in lines[idx:idx + 14]:
            print('  ' + l)


if __name__ == '__main__' and len(sys.argv) > 3 and sys.argv[2] == '--para':
    show_para(sys.argv[1], sys.argv[3])
