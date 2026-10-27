"""service.py — keeps this app's server running in the background, from login to shutdown, and up to date (V3.928, V3.935).

The installer starts it at login (HKCU Run) with pythonw, so there is no window. It runs serve.py with no browser and
restarts it if it stops on an error (waiting longer each time, up to a minute). serve.py ending normally (exit 0: the
app's Quit or Remove…) ends this too. A second copy finds the first one answering on the port and leaves.

Updates (V3.935), so a change to Scientia on the lab site reaches this computer on its own: two minutes after it starts,
then every hour (or at once when Settings → The lab asks), it reads the site's version.json. When the site has another
version of the app, it downloads the download (checked against its sha256), unpacks it beside the app, checks it is that
version, stops the server (which saves first), puts the new files in place and starts again from them — a few seconds.
The notebook folder, the connection to the lab and the app's own images / recordings / backup folders are not touched.
What it is doing is in update.json (Settings → The lab shows it). A copy run from a checkout (no VERSION.txt) never updates.
Output goes to service.log next to the app folder (kept under 5 MB).
"""
import hashlib, io, json, os, shutil, subprocess, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)                       # %LOCALAPPDATA%\ScientiaInSitu
PORT = int(os.environ.get('SIS_PORT', 8766))
SITE = os.environ.get('SIS_SITE', 'https://mcgheelab.com')
LOG = os.path.join(BASE, 'service.log')
STATUS = os.path.join(BASE, 'update.json')
NOW = os.path.join(BASE, 'update-now')             # Settings → The lab → Check for updates now
STAGE = os.path.join(BASE, 'update')
KEEP = {'images', 'recordings', 'backup', '__pycache__'}   # the app folder's own data: never replaced or removed
FIRST, EVERY = 120, 3600
FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def running():
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/api/lab/ping' % PORT, timeout=2) as r:
            return json.loads(r.read() or b'{}').get('app') == 'scientia-in-situ'
    except Exception:
        return False


def log_file():
    try:
        if os.path.getsize(LOG) > 5 * 1024 ** 2: os.replace(LOG, LOG + '.old')
    except OSError:
        pass
    return open(LOG, 'a', encoding='utf-8', errors='replace')


def note(msg):
    with log_file() as f: f.write('%s  %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))


# ---------------- updates ----------------
def installed():
    try:
        with open(os.path.join(HERE, 'VERSION.txt'), encoding='utf-8') as f: return f.read().strip() or None
    except OSError:
        return None


def status(**kw):
    try:
        with open(STATUS, encoding='utf-8') as f: s = json.load(f)
    except Exception:
        s = {}
    s.update(kw, version=installed())
    tmp = STATUS + '.part'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(s, f, indent=1)
    os.replace(tmp, STATUS)


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()


def check():
    """The site's version.json when it offers another app than this one, else None."""
    v = json.loads(fetch(SITE + '/rm/scientia/desktop/version.json?t=%d' % time.time(), 30) or b'{}')
    status(checked=time.strftime('%Y-%m-%dT%H:%M:%S'), latest=v.get('app'))
    if not v.get('app') or v['app'] == installed(): status(state='current', message=''); return None
    return v


def download(v):
    """The new app, unpacked and checked, in STAGE; its folder."""
    status(state='downloading', message='Downloading Scientia %s…' % v['app'])
    data = fetch(SITE + '/rm/scientia/desktop/' + (v.get('download') or 'ScientiaInSitu-Windows.zip') + '?v=' + v['app'], 600)
    if v.get('sha256') and hashlib.sha256(data).hexdigest() != v['sha256']:
        raise RuntimeError('the download does not match its checksum (the site may be mid-deploy) — trying again later')
    shutil.rmtree(STAGE, ignore_errors=True)
    zipfile.ZipFile(io.BytesIO(data)).extractall(STAGE)
    app = os.path.join(STAGE, 'Scientia In Situ', 'app')
    try:
        with open(os.path.join(app, 'VERSION.txt'), encoding='utf-8') as f: got = f.read().strip()
    except OSError:
        got = None
    if got != v['app'] or not os.path.isfile(os.path.join(app, 'serve.py')):
        raise RuntimeError('the download is not version %s' % v['app'])
    return app


def put_in_place(app):
    """The new files over the old; files the new app no longer has are removed (the app's own data folders stay)."""
    new = set()
    for d, dirs, files in os.walk(app):
        rel = os.path.relpath(d, app)
        os.makedirs(os.path.join(HERE, rel), exist_ok=True)
        for f in files:
            r = os.path.normpath(os.path.join(rel, f)); new.add(r)
            shutil.copy2(os.path.join(app, r), os.path.join(HERE, r))
    for d, dirs, files in os.walk(HERE, topdown=True):
        rel = os.path.relpath(d, HERE)
        if rel == '.': dirs[:] = [x for x in dirs if x not in KEEP]
        for f in files:
            r = os.path.normpath(os.path.join(rel, f))
            if r not in new:
                try: os.remove(os.path.join(HERE, r))
                except OSError: pass
    shutil.rmtree(STAGE, ignore_errors=True)


def stop_server(p):
    """Quit saves what is pending before the server exits."""
    try:
        req = urllib.request.Request('http://127.0.0.1:%d/api/lab/quit' % PORT, data=b'{}', method='POST', headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=10).read()
        p.wait(timeout=30)
    except Exception:
        p.terminate(); p.wait(timeout=30)


def restart_self():
    subprocess.Popen([sys.executable, os.path.join(HERE, 'service.py')], cwd=BASE, creationflags=FLAGS | getattr(subprocess, 'DETACHED_PROCESS', 0), close_fds=True)


# ---------------- the loop ----------------
def main():
    if running(): return
    env = dict(os.environ, SIS_NOBROWSER='1', SIS_SERVICE='1', PYTHONUTF8='1')
    wait, auto = 2.0, installed() is not None
    if auto and not os.path.isfile(STATUS): status(state='current')
    next_check = time.time() + FIRST
    while True:
        with log_file() as out:
            out.write('\n%s  starting serve.py (Scientia %s)\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), installed() or 'from a checkout')); out.flush()
            t0 = time.time()
            p = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py')], cwd=HERE, env=env, stdout=out, stderr=subprocess.STDOUT, creationflags=FLAGS)
            while p.poll() is None:
                time.sleep(3)
                if not auto: continue
                asked = os.path.exists(NOW)
                if not (asked or time.time() >= next_check): continue
                next_check = time.time() + EVERY
                try:
                    if asked: os.remove(NOW)
                except OSError: pass
                try:
                    v = check()
                    if not v: continue
                    app = download(v)
                    status(state='installing', message='Installing Scientia %s…' % v['app'])
                    note('updating %s -> %s' % (installed(), v['app']))
                    stop_server(p)
                    put_in_place(app)
                    status(state='updated', message='', updatedAt=time.strftime('%Y-%m-%dT%H:%M:%S'))
                    note('updated to %s; starting again' % installed())
                    restart_self(); return
                except Exception as e:
                    status(state='error', message=str(e)); note('update: %s' % e)
                    next_check = time.time() + 600   # a deploy caught half way, or no connection: again in ten minutes
            code = p.returncode
            out.write('%s  serve.py ended (%s)\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), code))
        if code == 0: return                            # asked to stop (Quit, Remove…)
        if time.time() - t0 > 300: wait = 2.0           # it ran a while: a fresh failure, not a loop
        if running(): return                            # someone else serves the port now
        time.sleep(wait); wait = min(60.0, wait * 2)


if __name__ == '__main__':
    main()
