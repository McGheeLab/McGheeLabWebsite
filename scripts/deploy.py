#!/usr/bin/env python3
"""
deploy.py — ship ONLY what changed to mcgheelab.com
===================================================

The site is deployed by FTP to GoDaddy. Dragging the whole repo (or the whole
rm/ folder) into Cyberduck re-uploads 1,000+ files when a typical change
touches five, and it also uploads things that are NOT the site (CodeLog,
functions, scripts, Data, keys...). This script fixes both:

  * `deploy/site.json`     says what IS the site (an allowlist of files/folders).
  * `deploy/manifest.json` records the content hash of every file known to be
                           live (git history can't do this: the server is
                           updated from the working tree, not from commits).
  * The commands below compare the two and move only the difference.

Commands
--------
    python3 scripts/deploy.py                 # = status
    python3 scripts/deploy.py status          # what differs from the live site (no network)
    python3 scripts/deploy.py stage           # copy ONLY changed files into deploy/upload/
                                              #   → drag that folder's contents into Cyberduck
    python3 scripts/deploy.py ftp             # upload changed files directly (no Cyberduck),
                                              #   then verify. Password: Keychain → env → prompt
    python3 scripts/deploy.py verify          # after a Cyberduck drag: confirm each staged file
                                              #   is live (HTTP HEAD) and record it as deployed
    python3 scripts/deploy.py baseline        # first run / after a full manual upload: ask the
                                              #   live site which files already match
    python3 scripts/deploy.py check           # log in, list the web root over TLS, say how (V3.925);
                                              #   uploads nothing
    python3 scripts/deploy.py audit           # repo files that are NOT the site but ARE public
                                              #   on the server (keys, rosters, docs...) → delete
    python3 scripts/deploy.py touch-folders   # bubble newest file dates up to parent folders
    python3 scripts/deploy.py autodeploy      # Claude Code Stop hook (V3.818): if site files changed,
                                              #   syntax-gate them, upload, verify, report — no prompts

Options
-------
    --only PREFIX     limit status/stage/ftp to paths under PREFIX (repeatable), e.g. --only rm/
    --all             status: list every changed file; verify: check every site file
    --delete          ftp: also delete files that were deployed but no longer exist locally
    --yes             ftp: don't ask before uploading
    --no-open         stage: don't open deploy/upload in Finder
    --dry-run         ftp: show what would be uploaded, connect to nothing

Password for `ftp` (first match wins):
    MCGHEELAB_FTP_PASSWORD env var
    macOS Keychain — the entry Cyberduck already saved (`security find-internet-password`);
                     macOS asks you to allow access the first time
    interactive prompt

No third-party packages. Python 3.9+.
"""

import argparse
import concurrent.futures
import ftplib
import getpass
import hashlib
import json
import os
import posixpath
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEPLOY_DIR = Path(os.environ.get("DEPLOY_STATE_DIR") or (ROOT / "deploy"))
CONFIG = Path(os.environ.get("DEPLOY_SITE_JSON") or (DEPLOY_DIR / "site.json"))
MANIFEST = DEPLOY_DIR / "manifest.json"
PENDING = DEPLOY_DIR / "pending.json"
UPLOAD_DIR = DEPLOY_DIR / "upload"

HARD_SKIP = {".git", "node_modules", "__pycache__", ".firebase", ".pytest_cache"}
LAST_RESULT = {}  # filled by cmd_ftp / cmd_verify so autodeploy can summarise

sys.path.insert(0, str(ROOT / "scripts"))
try:
    import touch_folders  # noqa: E402
except Exception:  # pragma: no cover
    touch_folders = None


# ───────────────────────── config / globs ─────────────────────────

def load_dotenv():
    """scripts/.env (git-ignored): KEY=VALUE lines. Only the deploy keys are read, and the real environment wins.
    This is how a second deployer (Gabe, V3.868) keeps his own FTP login: MCGHEELAB_FTP_USER / MCGHEELAB_FTP_PASSWORD."""
    p = ROOT / "scripts" / ".env"
    if not p.exists():
        return
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k in ("MCGHEELAB_FTP_USER", "MCGHEELAB_FTP_PASSWORD", "MCGHEELAB_FTP_HOST") and v and not os.environ.get(k):
                os.environ[k] = v
    except OSError:
        pass


def load_config():
    if not CONFIG.exists():
        sys.exit(f"missing {show_path(CONFIG)} — it lists what the site is")
    cfg = json.loads(CONFIG.read_text())
    load_dotenv()
    if os.environ.get("MCGHEELAB_FTP_USER"):
        cfg["ftp"]["user"] = os.environ["MCGHEELAB_FTP_USER"]
    if os.environ.get("MCGHEELAB_FTP_HOST"):
        cfg["ftp"]["host"] = os.environ["MCGHEELAB_FTP_HOST"]
    return cfg


def glob_to_re(pat):
    i, n, out = 0, len(pat), []
    while i < n:
        c = pat[i]
        if c == "*":
            if pat.startswith("**/", i):
                out.append("(?:.*/)?"); i += 3; continue
            if pat.startswith("**", i):
                out.append(".*"); i += 2; continue
            out.append("[^/]*"); i += 1; continue
        if c == "?":
            out.append("[^/]"); i += 1; continue
        out.append(re.escape(c)); i += 1
    return re.compile("^" + "".join(out) + "$")


def has_glob(s):
    return any(ch in s for ch in "*?[")


def site_files(cfg):
    """rel path (posix) -> absolute Path, for every file that IS the site."""
    inc = [glob_to_re(p) for p in cfg["include"]]
    exc = [glob_to_re(p) for p in cfg.get("exclude", [])]
    walk_dirs, root_files = set(), False
    for p in cfg["include"]:
        seg = p.split("/")[0]
        if has_glob(seg):
            walk_dirs.add("")
        elif "/" in p or (ROOT / seg).is_dir():
            walk_dirs.add(seg)
        else:
            root_files = True
    out = {}

    def consider(rel, path):
        if any(r.match(rel) for r in inc) and not any(r.match(rel) for r in exc):
            out[rel] = path

    if root_files:
        for e in os.scandir(ROOT):
            if e.is_file(follow_symlinks=False):
                consider(e.name, Path(e.path))
    for seg in sorted(walk_dirs):
        base = ROOT / seg if seg else ROOT
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in HARD_SKIP)
            for fn in filenames:
                p = Path(dirpath) / fn
                if p.is_symlink():
                    continue
                consider(p.relative_to(ROOT).as_posix(), p)
    return dict(sorted(out.items()))


# ───────────────────────── hashing / manifest ─────────────────────────

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def local_index(files):
    idx = {}
    for rel, p in files.items():
        st = p.stat()
        idx[rel] = {"size": st.st_size, "sha256": sha256_of(p), "mtime": st.st_mtime}
    return idx


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")
    os.replace(tmp, path)


def load_manifest():
    m = load_json(MANIFEST, {"version": 1, "files": {}})
    m.setdefault("files", {})
    return m


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ───────────────────────── build stamp (V3.916) ─────────────────────────

BUILD_STAMP = "rm/build.json"


def stamp_build(changed, files, idx):
    """V3.916 — an upload that changes the site also replaces rm/build.json, sent LAST: an open RM page
    (rm/js/build-check.js) compares it with the stamp it loaded with and reloads into the new code, and it
    only sees a new stamp once every new file is on the server. Git-ignored; the manifest tracks it."""
    others = [r for r in changed if r != BUILD_STAMP]
    if not others:
        return changed
    rc, head = _git("rev-parse", "--short", "HEAD")
    m = re.search(r"CACHE_VERSION\s*=\s*(\d+)", (ROOT / "sw.js").read_text(errors="replace"))
    data = {"build": now_iso(), "head": head if rc == 0 else "", "sw": int(m.group(1)) if m else None,
            "files": len(others)}
    p = ROOT / BUILD_STAMP
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data) + "\n")
    os.replace(tmp, p)
    files[BUILD_STAMP] = p
    idx.update(local_index({BUILD_STAMP: p}))
    return others + [BUILD_STAMP]


# ───────────────────────── two deployers (V3.868) ─────────────────────────

def _git(*args, timeout=60):
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, errors="replace")
    return r.returncode, (r.stdout or "").strip()


def git_guard(cfg):
    """Why this working tree must NOT be deployed right now, or None. With two people deploying (V3.868), a tree
    that is behind origin/main would put OLDER files over someone else's newer ones; a side branch is unreviewed."""
    if subprocess.run(["git", "rev-parse", "--git-dir"], cwd=ROOT, capture_output=True).returncode != 0:
        return None
    want = cfg.get("deployBranch", "main")
    rc, branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    if rc == 0 and branch not in ("HEAD", want):
        return f"on branch {branch}, not {want} — merge to {want} first (deploy only from {want}); --any-branch overrides"
    try:
        rc, _ = _git("fetch", "--quiet", "origin", want, timeout=25)
        if rc != 0:
            return None  # offline: the guard cannot know; let the deploy proceed
    except Exception:
        return None
    rc, behind = _git("rev-list", "--count", f"HEAD..origin/{want}")
    if rc == 0 and behind not in ("", "0"):
        return (f"this computer's {want} is {behind} commit(s) behind origin/{want} — pull first "
                f"(python3 scripts/git_autopush.py does it, or git pull --rebase)")
    return None


def scientia_build_if_stale():
    """The web Scientia build is a git-ignored OUTPUT of scientia/src (V3.866). Rebuild it before hashing when a
    source is newer than it, so a merged change from Gabe reaches the site without anyone remembering."""
    script = ROOT / "scripts" / "scientia_build.py"
    src = ROOT / "scientia" / "src"
    out = ROOT / "rm" / "scientia" / "scientia.html"
    if not script.exists() or not src.is_dir():
        return ""
    newest = 0.0
    # V3.902 — plus the lab's detectors that scientia_build.py copies into scientia/vendor (VENDOR_COPY, V3.901)
    for p in list(src.rglob("*")) + [ROOT / "rm" / "scientia" / "cloud-sync.js", ROOT / "scientia" / "build.py",
                                     ROOT / "rm" / "js" / "page-layout.js", ROOT / "rm" / "js" / "page-regions.js"]:
        try:
            if p.is_file():
                newest = max(newest, p.stat().st_mtime)
        except OSError:
            pass
    if out.exists() and out.stat().st_mtime >= newest:
        return ""
    r = subprocess.run([sys.executable, str(script)], cwd=ROOT, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return "scientia build FAILED (the previous build stays): " + (r.stdout + r.stderr).strip()[-300:]
    return "rebuilt rm/scientia/scientia.html from scientia/src"


def cmd_merge_manifest(args, cfg):
    """git merge driver for deploy/manifest.json (`.gitattributes` + `scripts/merge_check.py install`): the record
    of what is live is a union — for a file both sides recorded, the newer deployedAt wins; a file one side
    dropped (deleted from the server) stays dropped. Writes the result to the `ours` path, as git expects."""
    def read(p):
        try:
            return json.loads(Path(p).read_text(encoding="utf-8"))
        except Exception:
            return None
    base, ours, theirs = read(args.base), read(args.ours), read(args.theirs)
    if ours is None or theirs is None:
        print("merge-manifest: a side is not valid JSON — leaving the conflict for a person")
        return 1
    bf, of, tf = (base or {}).get("files", {}), ours.get("files", {}), theirs.get("files", {})
    out = {}
    for rel in sorted(set(of) | set(tf)):
        o, t = of.get(rel), tf.get(rel)
        if o and t:
            out[rel] = o if (o.get("deployedAt") or "") >= (t.get("deployedAt") or "") else t
        elif o and not t:
            if rel in bf and bf[rel] == o:
                continue  # theirs removed it (deleted on the server) and ours did not change it
            out[rel] = o
        elif t and not o:
            if rel in bf and bf[rel] == t:
                continue
            out[rel] = t
    merged = dict(ours)
    merged["files"] = out
    for k, v in theirs.items():
        if k != "files" and k not in merged:
            merged[k] = v
    Path(args.ours).write_text(json.dumps(merged, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"merge-manifest: {len(out)} files recorded (ours {len(of)}, theirs {len(tf)})")
    return 0


def diff(idx, manifest_files, only=None):
    """changed = new or modified locally; removed = deployed but gone locally."""
    changed, removed = [], []
    for rel, info in idx.items():
        if only and not any(rel.startswith(o) for o in only):
            continue
        m = manifest_files.get(rel)
        if not m or m.get("sha256") != info["sha256"]:
            changed.append(rel)
    for rel in manifest_files:
        if only and not any(rel.startswith(o) for o in only):
            continue
        if rel not in idx:
            removed.append(rel)
    return changed, removed


def show_path(p):
    """Path for messages: repo-relative when inside the repo, absolute otherwise."""
    try:
        return str(Path(p).relative_to(ROOT))
    except ValueError:
        return str(p)


def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


def top_dir(rel):
    return rel.split("/")[0] + "/" if "/" in rel else "(root)"


def print_grouped(rels, idx=None, limit=40, header=None):
    if header:
        print(header)
    groups = {}
    for r in rels:
        groups.setdefault(top_dir(r), []).append(r)
    for g in sorted(groups):
        rs = groups[g]
        size = sum(idx[r]["size"] for r in rs) if idx else 0
        print(f"  {g:<20} {len(rs):>4} file{'s' if len(rs) != 1 else ''}" + (f"  {fmt_size(size)}" if idx else ""))
    shown = 0
    for r in rels:
        if shown >= limit:
            print(f"  … {len(rels) - shown} more (use --all to list)")
            break
        print(f"    {r}")
        shown += 1


# ───────────────────────── TLS trust ─────────────────────────

_SSL_CTX = None


def ssl_context():
    """A verifying TLS context that works on python.org macOS builds, which ship
    with NO root certificates until 'Install Certificates.command' is run.
    Order: default store + certifi → the macOS system root keychain. certifi is added even when the default store
    has roots (V3.925): Windows fills its root store lazily, so Python there can lack GoDaddy's root and refuse the
    FTP server's chain ("self-signed certificate in certificate chain")."""
    global _SSL_CTX
    if _SSL_CTX is not None:
        return _SSL_CTX
    ctx = ssl.create_default_context()
    loaded = False
    try:
        import certifi  # type: ignore
        ctx.load_verify_locations(cafile=certifi.where())
        loaded = True
    except Exception:
        pass
    if ctx.cert_store_stats().get("x509_ca", 0) == 0:
        if not loaded and sys.platform == "darwin":
            try:
                pem = subprocess.run(
                    ["security", "find-certificate", "-a", "-p",
                     "/System/Library/Keychains/SystemRootCertificates.keychain"],
                    capture_output=True, text=True, timeout=30).stdout
                if "BEGIN CERTIFICATE" in pem:
                    ctx.load_verify_locations(cadata=pem)
                    loaded = True
            except Exception:
                pass
        if not loaded:
            print("warning: no root certificates found — HTTPS checks will fail. "
                  "Run 'Install Certificates.command' from the Python folder, or `pip3 install certifi`.")
    _SSL_CTX = ctx
    return ctx


# ───────────────────────── HTTP HEAD against the live site ─────────────────────────

def head(base_url, rel, timeout=25):
    url = base_url.rstrip("/") + "/" + urllib.parse.quote(rel) + "?_=" + str(int(time.time()))
    req = urllib.request.Request(url, method="HEAD", headers={
        "Cache-Control": "no-cache", "Pragma": "no-cache", "User-Agent": "mcgheelab-deploy/1"})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as r:
                cl = r.headers.get("Content-Length")
                return r.status, (int(cl) if cl is not None else -1), r.headers.get("Last-Modified")
        except urllib.error.HTTPError as e:
            return e.code, -1, None
        except Exception as e:
            if attempt == 2:
                return 0, -1, str(e)
            time.sleep(0.5)


def head_many(base_url, rels, workers=12, label="checking"):
    results, total, done = {}, len(rels), 0
    if not rels:
        return results
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(head, base_url, r): r for r in rels}
        for f in concurrent.futures.as_completed(futs):
            results[futs[f]] = f.result()
            done += 1
            if sys.stdout.isatty() and (done % 25 == 0 or done == total):
                print(f"\r  {label} {done}/{total}", end="", flush=True)
    if sys.stdout.isatty():
        print()
    return results


# ───────────────────────── commands ─────────────────────────

def cmd_status(args, cfg):
    files = site_files(cfg)
    idx = local_index(files)
    man = load_manifest()
    changed, removed = diff(idx, man["files"], args.only)
    pending = load_json(PENDING, None)
    total_size = sum(i["size"] for i in idx.values())
    print(f"Site: {len(idx)} files, {fmt_size(total_size)}   "
          f"recorded as live: {len(man['files'])}   "
          f"changed/new: {len(changed)} ({fmt_size(sum(idx[r]['size'] for r in changed))})   "
          f"removed locally: {len(removed)}")
    if not man["files"]:
        print("\nNo deploy/manifest.json yet — run `python3 scripts/deploy.py baseline` once "
              "(read-only: asks the live site what already matches).")
    if changed:
        print_grouped(changed, idx, limit=(10 ** 6 if args.all else 40), header="\nTo upload:")
    else:
        print("\nNothing to upload — the live site matches the repo.")
    if removed:
        print_grouped(removed, limit=20, header="\nDeployed earlier but gone from the repo (delete on the server):")
    if pending:
        n = len(pending.get("files", {}))
        print(f"\nA stage from {pending.get('stagedAt')} is waiting for `verify` ({n} files). "
              f"Run `python3 scripts/deploy.py verify` after the Cyberduck drag.")
    return 0


def _write_pending(idx, changed, removed, how):
    save_json(PENDING, {
        "stagedAt": now_iso(), "how": how,
        "files": {r: {"size": idx[r]["size"], "sha256": idx[r]["sha256"]} for r in changed},
        "removed": sorted(removed),
    })


def cmd_stage(args, cfg):
    files = site_files(cfg)
    idx = local_index(files)
    man = load_manifest()
    changed, removed = diff(idx, man["files"], args.only)
    if not man["files"]:
        print("No manifest yet — run `baseline` first, or everything would be staged.")
        return 2
    if not changed and not removed:
        print("Nothing to stage — the live site matches the repo.")
        return 0
    changed = stamp_build(changed, files, idx)   # V3.916
    if UPLOAD_DIR.exists():
        shutil.rmtree(UPLOAD_DIR)
    UPLOAD_DIR.mkdir(parents=True)
    for rel in changed:
        dst = UPLOAD_DIR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(files[rel], dst)
    _write_pending(idx, changed, removed, "stage")
    if touch_folders:
        touch_folders.bubble_tree(str(UPLOAD_DIR))
        touch_folders.bubble_configured()
    print_grouped(changed, idx, limit=(10 ** 6 if args.all else 60),
                  header=f"Staged {len(changed)} files ({fmt_size(sum(idx[r]['size'] for r in changed))}) "
                         f"into {show_path(UPLOAD_DIR)}/ :")
    if removed:
        print_grouped(removed, limit=20, header="\nAlso delete these on the server (they no longer exist locally):")
    print("\nNext:")
    print("  1. In Cyberduck, open the site root (/).")
    print(f"  2. Open {show_path(UPLOAD_DIR)}/ in Finder, select all (⌘A), drag into the Cyberduck window.")
    print("     Choose “Overwrite” when it asks (folders merge; only these files are touched).")
    print("  3. python3 scripts/deploy.py verify")
    if not args.no_open and sys.stdout.isatty() and sys.platform == "darwin":
        subprocess.run(["open", str(UPLOAD_DIR)], check=False)
    return 0


def _verify_set(cfg, targets, removed, via, man, uploaded=False):
    """targets: rel -> {size, sha256}. Returns (ok, bad, still_there). `uploaded`: the targets were just sent
    (a pending stage/ftp), so a protected file's 403 can stand for "it's there"."""
    base = cfg["baseUrl"]
    res = head_many(base, list(targets), label="verifying")
    ok, bad = [], []
    for rel, (status, size, extra) in res.items():
        # V3.902 — Apache answers 403 for every .ht* file by design, so l/.htaccess and rm/.htaccess could never verify
        # and were re-uploaded and reported on every deploy. Their effect is checked by the headers they set instead.
        hidden = uploaded and status == 403 and rel.rsplit("/", 1)[-1].startswith(".ht")
        if (status == 200 and size == targets[rel]["size"]) or hidden:
            ok.append(rel)
            man["files"][rel] = {"sha256": targets[rel]["sha256"], "size": size,
                                 "deployedAt": now_iso(), "via": via}
        else:
            bad.append((rel, status, size, targets[rel]["size"]))
            man["files"].pop(rel, None)  # not live after all → status/stage pick it up again
    still_there = []
    if removed:
        rres = head_many(base, list(removed), label="checking removed")
        for rel, (status, _s, _e) in rres.items():
            if status in (404, 410):
                man["files"].pop(rel, None)
            else:
                still_there.append((rel, status))
    return ok, bad, still_there


def cmd_verify(args, cfg):
    man = load_manifest()
    pending = load_json(PENDING, None)
    if args.all or not pending:
        if not args.all:
            print("Nothing is pending. Checking EVERY site file against the live server instead (--all).")
        files = site_files(cfg)
        idx = local_index(files)
        targets = {r: {"size": i["size"], "sha256": i["sha256"]} for r, i in idx.items()
                   if not args.only or any(r.startswith(o) for o in args.only)}
        removed = [r for r in man["files"] if r not in idx]
        via = "verify-all"
    else:
        targets = pending["files"]
        removed = pending.get("removed", [])
        via = "verify"
    ok, bad, still_there = _verify_set(cfg, targets, removed, via, man, uploaded=(via == "verify"))
    save_json(MANIFEST, man)
    LAST_RESULT["verify"] = {"ok": ok, "bad": [b[0] for b in bad], "still_there": [t[0] for t in still_there]}
    print(f"Live and recorded: {len(ok)}")
    if bad:
        print(f"\nNOT live yet ({len(bad)}):")
        for rel, status, size, want in sorted(bad):
            why = ("missing on server (404)" if status == 404 else
                   f"size differs (server {size}, local {want})" if status == 200 else
                   f"HTTP {status}")
            print(f"  {rel}   — {why}")
    if still_there:
        print(f"\nStill on the server but gone from the repo ({len(still_there)}) — delete in Cyberduck:")
        for rel, status in sorted(still_there):
            print(f"  {rel}")
    if pending and not args.all:
        if bad or still_there:
            pending["files"] = {r: targets[r] for r, *_ in bad}
            pending["removed"] = [r for r, _ in still_there]
            save_json(PENDING, pending)
            print("\nThe unverified files stay pending; run verify again after uploading them.")
        else:
            PENDING.unlink(missing_ok=True)
            if UPLOAD_DIR.exists():
                shutil.rmtree(UPLOAD_DIR)
            print("\nAll staged files are live. Pending cleared.")
    return 1 if bad else 0


def cmd_baseline(args, cfg):
    files = site_files(cfg)
    idx = local_index(files)
    man = load_manifest()
    print(f"Asking {cfg['baseUrl']} about {len(idx)} site files (HEAD only, nothing is changed)…")
    res = head_many(cfg["baseUrl"], list(idx), label="probing")
    matched, differs, missing, errors = [], [], [], []
    for rel, (status, size, extra) in res.items():
        if status == 200 and size == idx[rel]["size"]:
            matched.append(rel)
            man["files"][rel] = {"sha256": idx[rel]["sha256"], "size": size,
                                 "deployedAt": now_iso(), "via": "baseline"}
        elif status == 200:
            differs.append((rel, size, idx[rel]["size"]))
            man["files"].pop(rel, None)
        elif status == 404:
            missing.append(rel)
            man["files"].pop(rel, None)
        else:
            errors.append((rel, status, extra))
    man["baselineAt"] = now_iso()
    save_json(MANIFEST, man)
    print(f"\nSame size on server (recorded as live): {len(matched)}")
    if differs:
        print(f"\nOn the server but a DIFFERENT size (needs upload): {len(differs)}")
        for rel, s, l in sorted(differs)[:60]:
            print(f"  {rel}   (server {s}, local {l})")
        if len(differs) > 60:
            print(f"  … {len(differs) - 60} more")
    if missing:
        print_grouped(sorted(missing), idx, limit=60, header=f"\nNot on the server at all (needs upload): {len(missing)}")
    if errors:
        print(f"\nCould not check ({len(errors)}):")
        for rel, status, extra in sorted(errors)[:20]:
            print(f"  {rel}   HTTP {status} {extra or ''}")
    print(f"\nWrote {show_path(MANIFEST)}. Now `status` / `stage` / `ftp` know what to send.")
    return 0


SENSITIVE_HINTS = ("service-account", ".p8", ".env", "students", "roster", "LOR", "slack backup",
                   "CV.pdf", "AuthKey", "checkpoint", "password", "secret", ".duck", "RPT_AD_")


def cmd_audit(args, cfg):
    site = site_files(cfg)
    skip = set(HARD_SKIP) | set(cfg.get("auditSkip", []))
    others = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel_dir = Path(dirpath).relative_to(ROOT).as_posix()
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        for fn in filenames:
            if fn in (".DS_Store", "Thumbs.db"):
                continue
            rel = fn if rel_dir == "." else f"{rel_dir}/{fn}"
            if rel not in site:
                others.append(rel)
    # files the site used to ship that git says are deleted
    try:
        out = subprocess.run(["git", "ls-files", "--deleted"], cwd=ROOT, capture_output=True, text=True)
        deleted = [l.strip() for l in out.stdout.splitlines() if l.strip()]
    except Exception:
        deleted = []
    inc = [glob_to_re(p) for p in cfg["include"]]
    orphans = [d for d in deleted if any(r.match(d) for r in inc)]
    probe = sorted(set(others + orphans))
    # sensitive-looking paths are probed FIRST so a --limit never hides them
    probe.sort(key=lambda r: (not any(h.lower() in r.lower() for h in SENSITIVE_HINTS), r))
    if args.limit and len(probe) > args.limit:
        print(f"{len(probe)} candidate paths; probing the first {args.limit} (raise --limit to probe all).")
        probe = probe[:args.limit]
    print(f"Probing {cfg['baseUrl']} for {len(probe)} paths that are NOT part of the site (HEAD only)…")
    res = head_many(cfg["baseUrl"], probe, label="auditing")
    public = sorted(r for r, (s, _z, _e) in res.items() if s == 200)
    sensitive = [r for r in public if any(h.lower() in r.lower() for h in SENSITIVE_HINTS)]
    report = DEPLOY_DIR / f"audit-{datetime.now().strftime('%Y-%m-%d')}.txt"
    lines = [f"# Server audit {now_iso()} — {len(public)} non-site paths are PUBLIC on {cfg['baseUrl']}",
             "# Delete every path below from the server (Cyberduck), or run: python3 scripts/deploy.py ftp --purge-audit",
             ""]
    if sensitive:
        lines += ["## SENSITIVE — delete first, then rotate the credential / notify as required"] + sensitive + [""]
    lines += ["## All public non-site paths"] + public
    report.write_text("\n".join(lines) + "\n")
    print(f"\nPUBLIC non-site paths: {len(public)}   (written to {show_path(report)})")
    if sensitive:
        print(f"\n!! SENSITIVE ({len(sensitive)}):")
        for r in sensitive:
            print(f"  {r}")
    groups = {}
    for r in public:
        groups.setdefault(top_dir(r), []).append(r)
    print("\nBy folder:")
    for g in sorted(groups):
        print(f"  {g:<22} {len(groups[g])}")
    orphan_live = [r for r in orphans if r in public]
    if orphan_live:
        print(f"\nOld site files still live ({len(orphan_live)}): " + ", ".join(orphan_live))
    return 0


# ───────────────────────── FTP ─────────────────────────

class _ReusedSslSocket(ssl.SSLSocket):
    def unwrap(self):  # some servers close the data channel before TLS shutdown
        pass


class FTPS(ftplib.FTP_TLS):
    """FTP over explicit TLS that re-uses the control-channel TLS session on data
    connections (pure-ftpd / vsftpd / ProFTPD require it: '522 session reuse required')."""

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
            conn.__class__ = _ReusedSslSocket
        return conn, size


def get_password(cfg, args):
    env = os.environ.get("MCGHEELAB_FTP_PASSWORD")
    if env:
        return env, "env"
    f = cfg["ftp"]
    if sys.platform == "darwin" and not args.no_keychain:
        # FTPS entry first (V3.925): deploys are TLS only, and an older plain-"ftp " entry Cyberduck saved for the
        # same login can hold a stale password (it did after the 2026-10-26 password change)
        for extra in (["-r", "ftps"], ["-r", "ftp "], []):
            try:
                out = subprocess.run(
                    ["security", "find-internet-password", "-s", f["host"], "-a", f["user"], *extra, "-w"],
                    capture_output=True, text=True, timeout=120)
                if out.returncode == 0 and out.stdout.strip():
                    return out.stdout.strip(), "keychain"
            except Exception:
                pass
    if not sys.stdin.isatty():
        raise RuntimeError("no FTP password: allow Keychain access for `security` (click Always Allow), "
                           "or set MCGHEELAB_FTP_PASSWORD")
    pw = getpass.getpass(f"FTP password for {f['user']}@{f['host']}: ")
    return pw, "prompt"


def tls_host(f):
    """The name to open the TLS connection by (V3.925). GoDaddy's FTP certificate is for *.prod.phx3.secureserver.net,
    never mcgheelab.com, so it verifies only when we connect by the server's own name: `ftp.tlsHost` (cPanel → Server
    Information → Server Name). That name must still be the machine `host` points at; after a server move this fails
    by name instead of logging in somewhere else."""
    th = f.get("tlsHost")
    if not th or th == f["host"]:
        return f["host"]
    a, b = socket.gethostbyname(th), socket.gethostbyname(f["host"])
    if a != b:
        raise RuntimeError(f"ftp.tlsHost {th} is {a} but {f['host']} is {b}: the site has moved servers. Set tlsHost in "
                           f"deploy/site.json to the new Server Name (cPanel → Server Information)")
    return th


def ftp_connect(cfg, password):
    f = cfg["ftp"]
    host, port, user = f["host"], int(f.get("port", 21)), f["user"]
    mode = f.get("tls", "auto")
    if mode in ("auto", "always"):
        try:
            c = FTPS(timeout=40, context=ssl_context())
            c.connect(tls_host(f), port)
            c.auth()
            c.login(user, password)
            c.prot_p()
            c.set_pasv(True)
            return c, "FTPS (explicit TLS)"
        except Exception as e:
            # TLS worked and the password did not: say so, and never retry that password over plain FTP
            if isinstance(e, ftplib.error_perm) and str(e).startswith("530"):
                raise RuntimeError(f"login refused for {user} ({e}): the saved password is wrong or out of date "
                                   "(macOS Keychain, MCGHEELAB_FTP_PASSWORD or scripts/.env)") from e
            if mode == "always":  # never fall back: plain FTP sends the password in the clear
                why = f"{e.__class__.__name__}: {e}"
                if "local issuer" in why or "self-signed" in why:
                    why += " (this computer does not trust GoDaddy's root: python3 -m pip install certifi)"
                raise RuntimeError("TLS failed and plain FTP is off (ftp.tls = always): " + why) from e
            print(f"  TLS not available ({e.__class__.__name__}: {e}) — using plain FTP.")
    c = ftplib.FTP(timeout=40)
    c.connect(host, port)
    c.login(user, password)
    c.set_pasv(True)
    return c, "plain FTP"


def ftp_ensure_dir(conn, remote_dir, known):
    remote_dir = remote_dir.rstrip("/") or "/"
    if remote_dir in known or remote_dir == "/":
        return
    ftp_ensure_dir(conn, posixpath.dirname(remote_dir), known)
    try:
        conn.mkd(remote_dir)
    except ftplib.error_perm as e:
        if not str(e).startswith("550"):
            raise
    known.add(remote_dir)


def cmd_ftp(args, cfg):
    if not getattr(args, "any_branch", False) and not args.dry_run:
        why = git_guard(cfg)
        if why:
            print(f"Not deploying: {why}")
            return 2
    note = scientia_build_if_stale()
    if note:
        print("  " + note)
    files = site_files(cfg)
    idx = local_index(files)
    man = load_manifest()
    if not man["files"] and not args.force_all:
        print("No manifest yet — run `baseline` first (or --force-all to upload the entire site).")
        return 2
    pending = load_json(PENDING, None)
    if pending and not args.only and pending.get("how") == "stage":
        changed = [r for r in pending["files"] if r in idx]
        removed = pending.get("removed", [])
        print(f"Using the pending stage from {pending['stagedAt']}.")
    else:
        changed, removed = diff(idx, man["files"], args.only)
    if args.force_all:
        changed = list(idx)
    if changed and not args.dry_run:
        changed = stamp_build(changed, files, idx)   # V3.916 — last in the upload order
    audit_purge = []
    if args.purge_audit:
        reports = sorted(DEPLOY_DIR.glob("audit-*.txt"))
        if not reports:
            print("No deploy/audit-*.txt — run `audit` first.")
            return 2
        audit_purge = [l for l in reports[-1].read_text().splitlines() if l and not l.startswith("#")]
    if not changed and not (args.delete and removed) and not audit_purge:
        print("Nothing to upload — the live site matches the repo.")
        return 0
    root = cfg["ftp"].get("remoteRoot", "/")
    if changed:
        print_grouped(changed, idx, limit=(10 ** 6 if args.all else 60),
                      header=f"Will upload {len(changed)} files ({fmt_size(sum(idx[r]['size'] for r in changed))}) "
                             f"to {cfg['ftp']['host']}{root} (login {cfg['ftp']['user']}) :")
    if args.delete and removed:
        print_grouped(removed, limit=30, header=f"\nWill DELETE {len(removed)} files that no longer exist locally:")
    elif removed:
        print(f"\n({len(removed)} files deployed earlier are gone from the repo; add --delete to remove them.)")
    if audit_purge:
        print(f"\nWill DELETE {len(audit_purge)} non-site paths listed by the last audit.")
    if args.dry_run:
        print("\n--dry-run: nothing sent.")
        return 0
    if not args.yes and sys.stdin.isatty():
        ans = input("\nProceed? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("Cancelled.")
            return 1
    LAST_RESULT.clear()
    try:
        password, src = get_password(cfg, args)
        print(f"Connecting (password from {src})…")
        conn, how = ftp_connect(cfg, password)
    except Exception as e:
        LAST_RESULT["error"] = f"{e.__class__.__name__}: {e}"
        print(f"\nCould not connect: {LAST_RESULT['error']}")
        return 1
    print(f"  connected via {how}")
    known = set()
    sent, failed, deleted = [], [], []
    t0 = time.time()
    try:
        for i, rel in enumerate(changed, 1):
            remote = posixpath.join(root, rel)
            try:
                ftp_ensure_dir(conn, posixpath.dirname(remote), known)
                with open(files[rel], "rb") as fh:
                    conn.storbinary("STOR " + remote, fh)
                sent.append(rel)
                print(f"  [{i}/{len(changed)}] {rel}")
            except Exception as e:
                failed.append((rel, str(e)))
                print(f"  [{i}/{len(changed)}] {rel}  FAILED: {e}")
        for rel in (removed if args.delete else []) + audit_purge:
            remote = posixpath.join(root, rel)
            try:
                conn.delete(remote)
                deleted.append(rel)
                print(f"  deleted {rel}")
            except Exception as e:
                print(f"  could not delete {rel}: {e}")
    finally:
        try:
            conn.quit()
        except Exception:
            pass
    print(f"\nUploaded {len(sent)}, failed {len(failed)}, deleted {len(deleted)} in {time.time() - t0:.0f}s.")
    LAST_RESULT.update({"sent": sent, "failed": failed, "deleted": deleted, "via": how})
    if touch_folders:
        touch_folders.bubble_configured()
    rc = 0
    if sent or deleted:
        # record + verify through the same path a Cyberduck drag uses
        _write_pending(idx, sent, (removed if args.delete else []), "ftp")
        rc = cmd_verify(argparse.Namespace(all=False, only=None), cfg)
    if failed:
        print("\nFailed uploads:")
        for rel, err in failed:
            print(f"  {rel}: {err}")
        return 1
    return rc


# ───────────────────────── auto-deploy (Claude Code Stop hook, V3.818) ─────────────────────────

def gate(changed, files):
    """Cheap pre-upload checks. A broken file holds the WHOLE upload (a feature is several files)."""
    problems = []
    node = shutil.which("node")
    for rel in changed:
        p = files[rel]
        if rel.endswith((".js", ".mjs")) and node:
            r = subprocess.run([node, "--check", str(p)], capture_output=True, text=True, timeout=60)
            if r.returncode != 0 and ("outside a module" in r.stderr or "Unexpected token 'export'" in r.stderr):
                # an ES module saved as .js — re-check it as one
                import tempfile
                with tempfile.NamedTemporaryFile("wb", suffix=".mjs", delete=False) as t:
                    t.write(p.read_bytes())
                try:
                    r = subprocess.run([node, "--check", t.name], capture_output=True, text=True, timeout=60)
                finally:
                    os.unlink(t.name)
            if r.returncode != 0:
                lines = [l.strip() for l in r.stderr.splitlines() if l.strip() and not l.startswith("Node.js v")]
                err = next((l for l in lines if "Error" in l), lines[0] if lines else "syntax error")
                problems.append(f"{rel}: {err}")
        elif rel.endswith(".json"):
            try:
                json.loads(p.read_text())
            except Exception as e:
                problems.append(f"{rel}: invalid JSON ({e})")
    return problems


def sw_warning(changed):
    """Changed a precached shell file without bumping sw.js? PWA users keep the old copy."""
    try:
        block = (ROOT / "sw.js").read_text().split("SHELL_URLS")[1].split("];")[0]
        shell = {x.lstrip("/") for x in re.findall(r"'(/[^']*)'", block)} - {""}
    except Exception:
        return ""
    touched = sorted(c for c in changed if c in shell and c != "sw.js")
    if touched and "sw.js" not in changed:
        return (f" ⚠ sw.js CACHE_VERSION was not bumped although precached shell files changed "
                f"({', '.join(touched[:3])}{'…' if len(touched) > 3 else ''}) — installed-app users may keep the old copies.")
    return ""


def cmd_check(args, cfg):
    """Log in, list the remote root over the data channel, and say how (V3.925). Proves the login, TLS on the control
    AND data channel, and that the login lands on the web root. Uploads nothing."""
    f = cfg["ftp"]
    try:
        password, src = get_password(cfg, args)
        conn, how = ftp_connect(cfg, password)
    except Exception as e:
        print(f"Could not connect as {f['user']}: {e.__class__.__name__}: {e}")
        return 1
    root = f.get("remoteRoot", "/")
    try:
        names = {posixpath.basename(n.rstrip("/")) for n in conn.nlst(root)}
    finally:
        try:
            conn.quit()
        except Exception:
            conn.close()
    print(f"{f['user']} at {conn.host} via {how} (password from {src})")
    if not how.startswith("FTPS"):
        print("WARNING: the password went over plain FTP.")
    if {"index.html", "rm", "sw.js"} <= names:
        print(f"OK: {root} is the web root.")
        return 0
    print(f"WRONG FOLDER: {root} holds {sorted(names)[:20]}. The account's directory in cPanel must be the web root.")
    return 1


def cmd_autodeploy(args, cfg):
    """Stop-hook entry point: no prompts, no TTY. Everything the sub-commands print goes to
    stderr; stdout carries ONE JSON line with a systemMessage for Claude Code (or nothing)."""
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    msg = None
    try:
        if os.environ.get("MCGHEELAB_AUTODEPLOY", "1").lower() in ("0", "false", "no", "off") \
                or cfg.get("autoDeploy", True) is False:
            return 0
        build_note = scientia_build_if_stale()
        files = site_files(cfg)
        idx = local_index(files)
        man = load_manifest()
        if not man["files"]:
            msg = "auto-deploy skipped: deploy/manifest.json is empty — run `python3 scripts/deploy.py baseline`."
            return 0
        changed, removed = diff(idx, man["files"])
        if not changed:
            if build_note.startswith("scientia build FAILED"):
                msg = "auto-deploy: " + build_note
            return 0
        why = git_guard(cfg)
        if why:
            msg = f"auto-deploy HELD (nothing uploaded): {why}"
            return 0
        problems = gate(changed, files)
        if build_note:
            problems = problems if not build_note.startswith("scientia build FAILED") else problems + [build_note]
        if problems:
            msg = ("auto-deploy HELD (nothing uploaded) — fix these and it retries at the next stop:\n  "
                   + "\n  ".join(problems))
            return 0
        warn = sw_warning(changed)
        ns = argparse.Namespace(only=None, all=False, delete=False, yes=True, dry_run=args.dry_run,
                                no_keychain=False, force_all=False, purge_audit=False)
        cmd_ftp(ns, cfg)
        if args.dry_run:
            msg = f"auto-deploy dry run: would upload {len(changed)} file(s): " + ", ".join(changed[:8]) + warn
            return 0
        if LAST_RESULT.get("error"):
            msg = f"auto-deploy FAILED — nothing uploaded: {LAST_RESULT['error']}"
            return 0
        sent = LAST_RESULT.get("sent", [])
        failed = LAST_RESULT.get("failed", [])
        bad = LAST_RESULT.get("verify", {}).get("bad", [])
        names = ", ".join(sent[:6]) + ("…" if len(sent) > 6 else "")
        msg = f"Deployed {len(sent)} file(s) to mcgheelab.com via {LAST_RESULT.get('via', 'FTP')}: {names}"
        if failed:
            msg += f" — {len(failed)} FAILED: " + ", ".join(r for r, _ in failed[:5])
        if bad:
            msg += f" — {len(bad)} not verified live yet: " + ", ".join(bad[:5])
        msg += warn
        return 0
    except Exception as e:
        msg = f"auto-deploy error: {e.__class__.__name__}: {e}"
        return 0
    finally:
        sys.stdout = real_stdout
        if msg:
            print(json.dumps({"systemMessage": msg}))


def cmd_touch(args, cfg):
    if not touch_folders:
        print("scripts/touch_folders.py not found")
        return 1
    touch_folders.bubble_configured(all_dirs=args.all)
    print("Folder dates refreshed.")
    return 0


# ───────────────────────── main ─────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--only", action="append", help="limit to paths under this prefix (repeatable)")
    common.add_argument("--all", action="store_true", help="list everything / check every file")
    sub.add_parser("status", parents=[common], help="what differs from the live site (no network)")
    p = sub.add_parser("stage", parents=[common], help="copy changed files into deploy/upload/")
    p.add_argument("--no-open", action="store_true")
    p = sub.add_parser("ftp", parents=[common], help="upload changed files directly, then verify")
    p.add_argument("--delete", action="store_true", help="also delete files that no longer exist locally")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-keychain", action="store_true", help="never read the macOS Keychain")
    p.add_argument("--force-all", action="store_true", help="upload every site file regardless of the manifest")
    p.add_argument("--purge-audit", action="store_true", help="delete the paths listed by the last `audit`")
    p.add_argument("--any-branch", action="store_true", help="deploy even when not on main / behind origin (V3.868 guard)")
    p = sub.add_parser("check", parents=[common], help="log in and list the web root over TLS; uploads nothing")
    p.add_argument("--no-keychain", action="store_true", help="never read the macOS Keychain")
    p = sub.add_parser("merge-manifest", help="git merge driver for deploy/manifest.json (base ours theirs)")
    p.add_argument("base"); p.add_argument("ours"); p.add_argument("theirs")
    sub.add_parser("verify", parents=[common], help="confirm staged files are live; record them")
    sub.add_parser("baseline", parents=[common], help="record which files already match the live site")
    p = sub.add_parser("audit", parents=[common], help="non-site repo files that are public on the server")
    p.add_argument("--limit", type=int, default=4000)
    sub.add_parser("touch-folders", parents=[common], help="bubble file dates up to parent folders")
    p = sub.add_parser("autodeploy", parents=[common], help="Stop-hook: gate, upload, verify, report (no prompts)")
    p.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    if not args.cmd:
        args.cmd, args.only, args.all = "status", None, False
    cfg = load_config()
    return {
        "status": cmd_status, "stage": cmd_stage, "ftp": cmd_ftp, "verify": cmd_verify,
        "baseline": cmd_baseline, "audit": cmd_audit, "touch-folders": cmd_touch,
        "autodeploy": cmd_autodeploy, "merge-manifest": cmd_merge_manifest, "check": cmd_check,
    }[args.cmd](args, cfg)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
