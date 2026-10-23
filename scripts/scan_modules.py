#!/usr/bin/env python3
"""
scan_modules.py — Scan the modules/ directory and generate manifest.json

Walks modules/{folder}/*.html, extracts the <title> tag from each file,
and writes modules/manifest.json organized by folder.

Folder LABELS in the existing manifest are preserved (V3.656). They are
hand-curated -- "Lab Foundations", "TFM (Biomechanics 466/566)" -- and are
surfaced in the class-builder Add Module picker, the teacher "request a class"
form, and the admin approve modal. Earlier versions re-derived them from the
directory name on every run, which clobbered the curated values; that is why
the manifest was being hand-edited instead, and why modules/heat_transfer/
silently never made it into the manifest at all. Only NEW folders get an
auto-derived label now.

Usage:
    python3 scripts/scan_modules.py

Run this after adding or removing module HTML files.
"""

import html
import json
import os
import re
from pathlib import Path

MODULES_DIR = Path(__file__).resolve().parent.parent / "modules"
MANIFEST_PATH = MODULES_DIR / "manifest.json"
SKIP_FILES = {"_template.html"}
SKIP_DIRS = {"shared"}

# V3.659 — files whose name starts with "_" are instructor/private assets and
# stay OUT of manifest.json, which is world-readable and drives the public
# module pickers. This is an *unlisting* convention, not access control: the
# file is still served by the web server to anyone who knows its URL.
SKIP_PREFIX = "_"


def extract_title(html_path: Path) -> str:
    """Pull the content of the first <title> tag from an HTML file."""
    try:
        text = html_path.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        if match:
            # Clean whitespace and HTML entities. V3.770 — the unescape was
            # described here but never done: `<title>Gradients &amp;
            # Encounters</title>` was stored verbatim, so every consumer that
            # escapes the title for display (the admin catalog, the teacher
            # picker, the student class page) printed a literal "&amp;".
            # manifest.json holds TEXT; escaping is the renderer's job.
            title = match.group(1).strip()
            title = re.sub(r"\s+", " ", title)
            return html.unescape(title)
    except Exception:
        pass
    return html_path.stem.replace("_", " ").replace("-", " ").title()


def auto_label(name: str) -> str:
    """Fallback label for a folder that isn't already in the manifest."""
    if len(name) <= 8:
        return name.upper()
    return name.replace("_", " ").replace("-", " ").title()


def existing_labels() -> dict:
    """Read folder->label from the current manifest so curated labels survive."""
    try:
        prev = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        return {
            k: v["label"]
            for k, v in (prev.get("folders") or {}).items()
            if isinstance(v, dict) and v.get("label")
        }
    except Exception:
        return {}


def scan():
    folders = {}
    kept = existing_labels()
    new_folders = []

    for entry in sorted(MODULES_DIR.iterdir()):
        if not entry.is_dir() or entry.name in SKIP_DIRS or entry.name.startswith("."):
            continue

        html_files = sorted(entry.glob("*.html"))
        html_files = [f for f in html_files
                      if f.name not in SKIP_FILES and not f.name.startswith(SKIP_PREFIX)]

        if not html_files:
            continue

        files = []
        for html_file in html_files:
            title = extract_title(html_file)
            files.append({
                "name": html_file.name,
                "title": title,
            })

        if entry.name not in kept:
            new_folders.append(entry.name)
        folders[entry.name] = {
            "label": kept.get(entry.name) or auto_label(entry.name),
            "files": files,
        }

    manifest = {
        "folders": folders,
        "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    total = sum(len(f["files"]) for f in folders.values())
    print(f"Wrote {MANIFEST_PATH.name}: {len(folders)} folder(s), {total} file(s)")
    if new_folders:
        for name in new_folders:
            print(f"  new folder {name!r} -> label {folders[name]['label']!r} (edit manifest.json to curate)")


if __name__ == "__main__":
    scan()
