/* ==========================================================================
   15c · The Portfolio's layout is the person's (V3.948, Gabe's SiS Shaping,
   Phase C). The lab's Portfolio (lab-mode §10) keeps where its cards are and
   which are folded per device (_ls lab:portfolio). Here that key is
   mirrored into the notebook's settings (settings().portfolio, synced like
   the pills' layout), and the settings copy is written back before the
   Portfolio draws — so a card moved on one computer is there on the other.
   No lab-layer change; the mirror watches the key.
   ========================================================================== */
const PFSYNC = {
  KEY: 'lab:portfolio', busy: false,
  same: (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null),
  /** The notebook's copy into this device's key (before the Portfolio draws). */
  pull() { try { const s = settings().portfolio; if (!s || typeof s !== 'object') return false; if (PFSYNC.same(_ls.get(PFSYNC.KEY, null), s)) return false; PFSYNC.busy = true; _ls.set(PFSYNC.KEY, s); PFSYNC.busy = false; return true; } catch (e) { PFSYNC.busy = false; return false; } },
  /** This device's key into the notebook (whenever the Portfolio saves it). */
  push(v) { try { if (!v || typeof v !== 'object' || PFSYNC.same(settings().portfolio, v)) return; saveSettings({ portfolio: JSON.parse(JSON.stringify(v)) }); } catch (e) { } },
};
{
  const set = _ls.set; _ls.set = function (k, v) { const r = set.apply(this, arguments); if (k === PFSYNC.KEY && !PFSYNC.busy) PFSYNC.push(v); return r; };
  const rf = App.refresh; App.refresh = function () { try { if (App.parse().name === 'portfolio') PFSYNC.pull(); } catch (e) { } return rf.apply(this, arguments); };
}
