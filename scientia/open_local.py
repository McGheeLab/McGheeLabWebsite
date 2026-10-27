"""open_local.py — what a scientia:// link does on this computer (V3.928).

  scientia://start          make sure the app runs here (the lab site's button opens the tab itself)
  scientia://open[?h=#/…]   the same, then open it in the default browser (the Start menu entry)

The installer registers it for this user (HKCU\\Software\\Classes\\scientia). The browser asks once whether the lab
site may open scientia links.
"""
import os, subprocess, sys, time, webbrowser
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from service import PORT, running   # noqa: E402


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else 'scientia://open'
    u = urlparse(url); verb = (u.netloc or u.path.strip('/') or 'open').lower()
    if not running():
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0)
        subprocess.Popen([sys.executable, os.path.join(HERE, 'service.py')], cwd=HERE, creationflags=flags, close_fds=True)
        for _ in range(60):
            if running(): break
            time.sleep(0.5)
    if verb == 'open':
        h = (parse_qs(u.query).get('h') or [''])[0]
        webbrowser.open('http://localhost:%d/scientia.html%s' % (PORT, h if h.startswith('#/') else ''))


if __name__ == '__main__':
    main()
