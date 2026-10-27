"""service.py — keeps this app's server running in the background, from login to shutdown (V3.928).

The installer starts it at login (HKCU Run) with pythonw, so there is no window. It runs serve.py with no browser and
restarts it if it stops on an error (waiting longer each time, up to a minute). serve.py ending normally (exit 0: the
app's Quit or Remove…) ends this too. A second copy finds the first one answering on the port and leaves.
Output goes to service.log next to the app folder (kept under 5 MB).
"""
import json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('SIS_PORT', 8766))
LOG = os.path.join(os.path.dirname(HERE), 'service.log')


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


def main():
    if running(): return
    env = dict(os.environ, SIS_NOBROWSER='1', SIS_SERVICE='1', PYTHONUTF8='1')
    wait = 2.0
    while True:
        with log_file() as out:
            out.write('\n%s  starting serve.py\n' % time.strftime('%Y-%m-%d %H:%M:%S')); out.flush()
            t0 = time.time()
            p = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py')], cwd=HERE, env=env, stdout=out, stderr=subprocess.STDOUT,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            code = p.wait()
            out.write('%s  serve.py ended (%s)\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), code))
        if code == 0: return                            # asked to stop (Quit, Remove…)
        if time.time() - t0 > 300: wait = 2.0           # it ran a while: a fresh failure, not a loop
        if running(): return                            # someone else serves the port now
        time.sleep(wait); wait = min(60.0, wait * 2)


if __name__ == '__main__':
    main()
