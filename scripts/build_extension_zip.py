#!/usr/bin/env python3
"""Build the public McGhee Lab Capture extension zip (V3.858).

The Library page's "↓ Download extension (.zip)" button used to point at the
dev server's /api/extension/download.zip, which mcgheelab.com (a static host)
never served — every lab member got a 403. This script bundles the unpacked
extension into a STATIC zip inside the site tree, so the ordinary deploy
(scripts/deploy.py, auto at the end of every Claude turn) ships it:

    python3 scripts/build_extension_zip.py            # build (default paths)
    python3 scripts/build_extension_zip.py --check    # exit 1 if the zip is stale

Source:  ../ResearchManagement/extension   (or --src / $MCGHEELAB_EXTENSION_DIR)
Output:  rm/downloads/mcgheelab-capture-extension.zip  → mcgheelab.com/rm/downloads/…

The zip is DETERMINISTIC (sorted entries, fixed timestamps, fixed mode), so
its sha256 — which deploy/manifest.json keys on — changes only when the
extension's content does. Entries sit under a top-level `extension/` folder,
matching the install steps ("Load unpacked → the unzipped extension/ folder").

Never shipped, even if they live inside the source folder (same list as the
dev server route, plus the test fixtures): key.pem / any *.pem (would let the
recipient publish updates as the PI), .DS_Store, __pycache__/, .git/, test/,
node_modules/.
"""
import argparse
import hashlib
import io
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT.parent / "ResearchManagement" / "extension"
DEFAULT_OUT = ROOT / "rm" / "downloads" / "mcgheelab-capture-extension.zip"
EXCLUDE_NAMES = {"key.pem", ".DS_Store", "Thumbs.db"}
EXCLUDE_DIRS = {"__pycache__", ".git", "test", "node_modules"}
FIXED_TIME = (2020, 1, 1, 0, 0, 0)   # content-only hash


def collect(src: Path):
    files = []
    for root, dirs, names in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for n in sorted(names):
            if n in EXCLUDE_NAMES or n.endswith(".pem"):
                continue
            p = Path(root) / n
            files.append((p, "extension/" + p.relative_to(src).as_posix()))
    return files


def build(src: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p, arc in collect(src):
            zi = zipfile.ZipInfo(arc, date_time=FIXED_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o100644 & 0xFFFF) << 16
            zf.writestr(zi, p.read_bytes())
    return buf.getvalue()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", default=os.environ.get("MCGHEELAB_EXTENSION_DIR", str(DEFAULT_SRC)))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--check", action="store_true", help="exit 1 if the zip on disk differs from a fresh build")
    a = ap.parse_args(argv)
    src, out = Path(a.src).expanduser(), Path(a.out)
    if not (src / "manifest.json").is_file():
        print(f"error: no manifest.json in {src} — pass --src", file=sys.stderr)
        return 2
    version = json.loads((src / "manifest.json").read_text("utf-8")).get("version", "?")
    data = build(src)
    sha = hashlib.sha256(data).hexdigest()[:12]
    n = len(collect(src))
    if a.check:
        if out.is_file() and out.read_bytes() == data:
            print(f"up to date: {out.relative_to(ROOT)} (extension {version}, {n} files, sha {sha})")
            return 0
        print(f"STALE: {out.relative_to(ROOT)} does not match {src} (extension {version}) — run scripts/build_extension_zip.py", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.is_file() and out.read_bytes() == data:
        print(f"unchanged: {out.relative_to(ROOT)} (extension {version}, {n} files, {len(data):,} bytes, sha {sha})")
        return 0
    out.write_bytes(data)
    print(f"wrote {out.relative_to(ROOT)} (extension {version}, {n} files, {len(data):,} bytes, sha {sha})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
