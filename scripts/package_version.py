#!/usr/bin/env python3
"""
Package Version Tool
====================

Packages the production site files into a versioned zip archive inside Versions/.

Includes only the files needed to serve the live site:
  index.html, app.js, content.json, styles.css, user-styles.css,
  user-system.js, firebase-config.js, firestore.rules, storage.rules,
  robots.txt, sitemap.xml, Images/, Videos/, poster/

Excludes development files:
  CodeLog/, Research/, scripts/, src/, .git/, .vscode/, .claude/,
  migrate-content.js, CLAUDE.md, requirements.txt, *.duck, etc.

Usage:
    python3 scripts/package_version.py                # auto-detect version from branch
    python3 scripts/package_version.py -v 2.4         # explicit version
    python3 scripts/package_version.py --dry-run      # show what would be included
    python3 scripts/package_version.py --list          # list existing packaged versions
"""

import argparse
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

# ── Files and directories to include in the package ──
INCLUDE_FILES = [
    "index.html",
    "app.js",
    "content.json",
    "styles.css",
    "user-styles.css",
    "user-system.js",
    "firebase-config.js",
    "firestore.rules",
    "storage.rules",
    "robots.txt",
    "sitemap.xml",
    ".htaccess",
]

INCLUDE_DIRS = [
    "Images",
    "Videos",
    "poster",
]

# ── Patterns to skip inside included directories ──
SKIP_PATTERNS = {".DS_Store", "Thumbs.db", ".gitkeep"}
SKIP_EXTENSIONS = {".ai", ".psd", ".duck"}


def get_repo_root() -> Path:
    """Find the repository root (where index.html lives)."""
    # Walk up from script location
    candidate = Path(__file__).resolve().parent.parent
    if (candidate / "index.html").exists():
        return candidate
    # Fallback: cwd
    if (Path.cwd() / "index.html").exists():
        return Path.cwd()
    print("ERROR: Cannot find repository root (no index.html found).")
    sys.exit(1)


def detect_version() -> str:
    """Detect version from CHANGELOG, then branch name, then CLAUDE.md."""
    root = get_repo_root()

    # Primary: latest version from CHANGELOG
    changelog = root / "CodeLog" / "Updates" / "CHANGELOG.md"
    if changelog.exists():
        m = re.search(r"##\s*\[V(\d+\.\d+)\]", changelog.read_text())
        if m:
            return m.group(1)

    # Fallback: git branch name
    try:
        branch = subprocess.run(
            "git rev-parse --abbrev-ref HEAD",
            shell=True, capture_output=True, text=True, check=True
        ).stdout.strip()
        match = re.match(r"Version-(\d+\.\d+)", branch)
        if match:
            return match.group(1)
    except subprocess.CalledProcessError:
        pass

    # Last resort: CLAUDE.md
    claude_md = root / "CLAUDE.md"
    if claude_md.exists():
        m = re.search(r"Current version:\s*V(\d+\.\d+)", claude_md.read_text())
        if m:
            return m.group(1)

    print("ERROR: Could not detect version from CHANGELOG, branch, or CLAUDE.md.")
    print("Use -v/--version to specify a version number explicitly.")
    sys.exit(1)


def should_skip(filepath: Path) -> bool:
    """Check if a file inside an included directory should be skipped."""
    if filepath.name in SKIP_PATTERNS:
        return True
    if filepath.suffix.lower() in SKIP_EXTENSIONS:
        return True
    return False


def collect_files(root: Path) -> list[tuple[Path, str]]:
    """
    Collect all files to package.
    Returns list of (absolute_path, archive_path) tuples.
    """
    files = []

    # Individual root files
    for name in INCLUDE_FILES:
        p = root / name
        if p.is_file():
            files.append((p, name))
        else:
            print(f"  WARNING: Expected file not found: {name}")

    # Directories (recursive)
    for dirname in INCLUDE_DIRS:
        dirpath = root / dirname
        if not dirpath.is_dir():
            print(f"  WARNING: Expected directory not found: {dirname}/")
            continue
        for filepath in sorted(dirpath.rglob("*")):
            if filepath.is_file() and not should_skip(filepath):
                rel = filepath.relative_to(root)
                files.append((filepath, str(rel)))

    return files


def format_size(nbytes: int) -> str:
    """Human-readable file size."""
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024:
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.1f} TB"


def list_versions(versions_dir: Path):
    """List all packaged versions."""
    if not versions_dir.is_dir():
        print("No Versions/ folder found. No packages created yet.")
        return

    zips = sorted(versions_dir.glob("*.zip"))
    if not zips:
        print("Versions/ folder is empty.")
        return

    print(f"\nPackaged versions in {versions_dir}/:\n")
    print(f"  {'Archive':<40} {'Size':>10}  {'Modified'}")
    print(f"  {'─' * 40} {'─' * 10}  {'─' * 20}")
    for z in zips:
        stat = z.stat()
        modified = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
        print(f"  {z.name:<40} {format_size(stat.st_size):>10}  {modified}")
    print(f"\n  Total: {len(zips)} version(s)")


def package(version: str, dry_run: bool = False):
    """Create the versioned zip package."""
    root = get_repo_root()
    versions_dir = root / "Versions"
    timestamp = datetime.now().strftime("%Y%m%d")
    archive_name = f"McGheeLab_V{version}_{timestamp}.zip"
    archive_path = versions_dir / archive_name

    print(f"\nPackaging McGheeLab V{version}")
    print(f"  Source:  {root}")
    print(f"  Output:  Versions/{archive_name}")
    print()

    # Collect files
    files = collect_files(root)
    if not files:
        print("ERROR: No files to package.")
        sys.exit(1)

    total_size = sum(f.stat().st_size for f, _ in files)
    print(f"  Files:   {len(files)}")
    print(f"  Size:    {format_size(total_size)} (uncompressed)")
    print()

    if dry_run:
        print("Files that would be included:\n")
        for _, arc_path in files:
            print(f"  {arc_path}")
        print(f"\n[DRY RUN] No archive created.")
        return

    # Create Versions/ directory
    versions_dir.mkdir(exist_ok=True)

    # Check for existing archive
    if archive_path.exists():
        print(f"  WARNING: {archive_name} already exists — overwriting.")

    # Build zip — files at root level so they can be extracted directly to the server
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for abs_path, arc_path in files:
            zf.write(abs_path, arc_path)

    compressed_size = archive_path.stat().st_size
    ratio = (1 - compressed_size / total_size) * 100 if total_size else 0

    print(f"  Archive: {format_size(compressed_size)} ({ratio:.0f}% compression)")
    print(f"\n  Created: Versions/{archive_name}")


def main():
    parser = argparse.ArgumentParser(
        description="Package the McGheeLab site into a versioned zip archive"
    )
    parser.add_argument(
        "-v", "--version",
        type=str,
        default=None,
        help="Version number (e.g. 2.4). Auto-detected from branch if omitted.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be packaged without creating the archive",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        dest="list_versions",
        help="List all existing packaged versions",
    )
    args = parser.parse_args()

    os.chdir(get_repo_root())

    if args.list_versions:
        list_versions(Path("Versions"))
        return

    version = args.version or detect_version()

    # Strip leading "V" or "v" if user typed it (the script adds the prefix)
    version = re.sub(r'^[Vv]', '', version)

    # Validate version format
    if not re.match(r'^\d+\.\d+$', version):
        print(f"ERROR: Invalid version '{version}'. Expected format: X.Y (e.g. 2.4)")
        sys.exit(1)

    package(version, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
