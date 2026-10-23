#!/usr/bin/env python3
"""Second codemod pass: ternaries whose branches are bare glyphs.

    chev.textContent = open ? '▾' : '▸';
      -> ICON.label(chev, open ? 'chevron-down' : 'chevron-right');

    '<span>' + (open ? '▾' : '▸') + '</span>'
      -> '<span>' + ICON.svg(open ? 'chevron-down' : 'chevron-right') + '</span>'

This is the single biggest pattern the first pass declines, because a glyph
there is a VALUE inside an expression rather than text inside a literal.
It is only safe when EVERY branch is a bare glyph string — a mixed ternary
('▾' vs 'Loading…') keeps its text and is left alone.

Same refusals as pass 1: comments, text-only channels, comparisons.
"""
import argparse, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAN = json.loads((ROOT / 'scripts' / 'icons.manifest.json').read_text())
NAME_OF = {}
for _n, _c in MAN['icons'].items():
    for _g in [_c.get('emoji')] + _c.get('also', []):
        if _g:
            NAME_OF[_g] = _n
for _k in [k for k in MAN.get('keep', {}) if not k.startswith('_')]:
    NAME_OF.pop(_k, None)

G = '|'.join(re.escape(g) for g in sorted(NAME_OF, key=len, reverse=True))
# a bare glyph string:  '▾'   "▾"   '▾ '  (trailing space kept out of the icon)
BARE = re.compile(r"""(['"])\s*(?P<g>""" + G + r""")️?\s*\1""")
SKIP_LINE = re.compile(
    r"""(\.title\s*=|\btitle\s*:|aria-label|\balt\s*=|placeholder|\bTOAST\b|
         \bconsole\.|\balert\(|document\.title|===|!==|\bcase\s)""", re.X)
NEVER = {'icon-picker.js', 'icons.js'}

# X.textContent = <expr made only of bare glyphs, ?, :, and identifiers>;
SINK_TERNARY = re.compile(
    r"^(?P<i>\s*)(?P<lhs>[A-Za-z_$][\w$.\[\]]*)\.(?:textContent|innerText)\s*=\s*(?P<expr>[^;]+);\s*$")


def all_strings_are_glyphs(expr):
    strings = re.findall(r"""(['"])(?:\\.|(?!\1).)*\1""", expr)
    found = list(re.finditer(r"""(['"])((?:\\.|(?!\1).)*)\1""", expr))
    if not found:
        return False
    for m in found:
        if not BARE.fullmatch(m.group(0)):
            return False
    return True


def to_names(expr):
    return BARE.sub(lambda m: "'" + NAME_OF[m.group('g')] + "'", expr)


def convert(path, apply):
    p = pathlib.Path(path)
    if p.name in NEVER:
        return None
    src = p.read_text()
    out, n_sink, n_mark = [], 0, 0
    in_block = False
    for line in src.split('\n'):
        s = line.strip()
        if in_block:
            if '*/' in line: in_block = False
            out.append(line); continue
        if s.startswith('/*') and '*/' not in line:
            in_block = True; out.append(line); continue
        if s.startswith(('//', '*')) or not BARE.search(line) or SKIP_LINE.search(line):
            out.append(line); continue

        m = SINK_TERNARY.match(line)
        if m and '?' in m.group('expr') and all_strings_are_glyphs(m.group('expr')):
            out.append(f"{m.group('i')}ICON.label({m.group('lhs')}, {to_names(m.group('expr'))});")
            n_sink += 1
            continue

        # ${cond ? '▸' : '▾'} inside a template literal — the single most
        # common shape in this codebase (every collapse caret is one).
        def tpl(mm):
            nonlocal n_mark
            inner = mm.group(1)
            if '?' not in inner or not all_strings_are_glyphs(inner):
                return mm.group(0)
            n_mark += 1
            return '${ICON.svg(' + to_names(inner) + ')}'

        line = re.sub(r"\$\{([^{}]*\?[^{}]*:[^{}]*)\}", tpl, line)

        # A parenthesised all-glyph ternary in a CONCATENATION is markup —
        # but the same shape assigned to .textContent is a text sink, and
        # SINK_TERNARY above only claims it when the WHOLE expression is
        # glyphs. Anything left over that still writes to a text sink must
        # stay untouched or it paints raw <svg>. (The release gate caught
        # exactly this twice before the rule was added.)
        if re.search(r'\.(?:textContent|innerText)\s*=', line):
            out.append(line); continue

        # a parenthesised all-glyph ternary sitting in a concatenation
        def par(mm):
            nonlocal n_mark
            inner = mm.group(1)
            if '?' not in inner or not all_strings_are_glyphs(inner):
                return mm.group(0)
            n_mark += 1
            return '(ICON.svg(' + to_names(inner) + '))'

        new = re.sub(r"\(([^()]*\?[^()]*:[^()]*)\)", par, line)
        out.append(new)

    new_src = '\n'.join(out)
    if apply and new_src != src:
        p.write_text(new_src)
    return {'file': p.name, 'changed': new_src != src, 'sink': n_sink, 'markup': n_mark}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    ts = tm = nf = 0
    for f in a.files:
        r = convert(f, a.apply)
        if r and r['changed']:
            nf += 1; ts += r['sink']; tm += r['markup']
            print(f"  {r['file']:34} sink-ternary {r['sink']:3}  markup-ternary {r['markup']:3}")
    print(f"\n  TOTAL  sink {ts}  markup {tm}   ({nf} files"
          f"{' written' if a.apply else ' would change'})")


if __name__ == '__main__':
    main()
