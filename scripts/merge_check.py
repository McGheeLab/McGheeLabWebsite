#!/usr/bin/env python3
"""merge_check.py — the push gate (V3.868): will this merge, and does it duplicate a feature we already have?

Runs from the git `pre-push` hook (.githooks/pre-push, installed by `install`), from the end-of-turn
`scripts/git_autopush.py`, and from GitHub Actions on every pull request. One report, four questions (plus one rule:
a new file name a Windows clone cannot check out — `?`, `:`, `CON`, a trailing dot, a case-only twin — is HELD):

  1. REGISTRY    CodeLog/features.json lists every feature-sized thing in RM, the site and Scientia, with the
                 files that make it. A NEW module (rm/js/*.js, rm/pages/*.html, functions/*.js, scientia/src/*.js …)
                 must be registered, and two features that look alike must say how they relate
                 (extends | merges_into | related | distinct_from). Unregistered or undeclared → HELD.
  2. OVERLAP     The identity signals a push adds — new files, tabs, stores, nav items, exported functions,
                 widget registrations, routes, UI labels, top-level objects — are tokenised and compared with every
                 OTHER feature's name, keywords and file names. A close match that no relation explains → HELD,
                 with the fix spelled out: build on the existing feature (extends), fold one into the other
                 (merges_into), or record why they are distinct. That is what "flagged to combination" means.
  3. MERGE       `git merge-tree` against origin/main: a textual conflict → HELD (rebase first).
  4. GATES       node --check on changed scripts, the Scientia build when scientia/ changed, the hub tests when the
                 hub changed, the icon/emoji gate when site files changed.

    python3 scripts/merge_check.py range <base> <head>     check the commits base..head
    python3 scripts/merge_check.py worktree                check uncommitted work against HEAD (a preview)
    python3 scripts/merge_check.py lint                    the registry alone
    python3 scripts/merge_check.py queue                   the combination queue (features folding into another)
    python3 scripts/merge_check.py install                 git config: hooksPath → .githooks, the manifest merge driver
    python3 scripts/merge_check.py pre-push <remote> <url> (git calls this; refs on stdin)
    python3 scripts/merge_check.py ci                      GitHub Actions (base = the PR base or the push's `before`)

  options: --target origin/main   --no-fetch   --no-merge   --no-gates   --json   --quiet

Exit 1 when anything is HELD. Warnings never block. No third-party packages; Python 3.9+.
"""
import codecs, fnmatch, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))


def _root():
    try:
        r = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, cwd=HERE)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return os.path.dirname(HERE)


ROOT = os.environ.get('MERGE_CHECK_ROOT') or _root()
REGISTRY = os.path.join(ROOT, 'CodeLog', 'features.json')
WORKTREE = 'WORKTREE'
ZERO = '0' * 40

# ───────────────────────── git ─────────────────────────

def git(*args, timeout=120, ok=(0,), input=None):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, input=input,
                       errors='replace')
    if ok is not None and r.returncode not in ok:
        raise RuntimeError('git %s: %s' % (' '.join(args), (r.stderr or r.stdout).strip()[:400]))
    return r.stdout


def rev_ok(rev):
    return subprocess.run(['git', 'rev-parse', '--verify', '-q', rev + '^{commit}'], cwd=ROOT,
                          capture_output=True).returncode == 0


def changed_files(base, head):
    """[(status, path)] — status A/M/D; renames count as A of the new path."""
    out = []
    if head == WORKTREE:
        raw = git('diff', '--name-status', '-M', base)
    else:
        raw = git('diff', '--name-status', '-M', base, head)
    for line in raw.splitlines():
        parts = line.split('\t')
        if len(parts) < 2:
            continue
        st = parts[0][0]
        if st == 'R':
            out.append(('A', parts[2]))
        elif st in 'AMDTC':
            out.append(('M' if st in 'MT' else st, parts[-1]))
    if head == WORKTREE:
        for p in git('ls-files', '-o', '--exclude-standard').splitlines():
            if p.strip():
                out.append(('A', p.strip()))
    return out


def diff_lines(base, head, path):
    """(added, removed) lines of one file in the range (text only, capped)."""
    added, removed = [], []
    full = os.path.join(ROOT, path)
    if head == WORKTREE and not subprocess.run(['git', 'ls-files', '--error-unmatch', path], cwd=ROOT,
                                               capture_output=True).returncode == 0:
        try:
            if os.path.getsize(full) > 4_000_000:
                return [], []
            with open(full, encoding='utf-8', errors='replace') as fh:
                return [l.rstrip('\n') for l in fh][:40000], []
        except OSError:
            return [], []
    args = ['diff', '-U0', '-M', '--no-color', base] + ([] if head == WORKTREE else [head]) + ['--', path]
    raw = git(*args, ok=None)
    if 'Binary files' in raw[:400]:
        return [], []
    for line in raw.splitlines():
        if line.startswith('+++') or line.startswith('---'):
            continue
        if line.startswith('+'):
            added.append(line[1:])
        elif line.startswith('-'):
            removed.append(line[1:])
        if len(added) > 40000:
            break
    return added, removed


# ───────────────────────── registry ─────────────────────────

RELATION_KEYS = ('extends', 'merges_into', 'related', 'distinct_from')


def load_registry():
    with open(REGISTRY, encoding='utf-8') as fh:
        reg = json.load(fh)
    feats = reg.get('features', [])
    by_id = {}
    errors = []
    for f in feats:
        fid = f.get('id')
        if not fid or not isinstance(fid, str):
            errors.append('a feature has no id: %r' % (f.get('name'),)); continue
        if fid in by_id:
            errors.append('duplicate feature id %s' % fid)
        by_id[fid] = f
        for k in ('name', 'summary'):
            if not f.get(k):
                errors.append('%s: missing %s' % (fid, k))
        if not isinstance(f.get('keywords'), list) or not f['keywords']:
            errors.append('%s: keywords must be a non-empty list' % fid)
        if not isinstance(f.get('paths'), list) or not f['paths']:
            errors.append('%s: paths must be a non-empty list' % fid)
        if f.get('status', 'active') not in ('active', 'retiring', 'decision', 'merged'):
            errors.append('%s: status must be active | retiring | decision | merged' % fid)
        if f.get('status') == 'retiring' and not f.get('merges_into'):
            errors.append('%s: retiring needs merges_into' % fid)
    for f in feats:
        fid = f.get('id')
        for k in ('extends', 'merges_into'):
            v = f.get(k)
            if v and v not in by_id:
                errors.append('%s: %s points at unknown feature %s' % (fid, k, v))
        for v in f.get('related', []) or []:
            if v not in by_id:
                errors.append('%s: related points at unknown feature %s' % (fid, v))
        for v, why in (f.get('distinct_from') or {}).items():
            if v not in by_id:
                errors.append('%s: distinct_from points at unknown feature %s' % (fid, v))
            if not why or len(str(why)) < 8:
                errors.append('%s: distinct_from %s needs a reason' % (fid, v))
    reg['_by_id'] = by_id
    reg['_errors'] = errors
    return reg


_GLOB_CACHE = {}


def glob_re(pattern):
    """Anchored glob: `*` and `?` stay inside one path segment, `**` crosses segments (`rm/scientia/**`,
    `**/roster*`, `*.js` = root-level scripts only)."""
    rx = _GLOB_CACHE.get(pattern)
    if rx is None:
        out, i = '', 0
        while i < len(pattern):
            c = pattern[i]
            if pattern.startswith('**/', i):
                out += '(?:.*/)?'; i += 3; continue
            if pattern.startswith('**', i):
                out += '.*'; i += 2; continue
            if c == '*':
                out += '[^/]*'
            elif c == '?':
                out += '[^/]'
            else:
                out += re.escape(c)
            i += 1
        rx = _GLOB_CACHE[pattern] = re.compile('^' + out + '$')
    return rx


def path_match(pattern, path):
    return bool(glob_re(pattern).match(path))


def owners(reg, path):
    return [f['id'] for f in reg['features'] if any(path_match(p, path) for p in f['paths'])]


def is_feature_file(reg, path):
    return any(path_match(p, path) for p in reg.get('feature_dirs', []))


def related(a, b):
    """True when the registry already explains why a and b may look alike."""
    for x, y in ((a, b), (b, a)):
        if x.get('extends') == y['id'] or x.get('merges_into') == y['id']:
            return True
        if y['id'] in (x.get('related') or []):
            return True
        if y['id'] in (x.get('distinct_from') or {}):
            return True
    return False


# ───────────────────────── tokens ─────────────────────────

STOP = set('''the and of to a in for is on by with as at or an it this that from new get set del put has have was were be
js html css py md rm lab page pages src index main app apps data item items view views mode state list lists name names
id ids key keys value values type types kind kinds text str string number num int bool flag flags opt opts option options
arg args param params obj object fn func function cb callback el elem element elems node nodes dom ctx context evt event
events msg message err error res req result results out in out input output ret val var let const class def self
render init update save load open close show hide toggle draw click mount unmount refresh format parse build make create
remove delete add insert apply handle run start stop reset clear check test tests helper helpers util utils shared common
base core misc tmp temp old next prev cur current last first all any none null undefined true false default
user users admin admins member members owner public private local remote web desktop online offline
col row rows cols width height size pos x y z top left right bottom min max count total sum avg
file files folder dir path paths url href link links tab tabs panel panels button btn menu modal dialog form field fields
async await then catch error errors warn warning info debug log logs console window document body head
what who how why when where your our its into per via use uses used using with without about
boot live report note notes editor embed carry every open
'''.split())

GENERIC_FILE_STEMS = {'index', 'main', 'app', 'util', 'utils', 'shell', 'base', 'core', 'shared', 'helpers'}


def singular(t):
    if len(t) > 4 and t.endswith('ies'):
        return t[:-3] + 'y'
    if len(t) > 4 and t.endswith('es') and t[-3] in 'sxz':
        return t[:-2]
    if len(t) > 3 and t.endswith('s') and not t.endswith('ss'):
        return t[:-1]
    return t


def tokenize(s):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s or '')
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', s)
    out = []
    for raw in re.split(r'[^A-Za-z0-9]+', s):
        t = raw.lower()
        if len(t) < 3 or t.isdigit() or t in STOP:
            continue
        out.append(singular(t))
    return out


def profile(f):
    """token -> weight: what a feature is ABOUT (name + keywords 1.0, file stems 0.6)."""
    prof = {}
    for t in tokenize(f.get('name', '')) + [x for k in f.get('keywords', []) for x in tokenize(k)]:
        prof[t] = 1.0
    for p in f.get('paths', []):
        stem = os.path.basename(p.replace('**', '').replace('*', '')).rsplit('.', 1)[0]
        for t in tokenize(stem):
            if t not in GENERIC_FILE_STEMS:
                prof.setdefault(t, 0.6)
    return prof


def name_tokens(f):
    return set(tokenize(f.get('name', '')))


def idf_table(feats):
    df = {}
    for f in feats:
        for t in set(profile(f)):
            df[t] = df.get(t, 0) + 1
    return {t: (1.0 if n <= 3 else 0.5 if n <= 6 else 0.25) for t, n in df.items()}


def score(tokens, f, prof, idf):
    hits = {}
    for t in set(tokens):
        if t in prof:
            hits[t] = prof[t] * idf.get(t, 1.0)
    return sum(hits.values()), hits


def name_claims(sig, f, hits):
    """An ENTRY signal (a file, tab, store, nav item, export, route) whose identity IS the feature's name:
    the distinctive name tokens they share cover more than half of the signal's own tokens
    ('tasks' → Tasks; 'notebook-board' ↛ Figure board)."""
    if sig['kind'] not in ENTRY_KINDS:
        return False
    toks = set(sig['tokens'])
    shared = {t for t, w in hits.items() if w >= 1.0} & name_tokens(f) & toks
    return bool(shared) and len(shared) * 2 > len(toks)


# ───────────────────────── signals ─────────────────────────

ENTRY_PATTERNS = [  # (kind, where, regex) — a new ENTRY POINT; checked in every changed feature file it applies to
    ('tab', 'scientia/src/11-shell.js', re.compile(r"\[\s*'([a-z0-9_-]+)'\s*,\s*'([^']{2,40})'\s*\]")),  # Scientia TABS = [['id','Label'], …]
    ('store', 'scientia/src/02-schema.js', re.compile(r"^\s{1,4}([a-z][a-z0-9_]*)\s*:\s*\{\s*key\s*:")),  # Scientia STORES
    ('nav', 'rm/js/nav.js', re.compile(r"label\s*:\s*'([^']{2,40})'\s*,[^\n]*href\s*:\s*'([^']+)'")),  # RM NAV_ITEMS
    ('nav', 'rm/js/nav.js', re.compile(r"href\s*:\s*'(/rm/pages/[a-z0-9-]+\.html[^']*)'[^\n]*label\s*:\s*'([^']{2,40})'")),
    ('widget', 'rm/js/*.js', re.compile(r"register\(\s*\{\s*type\s*:\s*'([a-z0-9_-]+)'")),           # canvas-widgets.js register({type})
    ('widget', '**/*.js', re.compile(r"\bregister(?:Widget|Block|Tool|Card)\(\s*'([a-z0-9_-]+)'")),
    ('export', 'functions/*.js', re.compile(r"^\s*exports\.([A-Za-z_$][\w$]*)\s*=")),                # Cloud Functions
    ('global', '**/*.js', re.compile(r"^\s*window\.([A-Z][A-Za-z0-9_$]{2,})\s*=")),                  # window.FOO = {…}
    ('route', '**/*.*', re.compile(r"['\"](api/[a-z0-9_/-]{3,60})['\"]")),
    ('label', '**/*.js', re.compile(r"(?:label|title|heading)\s*:\s*'([A-Z][A-Za-z][A-Za-z &/-]{2,36})'")),
]
NEWFILE_PATTERNS = [  # only in ADDED script files: the file's own top-level shape (lesson HTML keeps its inline helpers)
    ('function', '**/*.js', re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]{2,})\s*\(")),
    ('function', '**/*.py', re.compile(r"^def\s+([A-Za-z_][\w]{2,})\s*\(")),
    ('global', '**/*.js', re.compile(r"^(?:const|let|var|class)\s+([A-Z][A-Za-z0-9_$]{2,})\b")),
]
ENTRY_KINDS = {'file', 'tab', 'store', 'nav', 'widget', 'export', 'route'}   # a name match alone can flag these
MAX_SIGNALS_PER_FILE = 300


def signals_for(path, status, added, removed):
    """Identity signals introduced by this file's change. Entries removed and re-added on the same line
    (an array that merely grew) are compared as sets so only the NEW entries count."""
    out = []
    pats = [(k, rx) for k, where, rx in ENTRY_PATTERNS if path_match(where, path)]
    if status == 'A':
        pats += [(k, rx) for k, where, rx in NEWFILE_PATTERNS if path_match(where, path)]
    before = set()
    for line in removed:
        for kind, rx in pats:
            for m in rx.finditer(line):
                before.add((kind, m.groups()))
    seen = set()
    if status == 'A' and is_source(path):
        stem = os.path.basename(path).rsplit('.', 1)[0]
        toks = [t for t in tokenize(stem) if t not in GENERIC_FILE_STEMS]
        if toks:
            out.append({'kind': 'file', 'text': path, 'tokens': toks, 'file': path})
    for line in added:
        for kind, rx in pats:
            for m in rx.finditer(line):
                key = (kind, m.groups())
                if key in before or key in seen:
                    continue
                seen.add(key)
                text = ' '.join(g for g in m.groups() if g)
                toks = tokenize(text)
                if kind == 'route':
                    toks = [t for t in toks if t not in ('api', 'sync', 'cloud')]
                if not toks:
                    continue
                out.append({'kind': kind, 'text': text, 'tokens': toks, 'file': path})
                if len(out) >= MAX_SIGNALS_PER_FILE:
                    return out
    return out


def is_source(path):
    return path.endswith(('.js', '.mjs', '.py', '.html')) and '/vendor/' not in path and not path.endswith('.min.js')


# ───────────────────────── the report ─────────────────────────

class Report:
    def __init__(self):
        self.holds, self.warns, self.info = [], [], []

    def hold(self, title, lines=()):
        self.holds.append((title, list(lines)))

    def warn(self, title, lines=()):
        self.warns.append((title, list(lines)))

    def note(self, s):
        self.info.append(s)

    def text(self):
        out = []
        for title, lines in self.holds:
            out.append('HELD — ' + title)
            out += ['    ' + l for l in lines]
        for title, lines in self.warns:
            out.append('warning — ' + title)
            out += ['    ' + l for l in lines]
        out += ['  ' + s for s in self.info]
        out.append('merge check: %s' % ('HELD (%d)' % len(self.holds) if self.holds else 'clean'))
        return '\n'.join(out)

    def as_json(self):
        return {'held': bool(self.holds), 'holds': self.holds, 'warnings': self.warns, 'info': self.info}


THRESHOLD = 1.5          # two distinctive shared tokens, or one plus two common ones
LABEL_THRESHOLD = 2.0    # a UI label needs more than a name match


def check_registry(reg, rep):
    if reg['_errors']:
        rep.hold('CodeLog/features.json has problems', reg['_errors'][:30])
        return
    feats = reg['features']
    idf = idf_table(feats)
    profs = {f['id']: profile(f) for f in feats}
    undeclared = []
    for i, a in enumerate(feats):
        for b in feats[i + 1:]:
            if related(a, b):
                continue
            ta = set(tokenize(a['name'])) | {x for k in a['keywords'] for x in tokenize(k)}
            s, hits = score(ta, b, profs[b['id']], idf)
            s2, hits2 = score(set(tokenize(b['name'])) | {x for k in b['keywords'] for x in tokenize(k)}, a, profs[a['id']], idf)
            best = max(s, s2)
            if best >= THRESHOLD + 1.0 or (name_tokens(a) & name_tokens(b) and best >= THRESHOLD):
                shared = sorted(set(hits) | set(hits2))
                undeclared.append('%s ↔ %s  share %s' % (a['id'], b['id'], ', '.join(shared[:8])))
    if undeclared:
        rep.hold('features that look alike with no relation declared in CodeLog/features.json',
                 undeclared + ['→ on one of them add "extends", "merges_into", "related": [...] or "distinct_from": {"<id>": "why"}'])


def check_files(reg, rep, base, head, files):
    feats = reg['features']
    by_id = reg['_by_id']
    idf = idf_table(feats)
    profs = {f['id']: profile(f) for f in feats}
    unregistered = []
    hits = {}         # (owner, other) -> [signal lines]
    retiring = {}     # feature id -> added line count
    for status, path in files:
        if status == 'D':
            continue
        own = owners(reg, path)
        if status == 'A' and is_feature_file(reg, path) and not own:
            unregistered.append(path)
        if not is_source(path) or not (own or is_feature_file(reg, path)):
            continue  # tooling, tests, docs: not a product feature
        added, removed = diff_lines(base, head, path)
        if not added:
            continue
        for oid in own:
            f = by_id[oid]
            if f.get('status') == 'retiring':
                retiring[oid] = retiring.get(oid, 0) + len(added)
        sigs = signals_for(path, status, added, removed)
        if not sigs:
            continue
        sides = {by_id[o].get('side') for o in own}
        for sig in sigs:
            # the feature this signal belongs to: the file's owner that fits it best — or a feature on the SAME side
            # that clearly claims it (a newly registered scientia.tasks claims the Tasks tab added to the shell)
            owner = None
            if own:
                owner = max(own, key=lambda oid: score(sig['tokens'], by_id[oid], profs[oid], idf)[0])
                best, best_s = None, score(sig['tokens'], by_id[owner], profs[owner], idf)[0]
                for g in feats:
                    if g['id'] in own or (g.get('side') not in sides and g.get('side') != 'shared' and 'shared' not in sides):
                        continue
                    s, h = score(sig['tokens'], g, profs[g['id']], idf)
                    if s > best_s and (s >= THRESHOLD or name_claims(sig, g, h)):
                        best, best_s = g['id'], s
                if best:
                    owner = best
            for g in feats:
                if g['id'] == owner or (owner and related(by_id[owner], g)):
                    continue
                if owner is None and g['id'] in own:
                    continue
                s, h = score(sig['tokens'], g, profs[g['id']], idf)
                strong = [t for t, w in h.items() if w >= 1.0]
                thr = LABEL_THRESHOLD if sig['kind'] == 'label' else THRESHOLD
                if (s >= thr and strong) or name_claims(sig, g, h):
                    key = (owner or '(unregistered: %s)' % path, g['id'])
                    hits.setdefault(key, []).append('%s %r in %s  (shares %s)' % (sig['kind'], sig['text'], sig['file'], ', '.join(sorted(h))))
    if unregistered:
        rep.hold('new modules that no feature in CodeLog/features.json owns',
                 unregistered[:40] + ['→ add each to the "paths" of the feature it belongs to, or add a new feature entry for it'])
    for (owner, other), lines in sorted(hits.items()):
        g = by_id[other]
        fix = ['→ this looks like %s (%s): %s' % (other, g['name'], g.get('summary', '')[:140]),
               '  combine them: on the feature that owns the new work set "extends": "%s" (build on it) or "merges_into": "%s" (fold into it),' % (other, other),
               '  or declare "related": ["%s"] (uses it) or "distinct_from": {"%s": "<why>"} (reviewed, kept apart).' % (other, other)]
        if g.get('status') == 'retiring':
            fix.append('  note: %s is itself folding into %s — build there.' % (other, g.get('merges_into')))
        rep.hold('possible duplicate feature: %s ↔ %s' % (owner, other), lines[:6] + (['    … %d more' % (len(lines) - 6)] if len(lines) > 6 else []) + fix)
    for oid, n in sorted(retiring.items()):
        f = by_id[oid]
        rep.warn('%d line(s) added to %s, which is folding into %s' % (n, oid, f.get('merges_into')),
                 ['new work belongs in %s; bug fixes here are fine (%s)' % (f.get('merges_into'), f.get('plan', 'see the plan'))])


def check_merge(rep, target, head, fetch=True):
    if head == WORKTREE:
        rep.note('merge test skipped for uncommitted work (commit, then it runs)')
        return
    if fetch and target.startswith('origin/'):
        try:
            git('fetch', '--quiet', 'origin', target.split('/', 1)[1], timeout=40)
        except Exception as e:
            rep.warn('could not fetch %s — the merge test ran against the last known copy' % target, [str(e)[:200]])
    if not rev_ok(target):
        rep.warn('no %s to test the merge against (fetch it, or set --target)' % target)
        return
    r = subprocess.run(['git', 'merge-tree', '--write-tree', '--no-messages', target, head], cwd=ROOT,
                       capture_output=True, text=True, errors='replace')
    if r.returncode == 0:
        behind = git('rev-list', '--count', '%s..%s' % (head, target)).strip()
        if behind != '0':
            rep.note('merges cleanly with %s (%s commit(s) there you do not have yet)' % (target, behind))
        else:
            rep.note('merges cleanly with %s' % target)
        return
    if r.returncode == 1:
        files = sorted({l.split('\t')[-1] for l in r.stdout.splitlines()[1:] if l.strip() and not l.startswith('CONFLICT')})
        rep.hold('would not merge cleanly with %s' % target,
                 files[:20] + ['→ git fetch origin && git rebase %s   (then resolve, build, push again)' % target])
        return
    rep.warn('merge test could not run', [(r.stderr or r.stdout).strip()[:300]])


# Windows refuses these in a file name; a clone there stops at the first one and leaves no working tree (V3.922)
WIN_BAD_CHARS = set('<>:"\\|?*') | {chr(c) for c in range(32)}
WIN_RESERVED = {'con', 'prn', 'aux', 'nul'} | {'com%d' % i for i in range(1, 10)} | {'lpt%d' % i for i in range(1, 10)}


def unquote(path):
    """git C-quotes a path holding '"', '\\', a control character or non-ASCII; undo it so the real name is checked."""
    if len(path) > 1 and path[0] == path[-1] == '"':
        return codecs.escape_decode(path[1:-1].encode())[0].decode('utf-8', 'replace')
    return path


def windows_problem(path):
    for part in path.split('/'):
        bad = sorted({c for c in part if c in WIN_BAD_CHARS})
        if bad:
            return 'has %s' % ' '.join(repr(c) for c in bad)
        if part.endswith(('.', ' ')):
            return '%r ends in a dot or space' % part
        if part.split('.')[0].rstrip(' ').lower() in WIN_RESERVED:
            return '%r is a reserved device name' % part
    return None


def check_paths(rep, head, files):
    new = [unquote(p) for s, p in files if s == 'A']
    if not new:
        return
    bad = ['%s  — %s' % (p, why) for p in new for why in [windows_problem(p)] if why]
    if head == WORKTREE:
        tree = git('ls-files', '-z').split('\0') + git('ls-files', '-z', '-o', '--exclude-standard').split('\0')
    else:
        tree = git('ls-tree', '-r', '-z', '--name-only', head).split('\0')
    folded = {}
    for p in tree:
        if p:
            folded.setdefault(p.lower(), set()).add(p)
    for p in new:
        twins = sorted(folded.get(p.lower(), set()) - {p})
        if twins:
            bad.append('%s  — differs only in case from %s (Windows and macOS keep one)' % (p, ', '.join(twins)))
    if bad:
        rep.hold('file names a Windows clone cannot check out (Gabe works on Windows)',
                 bad[:20] + ['→ rename: none of < > : " \\ | ? * or control characters, no name ending in a dot or space,',
                             '  no CON / PRN / AUX / NUL / COM1-9 / LPT1-9, no two paths that differ only in case'])


def run_cmd(cmd, timeout=180):
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout, errors='replace')
        return r.returncode, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return 124, 'timed out after %ss' % timeout
    except FileNotFoundError as e:
        return 127, str(e)


def check_gates(rep, files, head):
    paths = [p for s, p in files if s != 'D']
    node = shutil.which('node')
    py = sys.executable or 'python3'
    bad = []
    if node:
        for p in paths:
            if p.endswith(('.js', '.mjs')) and is_source(p) and not p.startswith('functions/node_modules') and os.path.isfile(os.path.join(ROOT, p)):
                if head != WORKTREE:
                    continue  # pre-push/ci: the committed file is what matters; worktree mode checks the disk copy
                rc, out = run_cmd([node, '--check', os.path.join(ROOT, p)], timeout=60)
                if rc != 0 and 'outside a module' not in out and "Unexpected token 'export'" not in out:
                    bad.append('%s: %s' % (p, out.splitlines()[-1][:160] if out else 'syntax error'))
    if any(p.startswith('scientia/') for p in paths) and os.path.isfile(os.path.join(ROOT, 'scripts', 'scientia_build.py')):
        rc, out = run_cmd([py, os.path.join(ROOT, 'scripts', 'scientia_build.py')], timeout=120)
        if rc != 0:
            bad.append('scientia build failed: ' + out[-400:])
        else:
            rep.note('scientia built (desktop + web)')
    if any(p.startswith('functions/scientia-hub') for p in paths) and node:
        rc, out = run_cmd([node, os.path.join(ROOT, 'functions', 'test', 'scientia-hub.test.js')], timeout=120)
        if rc != 0:
            bad.append('hub tests failed: ' + out[-400:])
        else:
            rep.note('hub tests pass')
    if node and os.path.isfile(os.path.join(ROOT, 'scripts', 'gen-icons.mjs')) and any(
            p.startswith(('rm/', 'modules/')) or (p.endswith(('.js', '.html')) and '/' not in p) for p in paths):
        rc, out = run_cmd([node, os.path.join(ROOT, 'scripts', 'gen-icons.mjs'), '--check', '--scan', '--emoji'], timeout=120)
        if rc != 0:
            bad.append('icon/emoji gate failed: ' + out[-600:])
        else:
            rep.note('icon/emoji gate passes')
    if bad:
        rep.hold('gates failed', bad)


def run_range(base, head, opts):
    rep = Report()
    if not os.path.isfile(REGISTRY):
        rep.hold('missing CodeLog/features.json (the feature registry)')
        return rep
    reg = load_registry()
    try:
        files = changed_files(base, head)
    except Exception as e:
        rep.hold('could not list the changed files', [str(e)])
        return rep
    rep.note('%s..%s: %d changed file(s)' % (base[:10], head[:10], len(files)))
    check_registry(reg, rep)
    if not reg['_errors']:
        check_files(reg, rep, base, head, files)
    check_paths(rep, head, files)
    if not opts.get('no_merge'):
        check_merge(rep, opts.get('target', 'origin/main'), head, fetch=not opts.get('no_fetch'))
    if not opts.get('no_gates'):
        check_gates(rep, files, head)
    return rep


# ───────────────────────── commands ─────────────────────────

def parse_opts(argv):
    opts, rest = {'target': 'origin/main'}, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--target':
            opts['target'] = argv[i + 1]; i += 2; continue
        if a.startswith('--target='):
            opts['target'] = a.split('=', 1)[1]
        elif a == '--no-fetch':
            opts['no_fetch'] = True
        elif a == '--no-merge':
            opts['no_merge'] = True
        elif a == '--no-gates':
            opts['no_gates'] = True
        elif a == '--json':
            opts['json'] = True
        elif a == '--quiet':
            opts['quiet'] = True
        else:
            rest.append(a)
        i += 1
    return opts, rest


def emit(rep, opts):
    if opts.get('json'):
        print(json.dumps(rep.as_json(), indent=1))
    elif not opts.get('quiet') or rep.holds:
        print(rep.text())
    return 1 if rep.holds else 0


def cmd_pre_push(opts, rest):
    target = opts['target']
    if os.environ.get('MERGE_CHECK_DONE') == '1':
        return 0  # scripts/git_autopush.py already ran the same check on this range and captured the report
    lines = [l.split() for l in sys.stdin.read().splitlines() if l.strip()]
    if not lines:
        return 0
    fetched = False
    rc = 0
    for parts in lines:
        if len(parts) != 4:
            continue
        local_ref, local_sha, remote_ref, remote_sha = parts
        if local_sha == ZERO:
            continue  # deleting a remote branch
        if not fetched and not opts.get('no_fetch') and target.startswith('origin/'):
            try:
                git('fetch', '--quiet', 'origin', target.split('/', 1)[1], timeout=40)
            except Exception:
                pass
            fetched = True
        if remote_sha != ZERO and rev_ok(remote_sha):
            base = remote_sha
        elif rev_ok(target):
            base = git('merge-base', target, local_sha).strip()
        else:
            base = git('rev-list', '--max-parents=0', local_sha).strip().splitlines()[-1]
        o = dict(opts); o['no_fetch'] = True
        rep = run_range(base, local_sha, o)
        rep.info.insert(0, 'push %s → %s' % (local_ref.replace('refs/heads/', ''), remote_ref.replace('refs/heads/', '')))
        rc |= emit(rep, opts)
    if rc:
        print('push refused by scripts/merge_check.py — fix the HELD items above (git push --no-verify skips this gate; the CI check does not).', file=sys.stderr)
    return rc


def cmd_ci(opts, rest):
    head = os.environ.get('GITHUB_SHA') or 'HEAD'
    base = os.environ.get('MERGE_CHECK_BASE') or ''
    if not base or not rev_ok(base):
        target = opts['target']
        base = git('merge-base', target, head).strip() if rev_ok(target) else git('rev-parse', head + '~1').strip()
    o = dict(opts); o['no_merge'] = True; o['no_fetch'] = True
    rep = run_range(base, head, o)
    return emit(rep, opts)


def cmd_lint(opts, rest):
    rep = Report()
    reg = load_registry()
    check_registry(reg, rep)
    rep.note('%d features, %d sides' % (len(reg['features']), len({f.get('side') for f in reg['features']})))
    return emit(rep, opts)


def cmd_queue(opts, rest):
    reg = load_registry()
    rows = [f for f in reg['features'] if f.get('merges_into') or f.get('status') in ('retiring', 'decision')]
    if not rows:
        print('combination queue: empty'); return 0
    print('combination queue (features folding into another, or awaiting a decision):')
    for f in rows:
        print('  %-26s %-9s → %-16s %s' % (f['id'], f.get('status', 'active'), f.get('merges_into') or '?', f.get('note') or f.get('plan') or ''))
    return 0


def cmd_install(opts, rest):
    hooks = os.path.join(ROOT, '.githooks')
    for name in os.listdir(hooks) if os.path.isdir(hooks) else []:
        p = os.path.join(hooks, name)
        if os.path.isfile(p):
            os.chmod(p, 0o755)
    git('config', 'core.hooksPath', '.githooks')
    git('config', 'merge.deploy-manifest.name', 'deploy manifest: keep the newer record of each file')
    git('config', 'merge.deploy-manifest.driver', 'python3 scripts/deploy.py merge-manifest %O %A %B')
    print('installed: core.hooksPath=.githooks (pre-push runs scripts/merge_check.py); merge driver for deploy/manifest.json')
    return 0


def installed():
    try:
        return git('config', '--get', 'core.hooksPath', ok=None).strip() == '.githooks'
    except Exception:
        return False


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    opts, rest = parse_opts(argv)
    cmd = rest[0] if rest else 'worktree'
    args = rest[1:]
    if cmd == 'range':
        if len(args) != 2:
            print('usage: merge_check.py range <base> <head>'); return 2
        return emit(run_range(args[0], args[1], opts), opts)
    if cmd == 'worktree':
        return emit(run_range('HEAD', WORKTREE, opts), opts)
    if cmd == 'pre-push':
        return cmd_pre_push(opts, args)
    if cmd == 'ci':
        return cmd_ci(opts, args)
    if cmd == 'lint':
        return cmd_lint(opts, args)
    if cmd == 'queue':
        return cmd_queue(opts, args)
    if cmd == 'install':
        return cmd_install(opts, args)
    if cmd == 'installed':
        print('yes' if installed() else 'no'); return 0 if installed() else 1
    print(__doc__); return 2


if __name__ == '__main__':
    sys.exit(main())
