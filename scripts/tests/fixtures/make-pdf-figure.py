#!/usr/bin/env python3
"""V3.901 — the fixture for clipping figures and equations: pdf-figure.pdf (two pages, made-up text, ours to publish).

    python3 scripts/tests/fixtures/make-pdf-figure.py

Page 1: a two-column article page — a bar chart drawn as vector paths in the left column with "Figure 1." under it,
two numbered display equations in the right column (Greek and operators set as separate runs, the way typeset math
arrives in a PDF). Page 2: a full-width two-panel line plot with "Figure 2." under it, then two columns of prose.
Needs reportlab and matplotlib (for its bundled DejaVu fonts, so pdf.js reads the Greek back as Unicode).
"""
import os, random
import matplotlib
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(os.path.dirname(matplotlib.__file__), 'mpl-data', 'fonts', 'ttf')
pdfmetrics.registerFont(TTFont('DVS', os.path.join(FONTS, 'DejaVuSerif.ttf')))
pdfmetrics.registerFont(TTFont('DVSI', os.path.join(FONTS, 'DejaVuSerif-Italic.ttf')))

W, H = letter
M, GUT = 54, 18
COLW = (W - 2 * M - GUT) / 2
BODY, LEAD = 9.5, 11.6
random.seed(7)
WORDS = ('the packed microgels yield when the applied stress exceeds the contact network strength and the granular '
         'hydrogel then flows like a liquid before it recovers its solid state within seconds of rest which lets it '
         'hold printed filaments in place while cells remain viable across the support bath over many hours of culture '
         'we measured each formulation three times on a cone and plate rheometer at room temperature and report the mean').split()


def prose(n):
    return ' '.join(random.choice(WORDS) for _ in range(n)).capitalize() + '.'


def wrap(text, width, font='Times-Roman', size=BODY):
    lines, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if pdfmetrics.stringWidth(t, font, size) > width and cur: lines.append(cur); cur = w
        else: cur = t
    return lines + ([cur] if cur else [])


def para(c, x, y, width, nlines, size=BODY, font='Times-Roman', lead=LEAD):
    """Prose until nlines are set; returns the y below it."""
    c.setFont(font, size); c.setFillGray(0); left = nlines
    while left > 0:
        for ln in wrap(prose(40), width, font, size)[:left]:
            c.drawString(x, y, ln); y -= lead; left -= 1
        y -= 3
    return y


def caption(c, x, y, width, text):
    c.setFont('Times-Roman', 8); c.setFillGray(0)
    for ln in wrap(text, width, 'Times-Roman', 8): c.drawString(x, y, ln); y -= 9.6
    return y


def runs(c, x, y, parts):
    """Math as separate runs: (text, font, size, dy)."""
    for t, f, s, dy in parts:
        c.setFont(f, s); c.drawString(x, y + dy, t); x += pdfmetrics.stringWidth(t, f, s) + 1.2
    return x


def bars(c, x, y, w, h):
    c.setStrokeGray(0); c.setLineWidth(.8); c.rect(x, y, w, h, stroke=1, fill=0)   # an axes frame, as plotting tools draw
    vals = [.35, .52, .71, .88, .64]
    bw = w / (len(vals) * 1.6)
    for i, v in enumerate(vals):
        c.setFillColorRGB(.16, .5, .55); c.rect(x + 10 + i * bw * 1.6, y, bw, v * (h - 10), stroke=0, fill=1)
        c.setFillGray(0); c.setFont('Helvetica', 6); c.drawString(x + 10 + i * bw * 1.6, y - 8, '%.2f' % (.55 + i * .05))
    for k in range(5):
        c.line(x - 3, y + k * h / 4.4, x, y + k * h / 4.4); c.setFont('Helvetica', 6); c.drawRightString(x - 5, y + k * h / 4.4 - 2, str(k * 50))
    c.setFont('Helvetica', 7); c.drawString(x + w / 2 - 30, y - 18, 'packing fraction')


def curves(c, x, y, w, h, seed):
    c.setStrokeGray(0); c.setLineWidth(.8); c.rect(x, y, w, h, stroke=1, fill=0)
    for k, rgb in enumerate([(.16, .5, .55), (.8, .4, .1), (.3, .3, .7)]):
        c.setStrokeColorRGB(*rgb); c.setLineWidth(1.2); p = c.beginPath(); p.moveTo(x + 4, y + 8 + k * 10)
        for i in range(1, 40):
            t = i / 39; p.lineTo(x + 4 + t * (w - 8), y + 8 + k * 10 + (h - 30) * (t ** (.4 + .25 * k + .05 * seed)))
        c.drawPath(p, stroke=1, fill=0)
    c.setStrokeGray(0)
    for k in range(5):
        c.line(x, y + k * h / 4.4, x - 3, y + k * h / 4.4); c.setFont('Helvetica', 6); c.drawRightString(x - 5, y + k * h / 4.4 - 2, str(10 ** k))


c = canvas.Canvas(os.path.join(HERE, 'pdf-figure.pdf'), pagesize=letter)
c.setTitle('Clip fixture — granular hydrogel yield'); c.setAuthor('McGhee Lab test fixture')
# ---- page 1 ----
c.setFont('Times-Bold', 16); c.drawString(M, H - M - 10, 'Granular hydrogel yield under confinement')
c.setFont('Times-Italic', 10); c.drawString(M, H - M - 28, 'A. Example, B. Sample and C. Fixture')
top = H - M - 52
xl, xr = M, M + COLW + GUT
y = para(c, xl, top, COLW, 12)
fy = y - 150; bars(c, xl + 30, fy, COLW - 50, 120)
y = caption(c, xl, fy - 30, COLW, 'Figure 1. Yield stress of the packed microgels against packing fraction. Bars show the mean of three runs on a cone and plate rheometer.')
para(c, xl, y - 10, COLW, 24)
y = para(c, xr, top, COLW, 14)
y -= 12; ex = xr + 40
end = runs(c, ex, y, [('σ', 'DVSI', 11, 0), ('y', 'DVSI', 7.5, -3), ('=', 'DVS', 11, 0), ('G', 'DVSI', 11, 0), ('φ', 'DVSI', 11, 0), ('(', 'DVS', 11, 0), ('φ', 'DVSI', 11, 0), ('−', 'DVS', 11, 0), ('φ', 'DVSI', 11, 0), ('c', 'DVSI', 7.5, -3), (')', 'DVS', 11, 0), ('β', 'DVSI', 7.5, 5)])
c.setFont('Times-Roman', BODY); c.drawRightString(xr + COLW, y, '(1)')
y = para(c, xr, y - 24, COLW, 9)
y -= 12
runs(c, ex, y, [('τ', 'DVSI', 11, 0), ('=', 'DVS', 11, 0), ('τ', 'DVSI', 11, 0), ('0', 'DVS', 7.5, -3), ('+', 'DVS', 11, 0), ('η', 'DVSI', 11, 0), ('γ̇', 'DVSI', 11, 0), ('n', 'DVSI', 7.5, 5), ('≈', 'DVS', 11, 0), ('τ', 'DVSI', 11, 0), ('0', 'DVS', 7.5, -3)])
c.setFont('Times-Roman', BODY); c.drawRightString(xr + COLW, y, '(2)')
para(c, xr, y - 24, COLW, 20)
c.setFont('Times-Roman', 8); c.drawCentredString(W / 2, M - 20, '1')
c.showPage()
# ---- page 2 ----
fy = H - M - 210
curves(c, M + 30, fy, (W - 2 * M) / 2 - 50, 190, 0); curves(c, M + (W - 2 * M) / 2 + 30, fy, (W - 2 * M) / 2 - 50, 190, 1)
c.setFont('Helvetica-Bold', 9); c.drawString(M + 10, fy + 196, 'A'); c.drawString(M + (W - 2 * M) / 2 + 10, fy + 196, 'B')
y = caption(c, M, fy - 22, W - 2 * M, 'Figure 2. Flow curves of the three formulations. (A) Shear stress against shear rate. (B) Viscosity against shear rate; each formulation thins by two orders of magnitude.')
y -= 14
para(c, xl, y, COLW, 34); para(c, xr, y, COLW, 34)
c.setFont('Times-Roman', 8); c.drawCentredString(W / 2, M - 20, '2')
c.showPage(); c.save()
print('wrote', os.path.join(HERE, 'pdf-figure.pdf'))
