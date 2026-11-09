#!/usr/bin/env python3
"""Scientia macros (V3.947): the command vocabulary, and a check of a .sis-macro.json file before it is imported.

    python scripts/scientia_macro.py list            every command with its arguments, then the + Insert rows
    python scripts/scientia_macro.py list --json     the same as JSON (the scientia-macro skill reads this)
    python scripts/scientia_macro.py check FILE…     what is wrong with each macro file (exit 1 when anything is)

The commands are read from scientia/src/11b-commands.js — one `C('slash', 'label', [A('name', 'kind', {…})…], run, {…})`
per line — and the insert rows from every `INSERTS.push({ id: '…'` in scientia/src and rm/scientia/lab-mode.js, so the
list is the build's, never a copy kept by hand. A macro file:

    { "format": "sis-macro/1", "name": "Start a gel run", "slash": "gelrun",
      "params": [{ "name": "title", "ask": "Title of the run", "default": "Gel run {date}" }],
      "steps": [ { "cmd": "new", "args": { "type": "experiment", "title": "{title}" } },
                 { "cmd": "insert", "args": { "row": "protocol", "pick": "Gel casting" } },
                 { "cmd": "timer", "args": { "action": "start" } },
                 { "cmd": "flag", "when": "{ask: Flag it for the weekly review?}" } ] }
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'scientia', 'src')
ALIAS = {'rmpaper': 'paper', 'rmprotocol': 'protocol', 'rmaction': 'action', 'rmcollection': 'labcollection', 'material-new': 'newmaterial',
         'equation-reg': 'registered', 'table-empty': 'emptytable', 'canvas-add': 'canvas', 'pull-barrier': 'barrier', 'pull-item': 'structure', 'pull-comp': 'component'}
BUILTIN_VARS = {'date', 'time', 'note', 'project'}
LINE = re.compile(r"^\s*C\('([a-z][a-z0-9-]*)', '((?:[^'\\]|\\.)*)', \[(.*?)\], ")
ARG = re.compile(r"A\('(\w+)', '(\w+)'(?:, \{([^}]*)\})?\)")
CHOICES = re.compile(r"choices: \[([^\]]*)\]")


def commands():
    out = []
    with open(os.path.join(SRC, '11b-commands.js'), encoding='utf-8') as f:
        for line in f:
            m = LINE.match(line)
            if not m: continue
            slash, label, args = m.group(1), m.group(2).replace("\\'", "'"), []
            for a in ARG.finditer(m.group(3)):
                opts = a.group(3) or ''
                arg = {'name': a.group(1), 'kind': a.group(2), 'optional': 'optional: true' in opts, 'rest': 'rest: true' in opts}
                c = CHOICES.search(opts)
                if c: arg['choices'] = re.findall(r"'([^']*)'", c.group(1))
                args.append(arg)
            tail = line[m.end():]
            al = re.search(r"alias: \[([^\]]*)\]", tail); grp = re.search(r"group: '([^']*)'", tail); scope = re.search(r"scope: '([^']*)'", tail)
            out.append({'slash': slash, 'label': label, 'args': args, 'alias': re.findall(r"'([^']*)'", al.group(1)) if al else [],
                        'group': grp.group(1) if grp else 'Notebook', 'scope': scope.group(1) if scope else 'both'})
    return out


def inserts():
    ids = []
    files = [os.path.join(SRC, f) for f in sorted(os.listdir(SRC)) if f.endswith('.js')] + [os.path.join(ROOT, 'rm', 'scientia', 'lab-mode.js')]
    for p in files:
        if not os.path.isfile(p): continue
        with open(p, encoding='utf-8') as f:
            for m in re.finditer(r"INSERTS\.push\(\{ id: '([\w-]+)'", f.read()):
                if m.group(1) not in ids: ids.append(m.group(1))
    return [{'id': i, 'slash': ALIAS.get(i, i)} for i in ids]


def vocabulary():
    cmds, ins = commands(), inserts()
    known = {}
    for c in cmds:
        known[c['slash']] = c
        for a in c['alias']: known[a] = c
    for i in ins:
        if i['slash'] not in known: known[i['slash']] = {'slash': i['slash'], 'label': 'Insert ' + i['id'], 'args': [{'name': 'pick', 'kind': 'text', 'optional': True, 'rest': True}], 'alias': [], 'group': 'Insert', 'scope': 'both'}
        known['insert-' + i['id']] = known[i['slash']]
    return cmds, ins, known


def sig(c):
    return '/' + c['slash'] + ''.join(' ' + ('[' if a['optional'] else '<') + a['name'] + (']' if a['optional'] else '>') for a in c['args'])


def check(path):
    errors = []
    try:
        with open(path, encoding='utf-8') as f: m = json.load(f)
    except Exception as e:
        return ['not JSON: %s' % e]
    if not isinstance(m, dict): return ['the file must hold one macro object']
    cmds, ins, known = vocabulary()
    if m.get('format') != 'sis-macro/1': errors.append('format must be "sis-macro/1"')
    if not isinstance(m.get('name'), str) or not m['name'].strip(): errors.append('name is missing')
    slash = str(m.get('slash') or '')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', slash): errors.append('slash must be letters, digits and dashes, starting with a letter')
    elif slash in known: errors.append('/%s is a built-in command' % slash)
    params = m.get('params') or []
    if not isinstance(params, list): errors.append('params must be a list'); params = []
    names = set(BUILTIN_VARS)
    for i, p in enumerate(params):
        if not isinstance(p, dict) or not re.fullmatch(r'[A-Za-z_]\w*', str(p.get('name') or '')): errors.append('param %d needs a name' % (i + 1))
        else: names.add(p['name'])
    steps = m.get('steps')
    if not isinstance(steps, list) or not steps: errors.append('steps must be a non-empty list'); steps = []
    for i, s in enumerate(steps):
        n = 'step %d' % (i + 1)
        if not isinstance(s, dict): errors.append(n + ' is not an object'); continue
        c = known.get(str(s.get('cmd') or '').lstrip('/'))
        if not c: errors.append('%s: no command /%s' % (n, s.get('cmd'))); continue
        args = s.get('args') or {}
        if not isinstance(args, dict): errors.append(n + ': args must be an object'); args = {}
        have = {a['name'] for a in c['args']}
        for k in args:
            if k != 'pick' and k not in have: errors.append('%s: /%s has no argument "%s"%s' % (n, c['slash'], k, (' (it takes ' + ', '.join(sorted(have)) + ')') if have else ''))
        for a in c['args']:
            if not a['optional'] and not args.get(a['name']): errors.append('%s: /%s needs "%s"' % (n, c['slash'], a['name']))
            if a.get('choices') and args.get(a['name']) and str(args[a['name']]).lower() not in [x.lower() for x in a['choices']] and '{' not in str(args[a['name']]):
                errors.append('%s: %s must be one of %s' % (n, a['name'], ' · '.join(a['choices'])))
        if 'when' in s and not isinstance(s['when'], str): errors.append(n + ': when must be text')
    for k in re.findall(r'\{([A-Za-z_]\w*)\}', json.dumps(steps) + json.dumps([p.get('default', '') for p in params if isinstance(p, dict)])):
        if k not in names: errors.append('{%s} is not a param (params: %s)' % (k, ', '.join(sorted(names))))
    return errors


def main(argv):
    if not argv or argv[0] not in ('list', 'check'):
        print(__doc__); return 2
    if argv[0] == 'list':
        cmds, ins, known = vocabulary()
        if '--json' in argv:
            print(json.dumps({'commands': cmds, 'inserts': ins}, indent=1, ensure_ascii=False)); return 0
        for g in sorted({c['group'] for c in cmds}, key=lambda g: ['Go', 'Find', 'Note', 'Hand & view', 'Notebook', 'Insert'].index(g) if g in ['Go', 'Find', 'Note', 'Hand & view', 'Notebook', 'Insert'] else 99):
            print('\n' + g)
            for c in sorted([c for c in cmds if c['group'] == g], key=lambda c: c['slash']):
                extra = ''.join('  %s: one of %s' % (a['name'], ' · '.join(a['choices'])) for a in c['args'] if a.get('choices'))
                print('  %-40s %s%s%s' % (sig(c), c['label'], ('  (also /' + ' /'.join(c['alias']) + ')') if c['alias'] else '', extra))
        print('\nInsert rows (/insert <row> [pick], or the row as its own command)')
        print('  ' + '  '.join('/' + i['slash'] for i in ins))
        return 0
    bad = 0
    for p in argv[1:]:
        E = check(p)
        if E:
            bad += 1; print('%s: %d problem(s)' % (p, len(E)))
            for e in E: print('  - ' + e)
        else:
            with open(p, encoding='utf-8') as f: m = json.load(f)
            print('%s: ok — /%s "%s", %d step(s)%s' % (p, m['slash'], m['name'], len(m['steps']), (', asks ' + ', '.join(x['name'] for x in m.get('params') or [])) if m.get('params') else ''))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
