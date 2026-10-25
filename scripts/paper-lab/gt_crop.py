#!/usr/bin/env python3
"""gt_crop.py — crop a region of a PDF page to PNG (Paper Lab, V3.906).

    python3 scripts/paper-lab/gt_crop.py paper.pdf PAGE X0 TOP X1 BOTTOM out.png [--dpi 300]
    python3 scripts/paper-lab/gt_crop.py paper.pdf PAGE --page out.png [--dpi 100]

Coordinates are PDF points from the page's top-left (the space
gt_extract.py --boxes prints). The crop is rendered by pdftoppm so vector
artwork (plots, labels) is rasterized exactly as printed. --page renders the
whole page (useful to look at a page before deciding a figure's box).
"""
import argparse
import os
import subprocess
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('page', type=int)
    ap.add_argument('coords', nargs='*')
    ap.add_argument('--page', dest='whole', action='store_true')
    ap.add_argument('--dpi', type=int, default=300)
    a = ap.parse_args()
    if a.whole:
        out = a.coords[0]
        x0 = top = None
    else:
        if len(a.coords) != 5:
            sys.exit('need X0 TOP X1 BOTTOM out.png')
        x0, top, x1, bottom = map(float, a.coords[:4])
        out = a.coords[4]
    k = a.dpi / 72.0
    with tempfile.TemporaryDirectory() as td:
        stem = os.path.join(td, 'c')
        cmd = ['pdftoppm', '-r', str(a.dpi), '-f', str(a.page), '-l', str(a.page), '-png', '-singlefile']
        if x0 is not None:
            cmd += ['-x', str(int(x0 * k)), '-y', str(int(top * k)),
                    '-W', str(int((x1 - x0) * k)), '-H', str(int((bottom - top) * k))]
        cmd += [a.pdf, stem]
        subprocess.run(cmd, check=True)
        os.replace(stem + '.png', out)
    print(out)


if __name__ == '__main__':
    main()
