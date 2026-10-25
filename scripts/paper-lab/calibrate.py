#!/usr/bin/env python3
"""calibrate.py — measure a journal look from a PDF (Paper Lab, V3.908).

    python3 scripts/paper-lab/calibrate.py paper.pdf [--pages 2-8]

Prints the numbers a template `look` needs, measured from the page itself:
page size, text block (robust extent of body-size text across pages),
columns + gap, body size + leading (baseline pitch), characters per full
line, and the sizes of other text styles in use (headings, captions,
footnotes). Use it on an original journal PDF to design a `spec` look, and on
a class-compiled PDF (PNAS, IEEE, REVTeX) to describe a `class` look so the
Document view draws exactly the page the class makes.
"""
import argparse
import collections
import json
import statistics

import pdfplumber


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    return xs[min(len(xs) - 1, max(0, int(q * (len(xs) - 1))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--pages')
    a = ap.parse_args()
    with pdfplumber.open(a.pdf) as pdf:
        n = len(pdf.pages)
        first, last = 1, n
        if a.pages:
            first, last = [int(x) for x in a.pages.split('-')]
        pages = pdf.pages[first - 1:last]
        W, H = pages[0].width, pages[0].height
        sizes = collections.Counter()
        fonts = collections.Counter()
        for p in pages:
            for c in p.chars:
                if c['text'].strip():
                    sizes[round(c['size'], 2)] += 1
                    fonts[(c['fontname'].split('+')[-1], round(c['size'], 1))] += 1
        body = sizes.most_common(1)[0][0]
        xs0, xs1, tops, bots = [], [], [], []
        pitches, full_lens, gaps = [], [], []
        for p in pages:
            bc = [c for c in p.chars if c['text'].strip() and abs(c['size'] - body) < 0.2 and c.get('upright', True)]
            if len(bc) < 50:
                continue
            xs0.append(min(c['x0'] for c in bc))
            xs1.append(max(c['x1'] for c in bc))
            lines = collections.defaultdict(list)
            for c in bc:
                lines[round(H - c['matrix'][5], 1)].append(c)
            bases = sorted(lines)
            tops.append(bases[0] - body * 0.75)
            bots.append(bases[-1] + body * 0.25)
            # column gutter: largest empty x-run in the middle third
            cov = [0] * int(W + 1)
            for c in bc:
                for x in range(int(c['x0']), int(c['x1']) + 1):
                    if 0 <= x <= W:
                        cov[x] += 1
            mid = [x for x in range(int(W * 0.35), int(W * 0.65))]
            run, best = 0, (0, 0)
            for x in mid:
                if cov[x] == 0:
                    run += 1
                    if run > best[1] - best[0]:
                        best = (x - run + 1, x + 1)
                else:
                    run = 0
            if best[1] - best[0] > 4:
                gaps.append(best)
            # pitch per column
            for side in (0, 1):
                ys = sorted(b for b in bases if (min(c['x0'] for c in lines[b]) < W / 2) == (side == 0))
                d = [y - x for x, y in zip(ys, ys[1:]) if 0 < y - x < 1.6 * body]
                pitches += d
        two = len(gaps) >= max(1, len(xs0) // 2)
        gap = (statistics.median(g[0] for g in gaps), statistics.median(g[1] for g in gaps)) if two else None
        x0 = pct(xs0, 0.1)
        x1 = pct(xs1, 0.9)
        top = pct(tops, 0.1)
        bot = pct(bots, 0.9)
        out = {
            'page': {'w': round(W, 1), 'h': round(H, 1)},
            'margins': {'left': round(x0, 1), 'right': round(W - x1, 1), 'top': round(top, 1), 'bottom': round(H - bot, 1)},
            'columns': 2 if two else 1,
            'colsep': round(gap[1] - gap[0], 1) if gap else 0,
            'body': {'size': body, 'lead': round(statistics.median(pitches), 2) if pitches else None},
            'top_fonts': [(f, s, k) for (f, s), k in fonts.most_common(14)],
        }
        print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
