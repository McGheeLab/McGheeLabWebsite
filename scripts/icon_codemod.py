#!/usr/bin/env python3
"""Rewrite emoji icons to ICON.* calls — conservatively.

    python3 scripts/icon_codemod.py --dry rm/js/pmr.js
    python3 scripts/icon_codemod.py --apply rm/js/pmr.js rm/js/chat.js

Only three shapes are touched, because they are the only ones where the
transform is unambiguous. Everything else is left for a human — a wrong
rewrite here is SILENT (valid JS, wrong output), which is the worst failure
mode available.

  A. text sink        el.textContent = '✓ Done'      -> ICON.label(el, 'check', ' Done')
  B. markup string    '<button>✕</button>'           -> '<button>' + ICON.svg('x-mark') + '</button>'
  C. template literal `<b>✕</b>`                     -> `<b>${ICON.svg('x-mark')}</b>`

Refused on sight (see SKIP_LINE / the guards in walk()):
  * comment lines
  * text-only channels: .title=, title:, aria-label, alt=, placeholder,
    TOAST.*, console.*, alert(), document.title, .setAttribute('title'…)
  * comparisons — `=== '✓'`, `!== '▾'` — where the glyph is a VALUE
  * object keys and `case '✓':`
  * rm/js/icon-picker.js, which IS the emoji palette
  * any glyph in the manifest's `keep{}` block
"""
import argparse, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAN = json.loads((ROOT / 'scripts' / 'icons.manifest.json').read_text())
NAME_OF = {}
for _n, _c in MAN['icons'].items():
    for _g in [_c.get('emoji')] + _c.get('also', []):
        if _g:
            NAME_OF[_g] = _n
KEEP = set(k for k in MAN.get('keep', {}) if not k.startswith('_'))
for _k in KEEP:
    NAME_OF.pop(_k, None)

NEVER_FILES = {'icon-picker.js', 'icons.js'}

# a line carrying any of these is a text-only channel, or a comparison
SKIP_LINE = re.compile(
    r"""(\.title\s*=|\btitle\s*:|aria-label|\balt\s*=|placeholder|
         \bTOAST\b|\bconsole\.|\balert\(|document\.title|
         ===|!==|\bcase\s|\.setAttribute\(\s*['"](?:title|aria-label|alt|placeholder)['"]
        )""", re.X)

GLYPHS = ''.join(sorted(NAME_OF, key=len, reverse=True))
# \ufe0f is the emoji variation selector: '☀️' is '☀' + U+FE0F. Matching the
# glyph alone would leave the selector stranded beside the new <svg>.
GLYPH_RE = re.compile(
    '(' + '|'.join(re.escape(g) for g in sorted(NAME_OF, key=len, reverse=True)) + ')\ufe0f?')

# A. el.textContent = '<glyph><rest>';   (single or double quoted, no concat)
SINK = re.compile(
    r"""^(?P<i>\s*)(?P<lhs>[A-Za-z_$][\w$.\[\]'"]*)\.(?:textContent|innerText)\s*=\s*
        (?P<q>['"])(?P<g>GLYPH)\ufe0f?(?P<rest>(?:(?!(?P=q)).)*)(?P=q)\s*;\s*$""".replace(
        'GLYPH', '|'.join(re.escape(g) for g in sorted(NAME_OF, key=len, reverse=True))),
    re.X)


def is_comment(line):
    s = line.lstrip()
    return s.startswith('//') or s.startswith('*') or s.startswith('/*')


def looks_like_markup(segment):
    """True if this string literal is building HTML rather than prose."""
    return '<' in segment and '>' in segment


def convert(path, apply):
    p = pathlib.Path(path)
    if p.name in NEVER_FILES:
        return None
    src = p.read_text()
    lines = src.split('\n')
    out, hits = [], {'sink': 0, 'markup': 0, 'tpl': 0, 'skipped': 0}

    in_block_comment = False
    for line in lines:
        stripped = line.strip()
        if in_block_comment:
            if '*/' in line:
                in_block_comment = False
            out.append(line); continue
        if stripped.startswith('/*') and '*/' not in line:
            in_block_comment = True
            out.append(line); continue
        if is_comment(line) or not GLYPH_RE.search(line):
            out.append(line); continue
        if SKIP_LINE.search(line):
            hits['skipped'] += len(GLYPH_RE.findall(line))
            out.append(line); continue

        # ── A. text sink ────────────────────────────────────────────
        m = SINK.match(line)
        if m and m.group('rest').count('$') == 0 and not GLYPH_RE.search(m.group('rest')):
            name = NAME_OF[m.group('g')]
            rest = m.group('rest')
            q = m.group('q')
            args = f"{m.group('lhs')}, '{name}'"
            if rest:
                args += f", {q}{rest}{q}"
            out.append(f"{m.group('i')}ICON.label({args});")
            hits['sink'] += 1
            continue

        # ── B/C. glyphs inside string / template literals ───────────
        new, n_mark, n_tpl = rewrite_literals(line)
        hits['markup'] += n_mark
        hits['tpl'] += n_tpl
        if n_mark or n_tpl:
            out.append(new)
        else:
            hits['skipped'] += len(GLYPH_RE.findall(line))
            out.append(line)

    new_src = '\n'.join(out)
    changed = new_src != src
    if apply and changed:
        p.write_text(new_src)
    return {'file': str(p), 'changed': changed, **hits}


LITERAL = re.compile(r"""(?P<q>['"`])(?P<body>(?:\\.|(?!(?P=q)).)*)(?P=q)""", re.S)


def split_template(body):
    """Split a template-literal body into (is_expr, text) spans.

    Everything inside ${ ... } is CODE, not markup — it routinely holds its own
    quoted strings (`${pinned ? ' 📌' : ''}`). Substituting there produced
    `'${ICON.svg('pin')}'`: broken quoting, and a ${} inside single quotes is
    not interpolated anyway. So expression spans are handed back untouched and
    counted as left-for-human.
    """
    spans, i, n, start = [], 0, len(body), 0
    while i < n:
        if body[i] == '$' and i + 1 < n and body[i + 1] == '{':
            spans.append((False, body[start:i]))
            depth, j = 1, i + 2
            while j < n and depth:
                if body[j] == '{': depth += 1
                elif body[j] == '}': depth -= 1
                j += 1
            spans.append((True, body[i:j]))
            i = start = j
        else:
            i += 1
    spans.append((False, body[start:]))
    return spans


def rewrite_literals(line):
    n_mark = n_tpl = 0

    def do(m):
        nonlocal n_mark, n_tpl
        q, body = m.group('q'), m.group('body')
        if not GLYPH_RE.search(body) or not looks_like_markup(body):
            return m.group(0)          # prose, not markup — leave it
        if q == '`':
            out = []
            for is_expr, seg in split_template(body):
                if is_expr or not GLYPH_RE.search(seg):
                    out.append(seg); continue
                n_tpl += len(GLYPH_RE.findall(seg))
                out.append(GLYPH_RE.sub(
                    lambda g: '${ICON.svg(\'' + NAME_OF[g.group(1)] + '\')}', seg))
            return q + ''.join(out) + q
        # plain quoted string: break out of the literal and concatenate
        def rep(g):
            return f"{q} + ICON.svg('{NAME_OF[g.group(1)]}') + {q}"
        new = GLYPH_RE.sub(rep, body)
        n_mark += len(GLYPH_RE.findall(body))
        # tidy the empty fragments a leading/trailing glyph leaves behind
        new = q + new + q
        for a, b in ((f"{q}{q} + ", ''), (f" + {q}{q}", '')):
            new = new.replace(a, b)
        return new

    return LITERAL.sub(do, line), n_mark, n_tpl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    tot = {'sink': 0, 'markup': 0, 'tpl': 0, 'skipped': 0}
    changed = []
    for f in a.files:
        r = convert(f, a.apply)
        if not r:
            print(f"  -- {f} (never-touch)"); continue
        for k in tot:
            tot[k] += r[k]
        if r['changed']:
            changed.append(r['file'])
            print(f"  {pathlib.Path(f).name:34} sink {r['sink']:3}  markup {r['markup']:3}"
                  f"  tpl {r['tpl']:3}  left {r['skipped']:3}")
    print(f"\n  TOTAL  sink {tot['sink']}  markup {tot['markup']}  template {tot['tpl']}"
          f"  left-for-human {tot['skipped']}   ({len(changed)} files"
          f"{' written' if a.apply else ' would change'})")


if __name__ == '__main__':
    main()
