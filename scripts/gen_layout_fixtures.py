#!/usr/bin/env python3
"""gen_layout_fixtures.py — synthetic ground-truth pages for the paper
reader's layout-segmentation engine (layout coverage R1).

Generates PDF fixtures modeling real journal-layout archetypes (2-col
tight gutters, mixed front matter, figures interrupting flow, footnotes,
sidenotes, 3-col, single-col preprints, ragged reference lists, equation
gaps, rotated captions, multi-page) into rm/test-fixtures/layout/, each
with a sibling .truth.json recording every text run's bbox + block
membership + block type/column/order.

Truth coordinates are TOP-DOWN CSS-like points (y = pageH - baseline -
fontsize; h = fontsize) so they line up with what pdf.js's
extractTextItemsFromPdf emits at scale 1.0. The layout-audit harness
matches each extracted item to a truth run by center-point containment,
then scores column accuracy / block purity / reading-order violations /
selection-bridge simulation.

Deterministic (seeded per fixture) so regeneration is diff-stable.

Usage:  python3 scripts/gen_layout_fixtures.py
Deps:   pip3 install reportlab
"""

import json
import os
import random
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'rm', 'test-fixtures', 'layout')
PAGE_W, PAGE_H = letter  # 612 x 792 pt
FONT = 'Helvetica'

WORDS = ("granule coating traction force microscopy hydrogel elastic modulus "
         "collagen substrate cellular adhesion migration polymer network "
         "fluorescent bead displacement field stress fibroblast matrix "
         "stiffness gradient bioprinting scaffold viscoelastic strain tissue "
         "confocal spheroid rheology crosslink density porosity diffusion").split()


class Truth:
    """Accumulates block + run records while drawing, in TOP-DOWN coords."""

    def __init__(self, name):
        self.name = name
        self.pages = []          # list of {blocks:[], runs:[]}
        self._page = None
        self._order = 0

    def new_page(self):
        self._page = {'blocks': [], 'runs': []}
        self.pages.append(self._page)
        self._order = 0
        return len(self.pages) - 1

    def block(self, block_id, btype, column):
        """Register a block; return its id for run tagging."""
        self._page['blocks'].append({
            'id': block_id, 'type': btype, 'column': column,
            'order': self._order,
        })
        self._order += 1
        return block_id

    def run(self, block_id, text, x, baseline, size, page_h):
        """Record one drawn text run in top-down coords."""
        w = stringWidth(text, FONT, size)
        self._page['runs'].append({
            'block': block_id,
            'text': text,
            'x': round(x, 2),
            'y': round(page_h - baseline - size, 2),
            'w': round(w, 2),
            'h': round(size, 2),
        })

    def dump(self, path):
        with open(path, 'w') as f:
            json.dump({
                'name': self.name,
                'page_w': PAGE_W, 'page_h': PAGE_H,
                'pages': self.pages,
            }, f, indent=1)


def _wrap(rng, c, t, x, top, width, block_id, page_h, size=9.5, leading=12.5,
          max_lines=None, ragged=False):
    """Draw wrapped body text top-down from `top`, recording runs.
    Returns the y (top-down baseline space) after the last line drawn."""
    c.setFont(FONT, size)
    y = top
    lines = 0
    line = []
    n_words = rng.randint(28, 60) if max_lines is None else max_lines * 12
    for _ in range(n_words):
        line.append(rng.choice(WORDS))
        probe = ' '.join(line)
        if stringWidth(probe, FONT, size) > width:
            line.pop()
            text = ' '.join(line)
            indent = (rng.random() * 12) if ragged else 0
            c.drawString(x + indent, page_h - y, text)
            t.run(block_id, text, x + indent, page_h - y, size, page_h)
            y += leading
            lines += 1
            line = [probe.split()[-1]]
            if max_lines and lines >= max_lines:
                return y
    if line:
        text = ' '.join(line)
        c.drawString(x, page_h - y, text)
        t.run(block_id, text, x, page_h - y, size, page_h)
        y += leading
    return y


def _heading(c, t, text, x, top, block_id, page_h, size=13):
    c.setFont(FONT + '-Bold', size)
    c.drawString(x, page_h - top, text)
    # stringWidth needs a registered font; Helvetica-Bold is a base-14 font.
    w = stringWidth(text, FONT + '-Bold', size)
    t._page['runs'].append({
        'block': block_id, 'text': text, 'x': round(x, 2),
        'y': round(page_h - top - size, 2), 'w': round(w, 2), 'h': round(size, 2),
    })
    return top + size + 6


def _figure_box(c, x_top_y, w, h, page_h, label='Figure'):
    """Draw a gray filled rectangle to simulate a figure's ink (top-down y)."""
    x, top = x_top_y
    c.saveState()
    c.setFillGray(0.82)
    c.rect(x, page_h - top - h, w, h, fill=1, stroke=0)
    c.setFillGray(0.5)
    c.setFont(FONT, 8)
    c.drawString(x + 4, page_h - top - 12, label)
    c.restoreState()


# ---- fixture builders -----------------------------------------------------
# Standard two-column geometry.
LM, RM_ = 54, 54          # left/right page margins
COL_GAP = 18              # gutter width (pt) for the "normal" 2-col fixtures
COL_W = (PAGE_W - LM - RM_ - COL_GAP) / 2
COL_L_X = LM
COL_R_X = LM + COL_W + COL_GAP


def fx_2col_tight(c, t):
    """#1 — 2-col, TIGHT gutter (~10pt). Elsevier/IEEE stress."""
    rng = random.Random(1)
    gap = 10
    cw = (PAGE_W - LM - RM_ - gap) / 2
    lx, rx = LM, LM + cw + gap
    t.new_page()
    y = 60
    yl = _wrap(rng, c, t, lx, y, cw, t.block('L', 'body', 0), PAGE_H, max_lines=40)
    yr = _wrap(rng, c, t, rx, y, cw, t.block('R', 'body', 1), PAGE_H, max_lines=40)


def fx_frontmatter(c, t):
    """#2 — 1-col front matter (title/authors/abstract/keywords) → 2-col body."""
    rng = random.Random(2)
    t.new_page()
    y = 56
    y = _heading(c, t, 'A Robust Method for Traction Field Recovery',
                 LM, y, t.block('title', 'heading', -1), PAGE_H, size=16)
    c.setFont(FONT, 10)
    auth = 'A. McGhee, B. Researcher, C. Student'
    c.drawString(LM, PAGE_H - y, auth)
    t.run(t.block('authors', 'body', -1), auth, LM, y, 10, PAGE_H)
    y += 20
    # Abstract box (full width, own block).
    ab = t.block('abstract', 'abstract', -1)
    y = _heading(c, t, 'Abstract', LM, y, ab, PAGE_H, size=11)
    y = _wrap(rng, c, t, LM, y, PAGE_W - LM - RM_, ab, PAGE_H, max_lines=5)
    y += 6
    kw = t.block('keywords', 'keywords', -1)
    c.setFont(FONT, 9.5)
    kwtext = 'Keywords: traction force, hydrogel, microscopy, adhesion'
    c.drawString(LM, PAGE_H - y, kwtext)
    t.run(kw, kwtext, LM, y, 9.5, PAGE_H)
    y += 22
    # Two-column body below.
    body_top = y
    _wrap(rng, c, t, COL_L_X, body_top, COL_W, t.block('bodyL', 'body', 0), PAGE_H, max_lines=44)
    _wrap(rng, c, t, COL_R_X, body_top, COL_W, t.block('bodyR', 'body', 1), PAGE_H, max_lines=48)


def fx_fig_span(c, t):
    """#3 — 2-col with a figure spanning BOTH columns mid-page."""
    rng = random.Random(3)
    t.new_page()
    top = 60
    _wrap(rng, c, t, COL_L_X, top, COL_W, t.block('L1', 'body', 0), PAGE_H, max_lines=14)
    _wrap(rng, c, t, COL_R_X, top, COL_W, t.block('R1', 'body', 1), PAGE_H, max_lines=14)
    fig_top = top + 14 * 12.5 + 8
    _figure_box(c, (LM, fig_top), PAGE_W - LM - RM_, 150, PAGE_H, 'Figure 1 (spanning)')
    cap = t.block('cap1', 'caption', -1)
    capy = fig_top + 158
    c.setFont(FONT, 8.5)
    captext = 'Figure 1.  Spanning figure caption describing the full-width panel layout.'
    c.drawString(LM, PAGE_H - capy, captext)
    t.run(cap, captext, LM, capy, 8.5, PAGE_H)
    body2 = capy + 18
    _wrap(rng, c, t, COL_L_X, body2, COL_W, t.block('L2', 'body', 0), PAGE_H, max_lines=16)
    _wrap(rng, c, t, COL_R_X, body2, COL_W, t.block('R2', 'body', 1), PAGE_H, max_lines=16)


def fx_fig_onecol(c, t):
    """#4 — 2-col with a figure occupying ONE column + its caption."""
    rng = random.Random(4)
    t.new_page()
    top = 60
    # Left column: figure in top half, then body.
    _figure_box(c, (COL_L_X, top), COL_W, 150, PAGE_H, 'Figure 2')
    capL = t.block('capL', 'caption', 0)
    capy = top + 156
    c.setFont(FONT, 8.5)
    for i in range(2):
        ct = 'Figure 2.  ' + ' '.join(rng.choice(WORDS) for _ in range(9))
        c.drawString(COL_L_X, PAGE_H - (capy + i * 11), ct)
        t.run(capL, ct, COL_L_X, capy + i * 11, 8.5, PAGE_H)
    _wrap(rng, c, t, COL_L_X, capy + 30, COL_W, t.block('L2', 'body', 0), PAGE_H, max_lines=20)
    # Right column: full body.
    _wrap(rng, c, t, COL_R_X, top, COL_W, t.block('R1', 'body', 1), PAGE_H, max_lines=48)


def fx_footnote(c, t):
    """#5 — 2-col + footnote block bottom-left + header/footer/page-number."""
    rng = random.Random(5)
    t.new_page()
    # Header + footer + page number (margin furniture).
    hd = t.block('header', 'header', -1)
    c.setFont(FONT, 8)
    htext = 'J. Traction Microscopy  ·  Vol 12  ·  2026'
    c.drawString(LM, PAGE_H - 34, htext)
    t.run(hd, htext, LM, 34, 8, PAGE_H)
    ft = t.block('footer', 'footer', -1)
    ftext = 'Downloaded from mcgheelab.com on 2026-07-14'
    c.drawString(LM, PAGE_H - (PAGE_H - 30), ftext)
    t.run(ft, ftext, LM, PAGE_H - 30, 8, PAGE_H)
    pn = t.block('pagenum', 'pagenum', -1)
    c.drawString(PAGE_W / 2 - 4, PAGE_H - (PAGE_H - 30), '5')
    t.run(pn, '5', PAGE_W / 2 - 4, PAGE_H - 30, 8, PAGE_H)
    top = 56
    _wrap(rng, c, t, COL_L_X, top, COL_W, t.block('L1', 'body', 0), PAGE_H, max_lines=40)
    _wrap(rng, c, t, COL_R_X, top, COL_W, t.block('R1', 'body', 1), PAGE_H, max_lines=44)
    # Footnote island bottom-left, small font, above the footer.
    fn = t.block('footnote', 'footnote', 0)
    fny = PAGE_H - 90
    c.setFont(FONT, 7.5)
    c.line(COL_L_X, PAGE_H - (fny - 6), COL_L_X + 80, PAGE_H - (fny - 6))
    for i in range(3):
        ft2 = '%d  %s' % (i + 1, ' '.join(rng.choice(WORDS) for _ in range(10)))
        c.drawString(COL_L_X, PAGE_H - (fny + i * 10), ft2)
        t.run(fn, ft2, COL_L_X, fny + i * 10, 7.5, PAGE_H)


def fx_3col(c, t):
    """#6 — 3-column."""
    rng = random.Random(6)
    t.new_page()
    gap = 16
    cw = (PAGE_W - LM - RM_ - 2 * gap) / 3
    top = 60
    for i in range(3):
        x = LM + i * (cw + gap)
        _wrap(rng, c, t, x, top, cw, t.block('C%d' % i, 'body', i), PAGE_H, max_lines=46)


def fx_sidenote(c, t):
    """#7 — 1-col main text with wide right margin + sidenotes (Tufte/JMLR)."""
    rng = random.Random(7)
    t.new_page()
    main_w = (PAGE_W - LM - RM_) * 0.62
    side_x = LM + main_w + 22
    side_w = PAGE_W - RM_ - side_x
    top = 60
    _wrap(rng, c, t, LM, top, main_w, t.block('main', 'body', 0), PAGE_H, max_lines=48)
    # Two sidenote islands in the right margin.
    for i, sy in enumerate((90, 320)):
        sn = t.block('side%d' % i, 'sidenote', 1)
        c.setFont(FONT, 8)
        for j in range(3):
            st = ' '.join(rng.choice(WORDS) for _ in range(6))
            c.drawString(side_x, PAGE_H - (sy + j * 10), st)
            t.run(sn, st, side_x, sy + j * 10, 8, PAGE_H)


def fx_1col(c, t):
    """#8 — 1-col preprint (bioRxiv/arXiv). Must NOT invent columns."""
    rng = random.Random(8)
    t.new_page()
    top = 60
    _wrap(rng, c, t, LM, top, PAGE_W - LM - RM_, t.block('body', 'body', 0), PAGE_H, max_lines=52)


def fx_refs(c, t):
    """#9 — 2-col reference list, ragged + hanging indents, dense short lines."""
    rng = random.Random(9)
    t.new_page()
    y = 56
    y = _heading(c, t, 'References', LM, y, t.block('refhead', 'heading', -1), PAGE_H, size=12)
    top = y
    for colx, colblk, coln in ((COL_L_X, 'refL', 0), (COL_R_X, 'refR', 1)):
        blk = t.block(colblk, 'body', coln)
        yy = top
        c.setFont(FONT, 8)
        for n in range(1, 20):
            head = '[%d] ' % n
            words = ' '.join(rng.choice(WORDS) for _ in range(rng.randint(10, 18)))
            # First line with marker, then a hanging-indent continuation.
            c.drawString(colx, PAGE_H - yy, head + words[:60])
            t.run(blk, head + words[:60], colx, yy, 8, PAGE_H)
            yy += 10
            c.drawString(colx + 10, PAGE_H - yy, words[60:110])
            t.run(blk, words[60:110], colx + 10, yy, 8, PAGE_H)
            yy += 13


def fx_equations(c, t):
    """#10 — 2-col with equation/table gaps breaking ink continuity."""
    rng = random.Random(10)
    t.new_page()
    top = 60
    for colx, colblk, coln in ((COL_L_X, 'L', 0), (COL_R_X, 'R', 1)):
        blk = t.block(colblk, 'body', coln)
        yy = _wrap(rng, c, t, colx, top, COL_W, blk, PAGE_H, max_lines=10)
        # A centered "equation" (short, indented) leaving big vertical gaps.
        c.setFont(FONT, 10)
        eq = 'F = 6 phi f c V / (L A)'
        c.drawString(colx + COL_W / 2 - 30, PAGE_H - (yy + 14), eq)
        t.run(blk, eq, colx + COL_W / 2 - 30, yy + 14, 10, PAGE_H)
        _wrap(rng, c, t, colx, yy + 40, COL_W, blk, PAGE_H, max_lines=20)


def fx_rotated(c, t):
    """#11 — landscape/rotated caption (known-limitation fixture)."""
    rng = random.Random(11)
    t.new_page()
    top = 60
    _wrap(rng, c, t, LM, top, PAGE_W - LM - RM_, t.block('body', 'body', 0), PAGE_H, max_lines=30)
    # Rotated caption up the left margin — recorded with an axis-aligned bbox
    # (the harness will flag it as a known miss; documents the limitation).
    rc = t.block('rotcap', 'caption', -1)
    c.saveState()
    c.translate(30, PAGE_H - 400)
    c.rotate(90)
    c.setFont(FONT, 8)
    rt = 'Figure S1.  Rotated supplementary caption text.'
    c.drawString(0, 0, rt)
    c.restoreState()
    # Approximate axis-aligned bbox for the rotated run.
    t._page['runs'].append({
        'block': rc, 'text': rt, 'x': 24, 'y': 400 - stringWidth(rt, FONT, 8),
        'w': 12, 'h': round(stringWidth(rt, FONT, 8), 2), 'rotated': True,
    })


def fx_multipage(c, t):
    """#12 — two-page spread (2-col each) for multi-page drag regression."""
    rng = random.Random(12)
    for pg in range(2):
        t.new_page()
        top = 60
        _wrap(rng, c, t, COL_L_X, top, COL_W, t.block('p%dL' % pg, 'body', 0), PAGE_H, max_lines=44)
        _wrap(rng, c, t, COL_R_X, top, COL_W, t.block('p%dR' % pg, 'body', 1), PAGE_H, max_lines=44)
        c.showPage()
        c.setFont(FONT, 9.5)


FIXTURES = [
    ('01-2col-tight', fx_2col_tight),
    ('02-frontmatter', fx_frontmatter),
    ('03-fig-span', fx_fig_span),
    ('04-fig-onecol', fx_fig_onecol),
    ('05-footnote', fx_footnote),
    ('06-3col', fx_3col),
    ('07-sidenote', fx_sidenote),
    ('08-1col', fx_1col),
    ('09-refs', fx_refs),
    ('10-equations', fx_equations),
    ('11-rotated', fx_rotated),
    ('12-multipage', fx_multipage),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    index = []
    for name, fn in FIXTURES:
        pdf_path = os.path.join(OUT_DIR, name + '.pdf')
        truth_path = os.path.join(OUT_DIR, name + '.truth.json')
        c = canvas.Canvas(pdf_path, pagesize=letter)
        c.setFont(FONT, 9.5)
        t = Truth(name)
        fn(c, t)
        c.showPage()
        c.save()
        t.dump(truth_path)
        n_runs = sum(len(p['runs']) for p in t.pages)
        index.append({'name': name, 'pdf': name + '.pdf',
                      'truth': name + '.truth.json',
                      'pages': len(t.pages), 'runs': n_runs})
        print('  %-16s %d page(s), %d runs' % (name, len(t.pages), n_runs))
    with open(os.path.join(OUT_DIR, 'index.json'), 'w') as f:
        json.dump({'fixtures': index}, f, indent=1)
    print('Wrote %d fixtures to %s' % (len(FIXTURES), os.path.relpath(OUT_DIR)))


if __name__ == '__main__':
    main()
