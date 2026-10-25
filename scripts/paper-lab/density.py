#!/usr/bin/env python3
"""density.py — body-text density of a PDF (Paper Lab, V3.907).

    python3 scripts/paper-lab/density.py paper.pdf [--pages 2-12] [--size 9.5]

Reports, for lines set in the body font size (the most common size, or
--size): characters per FULL line (lines that reach the right edge of their
column — paragraph-final lines excluded), lines per full column, baseline
pitch (leading), and the column x-ranges. Comparing the original journal PDF
with our compiled PDF says how to tune a look's font size: if the original
fits 7% more characters on a line, the look's text is ~7% too large (or the
face is wider).
"""
import argparse
import collections
import statistics

import pdfplumber


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--pages')
    ap.add_argument('--size', type=float)
    a = ap.parse_args()
    with pdfplumber.open(a.pdf) as pdf:
        n = len(pdf.pages)
        first, last = 1, n
        if a.pages:
            first, last = [int(x) for x in a.pages.split('-')]
        sizes = collections.Counter()
        pages = []
        for pno in range(first, min(last, n) + 1):
            p = pdf.pages[pno - 1]
            ch = [c for c in p.chars if c.get('upright', True) and c['text'].strip()]
            for c in ch:
                sizes[round(c['size'], 1)] += 1
            pages.append((p, ch))
        body = a.size or sizes.most_common(1)[0][0]
        full_lens, pitches, col_lines = [], [], []
        edges = collections.Counter()
        for p, ch in pages:
            bc = [c for c in ch if abs(c['size'] - body) < 0.25]
            if not bc:
                continue
            H = p.height
            # lines by baseline
            lines = collections.defaultdict(list)
            for c in bc:
                base = round((H - c['matrix'][5]) if c.get('matrix') else c['bottom'], 1)
                lines[base].append(c)
            # split each baseline into column runs
            runs = []
            for base, cs in lines.items():
                cs.sort(key=lambda c: c['x0'])
                run = [cs[0]]
                for c in cs[1:]:
                    if c['x0'] - run[-1]['x1'] > 1.0 * body:
                        runs.append((base, run))
                        run = [c]
                    else:
                        run.append(c)
                runs.append((base, run))
            for base, r in runs:
                edges[(round(r[0]['x0'] / 4) * 4)] += 1
            # right edges per column start
            by_col = collections.defaultdict(list)
            for base, r in runs:
                by_col[round(r[0]['x0'] / 20)].append((base, r))
            for k, rs in by_col.items():
                if len(rs) < 8:
                    continue
                right = max(r[-1]['x1'] for _, r in rs)
                full = [r for _, r in rs if r[-1]['x1'] > right - 2.5]
                for r in full:
                    full_lens.append(sum(len(c['text']) for c in r) + sum(1 for i in range(1, len(r)) if r[i]['x0'] - r[i - 1]['x1'] > 0.15 * body))
                bases = sorted(b for b, _ in rs)
                d = [y - x for x, y in zip(bases, bases[1:]) if 0 < y - x < 2.2 * body]
                pitches += d
                col_lines.append(len(rs))
        print('body size %.1f  chars/full line %.1f (n=%d)  leading %.2f  median lines/column %s  pages %d' % (
            body, statistics.mean(full_lens) if full_lens else 0, len(full_lens),
            statistics.median(pitches) if pitches else 0,
            statistics.median(col_lines) if col_lines else 0, len(pages)))


if __name__ == '__main__':
    main()
