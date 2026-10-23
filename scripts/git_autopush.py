#!/usr/bin/env python3
"""git_autopush.py — git keeps up with the site (V3.868).

The Claude Code Stop hook runs this at the end of every turn, BEFORE deploy.py autodeploy, so that what
goes live is also what is in git, and so that a change Gabe merged on GitHub reaches this computer (and
the next deploy) without anyone remembering to pull:

    commit everything the turn changed  →  fetch  →  rebase onto origin/<branch>  →  push (through the
    pre-push gate, scripts/merge_check.py)  →  rebuild Scientia if the rebase brought changes to it

Nothing here asks a question. Everything it prints goes to stderr; stdout carries ONE JSON line with a
`systemMessage` for Claude Code (the same convention as deploy.py autodeploy).

Guards (a HELD never commits the file in question; the message names it):
  * secrets and confidential files never go in: key material, service accounts, .env, payroll, transactions,
    grant documents, rosters, bundles of grants (patterns below, plus a content scan). The repo is PUBLIC.
  * files over 50 MB (GitHub refuses 100 MB; the site serves big media from Storage, not git).
  * a batch bigger than `autoPushMaxFiles` (deploy/site.json, default 80) is not a turn's work: it waits for
    `python3 scripts/git_autopush.py --batch` run by a person who looked at the list.
  * a rebase that conflicts is aborted; the commit stays local; the message says which files.

    python3 scripts/git_autopush.py            # what the hook runs (no prompts)
    python3 scripts/git_autopush.py --dry-run  # show the plan, change nothing
    python3 scripts/git_autopush.py --batch    # allow a big commit (the first push after the backlog)
    python3 scripts/git_autopush.py --status   # what would be held and why

Pause with "autoPush": false in deploy/site.json or MCGHEELAB_AUTOPUSH=0. No third-party packages; 3.9+.
"""
import fnmatch, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('AUTOPUSH_ROOT') or os.path.dirname(HERE)
SITE_JSON = os.path.join(ROOT, 'deploy', 'site.json')
CHANGELOG = os.path.join(ROOT, 'CodeLog', 'Updates', 'CHANGELOG.md')
MAX_BYTES = 50 * 1024 * 1024

HOLD_PATHS = [
    # key material and credentials
    '*.pem', '*.p8', '*.p12', '*.pfx', '*.key', '*.jks', '*.keystore', '*.ppk', 'id_rsa*', 'id_ed25519*',
    '*service-account*', '*service_account*', '*serviceaccount*', '*credential*', '*.env', '.env*', '*secret*',
    '*password*', '*.duck', '*.coreftp', 'AuthKey_*', '*firebase-adminsdk*', '*token*.json', '*token*.txt',
    # confidential lab data (the repo is public)
    'Data/payroll*', 'Data/transactions*', 'Data/*.csv', 'Data/*.xlsx', 'Data/Grants/**', 'Data/LOR*/**',
    '**/*payroll*', '**/*salary*', '**/roster*', '**/*roster*.*', '**/students.md', '**/*grades*', '**/*.paperbundle.zip',
    'slack backup*', '**/slack backup*',
]
HOLD_CONTENT = [
    (re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY'), 'private key'),
    (re.compile(r'"private_key_id"\s*:|"private_key"\s*:\s*"-----'), 'service-account JSON'),
    (re.compile(r'\b(?:sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})'), 'API token'),
    (re.compile(r'\bsck_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}'), 'Scientia sync key'),
]
TEXT_EXT = ('.js', '.mjs', '.cjs', '.py', '.json', '.md', '.txt', '.html', '.css', '.yml', '.yaml', '.toml', '.ini', '.cfg',
            '.sh', '.bat', '.rules', '.env', '.xml', '.svg', '.csv', '.tsv')


def log(*a):
    print(*a, file=sys.stderr)


def git(*args, ok=(0,), timeout=180, input=None):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, input=input, errors='replace')
    if ok is not None and r.returncode not in ok:
        raise RuntimeError('git %s → %s' % (' '.join(args[:3]), (r.stderr or r.stdout).strip()[:600]))
    return r


def cfg():
    try:
        with open(SITE_JSON, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return {}


def paused(c):
    if os.environ.get('MCGHEELAB_AUTOPUSH', '1').lower() in ('0', 'false', 'no', 'off'):
        return True
    return c.get('autoPush', True) is False


def pending_paths():
    """Paths git would commit with `add -A`: untracked, modified, deleted (renames as their two halves)."""
    out = []
    raw = git('status', '--porcelain=v1', '-z', '--untracked-files=all').stdout
    parts = raw.split('\0')
    i = 0
    while i < len(parts):
        p = parts[i]
        if not p:
            i += 1; continue
        code, path = p[:2], p[3:]
        if 'R' in code or 'C' in code:
            i += 1  # the next field is the origin path
        out.append((code, path))
        i += 1
    return out


PROSE_DIRS = ('CodeLog/',)          # plans and notes ABOUT a roster or payroll are not the roster or the payroll
TEMPLATE_SUFFIXES = ('.example', '.sample', '.template')


def held_reason(path, allow):
    for pat in allow:
        if fnmatch.fnmatchcase(path, pat) or fnmatch.fnmatchcase(os.path.basename(path), pat):
            return None
    base = os.path.basename(path)
    if path.endswith(TEMPLATE_SUFFIXES):
        return None
    for pat in HOLD_PATHS:
        if path.startswith(PROSE_DIRS) and not pat.endswith(('.pem', '.p8', '.p12', '.pfx', '.key', '.jks', '.keystore', '.ppk')):
            continue
        if fnmatch.fnmatchcase(path, pat) or fnmatch.fnmatchcase(base, pat) or (pat.startswith('**/') and fnmatch.fnmatchcase(path, pat[3:])):
            return 'matches %s' % pat
    full = os.path.join(ROOT, path)
    if not os.path.isfile(full):
        return None
    size = os.path.getsize(full)
    if size > MAX_BYTES:
        return 'too big for GitHub (%.0f MB)' % (size / 1048576)
    if size <= 5 * 1024 * 1024 and path.lower().endswith(TEXT_EXT):
        try:
            with open(full, encoding='utf-8', errors='ignore') as fh:
                text = fh.read()
            for rx, what in HOLD_CONTENT:
                if rx.search(text):
                    return 'contains a %s' % what
        except OSError:
            pass
    return None


def tracked_sensitive():
    """Already-committed files that match the hold list (so the message can say they are public)."""
    out = []
    for path in git('ls-files', '-z').stdout.split('\0'):
        if path and held_reason(path, []) and not path.startswith('node_modules'):
            r = held_reason(path, [])
            if not r.startswith('too big'):
                out.append(path)
    return out


def head_version():
    """'V3.868' and its title from the CHANGELOG head, or (None, None)."""
    try:
        with open(CHANGELOG, encoding='utf-8') as fh:
            for line in fh:
                m = re.match(r'## \[(V[\d.]+)\][^—\-]*[—\-]+\s*[\d-]+\s*[—\-]+\s*(.*)', line.strip())
                if m:
                    return m.group(1), m.group(2).strip()
                m = re.match(r'## \[(V[\d.]+)\]\s*(.*)', line.strip())
                if m:
                    return m.group(1), m.group(2).strip(' —-')
    except OSError:
        pass
    return None, None


def commit_message(n_files, held):
    ver, title = head_version()

    def clip(s, n=72):
        s = s.strip()
        return s if len(s) <= n else s[:n].rsplit(' ', 1)[0].rstrip(' ,;:—-') + '…'

    subject = clip('%s: %s' % (ver, title) if ver and title else ver or 'work in progress')
    last = git('log', '-1', '--format=%s', ok=None).stdout.strip()
    if ver and (last.startswith(ver + ':') or last.startswith(ver + ' (cont.)')):
        subject = clip('%s (cont.): %s' % (ver, title or '')).rstrip(' :')
    body = ['%d file(s) committed by scripts/git_autopush.py at the end of a turn.' % n_files]
    if held:
        body.append('Held out of git: ' + ', '.join(p for p, _ in held[:8]) + (' …' if len(held) > 8 else ''))
    if os.environ.get('CLAUDE_PROJECT_DIR') or os.environ.get('CLAUDE_CODE'):
        body.append('')
        body.append('Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')
    return subject + '\n\n' + '\n'.join(body) + '\n'


def current_branch():
    b = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.strip()
    return None if b == 'HEAD' else b


def scientia_touched(a, b):
    r = git('diff', '--name-only', a, b, '--', 'scientia/', 'rm/scientia/cloud-sync.js', ok=None)
    return bool(r.stdout.strip())


def rebuild_scientia():
    script = os.path.join(ROOT, 'scripts', 'scientia_build.py')
    if not os.path.isfile(script):
        return 'no build script'
    r = subprocess.run([sys.executable, script], cwd=ROOT, capture_output=True, text=True, timeout=180)
    return 'rebuilt scientia' if r.returncode == 0 else 'scientia build FAILED: ' + (r.stdout + r.stderr).strip()[-300:]


def ensure_hooks():
    r = git('config', '--get', 'core.hooksPath', ok=None)
    if r.stdout.strip() != '.githooks':
        mc = os.path.join(ROOT, 'scripts', 'merge_check.py')
        if os.path.isfile(mc):
            subprocess.run([sys.executable, mc, 'install'], cwd=ROOT, capture_output=True, text=True, timeout=60)


def main(argv):
    dry = '--dry-run' in argv
    batch = '--batch' in argv
    status_only = '--status' in argv
    c = cfg()
    msg = None
    try:
        if paused(c) and not status_only and not batch:
            return None
        if subprocess.run(['git', 'rev-parse', '--git-dir'], cwd=ROOT, capture_output=True).returncode != 0:
            return None
        ensure_hooks()
        branch = current_branch()
        if not branch:
            return 'git: detached HEAD — nothing pushed'
        allow = c.get('autoPushAllow', []) or []
        skip = c.get('autoPushSkip', []) or []     # left for a hand push (e.g. .github/workflows: needs a token with the workflow scope)
        limit = int(c.get('autoPushMaxFiles', 80) or 80)
        pend = pending_paths()
        held, skipped = [], []
        for code, path in pend:
            if code.strip() == 'D' or code == ' D':
                continue
            if any(fnmatch.fnmatchcase(path, pat) or (pat.endswith('/**') and path.startswith(pat[:-2])) for pat in skip):
                skipped.append(path); continue
            why = held_reason(path, allow)
            if why:
                held.append((path, why))
        held_set = {p for p, _ in held} | set(skipped)
        to_commit = [(code, p) for code, p in pend if p not in held_set]
        already = tracked_sensitive()
        notes = []
        if held:
            notes.append('held out of git (%d): ' % len(held) + '; '.join('%s (%s)' % (p, w) for p, w in held[:6]) + (' …' if len(held) > 6 else ''))
        if skipped:
            notes.append('left for a hand push (autoPushSkip): ' + ', '.join(skipped[:4]) + (' …' if len(skipped) > 4 else ''))
        if already:
            notes.append('ALREADY IN GIT HISTORY and the repo is public: ' + ', '.join(already[:6]) + ' — ask Claude for the purge steps')
        if status_only or dry:
            log('branch %s; %d change(s) to commit, %d held' % (branch, len(to_commit), len(held)))
            for p, w in held:
                log('  held  %-60s %s' % (p, w))
            for code, p in to_commit[:200]:
                log('  %s %s' % (code, p))
            log('commit message:\n' + commit_message(len(to_commit), held))
            return ('git dry run: would commit %d file(s) on %s' % (len(to_commit), branch) + ('; ' + '; '.join(notes) if notes else '')) if dry else None
        pushed_note = ''
        if to_commit:
            if len(to_commit) > limit and not batch:
                return ('git HELD: %d changed file(s) waiting on %s — more than a turn\'s work (autoPushMaxFiles=%d). '
                        'Look them over, then run once: python3 scripts/git_autopush.py --batch' % (len(to_commit), branch, limit)
                        + ('; ' + '; '.join(notes) if notes else ''))
            git('add', '-A', '--', '.')
            for p in held_set:
                git('reset', '-q', '--', p, ok=None)
            staged = git('diff', '--cached', '--name-only').stdout.strip().splitlines()
            if staged:
                git('commit', '-q', '-F', '-', input=commit_message(len(staged), held))
                pushed_note = '%d file(s) committed' % len(staged)
        # bring origin in, then push
        pulled = ''
        rebuilt = ''
        try:
            git('fetch', '--quiet', 'origin', branch, timeout=60)
            upstream = 'origin/' + branch
            if subprocess.run(['git', 'rev-parse', '--verify', '-q', upstream], cwd=ROOT, capture_output=True).returncode == 0:
                behind = git('rev-list', '--count', 'HEAD..' + upstream).stdout.strip()
                if behind != '0':
                    old = git('rev-parse', 'HEAD').stdout.strip()
                    r = git('rebase', '--autostash', upstream, ok=None, timeout=300)
                    if r.returncode != 0:
                        git('rebase', '--abort', ok=None)
                        conflicts = re.findall(r'CONFLICT \([^)]*\): [^\n]*?([^\s]+)$', r.stdout + r.stderr, re.M)
                        return ('git HELD: origin/%s has %s commit(s) that conflict with this computer\'s work%s. '
                                'The commit is kept locally; resolve by hand: git rebase origin/%s'
                                % (branch, behind, (' (' + ', '.join(sorted(set(conflicts))[:6]) + ')') if conflicts else '', branch)
                                + ('; ' + '; '.join(notes) if notes else ''))
                    authors = git('log', '--format=%an', old + '..' + upstream, ok=None).stdout.split()
                    pulled = 'pulled %s commit(s) from origin%s' % (behind, (' (' + ', '.join(sorted(set(authors))[:3]) + ')') if authors else '')
                    if scientia_touched(old, upstream):
                        rebuilt = rebuild_scientia()
        except Exception as e:
            notes.append('could not reach origin (%s) — commit kept locally' % str(e)[:120])
            return ('git: ' + (pushed_note or 'nothing to commit') + '; ' + '; '.join(notes))
        ahead = git('rev-list', '--count', 'origin/%s..HEAD' % branch, ok=None).stdout.strip() or '0'
        if ahead == '0':
            parts = [p for p in (pushed_note, pulled, rebuilt) if p] + notes
            return ('git: ' + '; '.join(parts)) if parts else None
        # the push gate, run here so its report lands in this message (the pre-push hook then skips: MERGE_CHECK_DONE)
        mc = os.path.join(ROOT, 'scripts', 'merge_check.py')
        if os.path.isfile(mc):
            base = 'origin/' + branch
            if subprocess.run(['git', 'rev-parse', '--verify', '-q', base], cwd=ROOT, capture_output=True).returncode != 0:
                base = git('rev-list', '--max-parents=0', 'HEAD').stdout.strip().splitlines()[-1]
            g = subprocess.run([sys.executable, mc, 'range', base, 'HEAD', '--no-fetch', '--target', 'origin/' + branch],
                               cwd=ROOT, capture_output=True, text=True, timeout=600, errors='replace')
            if g.returncode != 0:
                lines = [l for l in (g.stdout + g.stderr).splitlines() if l.strip()]
                return ('git HELD by the push gate (the commit is kept locally; it retries next turn):\n' + '\n'.join(lines[:40])
                        + ('\n' + '; '.join(notes) if notes else ''))
        env = dict(os.environ, MERGE_CHECK_DONE='1')
        r = subprocess.run(['git', 'push', '--quiet', '-u', 'origin', 'HEAD:' + branch], cwd=ROOT, capture_output=True,
                           text=True, timeout=300, env=env, errors='replace')
        if r.returncode != 0:
            out = (r.stderr or r.stdout).strip()
            return 'git push FAILED: ' + out[-500:] + ('; ' + '; '.join(notes) if notes else '')
        sha = git('rev-parse', '--short', 'HEAD').stdout.strip()
        subject = git('log', '-1', '--format=%s').stdout.strip()
        parts = ['pushed %s commit(s) to origin/%s (%s): %s' % (ahead, branch, sha, subject)] + [p for p in (pulled, rebuilt) if p] + notes
        return 'git: ' + '; '.join(parts)
    except Exception as e:
        return 'git autopush error: %s: %s' % (e.__class__.__name__, str(e)[:400])
    finally:
        pass


if __name__ == '__main__':
    m = main(sys.argv[1:])
    if m:
        log(m)
        print(json.dumps({'systemMessage': m}))
