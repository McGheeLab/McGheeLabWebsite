#!/usr/bin/env python3
"""serve.py — the Paper Lab: the real RM paper writer running on this
computer with NO Firebase (V3.906).

    python3 scripts/paper-lab/serve.py [--port 8917] [--workspace DIR]
    open http://localhost:8917/rm/pages/paper-builder.html

Every /rm/ HTML page is served with the four gstatic firebase-*-compat.js
tags replaced by scripts/paper-lab/fake-firebase.js (an in-memory Firestore /
Auth / Storage persisted into the workspace), plus lab-hooks.js (routes the
compile button to local Tectonic). Nothing leaves this computer: the
database is <workspace>/db.json, uploaded figures are <workspace>/storage/,
compiles land in <workspace>/compiles/.

The default workspace is ../PaperLab-corpus/_workspace beside this repo — a
folder outside every git repo, because the ground-truth corpus is copyrighted
journal content used only for local testing.

Endpoints (besides static files from the repo root):
  GET  /paper-lab/api/db                     whole database (JSON)
  POST /paper-lab/api/docs                   [{path, data|null}] document writes
  POST /paper-lab/api/reset                  wipe the database + storage
  POST /paper-lab/api/compile                {job, files:[{relpath, content}],
                                              figureAssets:[{relpath, storagePath}]}
                                             → {ok, pdf, log, seconds}
  GET|HEAD|POST|DELETE /paper-lab/storage/<path>
  GET  /paper-lab/corpus/<path>              read-only view of the corpus folder
  GET  /paper-lab/work/<path>                read-only view of the workspace
"""
import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
DEFAULT_CORPUS = os.path.abspath(os.path.join(REPO, '..', 'PaperLab-corpus'))

FIREBASE_TAG = re.compile(
    r'<script[^>]+src="https://www\.gstatic\.com/firebasejs/[^"]+/firebase-(app|auth|firestore|storage|functions|messaging)-compat\.js"[^>]*>\s*</script>\s*')

LOCK = threading.Lock()
STATE = {'db': None, 'dirty': False}


def ws_path(*p):
    return os.path.join(ARGS.workspace, *p)


def load_db():
    if STATE['db'] is None:
        try:
            with open(ws_path('db.json')) as f:
                STATE['db'] = json.load(f)
        except FileNotFoundError:
            STATE['db'] = {}
    return STATE['db']


def save_db_soon():
    STATE['dirty'] = True


def saver():
    while True:
        time.sleep(0.5)
        if STATE['dirty']:
            with LOCK:
                STATE['dirty'] = False
                tmp = ws_path('db.json.tmp')
                with open(tmp, 'w') as f:
                    json.dump(STATE['db'], f)
                os.replace(tmp, ws_path('db.json'))


def safe_join(root, rel):
    rel = unquote(rel).lstrip('/')
    full = os.path.abspath(os.path.join(root, rel))
    if not (full == root or full.startswith(root + os.sep)):
        raise PermissionError(rel)
    return full


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=REPO, **kw)

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            super().log_message(fmt, *args)

    # ── helpers ──
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def _file(self, full, head=False):
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        meta = full + '.ctype'
        if os.path.exists(meta):
            ctype = open(meta).read().strip() or ctype
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if not head:
            with open(full, 'rb') as f:
                shutil.copyfileobj(f, self.wfile)

    def end_headers(self):
        # the lab is a dev server: never let the browser cache site code
        if not any(h.lower().startswith(b'cache-control') for h in getattr(self, '_headers_buffer', [])):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # ── routing ──
    def do_HEAD(self):
        u = urlparse(self.path)
        if u.path.startswith('/paper-lab/storage/'):
            return self._file(safe_join(ws_path('storage'), u.path[len('/paper-lab/storage/'):]), head=True)
        return super().do_HEAD()

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == '/paper-lab/api/db':
            with LOCK:
                return self._json(load_db())
        if p.startswith('/paper-lab/storage/'):
            return self._file(safe_join(ws_path('storage'), p[len('/paper-lab/storage/'):]))
        if p.startswith('/paper-lab/corpus/'):
            return self._file(safe_join(ARGS.corpus, p[len('/paper-lab/corpus/'):]))
        if p.startswith('/paper-lab/work/'):
            return self._file(safe_join(ARGS.workspace, p[len('/paper-lab/work/'):]))
        if p.startswith('/paper-lab/') and p.endswith('.js'):
            return self._file(safe_join(HERE, p[len('/paper-lab/'):]))
        if p == '/sw.js':
            # no service worker in the lab: it would cache the fake-free pages
            body = b'/* paper-lab: no service worker */'
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p.startswith('/rm/') and p.endswith('.html'):
            full = safe_join(REPO, p)
            if os.path.isfile(full):
                html = open(full, encoding='utf-8').read()
                html, n = FIREBASE_TAG.subn('', html)
                if n:
                    inject = ('<script src="/paper-lab/fake-firebase.js"></script>\n'
                              '<script src="/paper-lab/lab-hooks.js"></script>\n')
                    html = html.replace('<script src="/rm/js/firebase-bridge.js"></script>',
                                        inject + '<script src="/rm/js/firebase-bridge.js"></script>', 1)
                    if 'fake-firebase.js' not in html:
                        html = html.replace('</head>', inject + '</head>', 1)
                body = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if p == '/paper-lab/api/docs':
            ops = json.loads(self._body() or b'[]')
            with LOCK:
                db = load_db()
                for op in ops:
                    if op.get('data') is None:
                        db.pop(op['path'], None)
                    else:
                        db[op['path']] = op['data']
                save_db_soon()
            return self._json({'ok': True, 'n': len(ops)})
        if p == '/paper-lab/api/reset':
            with LOCK:
                STATE['db'] = {}
                save_db_soon()
                shutil.rmtree(ws_path('storage'), ignore_errors=True)
                os.makedirs(ws_path('storage'), exist_ok=True)
            return self._json({'ok': True})
        if p == '/paper-lab/api/seed':
            # {path: data} merged into the db (driver seeding)
            docs = json.loads(self._body() or b'{}')
            with LOCK:
                load_db().update(docs)
                save_db_soon()
            return self._json({'ok': True, 'n': len(docs)})
        if p.startswith('/paper-lab/storage/'):
            full = safe_join(ws_path('storage'), p[len('/paper-lab/storage/'):])
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'wb') as f:
                f.write(self._body())
            ctype = self.headers.get('Content-Type')
            if ctype:
                open(full + '.ctype', 'w').write(ctype)
            return self._json({'ok': True})
        if p == '/paper-lab/api/compile':
            return self._json(compile_bundle(json.loads(self._body() or b'{}')))
        self.send_error(404)

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path.startswith('/paper-lab/storage/'):
            full = safe_join(ws_path('storage'), u.path[len('/paper-lab/storage/'):])
            for f in (full, full + '.ctype'):
                if os.path.exists(f):
                    os.remove(f)
            return self._json({'ok': True})
        self.send_error(404)


def compile_bundle(req):
    """Write a buildBundle() result to disk and run Tectonic on main.tex."""
    job = re.sub(r'[^\w.-]', '_', req.get('job') or 'job')
    out = ws_path('compiles', job)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    main = 'main.tex'
    for f in req.get('files') or []:
        rel = f['relpath']
        full = safe_join(out, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w', encoding='utf-8') as fh:
            fh.write(f['content'])
        if rel.endswith('.tex') and '\\documentclass' in f['content'][:4000]:
            main = rel
    missing = []
    for a in req.get('figureAssets') or []:
        src = safe_join(ws_path('storage'), a['storagePath'])
        dst = safe_join(out, a['relpath'])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isfile(src):
            shutil.copyfile(src, dst)
        else:
            missing.append(a['storagePath'])
    t0 = time.time()
    proc = subprocess.run(['tectonic', '-X', 'compile', '--keep-logs', '--keep-intermediates',
                           '--synctex', main], cwd=out, capture_output=True, text=True, timeout=600)
    pdf = os.path.splitext(main)[0] + '.pdf'
    ok = proc.returncode == 0 and os.path.isfile(os.path.join(out, pdf))
    log = (proc.stdout or '') + '\n' + (proc.stderr or '')
    with open(os.path.join(out, 'tectonic-output.txt'), 'w') as fh:
        fh.write(log)
    return {'ok': ok, 'job': job, 'dir': out, 'pdf': '/paper-lab/work/compiles/%s/%s' % (job, pdf) if ok else None,
            'log': log[-20000:], 'missing': missing, 'seconds': round(time.time() - t0, 2)}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8917)
    ap.add_argument('--corpus', default=DEFAULT_CORPUS)
    ap.add_argument('--workspace', default=None)
    ap.add_argument('--verbose', action='store_true')
    ARGS = ap.parse_args()
    ARGS.corpus = os.path.abspath(ARGS.corpus)
    ARGS.workspace = os.path.abspath(ARGS.workspace or os.path.join(ARGS.corpus, '_workspace'))
    if ARGS.workspace.startswith(REPO + os.sep):
        raise SystemExit('workspace must be outside the repo (it holds corpus content): ' + ARGS.workspace)
    os.makedirs(ws_path('storage'), exist_ok=True)
    os.makedirs(ws_path('compiles'), exist_ok=True)
    threading.Thread(target=saver, daemon=True).start()
    print('Paper Lab on http://localhost:%d/rm/pages/paper-builder.html  (workspace %s)' % (ARGS.port, ARGS.workspace))
    ThreadingHTTPServer(('127.0.0.1', ARGS.port), Handler).serve_forever()
