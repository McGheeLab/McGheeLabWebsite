#!/usr/bin/env python3
"""overview.py — one image of every corpus paper: first pages of
ORIGINAL | COMPILED | PREVIEW, with the headline numbers (Paper Lab, V3.906).

    python3 scripts/paper-lab/overview.py <runs/tag dir> out.png [--pages 2]
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

def font(sz, bold=False):
    p = '/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf'
    return ImageFont.truetype(p, sz)

def pdf_pages(pdf, first, n, h):
    td = tempfile.mkdtemp(prefix='plo-')
    subprocess.run(['pdftoppm', '-r', '60', '-f', str(first), '-l', str(first + n - 1), '-png', pdf, td + '/p'], check=True)
    return [Image.open(f).convert('RGB') for f in sorted(glob.glob(td + '/p-*.png'))]

def fit(im, h):
    return im.resize((int(im.width * h / im.height), h), Image.LANCZOS)

def main():
    runs, out = sys.argv[1], sys.argv[2]
    npg = int(sys.argv[sys.argv.index('--pages') + 1]) if '--pages' in sys.argv else 2
    corpus = os.path.abspath(os.path.join(runs, '..', '..'))
    H = 300
    rows = []
    for d in sorted(glob.glob(os.path.join(runs, 'gt-*'))):
        pid = os.path.basename(d)
        truth = {}
        try:
            truth = json.load(open(os.path.join(corpus, pid, 'truth.json')))
        except Exception:
            pass
        first = (truth.get('main_pages') or [1])[0]
        o = pdf_pages(os.path.join(corpus, pid, 'original.pdf'), first, npg, H)
        c = pdf_pages(os.path.join(d, 'compiled.pdf'), 1, npg, H) if os.path.exists(os.path.join(d, 'compiled.pdf')) else []
        p = [Image.open(f).convert('RGB') for f in sorted(glob.glob(os.path.join(d, 'preview-*.png')))[:npg]]
        m = {}
        try:
            m = json.load(open(os.path.join(d, 'metrics.json')))
        except Exception:
            pass
        rows.append((pid, truth.get('journal', ''), o, c, p, m))
    pw = int(H * 0.77)
    colw = npg * (pw + 6) + 14
    W = 260 + 3 * colw
    S = Image.new('RGB', (W, 70 + len(rows) * (H + 46)), (236, 236, 232))
    d = ImageDraw.Draw(S)
    d.text((16, 14), os.path.basename(runs.rstrip('/')).upper() + ' — first pages: ORIGINAL | COMPILED LaTeX | BROWSER PREVIEW', font=font(26, True), fill=(30, 41, 59))
    for ci, lab in enumerate(['ORIGINAL', 'COMPILED LaTeX', 'BROWSER PREVIEW']):
        d.text((260 + ci * colw, 48), lab, font=font(17, True), fill=(71, 85, 105))
    y = 70
    for pid, jn, o, c, p, m in rows:
        d.text((14, y + 4), pid.replace('gt-', ''), font=font(17, True), fill=(30, 41, 59))
        d.text((14, y + 28), jn[:28], font=font(14), fill=(71, 85, 105))
        yy = y + 54
        for k in ('original', 'compiled', 'preview'):
            v = m.get(k)
            txt = '%s: %s' % (k[:4], ('%d pp · %d gaps' % (v['pages'], v['gaps'])) if v else 'FAILED')
            d.text((14, yy), txt, font=font(14), fill=(185, 28, 28) if not v else (30, 41, 59))
            yy += 20
        for ci, ims in enumerate((o, c, p)):
            x = 260 + ci * colw
            if not ims:
                d.rectangle([x, y, x + pw, y + H], outline=(185, 28, 28), width=2)
                d.text((x + 20, y + H // 2), 'compile failed', font=font(16, True), fill=(185, 28, 28))
            for im in ims:
                t = fit(im, H)
                S.paste(t, (x, y))
                d.rectangle([x - 1, y - 1, x + t.width, y + t.height], outline=(150, 150, 150))
                x += t.width + 6
        y += H + 46
    tmp = out + '.tmp.png'
    S.save(tmp)
    os.replace(tmp, out)
    print(out, S.size)

main()
