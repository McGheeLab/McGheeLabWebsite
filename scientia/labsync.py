"""labsync.py — this computer and the lab cloud as one notebook, always (V3.928).

serve.py runs it as a thread for as long as the app's server runs (and the installed app's server runs from login to
shutdown), so nothing has to be started by hand. Once this computer is connected (a key in cloud.json next to the
config — made by pairing from the lab site, or by `scientia-cloud.py --key` before), it runs the lab's own bridge:
vendor/scientia_cloud.py, a copy of rm/scientia/scientia-cloud.py that scripts/scientia_build.py keeps current. That file
is never edited here; this module only paces it and keeps it alive.

Pacing, so a note written here shows on the tablet (the website) and the other way round within a couple of seconds:
  - a change on this computer wakes the loop at once (it waits on the local hub's own long-poll);
  - the cloud is asked every FAST seconds while a window of the app is open here or something changed lately,
    every SLOW seconds otherwise, and every IDLE seconds after half an hour of quiet (the cloud is a paid function).
Offline: it keeps trying (backing off to a minute) and catches up when the connection is back. If this computer's change
history no longer reaches back to the last sync (offline for a very long time), it realigns from the record both sides
agreed on last (shadow.json), three-way, instead of asking which side wins.
"""
import importlib.util, json, os, threading, time, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
FAST, SLOW, IDLE = 1.5, 15.0, 60.0
RECENT, QUIET = 120.0, 1800.0          # "changed lately" / "half an hour of quiet"


def load_bridge(port, cloud_cfg):
    """The lab's bridge module, pointed at this server and this computer's cloud.json."""
    os.environ['SIS_URL'] = 'http://127.0.0.1:%d' % port
    os.environ['SIS_CLOUD_CONFIG'] = cloud_cfg
    spec = importlib.util.spec_from_file_location('scientia_cloud', os.path.join(HERE, 'vendor', 'scientia_cloud.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


class LabSync(threading.Thread):
    def __init__(self, port, cloud_cfg, app_active, local_state):
        super().__init__(name='labsync', daemon=True)
        self.port, self.cloud_cfg, self.app_active, self.local_state = port, cloud_cfg, app_active, local_state
        self.sc = None; self.bridge = None; self.prefer = None
        self.wake = threading.Event(); self.halt = threading.Event()
        self.status = {'state': 'starting', 'message': '', 'lastSync': None, 'lastChange': None, 'choice': None}
        self.last_change = 0.0

    # ---- what the app shows ----
    def cfg(self):
        try:
            with open(self.cloud_cfg, encoding='utf-8') as f: return json.load(f)
        except Exception: return {}
    def connected(self): return bool((self.cfg().get('key') or '').startswith('sck_'))
    def local_conn(self): return ((self.cfg().get('sides') or {}).get('local') or {}).get('conn')
    def snapshot(self):
        c = self.cfg(); s = dict(self.status)
        s.update(connected=self.connected(), account=c.get('account') or None, computer=c.get('computer') or None)
        if not s['connected']: s['state'] = 'not-connected'
        return s
    def _set(self, state, message='', **kw):
        self.status.update(state=state, message=message, **kw)
    def _log(self, *a):
        msg = ' '.join(str(x) for x in a)
        if 'change' in msg or 'media:' in msg or 'replacing' in msg: self.last_change = time.time(); self.status['lastChange'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        self.status['message'] = msg

    # ---- what the app asks ----
    def kick(self): self.wake.set()
    def choose(self, prefer):
        if prefer in ('local', 'cloud'): self.prefer = prefer; self.status['choice'] = None; self.kick()
    def stop(self): self.halt.set(); self.wake.set()

    # ---- the loop ----
    def run(self):
        backoff = 5.0
        while not self.halt.is_set():
            if not self.connected():
                self._set('not-connected', 'This computer is not connected to the lab yet'); self._sleep(5); continue
            try:
                if self.sc is None:
                    self.sc = load_bridge(self.port, self.cloud_cfg); self.sc.log = self._log
                b = self.bridge = self.sc.Bridge(self.cfg(), prefer=self.prefer, interval=FAST)
                self.prefer = None
                self._set('aligning', 'Connecting to the lab cloud…')
                b.align(); b.sync_media()
                self._set('syncing', 'In step with the lab cloud', lastSync=time.strftime('%Y-%m-%dT%H:%M:%S'))
                backoff, n = 5.0, 0
                while not self.halt.is_set() and self.connected():
                    c0, l0 = b.C.seq, b.L.seq
                    b.step(); n += 1
                    if b.C.seq != c0 or b.L.seq != l0: self.last_change = time.time()
                    self.status.update(state='syncing', lastSync=time.strftime('%Y-%m-%dT%H:%M:%S'))
                    if n % 240 == 0: b.sync_media()
                    self._pace(b)
            except Exception as e:
                name = type(e).__name__
                if name == 'Realign': continue                                   # a side was replaced: align again
                if isinstance(e, PermissionError):
                    self._set('key-refused', 'The lab no longer accepts this computer\'s key — connect it again from the lab site'); self._sleep(60); continue
                if isinstance(e, (urllib.error.URLError, ConnectionError, TimeoutError, OSError)):
                    self._set('offline', 'Waiting for the lab cloud (%s) — changes are kept here meanwhile' % (getattr(e, 'reason', None) or e))
                    self._sleep(backoff); backoff = min(60.0, backoff * 2); continue
                self._set('error', '%s: %s' % (name, e)); self._sleep(backoff); backoff = min(60.0, backoff * 2)
            except SystemExit as e:                                               # the bridge's "decide" and "trimmed" exits
                msg = str(e)
                if 'trimmed' in msg or 'sync memory' in msg:
                    try:
                        self._set('realigning', 'Catching up after a long time apart…'); self.realign(); continue
                    except Exception as x: self._set('error', 'Could not catch up: %s' % x); self._sleep(60); continue
                if 'Both this computer' in msg:
                    self._set('needs-choice', msg, choice=msg); self._wait_choice(); continue
                self._set('error', msg); self._sleep(60)

    def _sleep(self, s):
        self.wake.wait(s); self.wake.clear()
    def _wait_choice(self):
        while not self.halt.is_set() and self.prefer is None: self._sleep(5)
    def _pace(self, b):
        quiet = time.time() - self.last_change
        every = FAST if (self.app_active() or quiet < RECENT) else (SLOW if quiet < QUIET else IDLE)
        t0 = time.time()
        try: b.L.pull(wait=every)                     # returns at once when this computer changed something
        except Exception: self._sleep(every)
        left = every - (time.time() - t0)
        if left > 0.05 and not self.wake.is_set(): time.sleep(min(left, 0.25))   # a local change: go now (debounced)
        self.wake.clear()

    # ---- catching up when this computer's history no longer reaches the last sync ----
    def realign(self):
        """Diff both full records against the last agreed one (shadow.json) and send each side's changes as the bridge's
        step() does, so each hub runs its own three-way merge (a field changed on both sides waits under the warning
        triangle). Only when neither side was replaced (same sids); otherwise align() decides as usual."""
        sc = self.sc; cfg = self.cfg(); b = sc.Bridge(cfg)
        known_l, known_c = cfg['sides']['local'], cfg['sides']['cloud']
        hl, hc = b.L.hello(), b.C.hello()
        if not hl or not hc or hl.get('sid') != known_l.get('sid') or hc.get('sid') != known_c.get('sid'):
            raise RuntimeError('a side was replaced; align() decides')
        anc = b.load_shadow()
        if anc is None: raise RuntimeError('no shadow.json to compare against')
        def rows(state):
            out = {}
            for store, rs in (state.get('stores') or {}).items():
                if store in sc.NOSYNC: continue
                k = sc.KEYS.get(store, 'id')
                for r in rs:
                    if isinstance(r, dict) and r.get(k) is not None: out[sc.key_of(store, r[k])] = r
            return out
        loc, cld = rows(self.local_state()), rows(b.C.state())
        newL, newC = {}, {}
        for k in set(anc) | set(loc) | set(cld):
            a, l, c = anc.get(k), loc.get(k), cld.get(k)
            if l == a and c == a: continue
            if l == c: anc[k] = l; continue
            if l != a: newL[k] = l if l is not None else sc.DEL
            if c != a: newC[k] = c if c is not None else sc.DEL
        b.L.sid, b.C.sid = hl['sid'], hc['sid']
        baseL, baseC = int(known_l.get('seq') or 0), int(known_c.get('seq') or 0)
        b.L.seq, b.C.seq = int(hl.get('seq') or 0), int(hc.get('seq') or 0)
        b.shadow = {k: v for k, v in anc.items() if v is not None}
        get = b.shadow.get
        resL = b.push_batch(b.L, newC, baseL, prev=get, name='Online copy')
        toC = {k: v for k, v in newL.items() if k not in newC}
        toC.update({k: resL[k] for k in newC if k in newL or resL[k] != newC[k]})
        resC = b.push_batch(b.C, toC, baseC, prev=lambda k: newC[k] if k in newC else get(k), name='This computer')
        final = {}
        for d in (newC, resL, newL, toC, resC): final.update(d)
        for k, v in final.items():
            if v is sc.DEL: b.shadow.pop(k, None)
            else: b.shadow[k] = v
        b.save_shadow(); b.remember()
        self.last_change = time.time()
        self._log('caught up: %d change(s) the cloud -> this computer, %d this computer -> the cloud' % (len(newC), len(toC)))
