#!/usr/bin/env python3
"""compare.py — side-by-side + measured comparison of one paper (Paper Lab, V3.906).

    python3 scripts/paper-lab/compare.py RUN_DIR [--original PDF --pages 1-6]
                                         [--out compare.png] [--title T]

RUN_DIR holds the driver output: preview-NN.png (Document view sheets),
compiled.pdf (local Tectonic compile of the real export). The original
journal PDF comes from --original (or RUN_DIR/original.pdf).

Writes:
  compare.png    rows of pages: ORIGINAL | COMPILED LaTeX | BROWSER PREVIEW
  metrics.json   the same ink-based measurements for all three, so they are
                 directly comparable:
                   pages          page count
                   fill           mean fraction of the text block that has ink
                   gaps           blank vertical runs INSIDE a column (between
                                  its first and last ink row) taller than
                                  2.5 body lines — "weird text gaps"
                   foot_blank     mean blank height at column feet (pages
                                  before the last), in body lines
                   cols           detected text columns per page
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

RENDER_DPI = 100  # page rasters for measurement + display


def font(sz, bold=False):
    p = '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf'
    try:
        return ImageFont.truetype(p, sz)
    except Exception:
        return ImageFont.load_default()


def render_pdf(pdf, first=None, last=None, dpi=RENDER_DPI):
    td = tempfile.mkdtemp(prefix='plc-')
    cmd = ['pdftoppm', '-r', str(dpi), '-png']
    if first:
        cmd += ['-f', str(first)]
    if last:
        cmd += ['-l', str(last)]
    subprocess.run(cmd + [pdf, os.path.join(td, 'p')], check=True)
    return [Image.open(p).convert('L') for p in sorted(glob.glob(os.path.join(td, 'p-*.png')))]


def load_preview(run_dir):
    files = sorted(glob.glob(os.path.join(run_dir, 'preview-*.png')))
    out = []
    for f in files:
        im = Image.open(f).convert('L')
        out.append(im)
    return out


def to_physical(im, page_w_in):
    """Rescale an image so it is RENDER_DPI px per physical inch."""
    w = int(round(page_w_in * RENDER_DPI))
    h = int(round(im.height * w / im.width))
    return im.resize((w, h), Image.LANCZOS)


def measure(im, block=None):
    """Ink-based layout measurements of one page raster (RENDER_DPI).
    block = (x0, top, x1, bottom) in PDF points: measure only the text
    block (running heads, page numbers and sheet borders are not text)."""
    if block:
        k = RENDER_DPI / 72.0
        pad = 2 * k
        im = im.crop((max(0, int(block[0] * k - pad)), max(0, int(block[1] * k - pad)),
                      min(im.width, int(block[2] * k + pad)), min(im.height, int(block[3] * k + pad))))
    a = np.asarray(im, dtype=np.uint8)
    ink = a < 160
    H, W = ink.shape
    rows = ink.sum(1)
    cols = ink.sum(0)
    # text block: rows/cols with any ink, trimmed of thin page furniture
    ys = np.where(rows > 0)[0]
    xs = np.where(cols > 0)[0]
    if len(ys) < 10 or len(xs) < 10:
        return {'empty': True}
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    # columns: find a vertical gutter near the middle of the text block
    mid0, mid1 = x0 + int(0.35 * (x1 - x0)), x0 + int(0.65 * (x1 - x0))
    band = ink[y0:y1, :]
    colcov = band.sum(0)
    gut = None
    best = 0
    run = 0
    for x in range(mid0, mid1):
        if colcov[x] <= 0.004 * (y1 - y0):
            run += 1
            if run > best:
                best = run
                gut = (x - run + 1, x)
        else:
            run = 0
    columns = [(x0, x1)]
    if gut and best >= max(6, int(0.01 * W)):
        columns = [(x0, gut[0]), (gut[1], x1)]
    # body line height estimate: median distance between text-line starts
    line_starts = []
    prev = False
    for y in range(y0, y1):
        on = rows[y] > 0
        if on and not prev:
            line_starts.append(y)
        prev = on
    d = np.diff(line_starts) if len(line_starts) > 3 else np.array([14])
    d = d[(d > 6) & (d < 40)]
    line_h = float(np.median(d)) if len(d) else 14.0
    gaps = []
    foot = []
    fills = []
    for (cx0, cx1) in columns:
        cin = ink[y0:y1 + 1, cx0:cx1 + 1].any(1)
        cy = np.where(cin)[0]
        if len(cy) == 0:
            foot.append((y1 - y0) / line_h)
            continue
        first, last = int(cy.min()), int(cy.max())
        fills.append(float(cin.mean()))
        foot.append(((y1 - y0) - last) / line_h)
        r = 0
        for y in range(first, last + 1):
            if not cin[y]:
                r += 1
            else:
                if r > 2.5 * line_h:
                    gaps.append({'col': columns.index((cx0, cx1)), 'y': int(y0 + y - r), 'h_lines': round(r / line_h, 1)})
                r = 0
    return {'cols': len(columns), 'line_h_px': round(line_h, 1), 'block': [x0, y0, x1, y1],
            'gaps': gaps, 'foot_blank_lines': [round(f, 1) for f in foot],
            'fill': round(float(np.mean(fills)) if fills else 0.0, 3)}


def summarize(pages, block=None):
    ms = [measure(p, block) for p in pages]
    real = [m for m in ms if not m.get('empty')]
    n_gaps = sum(len(m['gaps']) for m in real)
    gap_lines = sum(g['h_lines'] for m in real for g in m['gaps'])
    feet = [f for m in real[:-1] for f in m['foot_blank_lines']]
    return {
        'pages': len(pages),
        'cols_mode': int(np.bincount([m['cols'] for m in real]).argmax()) if real else 0,
        'gaps': n_gaps, 'gap_lines': round(gap_lines, 1),
        'foot_blank_lines_mean': round(float(np.mean(feet)), 2) if feet else 0.0,
        'fill_mean': round(float(np.mean([m['fill'] for m in real])), 3) if real else 0.0,
        'per_page': ms,
    }


def sheet(columns, labels, out, title, thumb_h=760, pad=14):
    n = max(len(c) for c in columns)
    head = 70
    colw = []
    for c in columns:
        ws = [int(im.width * thumb_h / im.height) for im in c] or [int(thumb_h * 0.77)]
        colw.append(max(ws))
    W = pad + sum(w + pad for w in colw)
    H = head + n * (thumb_h + pad) + pad
    S = Image.new('RGB', (W, H), (232, 232, 228))
    d = ImageDraw.Draw(S)
    d.text((pad, 10), title, font=font(26, True), fill=(30, 41, 59))
    x = pad
    for ci, (c, lab) in enumerate(zip(columns, labels)):
        d.text((x, 42), lab, font=font(20, True), fill=(30, 41, 59))
        for i in range(n):
            y = head + i * (thumb_h + pad)
            if i < len(c):
                im = c[i].convert('RGB')
                im = im.resize((int(im.width * thumb_h / im.height), thumb_h), Image.LANCZOS)
                S.paste(im, (x, y))
                d.rectangle([x - 1, y - 1, x + im.width, y + im.height], outline=(150, 150, 150))
            else:
                d.rectangle([x, y, x + colw[ci], y + thumb_h], outline=(200, 200, 200))
                d.text((x + 20, y + 20), '(no page)', font=font(18), fill=(150, 150, 150))
        x += colw[ci] + pad
    tmp = out + '.tmp.png'
    S.save(tmp)
    os.replace(tmp, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir')
    ap.add_argument('--original')
    ap.add_argument('--pages')
    ap.add_argument('--out')
    ap.add_argument('--title', default='')
    ap.add_argument('--thumb-h', type=int, default=760)
    ap.add_argument('--max-pages', type=int, default=0)
    ap.add_argument('--orig-block', help='x0,top,x1,bottom (pt) of the original\'s text block')
    ap.add_argument('--look-block', help='x0,top,x1,bottom (pt) of the look\'s text block (compiled + preview)')
    a = ap.parse_args()
    rd = a.run_dir
    orig = a.original or os.path.join(rd, 'original.pdf')
    first = last = None
    if a.pages:
        first, last = [int(x) for x in a.pages.split('-')]
    cols, labels, metrics = [], [], {}
    ob = tuple(float(v) for v in a.orig_block.split(',')) if a.orig_block else None
    lb = tuple(float(v) for v in a.look_block.split(',')) if a.look_block else None
    if os.path.exists(orig):
        o = render_pdf(orig, first, last)
        cols.append(o); labels.append('ORIGINAL (%d pp)' % len(o)); metrics['original'] = summarize(o, ob)
    comp = os.path.join(rd, 'compiled.pdf')
    if os.path.exists(comp):
        c = render_pdf(comp)
        cols.append(c); labels.append('COMPILED LaTeX (%d pp)' % len(c)); metrics['compiled'] = summarize(c, lb)
    pv = load_preview(rd)
    if pv:
        # preview sheets are CSS px (96 dpi) × DPR; scale to RENDER_DPI by the
        # page width in inches (letter 8.5 / A4 8.27 — read from aspect)
        aspect = pv[0].height / pv[0].width
        w_in = 8.27 if abs(aspect - 1.414) < 0.02 else 8.5
        pv = [to_physical(p, w_in) for p in pv]
        cols.append(pv); labels.append('BROWSER PREVIEW (%d pp)' % len(pv)); metrics['preview'] = summarize(pv, lb)
    if a.max_pages:
        cols = [c[:a.max_pages] for c in cols]
    out = a.out or os.path.join(rd, 'compare.png')
    sheet(cols, labels, out, a.title or os.path.basename(rd.rstrip('/')), thumb_h=a.thumb_h)
    with open(os.path.join(rd, 'metrics.json'), 'w') as f:
        json.dump(metrics, f, indent=1)
    brief = {k: {kk: v[kk] for kk in ('pages', 'cols_mode', 'gaps', 'gap_lines', 'foot_blank_lines_mean', 'fill_mean')} for k, v in metrics.items()}
    print(json.dumps(brief, indent=1))
    print(out)


if __name__ == '__main__':
    main()
