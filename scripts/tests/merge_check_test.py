#!/usr/bin/env python3
"""Fixtures for scripts/merge_check.py and scripts/git_autopush.py (V3.868).

    python3 scripts/tests/merge_check_test.py

Each case builds a throwaway git repo (and a bare origin) under a temp dir, so nothing here touches the
real repo. No third-party packages.
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
MC = os.path.join(SCRIPTS, 'merge_check.py')
AP = os.path.join(SCRIPTS, 'git_autopush.py')
PY = sys.executable
PASS = FAIL = 0


def ok(cond, name, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1; print('  ok   ' + name)
    else:
        FAIL += 1; print('  FAIL ' + name + ('\n       ' + str(detail)[:900] if detail else ''))


def sh(cwd, *args, env=None, input=None, check=True):
    e = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@x', GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@x')
    if env:
        e.update(env)
    r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, env=e, input=input)
    if check and r.returncode != 0:
        raise RuntimeError('%s\n%s%s' % (' '.join(args), r.stdout, r.stderr))
    return r


def write(repo, rel, text):
    p = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as fh:
        fh.write(text)


REGISTRY = {
    "version": 1,
    "feature_dirs": ["rm/js/*.js", "rm/pages/*.html", "functions/*.js", "scientia/src/*.js", "*.js"],
    "features": [
        {"id": "rm.tasks", "name": "Tasks & Task Market", "side": "rm",
         "summary": "Lab tasks: inbox, buckets, assignment, due dates, archive, the task market.",
         "keywords": ["task", "todo", "assign", "due", "deadline", "inbox", "bucket", "market", "archive"],
         "paths": ["rm/js/tasks*.js", "rm/js/task-*.js", "rm/pages/tasks*.html"]},
        {"id": "rm.library", "name": "Library", "side": "rm",
         "summary": "The lab's paper collection: import by DOI or PDF, metadata, topics, readings, sharing.",
         "keywords": ["library", "paper", "doi", "pdf", "citation", "reference", "reading", "share", "topic"],
         "paths": ["rm/js/library*.js", "rm/pages/library*.html"]},
        {"id": "rm.inventory", "name": "Inventory", "side": "rm",
         "summary": "Lab inventory: items, quantities, lots, locations, labels, scan-to-use.",
         "keywords": ["inventory", "stock", "item", "material", "reagent", "supply", "quantity", "lot", "label", "scan"],
         "paths": ["rm/js/inventory*.js"]},
        {"id": "scientia.core", "name": "Scientia core", "side": "scientia",
         "summary": "The app's spine: schema, stores, editor, shell.",
         "keywords": ["schema", "store", "editor", "shell", "block"],
         "paths": ["scientia/src/02-schema.js", "scientia/src/11-shell.js", "scientia/src/12-doc.js"]},
        {"id": "scientia.materials", "name": "Scientia Materials", "side": "scientia",
         "summary": "Materials inside notes.", "keywords": ["material", "reagent", "sheet"],
         "paths": ["scientia/src/13j-materials.js"], "status": "retiring", "merges_into": "rm.inventory"},
    ],
}

SHELL_BEFORE = "const VIEWS = {};\nconst TABS = [['home', 'Today'], ['library', 'Library'], ['materials', 'Materials']];\n"
SHELL_AFTER = "const VIEWS = {};\nconst TABS = [['home', 'Today'], ['library', 'Library'], ['materials', 'Materials'], ['tasks', 'Tasks']];\n"


def make_repo(tmp, registry=REGISTRY):
    repo = os.path.join(tmp, 'repo')
    os.makedirs(repo)
    sh(repo, 'git', 'init', '-q', '-b', 'main')
    write(repo, 'CodeLog/features.json', json.dumps(registry, indent=1))
    write(repo, 'rm/js/tasks.js', "function renderTasks(){}\n")
    write(repo, 'rm/js/library.js', "function renderLibrary(){}\n")
    write(repo, 'rm/js/inventory.js', "function renderInventory(){}\n")
    write(repo, 'scientia/src/02-schema.js', "const STORES = {\n  documents: { key: 'id' },\n  library:   { key: 'id' },\n};\n")
    write(repo, 'scientia/src/11-shell.js', SHELL_BEFORE)
    write(repo, 'scientia/src/12-doc.js', "const DocView = {};\n")
    write(repo, 'scientia/src/13j-materials.js', "const MATS = {};\n")
    write(repo, 'README.md', 'x\n')
    sh(repo, 'git', 'add', '-A')
    sh(repo, 'git', 'commit', '-q', '-m', 'base')
    return repo


def mc(repo, *args):
    r = sh(repo, PY, MC, *args, '--json', '--no-merge', '--no-gates', '--no-fetch', env={'MERGE_CHECK_ROOT': repo}, check=False)
    try:
        data = json.loads(r.stdout[r.stdout.index('{'):])
    except Exception:
        data = {'held': None, 'raw': r.stdout + r.stderr}
    data['rc'] = r.returncode
    data['text'] = json.dumps(data.get('holds', [])) + json.dumps(data.get('warnings', []))
    return data


def commit_all(repo, msg):
    sh(repo, 'git', 'add', '-A')
    sh(repo, 'git', 'commit', '-q', '-m', msg)
    return sh(repo, 'git', 'rev-parse', 'HEAD').stdout.strip()


def test_overlap_and_registration():
    print('merge_check: registration + overlap')
    tmp = tempfile.mkdtemp(prefix='mc-')
    try:
        repo = make_repo(tmp)
        base = sh(repo, 'git', 'rev-parse', 'HEAD').stdout.strip()
        # 1. Gabe adds a tasks module + a Tasks tab: unregistered, and a duplicate of rm.tasks
        write(repo, 'scientia/src/23-tasks.js', "const TASKS = {\n  render(){}\n};\nfunction taskDue(t){ return t.due; }\nfunction assignTask(t, who){}\n")
        write(repo, 'scientia/src/11-shell.js', SHELL_AFTER)
        head = commit_all(repo, 'tasks')
        d = mc(repo, 'range', base, head)
        ok(d['rc'] == 1 and d['held'] is True, 'held')
        ok('new modules that no feature' in d['text'] and '23-tasks.js' in d['text'], 'unregistered new module named', d['text'])
        ok('rm.tasks' in d['text'] and "'tasks Tasks'" in d['text'], 'the new Tasks tab is flagged against rm.tasks (only the NEW tab, the array merely grew)', d['text'])
        ok("'library Library'" not in d['text'] and "'home Today'" not in d['text'], 'tabs that were already there are not signals', d['text'])
        ok('combine them' in d['text'] and 'merges_into' in d['text'], 'the fix is spelled out', d['text'])
        # 2. register it as a feature folding into rm.tasks → clean
        reg = json.loads(json.dumps(REGISTRY))
        reg['features'].append({"id": "scientia.tasks", "name": "Scientia Tasks", "side": "scientia",
                                "summary": "In-app tasks.", "keywords": ["task", "due", "assign"],
                                "paths": ["scientia/src/23-tasks.js"], "status": "retiring", "merges_into": "rm.tasks"})
        write(repo, 'CodeLog/features.json', json.dumps(reg, indent=1))
        head2 = commit_all(repo, 'register')
        d = mc(repo, 'range', base, head2)
        ok(d['rc'] == 0 and d['held'] is False, 'registered + merges_into → clean', d['text'])
        d = mc(repo, 'range', head, head2)
        ok(d['rc'] == 0, 'the registry change alone is clean', d['text'])
        # 3. an unrelated change inside a registered file → clean
        write(repo, 'rm/js/tasks.js', "function renderTasks(){}\nfunction renderTaskRow(t){ return t.title; }\nconst TASK_SORT = 'due';\n")
        head3 = commit_all(repo, 'tasks tweak')
        d = mc(repo, 'range', head2, head3)
        ok(d['rc'] == 0, 'editing your own feature is clean', d['text'])
        # 4. a new RM page that duplicates the library (reading list) → held; distinct_from → clean
        write(repo, 'rm/js/reading-list.js', "const READING_LIST = {};\nfunction sharePaperReading(p){}\nfunction renderReadingList(){}\n")
        reg['features'].append({"id": "rm.reading-list", "name": "Reading list", "side": "rm",
                                "summary": "Papers to read, shared with a mentee.", "keywords": ["reading", "paper", "share", "mentee"],
                                "paths": ["rm/js/reading-list.js"]})
        write(repo, 'CodeLog/features.json', json.dumps(reg, indent=1))
        head4 = commit_all(repo, 'reading list')
        d = mc(repo, 'range', head3, head4)
        ok(d['rc'] == 1 and 'rm.reading-list' in d['text'] and 'rm.library' in d['text'], 'a look-alike feature entry is held by the registry lint', d['text'])
        reg['features'][-1]['distinct_from'] = {"rm.library": "a per-person queue over library papers; the library owns the papers"}
        write(repo, 'CodeLog/features.json', json.dumps(reg, indent=1))
        head5 = commit_all(repo, 'distinct')
        d = mc(repo, 'range', head3, head5)
        ok(d['rc'] == 0, 'distinct_from with a reason → clean', d['text'])
        # 5. a store added to the schema that names inventory → flagged against rm.inventory
        write(repo, 'scientia/src/02-schema.js', "const STORES = {\n  documents: { key: 'id' },\n  library:   { key: 'id' },\n  inventory: { key: 'id', doc: 'stock items' },\n};\n")
        head6 = commit_all(repo, 'store')
        d = mc(repo, 'range', head5, head6)
        ok(d['rc'] == 1 and 'rm.inventory' in d['text'] and "store 'inventory'" in d['text'], 'a new store named like an RM feature is flagged', d['text'])
        # 6. lines added to a retiring feature → a warning, not a hold
        write(repo, 'scientia/src/13j-materials.js', "const MATS = {};\nfunction fixMats(){}\n")
        head7 = commit_all(repo, 'mats fix')
        d = mc(repo, 'range', head6, head7)
        ok(d['rc'] == 0 and 'folding into rm.inventory' in d['text'], 'work on a retiring feature warns', d['text'])
        # 7. worktree mode sees uncommitted + untracked work
        write(repo, 'rm/js/stock-take-2.js', "function stockTake(){}\n")
        d = mc(repo, 'worktree')
        ok(d['rc'] == 1 and 'stock-take-2.js' in d['text'], 'worktree: an untracked new module is held', d['text'])
        os.remove(os.path.join(repo, 'rm/js/stock-take-2.js'))
        # 8. a registry with a broken relation
        bad = json.loads(json.dumps(reg)); bad['features'][0]['related'] = ['rm.nope']
        write(repo, 'CodeLog/features.json', json.dumps(bad, indent=1))
        d = mc(repo, 'lint')
        ok(d['rc'] == 1 and 'unknown feature rm.nope' in d['text'], 'lint catches a dangling relation', d['text'])
        write(repo, 'CodeLog/features.json', json.dumps(reg, indent=1))
        # 9. queue
        r = sh(repo, PY, MC, 'queue', env={'MERGE_CHECK_ROOT': repo})
        ok('scientia.materials' in r.stdout and 'rm.inventory' in r.stdout, 'queue lists what folds into what', r.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_merge_and_prepush():
    print('merge_check: textual merge + pre-push stdin')
    tmp = tempfile.mkdtemp(prefix='mc-')
    try:
        repo = make_repo(tmp)
        base = sh(repo, 'git', 'rev-parse', 'HEAD').stdout.strip()
        sh(repo, 'git', 'checkout', '-q', '-b', 'scientia/topic')
        write(repo, 'README.md', 'topic\n')
        head = commit_all(repo, 'topic')
        sh(repo, 'git', 'checkout', '-q', 'main')
        write(repo, 'README.md', 'main\n')
        commit_all(repo, 'main moved')
        sh(repo, 'git', 'checkout', '-q', 'scientia/topic')
        r = sh(repo, PY, MC, 'range', base, head, '--target', 'main', '--no-fetch', '--no-gates', env={'MERGE_CHECK_ROOT': repo}, check=False)
        ok(r.returncode == 1 and 'would not merge cleanly' in r.stdout and 'README.md' in r.stdout, 'a conflicting branch is held by the merge test', r.stdout + r.stderr)
        # pre-push protocol: first push of the branch (remote sha = zeros) → base = merge-base with main
        line = 'refs/heads/scientia/topic %s refs/heads/scientia/topic %s\n' % (head, '0' * 40)
        r = sh(repo, PY, MC, 'pre-push', 'origin', 'x', '--target', 'main', '--no-fetch', '--no-gates', env={'MERGE_CHECK_ROOT': repo}, input=line, check=False)
        ok(r.returncode == 1 and 'push refused' in r.stderr, 'pre-push refuses with the same report', r.stdout + r.stderr)
        # resolve: rebase onto main, then it passes
        sh(repo, 'git', 'rebase', 'main', check=False)
        sh(repo, 'git', 'checkout', '--theirs', 'README.md', check=False)
        write(repo, 'README.md', 'main\ntopic\n')
        sh(repo, 'git', 'add', 'README.md'); sh(repo, 'git', '-c', 'core.editor=true', 'rebase', '--continue', check=False)
        head2 = sh(repo, 'git', 'rev-parse', 'HEAD').stdout.strip()
        line = 'refs/heads/scientia/topic %s refs/heads/scientia/topic %s\n' % (head2, '0' * 40)
        r = sh(repo, PY, MC, 'pre-push', 'origin', 'x', '--target', 'main', '--no-fetch', '--no-gates', env={'MERGE_CHECK_ROOT': repo}, input=line, check=False)
        ok(r.returncode == 0 and 'merges cleanly' in r.stdout, 'after a rebase the push goes through', r.stdout + r.stderr)
        # install writes the config
        write(repo, '.githooks/pre-push', '#!/bin/sh\nexit 0\n')
        r = sh(repo, PY, MC, 'install', env={'MERGE_CHECK_ROOT': repo})
        hp = sh(repo, 'git', 'config', '--get', 'core.hooksPath').stdout.strip()
        drv = sh(repo, 'git', 'config', '--get', 'merge.deploy-manifest.driver').stdout.strip()
        ok(hp == '.githooks' and 'merge-manifest' in drv, 'install sets hooksPath and the manifest merge driver', hp + ' ' + drv)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_autopush():
    print('git_autopush: commit, guard, push')
    tmp = tempfile.mkdtemp(prefix='ap-')
    try:
        origin = os.path.join(tmp, 'origin.git')
        sh(tmp, 'git', 'init', '-q', '--bare', '-b', 'main', origin)
        repo = make_repo(tmp)
        write(repo, 'deploy/site.json', json.dumps({"autoPush": True, "autoPushMaxFiles": 3}))
        write(repo, 'CodeLog/Updates/CHANGELOG.md', "# Changelog\n\n## [V9.1] — 2026-10-23 — Test release title\n")
        write(repo, 'scripts/merge_check.py', open(MC, encoding='utf-8').read())
        write(repo, '.githooks/pre-push', open(os.path.join(os.path.dirname(SCRIPTS), '.githooks', 'pre-push'), encoding='utf-8').read())
        os.chmod(os.path.join(repo, '.githooks/pre-push'), 0o755)
        sh(repo, 'git', 'add', '-A'); sh(repo, 'git', 'commit', '-q', '-m', 'tooling')
        sh(repo, 'git', 'remote', 'add', 'origin', origin)
        sh(repo, 'git', 'push', '-q', '-u', 'origin', 'main')
        env = {'AUTOPUSH_ROOT': repo, 'MERGE_CHECK_ROOT': repo, 'CLAUDE_PROJECT_DIR': repo}
        # a) a normal turn: one edit + one secret file → the edit is pushed, the secret is held
        write(repo, 'rm/js/tasks.js', "function renderTasks(){ return 1; }\n")
        marker = '-----BEGIN ' + 'PRIVATE KEY-----'  # built in pieces so this test file is not itself held by the scan
        write(repo, 'scripts/service-account.json', '{"private_key' + '_id": "x", "private_key": "%s"}' % marker)
        write(repo, 'Data/payroll_all.csv', 'employee_name,amount\n')
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage'] if r.stdout.strip() else ''
        ok('pushed 1 commit' in msg, 'pushed the turn', msg + r.stderr)
        ok('held out of git (2)' in msg and 'service-account.json' in msg and 'payroll' in msg, 'secret + payroll held and named', msg)
        tracked = sh(repo, 'git', 'ls-files').stdout
        ok('service-account.json' not in tracked and 'payroll' not in tracked, 'held files are not in git')
        subj = sh(repo, 'git', 'log', '-1', '--format=%s%n%b').stdout
        ok(subj.startswith('V9.1: Test release title') and 'Co-Authored-By: Claude' in subj, 'commit message from the CHANGELOG head + trailer', subj)
        remote_head = sh(repo, 'git', 'rev-parse', 'origin/main').stdout.strip()
        ok(remote_head == sh(repo, 'git', 'rev-parse', 'HEAD').stdout.strip(), 'origin has it')
        # b) a big batch waits for a person
        for i in range(5):
            write(repo, 'rm/js/tasks-extra-%d.js' % i, 'function f%d(){}\n' % i)
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage']
        ok('git HELD' in msg and '--batch' in msg, 'a batch above autoPushMaxFiles is held', msg)
        ok(sh(repo, 'git', 'status', '--porcelain').stdout.strip() != '', 'nothing was committed')
        for i in range(5):
            os.remove(os.path.join(repo, 'rm/js/tasks-extra-%d.js' % i))
        # c) the push gate holds a duplicate feature; the commit stays local and the message carries the report
        write(repo, 'scientia/src/11-shell.js', SHELL_AFTER)
        write(repo, 'scientia/src/23-tasks.js', "const TASKS = {};\nfunction assignTask(){}\nfunction taskDue(){}\n")
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage']
        ok('HELD by the push gate' in msg and 'rm.tasks' in msg, 'push gate report reaches the turn', msg + r.stderr)
        ahead = sh(repo, 'git', 'rev-list', '--count', 'origin/main..HEAD').stdout.strip()
        ok(ahead == '1', 'the commit stayed local', ahead)
        # d) origin moved (another person pushed): we rebase, then push
        other = os.path.join(tmp, 'other')
        sh(tmp, 'git', 'clone', '-q', origin, other)
        write(other, 'rm/js/library.js', "function renderLibrary(){ return 2; }\n")
        sh(other, 'git', 'add', '-A'); sh(other, 'git', 'commit', '-q', '-m', 'gabe: library tweak'); sh(other, 'git', 'push', '-q')
        # register the tasks feature so the gate passes
        reg = json.loads(open(os.path.join(repo, 'CodeLog/features.json')).read())
        reg['features'].append({"id": "scientia.tasks", "name": "Scientia Tasks", "side": "scientia", "summary": "In-app tasks.",
                                "keywords": ["task", "due", "assign"], "paths": ["scientia/src/23-tasks.js"], "status": "retiring", "merges_into": "rm.tasks"})
        write(repo, 'CodeLog/features.json', json.dumps(reg, indent=1))
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage']
        ok('pulled 1 commit(s) from origin' in msg and 'pushed' in msg, 'rebased onto the other person\'s push, then pushed', msg + r.stderr)
        ok(sh(repo, 'git', 'rev-list', '--count', 'origin/main..HEAD').stdout.strip() == '0', 'in sync with origin')
        # f) a branch origin has never seen (V3.924): its first turn pushes it and sets the upstream
        sh(repo, 'git', 'switch', '-q', '-c', 'scientia/new-topic')
        write(repo, 'rm/js/tasks.js', "function renderTasks(){ return 3; }\n")
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage'] if r.stdout.strip() else ''
        ok('pushed 1 commit(s) to origin/scientia/new-topic (new branch)' in msg, 'a new branch is pushed on its first turn', msg + r.stderr)
        head = sh(repo, 'git', 'rev-parse', 'HEAD').stdout.strip()
        ok(sh(repo, 'git', 'rev-parse', 'origin/scientia/new-topic', check=False).stdout.strip() == head, 'origin has the new branch')
        up = sh(repo, 'git', 'rev-parse', '--abbrev-ref', '@{u}', check=False).stdout.strip()
        ok(up == 'origin/scientia/new-topic', 'and the branch tracks it', up)
        write(repo, 'rm/js/tasks.js', "function renderTasks(){ return 4; }\n")
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage'] if r.stdout.strip() else ''
        ok('pushed 1 commit(s) to origin/scientia/new-topic (' in msg and 'new branch' not in msg, 'its next turn is an ordinary push', msg + r.stderr)
        # g) origin unreachable: still "could not reach origin", never mistaken for a new branch
        sh(repo, 'git', 'remote', 'set-url', 'origin', os.path.join(tmp, 'missing.git'))
        write(repo, 'rm/js/tasks.js', "function renderTasks(){ return 5; }\n")
        r = sh(repo, PY, AP, env=env, check=False)
        msg = json.loads(r.stdout.strip().splitlines()[-1])['systemMessage'] if r.stdout.strip() else ''
        ok('could not reach origin' in msg and 'new branch' not in msg, 'an unreachable origin keeps the commit local', msg + r.stderr)
        sh(repo, 'git', 'remote', 'set-url', 'origin', origin)
        sh(repo, 'git', 'switch', '-q', 'main')
        # e) paused
        write(repo, 'deploy/site.json', json.dumps({"autoPush": False}))
        r = sh(repo, PY, AP, env=env, check=False)
        ok(r.stdout.strip() == '', 'autoPush:false prints nothing and does nothing', r.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    test_overlap_and_registration()
    test_merge_and_prepush()
    test_autopush()
    print('\n%d passed, %d failed' % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
