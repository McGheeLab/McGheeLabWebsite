#!/usr/bin/env python3
"""
Batch Release Push — web + Ourlab mobile, one command
=====================================================

Ships a batched release (see CLAUDE.md "Release Batching"). The pending
ledger at CodeLog/Updates/PENDING_RELEASE.md is the single input; everything
else is derived.

Why the mobile app is part of this
----------------------------------
Ourlab mobile is NOT a remote-URL wrapper — `scripts/sync-rm.mjs` bundles the
whole rm/ tree into the app at build time. So an FTP-only push reaches BROWSER
users and silently leaves APP users on the old code. Every batch release
therefore needs a matching app build, and the announcement needs to say which
build carries the changes. This script writes the mobile changelog entry from
the same ledger and cuts + uploads the TestFlight build, so the two halves
cannot drift.

What it does
------------
 1. Preflight — read pending ledger entries, web version, signing material.
 2. Diff the app's currently-bundled rm/ tree against the repo (the real
    "what is this build actually carrying" list) BEFORE syncing.
 3. Bump CURRENT_PROJECT_VERSION (both Debug + Release blocks) and pick the
    next m-vX.Y.Z (minor if native/config/plugin files changed, else patch).
 4. Write the Ourlab mobile CHANGELOG entry, generated from the ledger.
 5. npm run build (sync-rm → cap sync).
 6. Device-verification gate (standing rule: never ship app changes unrun).
 7. Archive → export → upload to TestFlight.
 8. Print the copy-paste announcement block for rm/pages/whats-new.html.
 9. Roll the ledger's pending entries into Shipped, stamped with both
    versions and the app build.

Usage
-----
    python3 scripts/release_push.py                 # full run (prompts)
    python3 scripts/release_push.py --dry-run       # show, change nothing
    python3 scripts/release_push.py --verified      # skip the device prompt
    python3 scripts/release_push.py --no-upload     # stop after export
    python3 scripts/release_push.py --web-only      # skip the app entirely
    python3 scripts/release_push.py --force         # ignore the 5-entry floor
    python3 scripts/release_push.py --version 3.610 # override web version

★ Run this from a REAL terminal, not a sandboxed tool call: codesign needs
  the login keychain and fails with errSecInternalComponent under a sandbox.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

WEB_REPO = Path(__file__).resolve().parent.parent
MOBILE_REPO = WEB_REPO.parent / "OurlabMobile"

LEDGER = WEB_REPO / "CodeLog" / "Updates" / "PENDING_RELEASE.md"
WEB_CHANGELOG = WEB_REPO / "CodeLog" / "Updates" / "CHANGELOG.md"
MOBILE_CHANGELOG = MOBILE_REPO / "CodeLog" / "Updates" / "CHANGELOG.md"
STATE_FILE = MOBILE_REPO / "CodeLog" / "Updates" / ".last-release.json"
PBXPROJ = MOBILE_REPO / "ios" / "App" / "App.xcodeproj" / "project.pbxproj"
EXPORT_PLIST = MOBILE_REPO / "ExportOptions.plist"
BUNDLED_RM = MOBILE_REPO / "ios" / "App" / "App" / "public" / "rm"

# App Store Connect API — key id is discovered from ~/.appstoreconnect;
# the issuer id is not secret (it identifies the team, not a credential).
ASC_KEY_ID = "UAZY3QKPQN"
ASC_ISSUER_ID = "81d3b81c-e248-45ff-906f-e462e1f4397c"

# A change to a HAND-AUTHORED native file means shell behavior moved → minor
# bump instead of patch. Deliberately narrow: `cap sync` and the asset
# generator rewrite hundreds of files under android/app/src/main/res/ and
# ios/.../Assets.xcassets/, and treating those as native changes would make
# every routine bundle refresh look like a native release. project.pbxproj is
# excluded on purpose — THIS script edits it to bump the build number, so
# counting it would make every release a minor bump forever.
AUTHORED_NATIVE = (
    re.compile(r"\.swift$"),
    re.compile(r"^ios/App/App/Info\.plist$"),
    re.compile(r"\.entitlements$"),
    re.compile(r"^android/app/src/main/AndroidManifest\.xml$"),
    re.compile(r"^android/app/build\.gradle$"),
    re.compile(r"^capacitor\.config\.json$"),
    re.compile(r"^package\.json$"),
    re.compile(r"^scripts/.*\.mjs$"),
    re.compile(r"^(assets|brand)/"),          # branding SOURCE, not generated output
)
DERIVED_PATHS = (
    "ios/App/App/public",                     # the bundled web tree itself
    "ios/App/App/Assets.xcassets",            # asset-generator output
    "android/app/src/main/res",               # asset-generator output
    "android/app/capacitor.build.gradle",     # cap sync output
    "android/capacitor.settings.gradle",
)

PENDING_FLOOR = 5


# ─────────────────────────── shell ───────────────────────────

def run(cmd, cwd=None, check=True, capture=True, dry_run=False, echo=True):
    if dry_run:
        print(f"  [DRY RUN] {cmd}")
        return ""
    if echo and not capture:
        print(f"  $ {cmd}")
    r = subprocess.run(cmd, shell=True, cwd=cwd, text=True,
                       capture_output=capture)
    if check and r.returncode != 0:
        print(f"\nERROR: command failed: {cmd}")
        if r.stderr:
            print(r.stderr.strip()[:4000])
        sys.exit(1)
    return (r.stdout or "").strip()


def die(msg):
    print(f"\nERROR: {msg}")
    sys.exit(1)


def step(n, title):
    print(f"\n{'─' * 66}\n{n}. {title}\n{'─' * 66}")


# ─────────────────────── ledger + versions ───────────────────────

LEDGER_ITEM = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+(.*)$")


def read_ledger():
    """Return (pending_lines, raw_pending_block). Multi-line entries are joined."""
    if not LEDGER.exists():
        die(f"no ledger at {LEDGER}")
    text = LEDGER.read_text()
    m = re.search(r"^## Pending.*?$(.*?)^## Shipped", text,
                  re.MULTILINE | re.DOTALL)
    if not m:
        die("ledger is missing its '## Pending' / '## Shipped' sections")
    block = m.group(1)
    entries, cur = [], None
    for line in block.splitlines():
        if not line.strip():
            continue
        hit = LEDGER_ITEM.match(line)
        if hit:
            if cur:
                entries.append(cur)
            cur = hit.group(1).strip()
        elif cur is not None and line.startswith((" ", "\t")):
            cur += " " + line.strip()          # continuation of a wrapped entry
    if cur:
        entries.append(cur)
    return entries, block.strip()


def clean_entry(s):
    """Strip ledger bookkeeping the same way rm/js/whats-new.js parseChanges does."""
    s = s.replace("**", "")
    s = re.sub(r"^\[[Vv][\d.]+\]\s*", "", s)
    s = re.sub(r"\s*\*?\(\d{4}-\d{2}-\d{2}\)\*?\s*$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def entry_versions(entries):
    """Web versions referenced by the ledger entries, in order."""
    out = []
    for e in entries:
        for v in re.findall(r"\[[Vv]([\d.]+)\]", e):
            if v not in out:
                out.append(v)
    return out


def web_version_from_changelog():
    m = re.search(r"^## \[V([\d.]+)\]", WEB_CHANGELOG.read_text(), re.MULTILINE)
    return m.group(1) if m else None


def read_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def current_build():
    hits = re.findall(r"CURRENT_PROJECT_VERSION = (\d+);", PBXPROJ.read_text())
    if not hits:
        die("CURRENT_PROJECT_VERSION not found in project.pbxproj")
    return max(int(h) for h in hits)


def last_mobile_version():
    m = re.search(r"^## \[m-v([\d.]+)\]", MOBILE_CHANGELOG.read_text(),
                  re.MULTILINE)
    return m.group(1) if m else "0.0.0"


def _authored(paths):
    return sorted(p for p in paths
                  if not p.startswith(DERIVED_PATHS)
                  and any(rx.search(p) for rx in AUTHORED_NATIVE))


def native_changed(state):
    """
    Returns (decisive, advisory) lists of hand-authored native files.

    `decisive` = committed since the last shipped release → drives the minor
    bump. `advisory` = merely uncommitted in the working tree, which in THIS
    repo is not evidence of a new change: the branding assets have been dirty
    since m-v0.3 and already shipped in earlier builds. Printing them without
    acting on them is the honest split — pass --minor to override.
    """
    dirty = set()
    for line in run("git status --porcelain", cwd=MOBILE_REPO).splitlines():
        p = line[3:].strip().strip('"')
        if " -> " in p:                       # renames: take the destination
            p = p.split(" -> ")[-1]
        dirty.add(p)

    committed = set()
    sha = state.get("git_sha")
    if sha:
        out = run(f"git diff --name-only {sha} HEAD 2>/dev/null || true",
                  cwd=MOBILE_REPO)
        committed.update(p.strip() for p in out.splitlines() if p.strip())

    return _authored(committed), _authored(dirty - committed)


def next_mobile_version(minor_bump):
    major, minor, patch = (int(x) for x in (last_mobile_version().split(".") + ["0", "0"])[:3])
    if minor_bump:
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def bundled_web_diff():
    """
    Files the app is about to newly carry. Mirrors the documented manual check
    (diff -rq bundled-public/rm repo/rm) and drops pages/*.html, which differ
    by construction because sync-rm injects script tags into every page.
    """
    if not BUNDLED_RM.exists():
        return None
    out = run(f'diff -rq "{BUNDLED_RM}" "{WEB_REPO / "rm"}" 2>/dev/null || true')
    files = []
    for line in out.splitlines():
        m = re.search(r"(?:Files .*? and (\S+) differ|Only in .*?: (\S+))", line)
        name = (m.group(1) or m.group(2)) if m else None
        if not name:
            continue
        rel = name.split("/rm/")[-1]
        if rel.startswith("pages/") and rel.endswith(".html"):
            continue
        if rel.endswith((".js", ".css", ".html", ".json")):
            files.append(rel)
    return sorted(set(files))


# ─────────────────────── writers ───────────────────────

def bump_build(new_build, dry_run):
    text = PBXPROJ.read_text()
    new = re.sub(r"CURRENT_PROJECT_VERSION = \d+;",
                 f"CURRENT_PROJECT_VERSION = {new_build};", text)
    n = len(re.findall(r"CURRENT_PROJECT_VERSION = \d+;", text))
    print(f"  CURRENT_PROJECT_VERSION → {new_build} ({n} block(s))")
    if not dry_run:
        PBXPROJ.write_text(new)


def write_mobile_changelog(mv, build, web_versions, entries, carried, native_hits, dry_run):
    """Generate the mobile CHANGELOG entry from the ledger — no hand-authoring."""
    web_ref = ", ".join("V" + v for v in web_versions) or "the current rm/ tree"
    kind = ("Native + web-bundle release" if native_hits
            else "Web-bundle refresh — no native code changed")
    lines = [
        f"## [m-v{mv}] - {date.today().isoformat()}",
        "",
        f"**{kind} — TestFlight build {build} (`CURRENT_PROJECT_VERSION` {build}).**",
        f"Carries web repo {web_ref} into the app bundle via",
        "`scripts/sync-rm.mjs`. Generated by",
        "`McGheeLabWebsite/scripts/release_push.py` from that repo's",
        "`CodeLog/Updates/PENDING_RELEASE.md` — the same entries lab members",
        "received in the release announcement, so app users and browser users",
        "are told the same thing about the same code.",
        "",
        "### What lab members get",
    ]
    lines += [f"- {clean_entry(e)}" for e in entries]
    if native_hits:
        lines += ["", "### Native / shell files changed"]
        lines += [f"- `{p}`" for p in native_hits]
    if carried:
        shown = carried[:40]
        lines += ["", "### Bundled web tree — files this build newly carries",
                  "(`pages/*.html` omitted: sync-rm injects script tags into every",
                  "page, so all of them differ by construction.)"]
        lines += [f"- `rm/{p}`" for p in shown]
        if len(carried) > len(shown):
            lines.append(f"- …and {len(carried) - len(shown)} more")
    elif carried is not None:
        lines += ["", "_No bundled web-tree changes detected — the app bundle already"
                  " matched the repo._"]
    lines += [""]
    entry = "\n".join(lines)

    text = MOBILE_CHANGELOG.read_text()
    anchor = re.search(r"^## \[m-v", text, re.MULTILINE)
    new_text = (text[:anchor.start()] + entry + "\n" + text[anchor.start():]
                if anchor else text.rstrip() + "\n\n" + entry)
    print(f"  mobile CHANGELOG → m-v{mv} ({len(entries)} ledger entr"
          f"{'y' if len(entries) == 1 else 'ies'})")
    if not dry_run:
        MOBILE_CHANGELOG.write_text(new_text)
    return entry


def roll_ledger(entries, web_version, mv, build, dry_run):
    """Move pending → Shipped, stamped with both versions."""
    text = LEDGER.read_text()
    shipped = [
        f"### V{web_version} · app m-v{mv} (TestFlight build {build}) — {date.today().isoformat()}",
        "",
    ] + [f"- {clean_entry(e)}" for e in entries] + [""]
    text = re.sub(r"^## Pending.*?$(.*?)^## Shipped",
                  "## Pending (0 changes — push at 5+)\n\n"
                  "_Nothing pending — next small change starts the new batch._\n\n"
                  "## Shipped",
                  text, flags=re.MULTILINE | re.DOTALL)
    text = text.replace("## Shipped\n", "## Shipped\n\n" + "\n".join(shipped), 1)
    text = re.sub(r"\n_\(nothing shipped through this ledger yet[^\n]*\n", "\n", text)
    print(f"  ledger → {len(entries)} entr"
          f"{'y' if len(entries) == 1 else 'ies'} moved to Shipped")
    if not dry_run:
        LEDGER.write_text(text)


# ─────────────────────── build + upload ───────────────────────

def cut_testflight_build(build, dry_run, upload=True):
    work = Path(tempfile.mkdtemp(prefix="ourlab-release-"))
    archive = work / "Ourlab.xcarchive"
    export = work / "export"
    print(f"  work dir: {work}")

    print("\n  → archive (~2 min)")
    run(f'xcodebuild -project "{PBXPROJ.parent}" -scheme App '
        f'-configuration Release -destination "generic/platform=iOS" '
        f'-archivePath "{archive}" archive',
        cwd=MOBILE_REPO, dry_run=dry_run, capture=False)

    print("\n  → export ipa (~45 s)")
    run(f'xcodebuild -exportArchive -archivePath "{archive}" '
        f'-exportOptionsPlist "{EXPORT_PLIST}" -exportPath "{export}"',
        cwd=MOBILE_REPO, dry_run=dry_run, capture=False)

    ipa = export / "App.ipa"
    if not upload:
        print(f"\n  --no-upload: ipa left at {ipa}")
        print("  Upload later with Transporter.app or:")
        print(f"    xcrun altool --upload-app -f {ipa} -t ios "
              f"--apiKey {ASC_KEY_ID} --apiIssuer {ASC_ISSUER_ID}")
        return None

    print(f"\n  → upload build {build} to TestFlight")
    run(f'xcrun altool --upload-app -f "{ipa}" -t ios '
        f'--apiKey {ASC_KEY_ID} --apiIssuer {ASC_ISSUER_ID}',
        cwd=MOBILE_REPO, dry_run=dry_run, capture=False)
    shutil.rmtree(work, ignore_errors=True)
    return ipa


# ─────────────────────── announcement ───────────────────────

def print_announcement(web_version, mv, build, entries, web_only):
    print("\n" + "=" * 66)
    print("ANNOUNCEMENT — paste into mcgheelab.com/rm/pages/whats-new.html")
    print("=" * 66)
    print(f"\nVersion:   {web_version}")
    print(f"Title:     🚀 App updated — v{web_version}")
    if not web_only:
        print(f"App build: {build}        (App version: m-v{mv})")
    n = len(entries)
    print(f"\nSummary:   {n} improvement{'' if n == 1 else 's'} in this update — "
          "tap to see what changed.")
    print("\nChanges (paste the whole block; the page strips the numbering):")
    print()
    for i, e in enumerate(entries, 1):
        print(f"  {i}. {clean_entry(e)}")
    print("\n" + "=" * 66)
    print("REMAINING MANUAL STEPS")
    print("=" * 66)
    print("  1. python3 scripts/deploy.py ftp      (uploads ONLY the changed site files, then verifies)")
    print("     — or: python3 scripts/deploy.py stage → drag deploy/upload/* onto / in Cyberduck → deploy.py verify")
    print("  2. Open rm/pages/whats-new.html as admin, paste the block above,")
    print("     press 📣 Send to all lab members.")
    if not web_only:
        print(f"  3. TestFlight build {build} is processing — app users get these")
        print("     changes once they install it (the announcement names the build).")


# ─────────────────────── main ───────────────────────

def check_icons(dry_run):
    """Gate the release on the icon set being coherent (V3.641).

    `rm/js/icons.js` is GENERATED from scripts/icons.manifest.json. Nothing at
    runtime depends on the generator — the committed file is what ships — so
    this is a release gate, not a build step. It catches three things that
    otherwise reach the lab silently:

      * a stale icons.js (manifest edited, generator never re-run)
      * a call site naming an icon the manifest doesn't ship (renders a
        question-mark placeholder instead of the intended glyph)
      * icon markup routed into .textContent / esc() / a text-only attribute,
        which paints a literal "<svg viewBox=…>" on the page
      * (V3.861) a colour emoji anywhere in shipped UI (`--emoji`) — Alex wants
        monochrome icons only; V3.642 converted the chrome and ~2,000 emoji
        crept back in over 200 versions because nothing failed. Plus a stale
        or unknown-icon sprite in a course module (scripts/module_icons.py)

    Skipped, with a warning, if node or the generator isn't present — this
    must never be the thing that blocks a release on a machine without node.
    """
    gen = WEB_REPO / "scripts" / "gen-icons.mjs"
    if not gen.exists():
        print("  ! scripts/gen-icons.mjs missing — skipping the icon check")
        return
    if not shutil.which("node"):
        print("  ! node not on PATH — skipping the icon check")
        return
    if dry_run:
        print("  [DRY RUN] node scripts/gen-icons.mjs --check --scan --emoji")
        print("  [DRY RUN] python3 scripts/module_icons.py --check --all")
        return
    # subprocess directly, not run(): this needs the exit code, and run()
    # returns stdout.
    r = subprocess.run(["node", str(gen), "--check", "--scan", "--emoji"],
                       cwd=WEB_REPO, text=True, capture_output=True)
    if r.returncode != 0:
        print(((r.stdout or "") + (r.stderr or "")).strip()[:4000])
        die("icon check failed — fix the above, or run "
            "`node scripts/gen-icons.mjs` if icons.js is merely stale.")
    mod = WEB_REPO / "scripts" / "module_icons.py"
    if mod.exists():
        r = subprocess.run([sys.executable, str(mod), "--check", "--all"],
                           cwd=WEB_REPO, text=True, capture_output=True)
        if r.returncode != 0:
            print(((r.stdout or "") + (r.stderr or "")).strip()[:4000])
            die("module icon sprites are stale — run `python3 scripts/module_icons.py --all`.")
    print("  icons:           manifest, generated file, call sites and module sprites agree; no colour emoji")


def main():
    ap = argparse.ArgumentParser(description="Ship a batched web + mobile release.")
    ap.add_argument("--dry-run", action="store_true", help="show everything, change nothing")
    ap.add_argument("--verified", action="store_true", help="skip the device-verification prompt")
    ap.add_argument("--no-upload", action="store_true", help="archive + export but do not upload")
    ap.add_argument("--web-only", action="store_true", help="skip the mobile build entirely")
    ap.add_argument("--force", action="store_true", help="push with fewer than 5 pending entries")
    ap.add_argument("--version", help="web version to announce (default: CHANGELOG head)")
    ap.add_argument("--minor", action="store_true", help="force an m-vX.(Y+1).0 bump (native change)")
    ap.add_argument("--patch", action="store_true", help="force an m-vX.Y.(Z+1) bump (bundle refresh)")
    args = ap.parse_args()

    print("\n" + "=" * 66)
    print("  BATCH RELEASE PUSH" + ("  [DRY RUN]" if args.dry_run else ""))
    print("=" * 66)

    # 1 — preflight
    step(1, "Preflight")
    entries, _ = read_ledger()
    if not entries:
        die("ledger has no pending entries — nothing to release.")
    web_version = args.version or web_version_from_changelog()
    if not web_version:
        die("could not read the web version from CHANGELOG; pass --version")
    print(f"  pending entries: {len(entries)}")
    for e in entries:
        print(f"    • {clean_entry(e)[:90]}")
    print(f"  web version:     V{web_version}")
    if len(entries) < PENDING_FLOOR and not args.force:
        die(f"only {len(entries)} pending entr"
            f"{'y' if len(entries) == 1 else 'ies'} (floor is {PENDING_FLOOR}). "
            "Alex saying \"push\" overrides it — re-run with --force.")

    check_icons(args.dry_run)

    # V3.852 — the device gate (step 4) is an input() prompt. Run from Claude or
    # any non-TTY, that prompt raises EOFError AFTER step 2 has already bumped the
    # build and written the mobile changelog, leaving a half-written release that a
    # re-run would bump again. Fail here, before anything is written.
    if not args.dry_run and not args.web_only and not args.verified and not sys.stdin.isatty():
        die("no terminal for the device-verification prompt. Run from a real terminal, "
            "or verify on a device/sim first and pass --verified.")

    web_only = args.web_only
    if not web_only:
        if not MOBILE_REPO.exists():
            print(f"  ! no mobile repo at {MOBILE_REPO} — continuing web-only")
            web_only = True
        elif not EXPORT_PLIST.exists():
            print(f"  ! missing {EXPORT_PLIST} — continuing web-only")
            web_only = True

    mv = build = None
    carried = native_hits = None

    if not web_only:
        state = read_state()
        build = current_build() + 1
        native_hits, advisory = native_changed(state)
        minor_bump = bool(native_hits) or args.minor
        if args.patch:
            minor_bump = False
        mv = next_mobile_version(minor_bump)
        carried = bundled_web_diff()
        print(f"  app:             m-v{last_mobile_version()} → m-v{mv}, "
              f"build {build - 1} → {build}")
        reason = ("--minor requested" if args.minor and not native_hits
                  else "committed native changes" if native_hits
                  else "web-bundle refresh")
        print(f"  bump reason:     {'minor' if minor_bump else 'patch'} ({reason})")
        for p in native_hits[:8]:
            print(f"    native: {p}")
        if advisory:
            print(f"  ! {len(advisory)} uncommitted native/asset file(s) — NOT counted")
            print("    (chronically-dirty files in this repo already shipped in")
            print("     earlier builds; pass --minor if they are new this time)")
            for p in advisory[:5]:
                print(f"      {p}")
        if not state:
            print("  ! no .last-release.json baseline yet — this run writes it, so")
            print("    native detection gets accurate from the next release on")
        if carried is None:
            print("  ! app has no bundled tree yet (first build) — carrying everything")
        else:
            print(f"  bundle diff:     {len(carried)} web file(s) newly carried")

        # 2 — write mobile side
        step(2, "Write the mobile release (changelog + build number)")
        bump_build(build, args.dry_run)
        write_mobile_changelog(mv, build, entry_versions(entries) or [web_version],
                               entries, carried, native_hits, args.dry_run)

        # 3 — bundle
        step(3, "Bundle the web tree into the app (npm run build)")
        run("npm run build", cwd=MOBILE_REPO, dry_run=args.dry_run, capture=False)

        # 4 — verification gate
        step(4, "Device verification")
        if args.verified or args.dry_run:
            print("  --verified: skipping prompt")
        else:
            print("  Standing rule: never ship rm/ app changes to TestFlight")
            print("  without running them first (sim pass alone is not enough for")
            print("  init-path or Firebase changes).")
            ans = input("\n  Have you run this build on a device/sim? [y/N] ").strip().lower()
            if ans != "y":
                die("stopped before upload. The changelog + build bump are written; "
                    "verify, then re-run with --verified.")

        # 5 — archive/export/upload
        step(5, "Cut the TestFlight build")
        cut_testflight_build(build, args.dry_run, upload=not args.no_upload)

        if not args.dry_run and not args.no_upload:
            STATE_FILE.write_text(json.dumps({
                "mobile_version": mv,
                "build": build,
                "web_version": web_version,
                "git_sha": run("git rev-parse HEAD", cwd=MOBILE_REPO),
                "date": date.today().isoformat(),
            }, indent=2) + "\n")
            print(f"  state → {STATE_FILE.name}")

    # 6 — ledger + announcement
    step(6, "Roll the ledger")
    roll_ledger(entries, web_version, mv or "—", build or "—", args.dry_run)
    print_announcement(web_version, mv, build, entries, web_only)
    print()


if __name__ == "__main__":
    main()
