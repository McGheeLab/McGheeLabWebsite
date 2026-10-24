"""Locate each quote of a lit-review spec on its PDF page.

A quote only enters the note if its words are found, in order, on one page of the
paper's PDF (word-sequence match, de-hyphenated across line ends, ligatures folded).
Output per quote: page (1-based), rects as page FRACTIONS [x, y, w, h] (one per line —
the form Scientia's quote component stores), the verbatim text as it sits on the page,
and 32-char prefix/suffix.

usage: python locate_quotes.py spec.json out.json
"""
import json, re, sys, unicodedata
import pymupdf

LIG = {'®': 'fi', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', '‐': '-', '‑': '-', '–': '-', '—': '-', '−': '-'}


def norm(tok):
    t = unicodedata.normalize('NFKC', tok)
    for a, b in LIG.items(): t = t.replace(a, b)
    t = t.lower().replace('µ', 'u').replace('μ', 'u')
    return re.sub(r'[^a-z0-9]+', '', t)


def page_words(page):
    """Words in reading order with line-end hyphenation joined: [(norm, display, [rect...], (block,line))]."""
    raw = page.get_text('words', sort=False)
    out = []
    i = 0
    while i < len(raw):
        x0, y0, x1, y1, w, b, l, n = raw[i]
        rects = [(x0, y0, x1, y1, b, l)]
        disp = w
        # "propa-" at the end of a line + "gation" at the start of the next → one word
        if w.endswith(('-', '­')) and i + 1 < len(raw) and (raw[i + 1][5], raw[i + 1][6]) != (b, l):
            nx = raw[i + 1]
            disp = w[:-1] + nx[4]
            rects.append((nx[0], nx[1], nx[2], nx[3], nx[5], nx[6]))
            i += 1
        out.append((norm(disp), disp, rects))
        i += 1
    return [w for w in out if w[0]]


def find(words, q):
    """Indices of the page words that spell the quote. Matching is on the quote's letters and digits as ONE stream,
    so hyphens, dashes and how the PDF split its words do not matter. A pure number on the page that the quote does
    not have (a preprint's margin line number, a page number) is stepped over and never included; a superscript
    reference glued to a word ("cells20") counts as the word."""
    for s in range(len(words)):
        if not words[s][0] or not q.startswith(words[s][0]): continue
        idx, i, pos = [], s, 0
        while pos < len(q) and i < len(words):
            w = words[i][0]
            if q.startswith(w, pos): idx.append(i); pos += len(w)
            elif w.startswith(q[pos:]): idx.append(i); pos = len(q)           # the quote ends inside this word
            else:
                m = re.match(r'^([a-z]+)(\d{1,3})$', w)
                if m and q.startswith(m.group(1), pos): idx.append(i); pos += len(m.group(1))
                elif w.isdigit() and len(w) <= 4 and idx: pass
                else: break
            i += 1
        if pos == len(q): return idx
    return None


def locate(pdf, text, hint=None):
    q = ''.join(norm(t) for t in text.split())
    if len(q) < 12: return None
    order = list(range(pdf.page_count))
    if hint and 1 <= hint <= pdf.page_count: order.remove(hint - 1); order.insert(0, hint - 1)
    for pi in order:
        page = pdf[pi]
        words = page_words(page)
        idx = find(words, q)
        if not idx: continue
        hit = [words[i] for i in idx]
        W, H = page.rect.width, page.rect.height
        lines = {}
        for _, _, rects in hit:
            for (x0, y0, x1, y1, b, l) in rects:
                k = (b, l)
                if k in lines:
                    a = lines[k]; lines[k] = (min(a[0], x0), min(a[1], y0), max(a[2], x1), max(a[3], y1))
                else: lines[k] = (x0, y0, x1, y1)
        rects = sorted(lines.values(), key=lambda r: (round(r[1]), r[0]))
        frac = [[round(r[0] / W, 5), round(r[1] / H, 5), round((r[2] - r[0]) / W, 5), round((r[3] - r[1]) / H, 5)] for r in rects]
        # shown as typed (verbatim, line-break hyphens rejoined); the page's own words are kept for checking
        exact = re.sub(r'\s+', ' ', text).strip()
        pageText = ' '.join(d for _, d, _ in hit)
        before = ' '.join(d for _, d, _ in words[max(0, idx[0] - 8):idx[0]])
        after = ' '.join(d for _, d, _ in words[idx[-1] + 1:idx[-1] + 9])
        prefix, suffix = before[-32:], after[:32]
        return {'page': pi + 1, 'rects': frac, 'exact': exact, 'pageText': pageText, 'prefix': prefix.strip(), 'suffix': suffix.strip()}
    return None


def main():
    spec = json.load(open(sys.argv[1]))
    out, missing = {}, []
    for key, p in spec['papers'].items():
        if not p.get('pdf'): continue
        pdf = pymupdf.open(p['pdf'])
        res = []
        for qi, qt in enumerate(p.get('quotes', [])):
            r = locate(pdf, qt['text'], qt.get('page'))
            if r: r['i'] = qi; res.append(r)
            else: missing.append((key, qi, qt['text'][:90]))
        out[key] = {'pages': pdf.page_count, 'quotes': res}
    json.dump(out, open(sys.argv[2], 'w'), indent=1)
    found = sum(len(v['quotes']) for v in out.values())
    print('located %d quotes; %d not found' % (found, len(missing)))
    for m in missing: print('  NOT FOUND', m)


if __name__ == '__main__':
    main()
