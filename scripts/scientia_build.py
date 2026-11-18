#!/usr/bin/env python3
"""Build Scientia from the one source tree for BOTH targets (V3.866).

    python3 scripts/scientia_build.py            # build both, report what changed
    python3 scripts/scientia_build.py --check    # build to memory, exit 1 if the files on disk are stale

  scientia/src/**  +  scientia/vendor/**  +  scientia/fonts.css
        │
        ├─ Gabe's build.py ─────────▶  scientia/scientia.html        the DESKTOP app (serve.py / launch.bat run it)
        │
        └─ + the lab layer ─────────▶  rm/scientia/scientia.html     the WEB app at mcgheelab.com/rm/scientia/
                                       rm/scientia/icons/, demos/, MANUAL.md  (copied from scientia/)

V3.928: the desktop download — rm/scientia/desktop/ScientiaInSitu-Windows.zip (the desktop app, its server and the
lab's sync bridge, with the Windows installer) and version.json beside it. Stored, not compressed, with fixed dates, so
the same sources give the same bytes on every computer. A build output like the two apps (git-ignored, deployed).

V3.929: the DESKTOP app carries the lab layer too — rm/scientia/lab-mode.js, unchanged, inline, with the website's
target flag and window.SIS_DESKTOP, all between <!--sis-desktop--> markers (the canvas export strips them). Its RM calls
and recorder go to the app's own server (scientia/serve.py); the RM scripts it loads are copied into scientia/vendor/rm/.

The lab layer is ONE script tag before the app's first source file: rm/scientia/cloud-sync.js (V3.857 — the
cloud hub + the notebook bridge). Its cache key is the hash of the file, so a changed shim is fetched afresh.
Both built files are build OUTPUTS (git-ignored): after `git pull`, run this script. Never edit them by hand.

V3.901: RM code the app uses is COPIED into scientia/vendor/ before Gabe's build.py runs (it inlines vendor/*.js into
both apps): rm/js/page-layout.js + page-regions.js (the figure and equation detectors behind "＋ Figure 2" / "＋ Equation 3"
on a PDF). The copies are tracked so a plain
`python3 scientia/build.py` still has it; edit the rm/ original, never the copy — --check fails when they differ.

V3.937: the lab's whiteboard as a page of the app — board.html beside scientia.html in both targets (and in the desktop
download): the Lab Notebook's board page (rm/pages/notebook-board.html) with its stylesheets and scripts inlined from the
lab's files, unchanged, on scientia/board/store.js (a small Firestore of its own; the board lives in the note, 13zzd-board.js),
so the desktop has the same board offline. A build output like the two apps (git-ignored, deployed).

V3.941: the whiteboard's way of writing in the app's notes — scientia/vendor/wb-ink.js is the stroke outline of
whiteboard.js (V3.727: pressF … fillStrokeOutline), cut out by name, unchanged, as `WBINK` (tracked like the copies above;
--check fails when it differs, the build stops when a name is gone). board.html also carries scientia/board/pen.js, after
the lab's scripts: the notebook's pen on the board (Scientia's board only — the website's is untouched).

V4.20: the lab's canvas pills in a build without the lab layer — scientia/vendor/lab-pills.js is lab-mode.js's section 11
(✎ ＋ ✦ ⊕) and the helper it calls, cut out unchanged, inside LABPILLS.start(LAB) (tracked like the copies above; --check
fails when it differs, the build stops when the section or a helper is gone or the section calls another helper).
scientia/src/99z-pills.js starts it when the lab layer is absent (Gabe's own repo, a plain build.py); the lab's builds run
lab-mode.js itself.
"""
import hashlib, io, json, os, re, shutil, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scientia')
WEB = os.path.join(ROOT, 'rm', 'scientia')
DESKTOP_OUT = os.path.join(SRC, 'scientia.html')
WEB_OUT = os.path.join(WEB, 'scientia.html')
SHIM = os.path.join(WEB, 'cloud-sync.js')
LAB = os.path.join(WEB, 'lab-mode.js')
ANCHOR = re.compile(r'<script>\n/\* =+\n   01 · Util')
COPY = ['MANUAL.md', 'icons', 'demos']   # V4.12: demos/ — each feature's recording and its still (scientia/demokit/record.mjs), shown on its page in Settings
DESK_DIR = os.path.join(WEB, 'desktop')
BUNDLE = os.path.join(DESK_DIR, 'ScientiaInSitu-Windows.zip')
BUNDLE_VERSION = os.path.join(DESK_DIR, 'version.json')
BUNDLE_APP = ['serve.py', 'sisync.py', 'labsync.py', 'service.py', 'open_local.py', 'hwread.py', 'slides.py', 'sttread.py', 'winink.py',
              'rawmouse.py',   # V3.960: the mouse's own movement for the edge pan
              'webcap.py',    # V3.971: a website kept as it was
              'vendor/rm/recorder-core.js', 'vendor/rm/speech-to-text.js', 'vendor/rm/stt-device-worker.js',
              'launch.bat', 'MANUAL.md', 'diagnose-pairing.bat', 'diagnose-pairing.ps1', 'vendor/scientia_cloud.py',
              'pen-button/ScientiaPen.cs', 'pen-button/Build ScientiaPen.cmd']   # V3.949: the pen's button (the installer builds the exe)
VENDOR_COPY = [('rm/js/page-layout.js', 'scientia/vendor/page-layout.js'),     # (the rm/ original, its copy in the app)
               ('rm/js/page-regions.js', 'scientia/vendor/page-regions.js'),
               ('rm/scientia/scientia-cloud.py', 'scientia/vendor/scientia_cloud.py'),
               ('rm/js/recorder-core.js', 'scientia/vendor/rm/recorder-core.js'),        # V3.929: what lab-mode.js loads, served by serve.py
               ('rm/js/speech-to-text.js', 'scientia/vendor/rm/speech-to-text.js'),
               ('rm/js/stt-device-worker.js', 'scientia/vendor/rm/stt-device-worker.js')]   # V3.928: the bridge the app runs (labsync.py)
BOARD_PAGE = os.path.join(ROOT, 'rm', 'pages', 'notebook-board.html')
BOARD_DIR = os.path.join(SRC, 'board')
BOARD_OUTS = [os.path.join(SRC, 'board.html'), os.path.join(WEB, 'board.html')]
# what the lab's board page loads that the port leaves out: the PDF picker behind ＋ From paper (it reads the lab's library),
# the lab's sign-in, and the deploy check that reloads an RM page
BOARD_SKIP = {'/rm/vendor/pdfjs/pdf_viewer.css', '/rm/js/runtime-mode.js', '/firebase-config.js', '/rm/js/page-layout.js', '/rm/js/pdf-viewer.js'}
BOARD_V = ['']   # the built board's hash: the app opens board.html?v=<it>, so a new board is never an old cached one
WB_INK_SRC = os.path.join(ROOT, 'whiteboard.js')
WB_INK_OUT = os.path.join(SRC, 'vendor', 'wb-ink.js')
WB_INK_NAMES = ['pressF', 'crControls', 'FLATTEN_STEP_PX', 'WIDTH_SMOOTH_PX', 'JOIN_ANGLE', 'flattenStroke', 'smoothHalfWidths', 'traceOutline', 'fillStrokeOutline']
PILLS_OUT = os.path.join(SRC, 'vendor', 'lab-pills.js')
PILLS_START = '  /* ---- 11. The canvas pills in a note'   # lab-mode.js's section 11, up to the next section's head
PILLS_END = '  /* ---- 12.'
PILLS_HELPERS = ['warn']   # lab-mode's own top-level functions the section calls (the build stops when it calls another)


def lab_pills():
    """V4.20: the lab's canvas pills for a build without the lab layer (Gabe's own repo) — lab-mode.js section 11 and the
    helpers it calls, unchanged, inside a function the app starts after boot (src/99z-pills.js) with a LAB of its own."""
    src = open(LAB, encoding='utf-8').read().replace('\r\n', '\n')
    if src.count('\n' + PILLS_START) != 1:
        print('lab-pills.js: section 11 of lab-mode.js was not found once (%r) — update PILLS_START' % PILLS_START); sys.exit(1)
    a = src.index('\n' + PILLS_START) + 1
    b = src.find('\n' + PILLS_END, a)
    if b < 0:
        print('lab-pills.js: no %r after section 11 of lab-mode.js — update PILLS_END' % PILLS_END); sys.exit(1)
    sec = src[a:b + 1]
    rest = src[:a] + src[b + 1:]
    tops = {}   # lab-mode's top-level functions outside the section (two spaces in, inside its IIFE): name -> text
    lines = rest.split('\n')
    for i, ln in enumerate(lines):
        m = re.match(r'  function ([A-Za-z_$][\w$]*)\(', ln)
        if not m: continue
        depth, out = 0, []
        for ln2 in lines[i:]:
            out.append(ln2); depth += ln2.count('{') - ln2.count('}')
            if depth <= 0 and '{' in ''.join(out): break
        tops[m.group(1)] = '\n'.join(out)
    calls = [n for n in tops if re.search(r'(?<![\w$.\-])' + re.escape(n) + r'\(', sec)   # lab-mode writes a call as name( — "the pointer (…" in a comment is no call
             and not re.search(r'\bfunction ' + re.escape(n) + r'\s*\(', sec)]
    extra = [n for n in calls if n not in PILLS_HELPERS]
    if extra:
        print('lab-pills.js: section 11 now calls %s from the rest of lab-mode.js — add it to PILLS_HELPERS (or keep the section to itself)' % ', '.join(extra)); sys.exit(1)
    gone = [n for n in PILLS_HELPERS if n not in tops]
    if gone:
        print('lab-pills.js: %s is no longer a top-level function of lab-mode.js — update PILLS_HELPERS' % ', '.join(gone)); sys.exit(1)
    return ('/* GENERATED by scripts/scientia_build.py (V4.20) from rm/scientia/lab-mode.js: its section 11, the canvas pills\n'
            '   (✎ ＋ ✦ ⊕), and the helper it calls (' + ', '.join(PILLS_HELPERS) + '), unchanged, for a build without the lab layer (Gabe\'s own\n'
            '   repo). src/99z-pills.js starts it after boot with a LAB of its own; the lab\'s builds run lab-mode.js itself and\n'
            '   never start this. Edit lab-mode.js, never this file. */\n'
            'const LABPILLS = { start(LAB) {\n\'use strict\';\n' + '\n'.join(tops[n] for n in PILLS_HELPERS) + '\n' + sec + '} };\n')


def wb_ink():
    """V3.941: whiteboard.js's stroke outline for the notes' pen — its top-level declarations, by name, unchanged."""
    src = open(WB_INK_SRC, encoding='utf-8').read().replace('\r\n', '\n')
    parts = []
    for n in WB_INK_NAMES:
        m = re.search(r'^function %s\(.*?^\}[ \t]*$' % n, src, re.S | re.M) or re.search(r'^const %s\s*=[^;\n]*;' % n, src, re.M)
        if not m:
            print('wb-ink.js: %s is no longer a top-level declaration of whiteboard.js — update WB_INK_NAMES' % n); sys.exit(1)
        parts.append(m.group(0))
    return ('/* GENERATED by scripts/scientia_build.py (V3.941) from whiteboard.js: the whiteboard\'s way of writing (its V3.727\n'
            '   stroke outline), unchanged, for the pen in Scientia\'s notes (13zf INK.path). Edit whiteboard.js, never this file. */\n'
            'const WBINK = (() => {\n' + '\n'.join(parts) + '\nreturn { pressF, flattenStroke, smoothHalfWidths, traceOutline, fillStrokeOutline };\n})();\n')


PCITE_SRC = os.path.join(ROOT, 'rm', 'js', 'paper-citations.js')
PCITE_VIEWER = os.path.join(ROOT, 'rm', 'js', 'pdf-viewer.js')
PCITE_OUT = os.path.join(SRC, 'vendor', 'paper-cite.js')
PCITE_CUT = ['_resolveDest', 'extractTextItemsFromPdf']   # pdf-viewer.js: its headless reading of a PDF's words and links
PCITE_USE = ['parseRefsFromAllItems', '_matchItemsOnPage', '_filterValidated', '_matchedRef', '_linkMatchesFromAnnotations', '_pickFamily', '_familyOf']


def paper_cite():
    """V4.22: the lab's citation finder for the References Map (src/17h-refmap.js) — paper-citations.js's whole body and
    pdf-viewer.js's two headless readers, unchanged; only the wrapper (what it hands back, and the app's own open document
    for pdf.js's getDocument) is ours."""
    src = open(PCITE_SRC, encoding='utf-8').read().replace('\r\n', '\n')
    m = re.match(r'^.*?\n\(function \(\) \{\n(.*)\n\}\)\(\);\s*$', src, re.S)
    if not m:
        print('paper-cite.js: rm/js/paper-citations.js is no longer one (function () { … })(); — update paper_cite()'); sys.exit(1)
    body = m.group(1)
    for n in PCITE_USE + ['_refs', '_style']:
        if not re.search(r'^\s*(?:function|let|const|var)\s+%s\b' % re.escape(n), body, re.M):
            print('paper-cite.js: %s is no longer declared in rm/js/paper-citations.js — update PCITE_USE' % n); sys.exit(1)
    viewer = open(PCITE_VIEWER, encoding='utf-8').read().replace('\r\n', '\n')
    parts = []
    for n in PCITE_CUT:
        c = re.search(r'^async function %s\(.*?^\}[ \t]*$' % n, viewer, re.S | re.M)
        if not c:
            print('paper-cite.js: %s is no longer a top-level async function of rm/js/pdf-viewer.js — update PCITE_CUT' % n); sys.exit(1)
        parts.append(c.group(0))
    return ('/* GENERATED by scripts/scientia_build.py (V4.22) — the lab\'s citation finder, for the References Map in Scientia\'s\n'
            '   PDF readers (src/17h-refmap.js `REFMAP`): rm/js/paper-citations.js (its whole body) and rm/js/pdf-viewer.js\'s\n'
            '   _resolveDest + extractTextItemsFromPdf (cut by name), unchanged. Edit those files, never this one; --check fails\n'
            '   when they differ. Only the wrapper is ours: getDocument hands back the app\'s own open document (a thin view whose\n'
            '   destroy() does nothing), and PCITE gives the app the pieces analyzeDocument() strings together, with the places. */\n'
            'const PCITE = (() => {\n'
            'const getDocument = src => ({ promise: Promise.resolve(src && src.pdfDoc) });\n'
            + '\n'.join(parts) + '\n'
            'const CITE = (function () {\n' + body + '\n'
            'return { ' + ', '.join(PCITE_USE) + ', state(refs, style) { _refs = refs; _style = style; } };\n'
            '})();\n'
            'return Object.assign({ extract: extractTextItemsFromPdf }, CITE);\n'
            '})();\n')


def _h(path):
    return hashlib.sha1(open(path, 'rb').read()).hexdigest()[:10]


def build_board():
    """V3.937: board.html — the lab's board page with what it loads inlined (unchanged), store.js first."""
    page = open(BOARD_PAGE, encoding='utf-8').read()
    css, js = [], []
    def take(m):
        tag, kind, href = m.group(0), m.group(1), m.group(2)
        if kind == 'link' and 'stylesheet' not in tag: return tag
        if href.startswith('http') or href in BOARD_SKIP: return ''
        f = os.path.join(ROOT, *href.lstrip('/').split('?')[0].split('/'))
        if not os.path.isfile(f):
            print('board.html: %s loads %s, which is not in the repo — add it to BOARD_SKIP or fix the page' % (os.path.relpath(BOARD_PAGE, ROOT), href)); sys.exit(1)
        (css if kind == 'link' else js).append(open(f, encoding='utf-8').read())
        return ''
    page = re.sub(r'<(link)\b[^>]*\bhref="([^"]+)"[^>]*>[ \t]*\n?', take, page)
    page = re.sub(r'<(script)\b[^>]*\bsrc="([^"]+)"[^>]*>\s*</script>[ \t]*\n?', take, page)
    if page.count('</head>') != 1 or page.count('</body>') != 1:
        print('board.html: %s changed shape (one </head> and one </body> expected)' % os.path.relpath(BOARD_PAGE, ROOT)); sys.exit(1)
    own = lambda n: open(os.path.join(BOARD_DIR, n), encoding='utf-8').read()
    sc = lambda t: '<script>\n' + t.replace('</script', '<' + chr(92) + '/script') + '\n</script>\n'
    style = '<style>\n' + '\n'.join(css + [own('board.css')]).replace('</style', '<' + chr(92) + '/style') + '\n</style>\n'
    note = '<!-- Scientia (V3.937): built by scripts/scientia_build.py from rm/pages/notebook-board.html and scientia/board/; edit those, never this file -->\n'
    return page.replace('</head>', note + style + '</head>').replace('</body>', sc(own('store.js')) + ''.join(sc(t) for t in js) + sc(own('pen.js')) + '</body>')


def shim_tag():
    # V3.869: the target flag first (lab-mode.js reads it), then the cloud layer
    return "<script>window.SIS_TARGET = 'web'; window.SIS_BOARD_V = '%s';</script>\n<script src=\"cloud-sync.js?v=%s\"></script>\n" % (BOARD_V[0], _h(SHIM))


def lab_tag():
    # V3.869: the lab layer runs AFTER the app (it reshapes TABS / VIEWS before the first render)
    return '<script src="lab-mode.js?v=%s"></script>\n' % _h(LAB)


def build_desktop():
    r = subprocess.run([sys.executable, '-I', os.path.join(SRC, 'build.py')], cwd=SRC, capture_output=True, text=True)
    if r.returncode:
        print(r.stdout + r.stderr); sys.exit(1)
    return open(DESKTOP_OUT, encoding='utf-8').read()


def desktop_variant(raw):
    """Gabe's desktop build + the lab layer (V3.929): the flags before the app's first source file, lab-mode.js inline
    after the app, then the app's own hook for what the computer keeps (23d-desktoplab.js). Marked for the canvas export."""
    m = list(ANCHOR.finditer(raw))
    if len(m) != 1:
        print('anchor found %d times (expected 1) — fix ANCHOR' % len(m)); sys.exit(1)
    end = raw.rfind('</body>')
    if end < 0:
        print('no </body> in the build — the shell changed shape; fix desktop_variant'); sys.exit(1)
    flags = "<!--sis-desktop--><script>window.SIS_TARGET = 'web'; window.SIS_DESKTOP = true; window.SIS_BOARD_V = '%s';</script><!--/sis-desktop-->" % BOARD_V[0] + chr(10)
    lab = open(LAB, encoding='utf-8').read().replace('</script', '<' + chr(92) + '/script')   # a literal </script> would end the inline tag
    tail = ('<!--sis-desktop--><script>' + chr(10) + lab + chr(10) + '</script>' + chr(10)
            + '<script>window.SIS_DESKTOP_AFTER_LAB && window.SIS_DESKTOP_AFTER_LAB();</script><!--/sis-desktop-->' + chr(10))
    a, e = m[0].start(), end
    return raw[:a] + flags + raw[a:e] + tail + raw[e:]


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


def desktop_bundle(desktop_html, board_html):
    """The Windows download: Install Scientia.cmd, install.ps1, uninstall.ps1 at the top; the app in app/."""
    files = [('app/scientia.html', desktop_html.encode('utf-8')), ('app/board.html', board_html.encode('utf-8'))]
    for rel in BUNDLE_APP:
        files.append(('app/' + rel, open(os.path.join(SRC, *rel.split('/')), 'rb').read()))
    for f in sorted(os.listdir(os.path.join(SRC, 'icons'))):
        files.append(('app/icons/' + f, open(os.path.join(SRC, 'icons', f), 'rb').read()))
    for f in sorted(os.listdir(os.path.join(SRC, 'demos'))):                # V4.12: the features' recordings, so an installed computer plays them offline
        files.append(('app/demos/' + f, open(os.path.join(SRC, 'demos', f), 'rb').read()))
    app_version = hashlib.sha256(b''.join(n.encode() + b'\0' + d for n, d in sorted(files))).hexdigest()[:12]   # what the app is, before packing
    files.append(('app/VERSION.txt', (app_version + '\n').encode()))
    inst = os.path.join(SRC, 'install')
    for f in sorted(os.listdir(inst)):
        b = open(os.path.join(inst, f), 'rb').read().replace(b'\r\n', b'\n')
        if f.endswith('.ps1'): b = b'\xef\xbb\xbf' + b                       # Windows PowerShell 5.1 reads UTF-8 only with a BOM
        if f.endswith('.cmd') or f.endswith('.bat'): b = b.replace(b'\n', b'\r\n')
        files.append((f, b))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_STORED) as z:
        for name, data in sorted(files):
            zi = zipfile.ZipInfo('Scientia In Situ/' + name, date_time=(2026, 1, 1, 0, 0, 0)); zi.external_attr = 0o644 << 16
            z.writestr(zi, data)
    data = buf.getvalue()
    ver = json.dumps({'version': hashlib.sha256(data).hexdigest()[:16], 'app': app_version, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'files': len(files),
                      'download': 'ScientiaInSitu-Windows.zip'}, indent=1) + '\n'
    return data, ver


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
        if not check: os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copy2(s, d)   # before build.py, so both apps carry the current copy
    ink = wb_ink()   # V3.941: likewise before build.py
    if not same(WB_INK_OUT, ink):
        stale.append(os.path.relpath(WB_INK_OUT, ROOT))
        if not check: open(WB_INK_OUT, 'w', encoding='utf-8', newline='\n').write(ink)
    pills = lab_pills()   # V4.20: likewise before build.py
    if not same(PILLS_OUT, pills):
        stale.append(os.path.relpath(PILLS_OUT, ROOT))
        if not check: open(PILLS_OUT, 'w', encoding='utf-8', newline='\n').write(pills)
    pc = paper_cite()   # V4.22: likewise before build.py
    if not same(PCITE_OUT, pc):
        stale.append(os.path.relpath(PCITE_OUT, ROOT))
        if not check: open(PCITE_OUT, 'w', encoding='utf-8', newline='\n').write(pc)
    before = open(DESKTOP_OUT, encoding='utf-8').read() if os.path.exists(DESKTOP_OUT) else None
    board = build_board()   # V3.937: first, so both apps carry its hash
    BOARD_V[0] = hashlib.sha1(board.encode('utf-8')).hexdigest()[:10]
    stale += [os.path.relpath(p, ROOT) for p in BOARD_OUTS if not same(p, board)]
    raw = build_desktop()
    desktop = desktop_variant(raw)   # V3.929: the desktop runs the lab layer too
    web = web_variant(raw)
    if before != desktop: stale.append(os.path.relpath(DESKTOP_OUT, ROOT))
    bundle, bundle_ver = desktop_bundle(desktop, board)
    if not (os.path.exists(BUNDLE) and open(BUNDLE, 'rb').read() == bundle): stale.append(os.path.relpath(BUNDLE, ROOT))
    if not same(WEB_OUT, web): stale.append(os.path.relpath(WEB_OUT, ROOT))
    for name in COPY:
        s, d = os.path.join(SRC, name), os.path.join(WEB, name)
        if os.path.isdir(s):
            for f in sorted(os.listdir(s)):
                if not os.path.exists(os.path.join(d, f)) or open(os.path.join(s, f), 'rb').read() != open(os.path.join(d, f), 'rb').read(): stale.append(os.path.relpath(os.path.join(d, f), ROOT))
        elif not os.path.exists(d) or open(s, 'rb').read() != open(d, 'rb').read(): stale.append(os.path.relpath(d, ROOT))
    if check:
        if before is not None: open(DESKTOP_OUT, 'w', encoding='utf-8').write(before)  # --check leaves the desktop file as it was
        if stale: print('STALE (run scripts/scientia_build.py):\n  ' + '\n  '.join(stale)); sys.exit(1)
        print('scientia builds are current'); return
    os.makedirs(WEB, exist_ok=True)
    open(DESKTOP_OUT, 'w', encoding='utf-8').write(desktop)   # build.py wrote the plain app; the desktop's has the lab layer
    open(WEB_OUT, 'w', encoding='utf-8').write(web)
    for p in BOARD_OUTS: open(p, 'w', encoding='utf-8').write(board)
    os.makedirs(DESK_DIR, exist_ok=True)
    open(BUNDLE, 'wb').write(bundle); open(BUNDLE_VERSION, 'w', encoding='utf-8', newline='\n').write(bundle_ver)
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
