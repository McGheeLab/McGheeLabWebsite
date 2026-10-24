#!/usr/bin/env python3
"""Build the self-contained simulator pages.

    python3 Research/bead_confocal_sim/interactive/build.py                     # src/*.html -> *.html
    python3 Research/bead_confocal_sim/interactive/build.py pe-bead-binding     # one page
    python3 Research/bead_confocal_sim/interactive/build.py --check

Each page in src/ carries the markers /*KIT_CSS*/ (inside its <style>) and /*KIT_JS*/ (inside its <script>);
the shared kit (src/kit.css, src/kit.js) is inlined there, and /*INCLUDE:name.js*/ inlines src/name.js (a model
engine kept in its own file so node can test it against the Python), so a published page is ONE file with no requests:
it runs offline on the desktop and inside Scientia's sandboxed frame. The build refuses a page that loads
anything from the network, has a colour emoji, or whose script fails `node --check`.
"""
import pathlib, re, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / 'src'
EMOJI = re.compile('[\U0001F300-\U0001FAFF☀-➿⭐✅❌]')


def build(page, check=False):
    text = page.read_text()
    css, js = (SRC / 'kit.css').read_text(), (SRC / 'kit.js').read_text()
    if '/*KIT_CSS*/' not in text or '/*KIT_JS*/' not in text:
        sys.exit(f'{page.name}: missing a /*KIT_CSS*/ or /*KIT_JS*/ marker')
    out = text.replace('/*KIT_CSS*/', css).replace('/*KIT_JS*/', js)
    out = re.sub(r'/\*INCLUDE:([\w.-]+)\*/', lambda m: (SRC / m.group(1)).read_text(), out)
    if re.search(r'<(script|link|img|iframe)[^>]+(src|href)="(https?:)?//', out):
        sys.exit(f'{page.name}: loads something from the network')
    if EMOJI.search(out):
        sys.exit(f'{page.name}: contains a colour emoji')
    scripts = re.findall(r'<script>(.*?)</script>', out, re.S)
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write('\n;\n'.join(scripts))
    r = subprocess.run(['node', '--check', f.name], capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'{page.name}: script does not parse\n{r.stderr}')
    dest = HERE / page.name
    if check:
        if not dest.exists() or dest.read_text() != out:
            sys.exit(f'{dest.name} is out of date: run build.py')
        return dest
    dest.write_text(out)
    return dest


if __name__ == '__main__':
    names = [a for a in sys.argv[1:] if not a.startswith('--')]
    pages = [SRC / (n if n.endswith('.html') else n + '.html') for n in names] if names else sorted(SRC.glob('*.html'))
    for p in pages:
        d = build(p, '--check' in sys.argv)
        print(f'{d.name}: {d.stat().st_size / 1024:.1f} KB')
