#!/usr/bin/env python3
"""warmup.py — the compile service's warm-up set (V3.916).

    python3 scripts/paper-lab/warmup.py            # serve.py must be running

A Cloud Run instance of paper-compile starts with an empty Tectonic cache and
fetches every package and font the first time a compile asks for it — about
47 s for a journal look on 2026-10-25, against 3 s once cached. This script
makes one SYNTHETIC paper (invented text, a generated figure, nothing from the
corpus) that touches what the templates use — figures, tables, equations,
lists, footnotes, citations, siunitx units, cleveref — compiles it through the
REAL Export page in the Paper Lab under every template (and, for a template
with a journal look, the plain submission page too), and copies each .tex tree
the page sent into functions/paper-compile/warmup/papers.tar.gz (one folder
per <template>[-submission]).
It then compiles that set AND every paper compiled in the Paper Lab
(<corpus>/_runs/*/*/compile.json — real papers reach fonts and sizes a
synthetic one never does: a ± in a 9 pt caption, bold math in a subscript,
wrapfig) into an empty Tectonic cache, and writes the name of every file
Tectonic fetched to warmup/tex-files.txt (names only — no paper content).
The Dockerfile fetches each listed file (`tectonic -X bundle cat`) and
compiles the warm-up set once, so the image ships with the cache full
(measured: a real paper 38 s from an empty cache, 2.8 s warm; every corpus
paper compiles with --only-cached after the simulated build).

    python3 scripts/paper-lab/warmup.py --list-only   # just rebuild tex-files.txt

Re-run after adding a template or a package to a look, then redeploy the
service (functions/paper-compile/README.md).
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
CORPUS = os.path.abspath(os.path.join(REPO, '..', 'PaperLab-corpus'))
BASE = os.environ.get('PAPER_LAB_URL', 'http://localhost:8917')
OUT = os.path.join(REPO, 'functions', 'paper-compile', 'warmup')
PAPERS = os.path.join(CORPUS, '_runs', 'warmup', 'papers')   # unpacked set (outside the repo)
TARBALL = os.path.join(OUT, 'papers.tar.gz')                  # what the Dockerfile ADDs
PID = 'warmup-sample'
KEEP_EXT = ('.tex', '.bib', '.cls', '.sty', '.bst', '.clo', '.cfg', '.def')


def png(w=64, h=36):
    """A gradient PNG written by hand (no imaging library needed)."""
    rows = b''.join(b'\x00' + b''.join(struct.pack('BBB', x * 255 // w, y * 255 // h, 160) for x in range(w))
                    for y in range(h))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


def para(i, body, kind='paragraph', attrs=None):
    return {'id': 'w-%s' % i, 'kind': kind, 'status': 'draft', 'body': body, 'attrs': attrs or {}}


def bundle():
    sections = [
        {'id': 'ws-abs', 'kind': 'abstract', 'label': 'Abstract', 'order': 0, 'status': 'draft', 'children': [
            para('a1', 'A synthetic manuscript that exercises the typesetting features the paper builder exports [1].')]},
        {'id': 'ws-kw', 'kind': 'keywords', 'label': 'Keywords', 'order': 1, 'status': 'draft', 'children': [
            para('k1', 'typesetting, warm-up, synthetic')]},
        {'id': 'ws-int', 'kind': 'introduction', 'label': 'Introduction', 'order': 2, 'status': 'draft', 'children': [
            para('i1', 'Text with **bold**, *italic*, H~2~O, cm^-1^, inline math $x_i^2 + \\alpha$, units '
                       '5~\\si{\\micro\\metre}, \\SI{10}{\\milli\\litre\\per\\minute} and 37~\\si{\\degreeCelsius}, '
                       '50\\% of samples, an en dash 200–300 nm, accents (Müller, Ćirić), a footnote[^A synthetic '
                       'note.] and citations [1], [2,3]. As \\cref{fig:overview} and Fig. [!fig:fig:overview] show, '
                       'Table [!tab:summary] and Eq. [!eqr:key] agree.'),
            para('i2', 'Scope', 'subheading', {'level': 2}),
            para('i3', 'first item\nsecond item\nthird item', 'list', {'list_type': 'number'}),
            para('i4', 'a point\nanother point', 'list', {'list_type': 'bullet'})]},
        {'id': 'ws-met', 'kind': 'methods', 'label': 'Materials and Methods', 'order': 3, 'status': 'draft', 'children': [
            para('m1', 'The governing relation is Eq. [!eqr:key], with $\\nabla \\cdot \\mathbf{u} = 0$.'),
            para('m2', 'E = mc^2 + \\int_0^1 f(x)\\,dx', 'equation',
                 {'display': True, 'numbered': True, 'label': 'key', 'span': 'column'}),
            para('m3', 'Detail', 'subheading', {'level': 3})]},
        {'id': 'ws-res', 'kind': 'results', 'label': 'Results', 'order': 4, 'status': 'draft', 'children': [
            para('r1', 'Round-trip import preserved every block [3].'),
            {'id': 'w-r2', 'kind': 'figure', 'status': 'draft', 'body': 'A generated gradient, $\\mu$m scale.',
             'attrs': {'storage_path': 'imports/warmup/fig-gradient.png', 'download_url': '', 'hash': 'fig-gradient',
                       'mime': 'image/png', 'width': '\\linewidth', 'label': 'fig:overview', 'numbered': True,
                       'span': 'column'}},
            {'id': 'w-r3', 'kind': 'table', 'status': 'draft', 'body': '',
             'attrs': {'rows': 3, 'cols': 3, 'label': 'tab:summary', 'numbered': True, 'header_row': True,
                       'booktabs': True, 'align': 'lcr', 'caption': {'__ytype': 'text', 'value': 'Counts by block kind.'},
                       'cells': {'__ytype': 'map', 'entries': {k: {'__ytype': 'text', 'value': v} for k, v in {
                           '0-0': 'Kind', '0-1': 'Count', '0-2': 'Share (\\%)',
                           '1-0': 'Paragraph', '1-1': '12', '1-2': '60',
                           '2-0': 'Figure', '2-1': '$n=3$', '2-2': '15'}.items()}}}}]},
        {'id': 'ws-dis', 'kind': 'discussion', 'label': 'Discussion', 'order': 5, 'status': 'draft', 'children': [
            para('d1', 'Nothing here is real data.')]},
        {'id': 'ws-ack', 'kind': 'acknowledgements', 'label': 'Acknowledgements', 'order': 6, 'status': 'draft',
         'children': [para('c1', 'None.')]},
        {'id': 'ws-ref', 'kind': 'references', 'label': 'References', 'order': 7, 'status': 'draft', 'children': []},
    ]
    refs = [
        {'title': 'A first synthetic reference', 'authors': [{'family': 'Doe', 'given': 'Jane'}, {'family': 'Roe', 'given': 'Richard'}],
         'year': '2024', 'journal': 'Journal of Examples', 'volume': '12', 'issue': '3', 'pages': '101-115',
         'doi': '10.1000/example.1', 'source': 'manual'},
        {'title': 'A second synthetic reference', 'authors': [{'family': 'Müller', 'given': 'Ana'}],
         'year': '2023', 'journal': 'Examples Letters', 'volume': '4', 'pages': '1-9', 'source': 'manual'},
        {'title': 'A third synthetic reference', 'authors': [{'family': 'Smith', 'given': 'Lee'}, {'family': 'Ng', 'given': 'Kai'},
                                                             {'family': 'Lopez', 'given': 'Rosa'}],
         'year': '2022', 'journal': 'Review of Examples', 'volume': '7', 'issue': '1', 'pages': '20-30', 'source': 'manual'},
    ]
    return {
        'bundle_version': 1, 'exported_at': '2026-10-25T00:00:00.000Z',
        'paper': {'title': 'A Synthetic Warm-up Manuscript', 'paper_type': 'journal', 'grant_subtype': None,
                  'template_id': 'preprint-numeric', 'target_journal': 'Journal of Examples', 'repo_path': '',
                  'repo_org': '', 'notes': 'compile-service warm-up (scripts/paper-lab/warmup.py)'},
        'config': {'templateId': 'preprint-numeric', 'paperType': 'journal', 'addons': [], 'overrides': {},
                   'authors': [{'name': 'Jane Doe', 'affiliationIdx': [0], 'corresponding': True, 'email': 'jane@example.org'},
                               {'name': 'Ana Müller', 'affiliationIdx': [1], 'corresponding': False, 'email': ''}],
                   'affiliations': ['Department of Examples, Example University', 'Institute of Samples'],
                   'buildTarget': 'submission', 'sectionNumbering': 'auto'},
        'tree': {'meta': {'title': 'A Synthetic Warm-up Manuscript'}, 'sections': sections},
        'equation_library': [], 'figure_unplaced': [], 'table_unplaced': [], 'references': refs,
        'assets': [{'hash': 'fig-gradient', 'ext': 'png', 'storage_path_original': 'imports/warmup/fig-gradient.png',
                    'relpath': 'assets/fig-gradient.png'}],
        'comment_count': 0,
    }


def api(path, data=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def drive(*args):
    p = subprocess.run(['node', os.path.join(HERE, 'drive.mjs')] + list(args), capture_output=True, text=True, timeout=900)
    if p.returncode:
        sys.exit('drive %s failed:\n%s' % (args[0], (p.stdout + p.stderr)[-2000:]))
    return p.stdout


def file_list():
    """tex-files.txt: every bundle file a compile of the warm-up set or of a Paper Lab paper fetched."""
    import glob
    import tempfile
    cache = tempfile.mkdtemp(prefix='tectonic-cache-')
    env = dict(os.environ, TECTONIC_CACHE_DIR=cache)
    dirs = sorted(d for d in glob.glob(os.path.join(PAPERS, '*')) if os.path.isdir(d))
    for c in glob.glob(os.path.join(CORPUS, '_runs', '*', '*', 'compile.json')):
        try:
            d = json.load(open(c)).get('dir')
        except Exception:
            d = None
        if d and os.path.exists(os.path.join(d, 'main.tex')):
            dirs.append(d)
    work = tempfile.mkdtemp(prefix='warm-')
    for i, d in enumerate(dirs):
        w = os.path.join(work, str(i))
        shutil.copytree(d, w, ignore=shutil.ignore_patterns('*.pdf', '*.aux', '*.log', '*.bbl', '*.blg', '*.out', '*.gz'))
        subprocess.run(['tectonic', '-X', 'compile', 'main.tex'], cwd=w, env=env, capture_output=True, timeout=600)
    names = set()
    for m in glob.glob(os.path.join(cache, 'manifests', '*.txt')):
        names.update(l.split(' ')[0] for l in open(m) if l.strip())
    with open(os.path.join(OUT, 'tex-files.txt'), 'w') as fh:
        fh.write('\n'.join(sorted(names)) + '\n')
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(cache, ignore_errors=True)
    print('tex-files.txt: %d files from %d compiles' % (len(names), len(dirs)))


def main():
    if '--list-only' in sys.argv:
        file_list()
        return
    src = os.path.join(CORPUS, '_examples', 'warmup')
    os.makedirs(src, exist_ok=True)
    zp = os.path.join(src, 'warmup.paperbundle.zip')
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('paper.json', json.dumps(bundle(), indent=1))
        z.writestr('assets/fig-gradient.png', png())
    db = api('/paper-lab/api/db')
    stale = [k for k in db if k in ('projects/' + PID, 'paperExports/' + PID) or k.startswith('papers/' + PID + '/')]
    if stale:
        api('/paper-lab/api/docs', [{'path': k, 'data': None} for k in stale])
    drive('import', '/paper-lab/corpus/_examples/warmup/warmup.paperbundle.zip', PID)

    tdir = os.path.join(REPO, 'rm', 'data', 'paper-templates')
    jobs = []
    for f in sorted(os.listdir(tdir)):
        if not f.endswith('.json') or f.startswith('rm-'):
            continue
        t = json.load(open(os.path.join(tdir, f)))
        jobs.append((t['id'], 'published'))
        if t.get('look'):
            jobs.append((t['id'], 'submission'))
    if os.path.isdir(PAPERS):
        shutil.rmtree(PAPERS)
    os.makedirs(PAPERS)
    os.makedirs(OUT, exist_ok=True)
    for tid, look in jobs:
        db = api('/paper-lab/api/db')
        cfg = dict(db.get('paperExports/' + PID) or {})
        cfg.update({'templateId': tid, 'layoutLook': look})
        api('/paper-lab/api/docs', [{'path': 'paperExports/' + PID, 'data': cfg}])
        tmp = os.path.join(CORPUS, '_runs', 'warmup', '%s-%s' % (tid, look))
        drive('compile', PID, tmp)
        res = json.load(open(os.path.join(tmp, 'compile.json')))
        name = tid if look == 'published' else tid + '-submission'
        if not res.get('ok'):
            print('%-28s FAILED — not in the warm-up set' % name)
            continue
        dst = os.path.join(PAPERS, name)
        for root, _dirs, files in os.walk(res['dir']):
            rel = os.path.relpath(root, res['dir'])
            for fn in files:
                if fn.endswith(KEEP_EXT) or rel.startswith('figures'):
                    os.makedirs(os.path.join(dst, rel), exist_ok=True)
                    shutil.copy(os.path.join(root, fn), os.path.join(dst, rel, fn))
        print('%-28s ok  %.1f s' % (name, res.get('seconds') or 0))
    # one small archive in the repo instead of ~200 generated files
    import tarfile
    with tarfile.open(TARBALL + '.tmp', 'w:gz') as tf:
        for name in sorted(os.listdir(PAPERS)):
            tf.add(os.path.join(PAPERS, name), arcname=name)
    os.replace(TARBALL + '.tmp', TARBALL)
    print('warm-up set →', os.path.relpath(TARBALL, REPO), '(%d KB)' % (os.path.getsize(TARBALL) // 1024))
    file_list()


if __name__ == '__main__':
    main()
