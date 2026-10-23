#!/usr/bin/env python3
"""Inline the icons a self-contained course module uses (V3.861).

A module is ONE self-contained HTML file (modules/AUTHORING.md §0) that can be
opened directly, so it cannot lean on /rm/js/icons.js the way the site does.
Instead each module carries a small inline sprite of exactly the icons it
references, generated from the same source of truth (rm/js/icons.js, itself
generated from scripts/icons.manifest.json):

    static HTML   <svg class="hi" aria-hidden="true"><use href="#hi-calculator"/></svg>
    solid weight  <svg class="hi hi-solid" aria-hidden="true"><use href="#hi-star-solid"/></svg>
    in a script   HI.svg('calculator')            -> the same markup string
                  HI.svg('dot', {solid:1, tint:'#ef4444'})
                  HI.draw(ctx, 'beer', x, y, 18, '#334155')   onto a <canvas>

Run after adding or removing an icon in a module (idempotent; rewrites only the
block between the hi-icons markers, inserted right after <body>):

    python3 scripts/module_icons.py modules/bme466/hw-01-transport-problems.html [...]
    python3 scripts/module_icons.py --all          # every modules/**/*.html that uses one
    python3 scripts/module_icons.py --check --all  # exit 1 if any block is stale / an icon is unknown
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS_JS = ROOT / 'rm' / 'js' / 'icons.js'
START = '<!-- hi-icons:start'
END = '<!-- hi-icons:end -->'
REF = re.compile(r'''href="#hi-([a-z0-9-]+?)(-solid)?"'''
                 r'''|HI\.svg\(\s*['"]([a-z0-9-]+)['"]([^)\n]{0,80})'''
                 r'''|HI\.draw\((?:[^,()\n]|\([^()\n]*\))*,\s*['"]([a-z0-9-]+)['"]([^;\n]{0,120})''')


def load_icons():
    src = ICONS_JS.read_text(encoding='utf-8')
    def grab(var):
        m = re.search(r'var %s = (\{.*?\});\n' % var, src)
        return json.loads(m.group(1))
    return grab('OUTLINE'), grab('SOLID')


CSS = ('.hi{width:1em;height:1em;display:inline-block;vertical-align:-0.125em;flex:none;fill:none;'
       'stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;overflow:visible}'
       '.hi-solid{fill:currentColor;stroke:none}')

# HI.draw reads the geometry back out of the sprite, so nothing is duplicated.
JS = r"""window.HI={svg:function(n,o){o=o||{};var s=o.solid?'-solid':'';return '<svg class="hi'+(o.solid?' hi-solid':'')+(o.cls?' '+o.cls:'')+'"'+(o.tint?' style="color:'+o.tint+'"':'')+(o.label?' role="img" aria-label="'+String(o.label).replace(/"/g,'&quot;')+'"':' aria-hidden="true"')+'><use href="#hi-'+n+s+'"/></svg>';},
draw:function(c,n,x,y,z,col,o){o=o||{};var sym=document.getElementById('hi-'+n+(o.solid?'-solid':''));if(!c||!sym||typeof Path2D==='undefined')return;var k=(z||16)/24;c.save();c.translate(x,y);c.scale(k,k);c.lineWidth=1.5;c.lineCap='round';c.lineJoin='round';c.strokeStyle=c.fillStyle=col||'#475569';
[].forEach.call(sym.children,function(e){var a=function(q){return parseFloat(e.getAttribute(q))||0},p=new Path2D(),t=e.tagName.toLowerCase();if(t==='path')p=new Path2D(e.getAttribute('d'));else if(t==='circle')p.arc(a('cx'),a('cy'),a('r'),0,7);else if(t==='ellipse')p.ellipse(a('cx'),a('cy'),a('rx'),a('ry'),0,0,7);else if(t==='rect')p.rect(a('x'),a('y'),a('width'),a('height'));else if(t==='line'){p.moveTo(a('x1'),a('y1'));p.lineTo(a('x2'),a('y2'));}else{var v=(e.getAttribute('points')||'').trim().split(/[\s,]+/).map(parseFloat);for(var i=0;i+1<v.length;i+=2)p[i?'lineTo':'moveTo'](v[i],v[i+1]);if(t==='polygon')p.closePath();}
if(o.solid)c.fill(p,'evenodd');else c.stroke(p);});c.restore();}};"""


def block_for(names, outline, solid):
    syms = []
    for n, want_solid in sorted(names):
        body = (solid.get(n) if want_solid else outline.get(n))
        if body is None:
            raise KeyError(n + ('-solid' if want_solid else ''))
        syms.append('<symbol id="hi-%s%s" viewBox="0 0 24 24">%s</symbol>' % (n, '-solid' if want_solid else '', body))
    return ('%s (scripts/module_icons.py — generated; re-run after adding an icon) -->\n'
            '<style>%s</style>\n'
            '<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>%s</defs></svg>\n'
            '<script>%s</script>\n%s' % (START, CSS, ''.join(syms), JS, END))


def wanted(html):
    body = re.sub(re.escape(START) + r'.*?' + re.escape(END), '', html, flags=re.S)
    names = set()
    for m in REF.finditer(body):
        if m.group(1):
            names.add((m.group(1), bool(m.group(2))))
        elif m.group(3):
            names.add((m.group(3), 'solid' in (m.group(4) or '')))
        else:
            names.add((m.group(5), 'solid' in (m.group(6) or '')))
    # a draw()/svg() of a solid icon still needs its outline twin for the fallback
    return names


def process(path, outline, solid, check):
    html = path.read_text(encoding='utf-8')
    names = wanted(html)
    has = START in html
    if not names and not has:
        return 'skip'
    # `HI` is the sprite's global (window.HI). A module variable with that name
    # shadows it and the icons silently stop drawing — 01-diffusion's drawBite()
    # had `const LO=-9, HI=0.35` and its marker vanished with no console error.
    body = re.sub(re.escape(START) + r'.*?' + re.escape(END), '', html, flags=re.S)
    if names and re.search(r'\b(?:var|let|const)\b[^;\n]*?(?<![\w.$])HI\s*=(?!=)|function\s+HI\b', body):
        print('  %s: declares its own `HI`, which hides the icon helper — rename that variable' % path.relative_to(ROOT))
        return 'bad'
    unknown = [n for n, s in names if (solid if s else outline).get(n) is None]
    if unknown:
        print('  %s: unknown icon(s) %s — add them to scripts/icons.manifest.json, run gen-icons' % (path.relative_to(ROOT), ', '.join(sorted(unknown))))
        return 'bad'
    new_block = block_for(names, outline, solid) if names else ''
    if has:
        out = re.sub(re.escape(START) + r'.*?' + re.escape(END), lambda _: new_block, html, count=1, flags=re.S)
    else:
        m = re.search(r'<body[^>]*>', html)
        if not m:
            print('  %s: no <body> tag' % path.relative_to(ROOT)); return 'bad'
        out = html[:m.end()] + '\n' + new_block + html[m.end():]
    if out == html:
        return 'ok'
    if check:
        print('  %s: icon block is stale — run scripts/module_icons.py' % path.relative_to(ROOT)); return 'bad'
    path.write_text(out, encoding='utf-8')
    return 'wrote'


def main(argv):
    check = '--check' in argv
    files = [a for a in argv if not a.startswith('--')]
    if '--all' in argv:
        files += [str(p) for p in sorted((ROOT / 'modules').rglob('*.html'))]
    outline, solid = load_icons()
    bad = 0
    for f in files:
        p = pathlib.Path(f).resolve()
        r = process(p, outline, solid, check)
        if r == 'bad':
            bad += 1
        elif r == 'wrote':
            print('  wrote %s' % p.relative_to(ROOT))
    if bad:
        print('module_icons: %d file(s) need attention' % bad); return 1
    print('module_icons: ok (%d file(s) checked)' % len(files)); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
