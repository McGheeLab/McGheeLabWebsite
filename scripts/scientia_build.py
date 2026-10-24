#!/usr/bin/env python3
"""Build Scientia from the one source tree for BOTH targets (V3.866).

    python3 scripts/scientia_build.py            # build both, report what changed
    python3 scripts/scientia_build.py --check    # build to memory, exit 1 if the files on disk are stale

  scientia/src/**  +  scientia/vendor/**  +  scientia/fonts.css
        │
        ├─ Gabe's build.py ─────────▶  scientia/scientia.html        the DESKTOP app (serve.py / launch.bat run it)
        │
        └─ + the lab layer ─────────▶  rm/scientia/scientia.html     the WEB app at mcgheelab.com/rm/scientia/
                                       rm/scientia/icons/, MANUAL.md  (copied from scientia/)

The lab layer is ONE script tag before the app's first source file: rm/scientia/cloud-sync.js (V3.857 — the
cloud hub + the notebook bridge). Its cache key is the hash of the file, so a changed shim is fetched afresh.
Both built files are build OUTPUTS (git-ignored): after `git pull`, run this script. Never edit them by hand.

V3.901: RM code the app uses is COPIED into scientia/vendor/ before Gabe's build.py runs (it inlines vendor/*.js into
both apps): rm/js/page-layout.js + page-regions.js (the figure and equation detectors behind "＋ Figure 2" / "＋ Equation 3"
on a PDF). The copies are tracked so a plain
`python3 scientia/build.py` still has it; edit the rm/ original, never the copy — --check fails when they differ.
"""
import hashlib, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scientia')
WEB = os.path.join(ROOT, 'rm', 'scientia')
DESKTOP_OUT = os.path.join(SRC, 'scientia.html')
WEB_OUT = os.path.join(WEB, 'scientia.html')
SHIM = os.path.join(WEB, 'cloud-sync.js')
LAB = os.path.join(WEB, 'lab-mode.js')
ANCHOR = re.compile(r'<script>\n/\* =+\n   01 · Util')
COPY = ['MANUAL.md', 'icons']
VENDOR_COPY = [('rm/js/page-layout.js', 'scientia/vendor/page-layout.js'),     # (the rm/ original, its copy in the app)
               ('rm/js/page-regions.js', 'scientia/vendor/page-regions.js')]


def _h(path):
    return hashlib.sha1(open(path, 'rb').read()).hexdigest()[:10]


def shim_tag():
    # V3.869: the target flag first (lab-mode.js reads it), then the cloud layer
    return "<script>window.SIS_TARGET = 'web';</script>\n<script src=\"cloud-sync.js?v=%s\"></script>\n" % _h(SHIM)


def lab_tag():
    # V3.869: the lab layer runs AFTER the app (it reshapes TABS / VIEWS before the first render)
    return '<script src="lab-mode.js?v=%s"></script>\n' % _h(LAB)


def build_desktop():
    r = subprocess.run([sys.executable, '-I', os.path.join(SRC, 'build.py')], cwd=SRC, capture_output=True, text=True)
    if r.returncode:
        print(r.stdout + r.stderr); sys.exit(1)
    return open(DESKTOP_OUT, encoding='utf-8').read()


def web_variant(desktop_html):
    if 'cloud-sync.js' in desktop_html:
        print('the desktop build already carries the lab layer — build.py or shell.html changed shape'); sys.exit(1)
    m = list(ANCHOR.finditer(desktop_html))
    if len(m) != 1:
        print('anchor found %d times (expected 1) — the app script no longer starts with 01 · Utilities; fix ANCHOR' % len(m)); sys.exit(1)
    html = desktop_html[:m[0].start()] + shim_tag() + desktop_html[m[0].start():]
    end = html.rfind('</body>')
    if end < 0:
        print('no </body> in the build — the shell changed shape; fix web_variant'); sys.exit(1)
    return html[:end] + lab_tag() + html[end:]


def same(path, text):
    return os.path.exists(path) and open(path, encoding='utf-8').read() == text


def main():
    check = '--check' in sys.argv
    for need in (SHIM, LAB):
        if not os.path.isfile(need):
            print('missing ' + os.path.relpath(need, ROOT)); sys.exit(1)
    stale = []
    for s, d in VENDOR_COPY:
        s, d = os.path.join(ROOT, s), os.path.join(ROOT, d)
        if os.path.exists(d) and open(s, 'rb').read() == open(d, 'rb').read(): continue
        stale.append(os.path.relpath(d, ROOT))
        if not check: shutil.copy2(s, d)   # before build.py, so both apps carry the current copy
    before = open(DESKTOP_OUT, encoding='utf-8').read() if os.path.exists(DESKTOP_OUT) else None
    desktop = build_desktop()
    web = web_variant(desktop)
    if before != desktop: stale.append(os.path.relpath(DESKTOP_OUT, ROOT))
    if not same(WEB_OUT, web): stale.append(os.path.relpath(WEB_OUT, ROOT))
    for name in COPY:
        s, d = os.path.join(SRC, name), os.path.join(WEB, name)
        if os.path.isdir(s):
            for f in sorted(os.listdir(s)):
                if not os.path.exists(os.path.join(d, f)) or open(os.path.join(s, f), 'rb').read() != open(os.path.join(d, f), 'rb').read(): stale.append(os.path.relpath(os.path.join(d, f), ROOT))
        elif not os.path.exists(d) or open(s, 'rb').read() != open(d, 'rb').read(): stale.append(os.path.relpath(d, ROOT))
    if check:
        if before != desktop: open(DESKTOP_OUT, 'w', encoding='utf-8').write(before if before is not None else desktop)  # --check leaves the desktop file as it was
        if stale: print('STALE (run scripts/scientia_build.py):\n  ' + '\n  '.join(stale)); sys.exit(1)
        print('scientia builds are current'); return
    os.makedirs(WEB, exist_ok=True)
    open(WEB_OUT, 'w', encoding='utf-8').write(web)
    for name in COPY:
        s, d = os.path.join(SRC, name), os.path.join(WEB, name)
        if os.path.isdir(s):
            os.makedirs(d, exist_ok=True)
            for f in os.listdir(s): shutil.copy2(os.path.join(s, f), os.path.join(d, f))
        else: shutil.copy2(s, d)
    print('desktop  %s  %.0f KB' % (os.path.relpath(DESKTOP_OUT, ROOT), len(desktop.encode()) / 1024))
    print('web      %s  %.0f KB  (+ %s)' % (os.path.relpath(WEB_OUT, ROOT), len(web.encode()) / 1024, shim_tag().strip()))
    print('changed: ' + (', '.join(stale) if stale else 'nothing'))


if __name__ == '__main__': main()
