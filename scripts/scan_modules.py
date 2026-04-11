#!/usr/bin/env python3
"""
scan_modules.py — Scan the modules/ directory and generate manifest.json

Walks modules/{folder}/*.html, extracts the <title> tag from each file,
and writes modules/manifest.json organized by folder.

Usage:
    python3 scripts/scan_modules.py

Run this after adding or removing module HTML files.
"""

import json
import os
import re
from pathlib import Path

MODULES_DIR = Path(__file__).resolve().parent.parent / "modules"
MANIFEST_PATH = MODULES_DIR / "manifest.json"
SKIP_FILES = {"_template.html"}
SKIP_DIRS = {"shared"}


def extract_title(html_path: Path) -> str:
    """Pull the content of the first <title> tag from an HTML file."""
    try:
        text = html_path.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        if match:
            # Clean whitespace and HTML entities
            title = match.group(1).strip()
            title = re.sub(r"\s+", " ", title)
            return title
    except Exception:
        pass
    return html_path.stem.replace("_", " ").replace("-", " ").title()


def scan():
    folders = {}

    for entry in sorted(MODULES_DIR.iterdir()):
        if not entry.is_dir() or entry.name in SKIP_DIRS or entry.name.startswith("."):
            continue

        html_files = sorted(entry.glob("*.html"))
        html_files = [f for f in html_files if f.name not in SKIP_FILES]

        if not html_files:
            continue

        files = []
        for html_file in html_files:
            title = extract_title(html_file)
            files.append({
                "name": html_file.name,
                "title": title,
            })

        folders[entry.name] = {
            "label": entry.name.upper() if len(entry.name) <= 8 else entry.name.replace("_", " ").replace("-", " ").title(),
            "files": files,
        }

    manifest = {
        "folders": folders,
        "generated": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    total = sum(len(f["files"]) for f in folders.values())
    print(f"Wrote {MANIFEST_PATH.name}: {len(folders)} folder(s), {total} file(s)")


if __name__ == "__main__":
    scan()
