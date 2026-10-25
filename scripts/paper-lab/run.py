#!/usr/bin/env python3
"""run.py — one corpus paper through the whole Paper Lab loop (V3.906).

    python3 scripts/paper-lab/run.py gt-pnas-legant2012 [--reimport] [--tag baseline]
    python3 scripts/paper-lab/run.py all --tag baseline

Steps (serve.py must be running): import the corpus bundle through the real
importer (skipped when the paper already exists, unless --reimport) →
Document-view page screenshots → real Export page compile (local Tectonic) →
compare.py (ORIGINAL | COMPILED | PREVIEW + metrics). Output goes to
<corpus>/_runs/<tag>/<id>/ (outside the repo).
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
CORPUS = os.path.abspath(os.path.join(REPO, '..', 'PaperLab-corpus'))
BASE = os.environ.get('PAPER_LAB_URL', 'http://localhost:8917')


def db():
    with urllib.request.urlopen(BASE + '/paper-lab/api/db') as r:
        return json.load(r)


def drive(*args):
    p = subprocess.run(['node', os.path.join(HERE, 'drive.mjs')] + list(args), capture_output=True, text=True, timeout=1800)
    out = (p.stdout or '') + (p.stderr or '')
    if p.returncode:
        print(out[-3000:])
        raise SystemExit('drive %s failed' % args[0])
    return out


def look_block(template_id):
    """Text block (pt) of a template's published look, or None."""
    try:
        t = json.load(open(os.path.join(REPO, 'rm', 'data', 'paper-templates', '%s.json' % template_id)))
    except Exception:
        return None
    lk = t.get('look')
    if not lk or 'page' not in lk:
        return None
    m = lk.get('margins', {})
    return '%s,%s,%s,%s' % (m.get('left', 72), m.get('top', 72), lk['page']['w'] - m.get('right', 72),
                            lk['page']['h'] - m.get('bottom', 72))


def run_one(pid, tag, reimport=False, skip=()):
    src = os.path.join(CORPUS, pid)
    out = os.path.join(CORPUS, '_runs', tag, pid)
    os.makedirs(out, exist_ok=True)
    truth = {}
    try:
        truth = json.load(open(os.path.join(src, 'truth.json')))
    except Exception:
        pass
    have = ('projects/' + pid) in db()
    if reimport or not have:
        # a fresh import: drop the old paper's docs first
        if have:
            d = db()
            ops = [{'path': k, 'data': None} for k in d if k == 'projects/' + pid or k.startswith('papers/' + pid + '/')
                   or k == 'papers/' + pid or k == 'paperExports/' + pid]
            req = urllib.request.Request(BASE + '/paper-lab/api/docs', data=json.dumps(ops).encode(),
                                         headers={'Content-Type': 'application/json'})
            urllib.request.urlopen(req).read()
        print(drive('import', '/paper-lab/corpus/%s/%s.paperbundle.zip' % (pid, pid), pid)[-1500:])
    if 'preview' not in skip:
        for f in os.listdir(out):
            if f.startswith('preview-') and f.endswith('.png'):
                os.remove(os.path.join(out, f))
        print(drive('preview', pid, out)[-800:])
    if 'compile' not in skip:
        print(drive('compile', pid, out)[-2500:])
    pages = truth.get('main_pages')
    cmd = ['python3', os.path.join(HERE, 'compare.py'), out, '--original', os.path.join(src, 'original.pdf'),
           '--title', '%s — %s (%s)' % (pid, truth.get('journal', ''), tag)]
    tb = truth.get('text_block_pt')
    if tb:
        cmd += ['--orig-block', '%s,%s,%s,%s' % (tb['x0'], tb['top'], tb['x1'], tb['bottom'])]
    lk = look_block(truth.get('template'))
    if lk:
        cmd += ['--look-block', lk]
    if pages:
        cmd += ['--pages', '%d-%d' % (pages[0], pages[1])]
    p = subprocess.run(cmd, capture_output=True, text=True)
    print(p.stdout[-1500:], p.stderr[-1500:])
    return out


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('id')
    ap.add_argument('--tag', default='latest')
    ap.add_argument('--reimport', action='store_true')
    ap.add_argument('--skip', default='')
    a = ap.parse_args()
    ids = [a.id]
    if a.id == 'all':
        ids = sorted(d for d in os.listdir(CORPUS) if d.startswith('gt-') and
                     os.path.exists(os.path.join(CORPUS, d, d + '.paperbundle.zip')))
    for pid in ids:
        print('=====', pid)
        run_one(pid, a.tag, a.reimport, tuple(s for s in a.skip.split(',') if s))
