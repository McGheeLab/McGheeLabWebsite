#!/usr/bin/env python3
"""
touch_folders.py — make Finder show a folder as modified when a file inside changes
=====================================================================================

macOS only changes a folder's "Date Modified" when something is ADDED, REMOVED
or RENAMED directly inside it. Saving an existing file in place (what VS Code,
Claude's Edit tool, sed, etc. do) changes nothing, and nothing ever propagates
up to the parent folders. So `rm/js/nav.js` can be edited today while `rm/js`
shows last week and `rm` shows last month. This script raises every folder's
date to its newest descendant, never lowering anything.

Modes
-----
    python3 scripts/touch_folders.py                  # the site tree + CodeLog/functions/scripts
                                                      #   (the `touchDirs` list in deploy/site.json)
    python3 scripts/touch_folders.py --all            # the whole repo (slower, ~1-2 s)
    python3 scripts/touch_folders.py path [path ...]  # just these files/folders and their ancestors
    python3 scripts/touch_folders.py --hook           # Claude Code PostToolUse hook: reads the tool
                                                      #   JSON on stdin, bubbles the edited file's
                                                      #   ancestors (or the tree, for a Bash call)

Skips .DS_Store (Finder rewrites it constantly), .git, node_modules, __pycache__.
Exit code is always 0 — this must never block an edit or a deploy.
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "deploy" / "site.json"

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".firebase", ".pytest_cache",
             "gcloud auth login"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}

DEFAULT_TOUCH_DIRS = ["rm", "modules", "Images", "Videos", "icons", "vendor", "poster",
                      "DataIllustrations", "CodeLog", "functions", "scripts", "Data"]


def bubble_tree(d):
    """Raise every folder under `d` (and `d` itself) to its newest descendant.
    Returns the newest mtime_ns seen at or below `d`."""
    newest = 0
    try:
        it = os.scandir(d)
    except OSError:
        return 0
    with it:
        for e in it:
            try:
                if e.is_symlink():
                    continue
                if e.is_dir():
                    if e.name in SKIP_DIRS:
                        continue
                    m = bubble_tree(e.path)
                elif e.is_file():
                    if e.name in SKIP_FILES:
                        continue
                    m = e.stat().st_mtime_ns
                else:
                    continue
            except OSError:
                continue
            if m > newest:
                newest = m
    try:
        st = os.stat(d)
    except OSError:
        return newest
    if newest > st.st_mtime_ns:
        try:
            os.utime(d, ns=(st.st_atime_ns, newest))
        except OSError:
            pass
        return newest
    return st.st_mtime_ns


def raise_dir(d, t_ns):
    try:
        st = os.stat(d)
        if t_ns > st.st_mtime_ns:
            os.utime(d, ns=(st.st_atime_ns, t_ns))
    except OSError:
        pass


def bubble_path(p):
    """Bubble one file or folder up to the repo root."""
    try:
        p = Path(p).resolve()
    except OSError:
        return
    if p != ROOT and ROOT not in p.parents:
        return  # outside the repo — not ours
    if p.is_dir():
        t = bubble_tree(str(p))
    elif p.exists():
        t = p.stat().st_mtime_ns
    else:
        # deleted/renamed: the parent folder's own mtime already moved; bubble that
        t = os.stat(p.parent).st_mtime_ns if p.parent.exists() else 0
    if not t:
        return
    for anc in [p] + list(p.parents) if p.is_dir() else list(p.parents):
        if anc.is_dir():
            raise_dir(str(anc), t)
        if anc == ROOT:
            break


def touch_dirs():
    dirs = DEFAULT_TOUCH_DIRS
    try:
        cfg = json.loads(CONFIG.read_text())
        dirs = cfg.get("touchDirs") or dirs
    except Exception:
        pass
    return dirs


def bubble_configured(all_dirs=False):
    newest = 0
    if all_dirs:
        newest = bubble_tree(str(ROOT))
        return newest
    for name in touch_dirs():
        d = ROOT / name
        if d.is_dir():
            newest = max(newest, bubble_tree(str(d)))
    # root-level files count too (sw.js, index.html, ...)
    try:
        with os.scandir(ROOT) as it:
            for e in it:
                if e.is_file() and e.name not in SKIP_FILES:
                    newest = max(newest, e.stat().st_mtime_ns)
    except OSError:
        pass
    raise_dir(str(ROOT), newest)
    return newest


def hook_main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    ti = payload.get("tool_input") or {}
    fp = ti.get("file_path") or ti.get("notebook_path")
    if fp:
        bubble_path(fp)
        return
    # A Bash call (or anything without a single file): the tree pass is ~50 ms.
    # If the host reported the files it changed, prefer those.
    tr = payload.get("tool_response") or {}
    changed = []
    if isinstance(tr, dict):
        for k, v in tr.items():
            if isinstance(v, list) and "file" in k.lower() and all(isinstance(x, str) for x in v):
                changed.extend(v)
    if changed:
        for c in changed:
            bubble_path(c)
    else:
        bubble_configured()


def main(argv):
    if "--hook" in argv:
        hook_main()
        return 0
    if "--all" in argv:
        bubble_configured(all_dirs=True)
        return 0
    paths = [a for a in argv if not a.startswith("--")]
    if paths:
        for p in paths:
            bubble_path(p)
    else:
        bubble_configured()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(0)
