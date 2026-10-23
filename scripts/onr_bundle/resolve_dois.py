#!/usr/bin/env python3
"""resolve_dois.py — fill in DOIs the Paperpile export never carried.

Stage 2 of the docx → .paperbundle.zip pipeline. Six of the proposal's 33
references reach us with no DOI, PMID or arXiv id, because that is how they sit
in Paperpile. RM will flag those in the library as "no identifier — enrich", and
its post-import Semantic Scholar pass may or may not find them.

So we look them up ONCE, here, against CrossRef — a lookup, never an invention.
A candidate is accepted only when the returned title matches the reference title
after aggressive normalization (lowercase, alphanumerics only). That rule is the
whole safety property: a paper that is genuinely unpublished (the porcine-liver
CTE manuscript) returns near-misses and is left blank rather than given the DOI
of something else.

Results are cached to doi_overrides.json so the build is deterministic and
repeatable offline; delete that file to re-query.

Usage:
  python3 scripts/onr_bundle/resolve_dois.py --stage <dir> [--refresh]
"""

import argparse
import json
import os
import re
import sys
import time
import subprocess
import urllib.parse

UA = 'McGheeLabRM/1.0 (https://mcgheelab.com; mailto:mcgheealex@arizona.edu)'
API = 'https://api.crossref.org/works'


def norm(text):
    return re.sub(r'[^a-z0-9]', '', (text or '').lower())


def query(ref):
    bits = [ref['title']]
    bits += [a['family'] for a in ref.get('authors', [])[:3] if a.get('family')]
    if ref.get('journal'):
        bits.append(ref['journal'])
    url = '%s?%s' % (API, urllib.parse.urlencode({
        'rows': 5,
        'query.bibliographic': ' '.join(bits),
        'select': 'DOI,title,score,container-title,issued',
    }))
    # curl, not urllib: this machine's Python has no CA bundle wired up, and
    # every request fails CERTIFICATE_VERIFY_FAILED. curl uses the system store.
    out = subprocess.run(['curl', '-sS', '--fail', '--max-time', '30',
                          '-H', 'User-Agent: ' + UA, url],
                         capture_output=True, check=True).stdout
    return json.loads(out)['message']['items']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', required=True)
    ap.add_argument('--refresh', action='store_true')
    args = ap.parse_args()

    refs_path = os.path.join(args.stage, 'refs.json')
    out_path = os.path.join(args.stage, 'doi_overrides.json')
    refs = json.load(open(refs_path))

    cache = {}
    if os.path.exists(out_path) and not args.refresh:
        cache = json.load(open(out_path))

    missing = [(i, r) for i, r in enumerate(refs)
               if not (r.get('doi') or r.get('pmid') or r.get('arxiv_id'))]
    print('%d of %d references carry no identifier' % (len(missing), len(refs)))

    for i, ref in missing:
        key = ref['citekey']
        if key in cache:
            print('  cached  [%2d] %-34s → %s' % (i + 1, key[:34], cache[key] or '(none)'))
            continue
        try:
            items = query(ref)
        except Exception as exc:                      # noqa: BLE001
            print('  ERROR   [%2d] %s: %s' % (i + 1, key[:34], exc), file=sys.stderr)
            continue
        want = norm(ref['title'])
        hit = ''
        for it in items:
            got = norm((it.get('title') or [''])[0])
            if got and got == want:
                hit = (it.get('DOI') or '').lower()
                break
        cache[key] = hit
        top = (items[0].get('title') or [''])[0][:52] if items else '(no results)'
        print('  %-7s [%2d] %-34s → %s   [top: %s]'
              % ('MATCH' if hit else 'no match', i + 1, key[:34],
                 hit or '(left blank)', top))
        time.sleep(1.2)                               # be polite to CrossRef

    with open(out_path, 'w') as fh:
        json.dump(cache, fh, indent=1, sort_keys=True)
    print('\nresolved %d / %d; wrote %s'
          % (sum(1 for v in cache.values() if v), len(cache), out_path))


if __name__ == '__main__':
    main()
