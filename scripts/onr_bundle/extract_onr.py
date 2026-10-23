#!/usr/bin/env python3
"""extract_onr.py — ONR Technical Proposal .docx → ordered intermediate blocks.

Stage 1 of the three-stage docx → .paperbundle.zip pipeline (see
scripts/onr_bundle/README.md). Reads word/document.xml directly rather than
trusting a converter, because three things in this file are only recoverable
from the raw XML:

  1. CITATIONS. Every citation is a Word field whose instruction text carries a
     Paperpile payload: base64(zlib(JSON)) with the full reference record
     (title/authors/journal/DOI). The instruction is split across many w:instrText
     runs (89 nodes for 32 fields), so the payload only reassembles if you join
     them in document order. The field's RENDERED text ("6", "6,15", "22-28") is
     the numeric marker the RM importer rewrites to [@citekey].
  2. ANCHORED IMAGES. image4 is an anchored w:drawing living INSIDE the body
     paragraph that precedes its caption, not in a paragraph of its own. A walker
     that only looks at "paragraphs that are just an image" finds 4 of 5 figures.
  3. TABLE SHADING. The schedule Gantt encodes its bars as w:shd/@w:fill=FFC000
     on otherwise-empty cells. Drop the fill and the table says nothing.

Math is the one thing NOT hand-parsed: pandoc's OMML→LaTeX is better than
anything worth writing here. We take pandoc's AST (97 Math nodes) and align it
1:1, in document order, with the 97 m:oMath elements in the XML. (Counting
'<m:oMath' textually gives 106 — nine of those are '<m:oMathPara' prefixes.)

Output (all into --out):
  blocks.ndjson  ordered {kind: para|table} records; paragraph text carries
                 placeholders @@M<k>@@ (math), @@IMG:<target>@@ (image)
  refs.json      the 33 unique references, in first-citation order
  math.json      97 normalized LaTeX strings, indexed by k
  media/         the 5 embedded image files

Usage: python3 scripts/onr_bundle/extract_onr.py <file.docx> --out <dir>
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
import zlib
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
M = '{http://schemas.openxmlformats.org/officeDocument/2006/math}'


# ── math normalization ──────────────────────────────────────────────
#
# Word's equation editor stores Greek letters that LOOK like Latin ones, and
# pandoc faithfully passes them through: \mu_{ο} carries U+03BF GREEK SMALL
# LETTER OMICRON, k_{Β}Τ carries GREEK CAPITAL BETA and TAU. LaTeX has no
# glyph for those in math mode and the compile dies with a confusing error
# about an invalid character, several sections away from the real cause.
GREEK_CONFUSABLES = {
    'ο': 'o', 'Ο': 'O',   # omicron
    'Β': 'B', 'Τ': 'T', 'Α': 'A', 'Ε': 'E',
    'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
    'Μ': 'M', 'Ν': 'N', 'Ρ': 'P', 'Υ': 'Y',
    'Χ': 'X',
}


def normalize_math(tex):
    """Make one pandoc-emitted LaTeX fragment compile."""
    for bad, good in GREEK_CONFUSABLES.items():
        tex = tex.replace(bad, good)
    # Word writes wide gaps as runs of thin spaces; pandoc renders each as '\ '.
    # Four or more in a row is a deliberate visual separator between two paired
    # expressions (eq. 3, 5, 6, 8) — \qquad says that in one token.
    tex = re.sub(r'(?:\\ ){4,}', r' \\qquad ', tex)
    tex = tex.replace(' ', ' ').replace(' ', ' ')
    # A trailing '\' or '\ ' before the closing delimiter escapes it: "$n\$"
    # is a literal dollar sign and everything after it becomes math.
    tex = re.sub(r'(\\\s*)+$', '', tex.rstrip())
    tex = re.sub(r'\s+', ' ', tex).strip()
    return tex


def load_math(docx_path):
    """pandoc AST → the document-ordered list of (kind, latex)."""
    out = subprocess.run(['pandoc', docx_path, '-t', 'json'],
                         capture_output=True, check=True).stdout
    ast = json.loads(out)
    found = []

    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            if node.get('t') == 'Math':
                kind, tex = node['c'][0]['t'], node['c'][1]
                found.append({'display': kind == 'DisplayMath',
                              'tex': normalize_math(tex),
                              'raw': tex})
                return
            for value in node.values():
                walk(value)

    walk(ast['blocks'])
    return found


# ── citation payloads ───────────────────────────────────────────────

def decode_paperpile(instr):
    """Every <data> blob in a Paperpile field instruction → reference records."""
    records = []
    for blob in re.findall(r'<data>([A-Za-z0-9+/=]+)</data>', instr):
        try:
            records.extend(json.loads(zlib.decompress(base64.b64decode(blob))))
        except Exception as exc:                      # noqa: BLE001
            print('  ! undecodable citation payload: %s' % exc, file=sys.stderr)
    return records


def unify(rec):
    """Paperpile record → the RM bundle's unified-metadata reference shape."""
    pub = rec.get('published') or {}
    doi = (rec.get('doi') or '').strip().lower()
    return {
        'citekey': rec.get('citekey') or rec.get('_id') or '',
        'title': (rec.get('title') or '').strip(),
        'authors': [{'family': (a.get('last') or '').strip(),
                     'given': (a.get('first') or '').strip()}
                    for a in (rec.get('author') or [])
                    if (a.get('last') or a.get('first'))],
        'year': str(pub.get('year') or '').strip(),
        'journal': (rec.get('journalfull') or rec.get('journal')
                    or rec.get('booktitle') or '').strip(),
        'volume': str(rec.get('volume') or '').strip(),
        'issue': str(rec.get('issue') or '').strip(),
        'pages': str(rec.get('pages') or '').strip(),
        'doi': doi,
        'pmid': str(rec.get('pmid') or '').strip(),
        'arxiv_id': str(rec.get('arxivid') or '').strip(),
        'url': doi and ('https://doi.org/' + doi) or (rec.get('url') or [''])[0],
        'abstract': '',
        'source': 'manual',
        'pubtype': rec.get('pubtype') or '',
        'publisher': (rec.get('publisher') or '').strip(),
    }


# ── the walker ──────────────────────────────────────────────────────

class Extractor:
    def __init__(self, zf, math):
        self.zf = zf
        self.math = math
        self.math_i = 0
        self.rels = {}
        rel_root = ET.fromstring(zf.read('word/_rels/document.xml.rels'))
        for child in rel_root:
            self.rels[child.get('Id')] = child.get('Target')
        self.refs = []           # unified refs, first-citation order
        self.ref_index = {}      # citekey → position (0-based)
        self.markers = []        # every rendered marker, in order
        self.images = []         # every image target, in order
        # Field state is document-level, not paragraph-level: a Word field can
        # (and here, does) span runs freely.
        self.field_depth = 0
        self.field_instr = []
        self.field_result = []
        self.in_result = False

    # -- math ------------------------------------------------------
    def take_math(self, display_expected):
        if self.math_i >= len(self.math):
            raise RuntimeError('ran out of pandoc math nodes at index %d'
                               % self.math_i)
        node = self.math[self.math_i]
        if node['display'] != display_expected:
            raise RuntimeError(
                'math alignment drift at index %d: XML says display=%s, '
                'pandoc says display=%s (%r)'
                % (self.math_i, display_expected, node['display'], node['tex'][:60]))
        self.math_i += 1
        return '@@M%d@@' % (self.math_i - 1)

    # -- fields ----------------------------------------------------
    def end_field(self):
        instr = ''.join(self.field_instr)
        rendered = ''.join(self.field_result).strip()
        self.field_instr, self.field_result = [], []
        if 'paperpile_citation' in instr:
            for rec in decode_paperpile(instr):
                meta = unify(rec)
                if meta['citekey'] not in self.ref_index:
                    self.ref_index[meta['citekey']] = len(self.refs)
                    self.refs.append(meta)
            marker = '[' + rendered + ']' if rendered else ''
            self.markers.append(rendered)
            return marker
        if 'paperpile_bibliography' in instr:
            return ''            # the rendered bibliography is empty in this file
        # SEQ / REF / TOC / PAGE: keep whatever Word rendered.
        return rendered

    # -- paragraph text -------------------------------------------
    def render(self, el, bold=False):
        """Depth-first over one w:p, returning its text with placeholders."""
        out = []
        for child in el:
            tag = child.tag

            if tag == M + 'oMathPara':
                for om in child.iter(M + 'oMath'):
                    out.append(self.take_math(True))
                continue
            if tag == M + 'oMath':
                out.append(self.take_math(False))
                continue

            if tag == W + 'fldChar':
                kind = child.get(W + 'fldCharType')
                if kind == 'begin':
                    self.field_depth += 1
                    self.in_result = False
                elif kind == 'separate':
                    self.in_result = True
                elif kind == 'end':
                    self.field_depth -= 1
                    self.in_result = False
                    if self.field_depth <= 0:
                        self.field_depth = 0
                        out.append(self.end_field())
                continue
            if tag == W + 'instrText':
                self.field_instr.append(child.text or '')
                continue

            if tag == W + 'drawing' or tag == W + 'pict' or tag == W + 'object':
                for blip in child.iter(A + 'blip'):
                    rid = blip.get(R + 'embed') or blip.get(R + 'link')
                    target = self.rels.get(rid, rid)
                    self.images.append(target)
                    out.append('@@IMG:%s@@' % target)
                for node in child.iter():
                    if node.tag.endswith('}imagedata'):
                        target = self.rels.get(node.get(R + 'id'))
                        if target:
                            self.images.append(target)
                            out.append('@@IMG:%s@@' % target)
                continue

            if tag == W + 't':
                text = child.text or ''
                if self.field_depth > 0:
                    if self.in_result:
                        self.field_result.append(text)
                    continue
                out.append(('**%s**' % text) if (bold and text.strip()) else text)
                continue
            if tag == W + 'tab':
                out.append(' ' if self.field_depth else ' ')
                continue
            if tag == W + 'br':
                if not self.field_depth:
                    out.append('\n')
                continue
            if tag == W + 'r':
                rpr = child.find(W + 'rPr')
                child_bold = bold
                if rpr is not None:
                    b = rpr.find(W + 'b')
                    if b is not None:
                        child_bold = b.get(W + 'val') not in ('0', 'false')
                out.append(self.render(child, child_bold))
                continue

            out.append(self.render(child, bold))
        return ''.join(out)

    # -- blocks ----------------------------------------------------
    def paragraph(self, p):
        ppr = p.find(W + 'pPr')
        style, numbered = '', False
        if ppr is not None:
            ps = ppr.find(W + 'pStyle')
            if ps is not None:
                style = ps.get(W + 'val') or ''
            numbered = ppr.find(W + 'numPr') is not None
        text = self.render(p)
        return {'kind': 'para', 'style': style, 'list': numbered, 'text': text}

    def table(self, tbl):
        rows = []
        for tr in tbl.findall(W + 'tr'):
            cells = []
            for tc in tr.findall(W + 'tc'):
                tcpr = tc.find(W + 'tcPr')
                fill, span = '', 1
                if tcpr is not None:
                    shd = tcpr.find(W + 'shd')
                    if shd is not None:
                        fill = (shd.get(W + 'fill') or '').upper()
                    gs = tcpr.find(W + 'gridSpan')
                    if gs is not None:
                        span = int(gs.get(W + 'val') or 1)
                text = ' '.join(self.render(p) for p in tc.findall(W + 'p'))
                cells.append({'text': re.sub(r'\s+', ' ', text).strip(),
                              'fill': fill if fill not in ('', 'AUTO') else '',
                              'span': span})
            rows.append(cells)
        return {'kind': 'table', 'rows': rows}

    def run(self, body):
        blocks = []
        for child in body:
            if child.tag == W + 'p':
                blocks.append(self.paragraph(child))
            elif child.tag == W + 'tbl':
                blocks.append(self.table(child))
            elif child.tag == W + 'sectPr':
                continue
            else:                       # sdt (the TOC) and friends: recurse
                for p in child.iter(W + 'p'):
                    blocks.append(self.paragraph(p))
        return blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('docx')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    media_dir = os.path.join(args.out, 'media')
    os.makedirs(media_dir, exist_ok=True)

    print('pandoc: converting math…')
    math = load_math(args.docx)
    print('  %d math nodes (%d display)'
          % (len(math), sum(1 for m in math if m['display'])))

    zf = zipfile.ZipFile(args.docx)
    ex = Extractor(zf, math)
    root = ET.fromstring(zf.read('word/document.xml'))
    blocks = ex.run(root.find(W + 'body'))

    if ex.math_i != len(math):
        raise SystemExit('math misalignment: consumed %d of %d nodes'
                         % (ex.math_i, len(math)))

    for name in zf.namelist():
        if name.startswith('word/media/'):
            with zf.open(name) as src, open(
                    os.path.join(media_dir, os.path.basename(name)), 'wb') as dst:
                shutil.copyfileobj(src, dst)

    with open(os.path.join(args.out, 'blocks.ndjson'), 'w') as fh:
        for b in blocks:
            fh.write(json.dumps(b, ensure_ascii=False) + '\n')
    with open(os.path.join(args.out, 'refs.json'), 'w') as fh:
        json.dump(ex.refs, fh, indent=1, ensure_ascii=False)
    with open(os.path.join(args.out, 'math.json'), 'w') as fh:
        json.dump(math, fh, indent=1, ensure_ascii=False)

    paras = [b for b in blocks if b['kind'] == 'para']
    print('blocks      : %d (%d paragraphs, %d tables)'
          % (len(blocks), len(paras), len(blocks) - len(paras)))
    print('references  : %d unique from %d markers' % (len(ex.refs), len(ex.markers)))
    print('images      : %d placements, %d files'
          % (len(ex.images), len(os.listdir(media_dir))))
    print('markers     : %s' % ' '.join(ex.markers))


if __name__ == '__main__':
    main()
