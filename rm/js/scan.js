/* scan.js — capture a label code (V3.646)
 *
 * One sheet, three input routes, in order of how often they are the right one:
 *
 *   1. TYPED / USB WEDGE — the DEFAULT on a desktop. The sheet opens with a focused field. A
 *      USB 2D barcode gun is a keyboard: it types the code and presses Enter.
 *      That is the cheapest, most robust path on a lab desktop, needs no
 *      permission, and is the fallback whenever a camera is denied or busy.
 *   2. CAMERA — opt-in, behind a button… except with open({ cameraFirst: true })
 *      (V3.847, the phone's scan tool and the app's inventory hero): the camera
 *      starts at once and the typed field hides behind "Type the code instead".
 *      Alex: "no one wants to ever add the code by text and the text isn't even
 *      on the printout of the label."
 *   3. Neither — every error path lands on the field, already focused.
 *
 * ⚠ TEARDOWN IS THE BUG THAT BITES. The native shell keeps hidden tabs ALIVE
 * and only toggles view.isHidden, so per tab-lifecycle.js:39-41
 * document.visibilityState is UNRELIABLE in a hidden WKWebView — the
 * visibilitychange handler will NOT fire and the camera light stays on after the
 * user switches tabs. _stopCamera() is therefore idempotent and wired to five
 * signals, including the app's own 'ourlab:tab-hidden' document event. We listen
 * to the RAW document events rather than claiming window.OURLAB_TAB_LIFECYCLE,
 * which is a single per-page hook that belongs to the page.
 *
 * ⚠ NO BarcodeDetector. iOS WKWebView has never shipped Shape Detection, and the
 * Ourlab app is the mobile target, so a vendored decoder is mandatory anyway.
 * Two decode paths where only one is ever exercised on a Mac is worse than 56 KB
 * gzipped. _decoders is left as a documented seam for a future native fast path.
 *
 * Global: window.SCAN
 */
(function () {
  'use strict';

  var JSQR_SRC = '/rm/vendor/jsqr/jsQR.js';
  var DUP_MS = 2500;            // ignore the same code re-decoded this fast
  var FPS = 10;                 // jsQR is O(pixels); 10/s is plenty for a still tube
  var ROI = 0.70;               // centred square, as a fraction of the smaller side
  var CONFIRM_FRAMES = 2;       // same code twice — kills a half-occluded neighbour

  var _css = false, _stream = null, _video = null, _canvas = null, _ctx = null;
  var _raf = null, _rvfc = null, _running = false, _decoderPromise = null;
  var _last = { code: '', at: 0 }, _streak = { code: '', n: 0 };
  var _audio = null, _beepOn = true;
  var _tracksStopped = 0;       // selftest counter — see ?selftest=scan
  var _onHit = null, _api = null, _statusEl = null, _reticleEl = null;

  var CSS =
    '.scn-wrap{display:flex;flex-direction:column;gap:10px;}' +
    '.scn-field{display:flex;gap:8px;}' +
    '.scn-field input{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'text-transform:uppercase;letter-spacing:.06em;}' +
    '.scn-go{min-height:44px;padding:0 16px;font-size:15px;font-weight:600;border:none;' +
      'border-radius:10px;background:var(--primary,#2563eb);color:#fff;cursor:pointer;}' +
    '.scn-alt{min-height:44px;font-size:15px;border:1px solid var(--border,#e2e8f0);' +
      'border-radius:10px;background:var(--card,#fff);color:var(--text,#0f172a);cursor:pointer;}' +
    '.scn-hint{font-size:12px;color:var(--text-muted,#64748b);}' +
    '.scn-stage{position:relative;border-radius:12px;overflow:hidden;background:#000;' +
      'aspect-ratio:4/3;display:none;}' +
    '.scn-stage.is-on{display:block;}' +
    '.scn-stage video{width:100%;height:100%;object-fit:cover;display:block;}' +
    '.scn-ret{position:absolute;border:3px solid rgba(255,255,255,.9);border-radius:10px;' +
      'box-shadow:0 0 0 9999px rgba(0,0,0,.35);transition:border-color .12s;}' +
    '.scn-ret.is-hit{border-color:var(--green,#16a34a);}' +
    '.scn-cam-btns{position:absolute;left:8px;bottom:8px;display:flex;gap:6px;}' +
    '.scn-cam-btns button{min-height:36px;padding:0 10px;font-size:13px;border-radius:8px;' +
      'border:none;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;}' +
    '.scn-status{font-size:13px;min-height:18px;}' +
    '.scn-status.is-bad{color:var(--red,#dc2626);}' +
    '.scn-status.is-ok{color:var(--green,#16a34a);font-weight:600;}' +
    '.scn-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;font-weight:700;}' +
    '.scn-choices{display:flex;flex-direction:column;gap:6px;}' +
    '.scn-choices button{min-height:48px;font-size:15px;text-align:left;padding:0 12px;' +
      'border:1px solid var(--border,#e2e8f0);border-radius:10px;background:var(--card,#fff);' +
      'color:var(--text,#0f172a);cursor:pointer;}';

  function ensureCSS() {
    if (_css) return;
    var s = document.createElement('style'); s.textContent = CSS;
    document.head.appendChild(s); _css = true;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNativeApp() {
    try {
      return !!(window.Capacitor && typeof Capacitor.isNativePlatform === 'function'
                && Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  /* ── capability gate: never ATTEMPT getUserMedia in the app until iOS is ready
   *
   * Capacitor's WebViewDelegationHandler unconditionally grants
   * requestMediaCapturePermissionFor, so there is NO in-page WebKit prompt. The
   * only remaining gate is iOS TCC, and its contract with a missing
   * NSCameraUsageDescription is process TERMINATION, not a denied promise. So the
   * app must be told explicitly that camera is safe — the native shell sets
   * window.__OURLAB_CAPS = { camera: true } once the plist key ships. Until then
   * the sheet quietly opens to the typed field, which is a complete feature.
   *
   * Do NOT infer the plist state from enumerateDevices(): iOS lists the video
   * device with an empty label before permission, so it tells you nothing. */
  function cameraAvailable() {
    if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, reason: 'unsupported' };
    }
    if (isNativeApp()) {
      var forced = false;
      try { forced = localStorage.getItem('rm.scan.forceCamera') === '1'; } catch (e) {}
      var caps = window.__OURLAB_CAPS;
      if (!forced && !(caps && caps.camera)) return { ok: false, reason: 'app-not-yet' };
    }
    return { ok: true, reason: '' };
  }

  var REASON_TEXT = {
    insecure: 'Scanning needs a secure (https) connection.',
    unsupported: 'This browser can’t use a camera. Type the code, or use a USB barcode scanner.',
    'app-not-yet': 'Camera scanning isn’t switched on in the app yet — type or scan the code below.',
  };
  function errText(err) {
    var n = (err && err.name) || '';
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
      return 'Camera access was denied. Type the code instead, or re-enable the camera for this site.';
    }
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
      return 'No camera found. Type the code, or use a USB barcode scanner.';
    }
    if (n === 'NotReadableError' || n === 'TrackStartError') {
      return 'The camera is in use by another app (Zoom, Teams…). Close it, or type the code.';
    }
    if (n === 'SecurityError') return REASON_TEXT.insecure;
    return 'Could not start the camera: ' + ((err && err.message) || n || 'unknown');
  }

  /* ── decoder ─────────────────────────────────────────────────────────── */

  function loadDecoder() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (_decoderPromise) return _decoderPromise;
    _decoderPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = JSQR_SRC;
      s.onload = function () { window.jsQR ? res(window.jsQR) : rej(new Error('decoder loaded but absent')); };
      // sw.js is network-first for /rm/ and deliberately propagates real network
      // errors, so an offline first-use genuinely fails here. Degrade to typed.
      s.onerror = function () { _decoderPromise = null; rej(new Error('offline — the scanner code isn’t cached yet')); };
      document.head.appendChild(s);
    });
    return _decoderPromise;
  }
  var _decoders = [{ name: 'jsQR', load: loadDecoder,
    decode: function (d, w, h) { return window.jsQR(d, w, h, { inversionAttempts: 'dontInvert' }); } }];

  /* ── feedback ────────────────────────────────────────────────────────── */

  function unlockAudio() {
    // Must be constructed inside the opening user gesture or iOS keeps it muted.
    if (_audio) return;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (C) _audio = new C();
    } catch (e) { _audio = null; }
  }
  function beep() {
    if (!_beepOn || !_audio) return;
    try {
      var o = _audio.createOscillator(), g = _audio.createGain();
      o.frequency.value = 880; o.type = 'sine';
      g.gain.value = 0.06;
      o.connect(g); g.connect(_audio.destination);
      o.start(); o.stop(_audio.currentTime + 0.04);
    } catch (e) { /* audio is a courtesy */ }
  }
  function buzz() {
    // Capacitor.Plugins.Haptics is NOT installed in OurlabMobile, so iOS gets no
    // haptic today. Guard and move on rather than pretend.
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
  }

  /* ── camera ──────────────────────────────────────────────────────────── */

  function layoutReticle() {
    if (!_reticleEl || !_video) return;
    var w = _video.clientWidth, h = _video.clientHeight;
    if (!w || !h) return;
    var side = Math.round(Math.min(w, h) * ROI);
    _reticleEl.style.width = side + 'px';
    _reticleEl.style.height = side + 'px';
    _reticleEl.style.left = Math.round((w - side) / 2) + 'px';
    _reticleEl.style.top = Math.round((h - side) / 2) + 'px';
  }

  async function startCamera(stage, status) {
    var gate = cameraAvailable();
    if (!gate.ok) { setStatus(REASON_TEXT[gate.reason] || 'Camera unavailable.', 'bad'); return; }
    try { await loadDecoder(); }
    catch (e) { setStatus(e.message + ' — type the code instead.', 'bad'); return; }

    setStatus('Starting the camera…');
    try {
      // `ideal`, never `exact` — exact:'environment' throws OverconstrainedError
      // on every desktop webcam.
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' },
                 width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      if (e && e.name === 'OverconstrainedError') {
        try { _stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
        catch (e2) { setStatus(errText(e2), 'bad'); return; }
      } else { setStatus(errText(e), 'bad'); return; }
    }

    _video = document.createElement('video');
    _video.setAttribute('playsinline', '');   // without this WebKit goes fullscreen
    _video.muted = true; _video.autoplay = true;
    _video.setAttribute('disablepictureinpicture', '');
    _video.srcObject = _stream;
    stage.insertBefore(_video, stage.firstChild);
    stage.classList.add('is-on');
    try { await _video.play(); } catch (e) { /* autoplay+muted is normally fine */ }

    _canvas = document.createElement('canvas');
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    layoutReticle();
    window.addEventListener('resize', layoutReticle);

    mountCamButtons(stage);
    setStatus('Point the code at the box.');
    _running = true;
    loop();
  }

  function mountCamButtons(stage) {
    var track = _stream && _stream.getVideoTracks()[0];
    var caps = (track && track.getCapabilities) ? (track.getCapabilities() || {}) : {};
    var host = document.createElement('div');
    host.className = 'scn-cam-btns';
    // Render a control ONLY where the hardware reports it. Both are
    // Chrome-on-Android in practice; iOS exposes neither.
    if ('torch' in caps) {
      var on = false;
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = 'Light';
      b.onclick = function () {
        on = !on;
        track.applyConstraints({ advanced: [{ torch: on }] }).catch(function () {});
      };
      host.appendChild(b);
    }
    if (host.children.length) stage.appendChild(host);
  }

  /* requestVideoFrameCallback where it exists (Safari 15.4+ / Chrome 83+, so it
   * covers both real targets) — it fires on actual decoded frames rather than on
   * the compositor. Never setInterval: it keeps firing under tab throttling and
   * drifts against the frame clock. */
  function loop() {
    if (!_running) return;
    function schedule() {
      if (!_running) return;
      if (_video && _video.requestVideoFrameCallback) {
        _rvfc = _video.requestVideoFrameCallback(function () { setTimeout(step, 1000 / FPS); });
      } else {
        _raf = setTimeout(function () { requestAnimationFrame(step); }, 1000 / FPS);
      }
    }
    function step() {
      if (!_running) return;
      try { tick(); } catch (e) { /* one bad frame must not kill the loop */ }
      schedule();
    }
    schedule();
  }

  function tick() {
    if (!_video || _video.readyState < 2) return;
    var vw = _video.videoWidth, vh = _video.videoHeight;
    if (!vw || !vh) return;
    // Crop to the centred square the reticle shows. jsQR is O(pixels), so this
    // is the single biggest performance lever — and it makes "put it in the box"
    // literally true rather than decorative.
    var side = Math.round(Math.min(vw, vh) * ROI);
    var sx = Math.round((vw - side) / 2), sy = Math.round((vh - side) / 2);
    if (_canvas.width !== side) { _canvas.width = side; _canvas.height = side; }
    _ctx.drawImage(_video, sx, sy, side, side, 0, 0, side, side);
    var img = _ctx.getImageData(0, 0, side, side);
    var got = _decoders[0].decode(img.data, side, side);
    if (got && got.data) onDecoded(got.data);
  }

  function onDecoded(raw) {
    var now = Date.now();
    if (raw === _last.code && now - _last.at < DUP_MS) return;
    // Require the same code on two consecutive decoded frames. jsQR's
    // Reed-Solomon makes a false positive near-impossible, but this kills the
    // case where a neighbouring label drifts half-way into frame.
    if (_streak.code === raw) _streak.n++;
    else { _streak = { code: raw, n: 1 }; }
    if (_streak.n < CONFIRM_FRAMES) return;

    _last = { code: raw, at: now };
    _streak = { code: '', n: 0 };
    // Stop the loop BEFORE awaiting, or a slow Firestore read queues 30 resolves.
    _running = false;
    if (_reticleEl) _reticleEl.classList.add('is-hit');
    beep(); buzz();
    handle(raw);
  }

  /* ── teardown: idempotent, five callers ──────────────────────────────── */

  function stopCamera() {
    _running = false;
    if (_rvfc && _video && _video.cancelVideoFrameCallback) {
      try { _video.cancelVideoFrameCallback(_rvfc); } catch (e) {}
    }
    _rvfc = null;
    if (_raf) { clearTimeout(_raf); _raf = null; }
    if (_stream) {
      try {
        _stream.getTracks().forEach(function (t) { _tracksStopped++; t.stop(); });
      } catch (e) {}
      _stream = null;
    }
    if (_video) {
      try { _video.pause(); } catch (e) {}
      _video.srcObject = null;
      if (_video.parentNode) _video.parentNode.removeChild(_video);
      _video = null;
    }
    _canvas = null; _ctx = null;
    window.removeEventListener('resize', layoutReticle);
  }

  function onVis() { if (document.hidden) stopCamera(); }
  function onTabHidden() { stopCamera(); }   // the one visibilitychange misses
  function onPageHide() { stopCamera(); }    // iOS never fires unload
  function bindTeardown() {
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('ourlab:tab-hidden', onTabHidden);
    window.addEventListener('pagehide', onPageHide);
  }
  function unbindTeardown() {
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('ourlab:tab-hidden', onTabHidden);
    window.removeEventListener('pagehide', onPageHide);
  }

  /* ── the sheet ───────────────────────────────────────────────────────── */

  function setStatus(text, kind) {
    if (!_statusEl) return;
    _statusEl.className = 'scn-status' + (kind ? ' is-' + kind : '');
    _statusEl.innerHTML = text;
  }

  async function handle(raw) {
    var R = window.SCAN_RESOLVE;
    if (!R) { setStatus('Scanner not fully loaded.', 'bad'); return; }
    setStatus('Looking up <span class="scn-code">' + esc(window.LABEL_ID.normalize(raw)) + '</span>…');
    var res = await R.resolve(raw, { source: 'scan' });
    if (_onHit) { var stop = _onHit(res); if (stop === true) { close(); return; } }
    if (!res.ok) {
      // Echoing the code back is not decoration — it answers "did it read the
      // right tube" before the user goes hunting.
      setStatus(esc(R.explain(res)) + (res.code ? ' <span class="scn-code">' + esc(res.code) + '</span>' : ''), 'bad');
      renderResume();
      return;
    }
    var d = R.dispatch(res, _api && _api.targetId ? { targetId: _api.targetId } : {});
    if (d.claimed) {
      setStatus('Found <span class="scn-code">' + esc(res.code) + '</span> — ' +
                esc((res.label && res.label.title) || (res.item && res.item.name) || 'sent'), 'ok');
      setTimeout(close, 700);
      return;
    }
    if (d.choices && d.choices.length > 1) { renderChoices(res, d.choices); return; }
    // Nobody claimed it — the caller's default action.
    if (_api && _api.onUnclaimed) _api.onUnclaimed(res);
  }

  function renderChoices(res, choices) {
    var host = document.querySelector('.scn-choices');
    if (!host) return;
    host.innerHTML = '<div class="scn-hint">Send this to…</div>' + choices.map(function (c) {
      return '<button type="button" data-id="' + esc(c.id) + '">' + esc(c.label || c.id) + '</button>';
    }).join('');
    host.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        window.SCAN_RESOLVE.dispatch(res, { pick: b.dataset.id });
        close();
      };
    });
  }

  function renderResume() {
    // Never auto-resume: a silent restart is a permission and LED surprise, and
    // frequently just fails on iOS.
    var host = document.querySelector('.scn-choices');
    if (!host || !cameraAvailable().ok) return;
    host.innerHTML = '<button type="button" class="scn-alt scn-resume">Scan again</button>';
    host.querySelector('.scn-resume').onclick = function () {
      host.innerHTML = '';
      if (_reticleEl) _reticleEl.classList.remove('is-hit');
      _running = true; loop();
      setStatus('Point the code at the box.');
    };
  }

  function close() {
    stopCamera();
    unbindTeardown();
    if (typeof APP_SHEET !== 'undefined') APP_SHEET.close();
    _onHit = null; _api = null; _statusEl = null; _reticleEl = null;
  }

  function open(opts) {
    opts = opts || {};
    ensureCSS();
    unlockAudio();
    _onHit = opts.onResult || null;
    _last = { code: '', at: 0 }; _streak = { code: '', n: 0 };
    var cam = cameraAvailable();
    var camFirst = !!opts.cameraFirst && cam.ok;   // V3.847

    APP_SHEET.open({
      title: opts.prompt || 'Scan a label',
      build: function (body, sheetApi) {
        _api = { targetId: opts.targetId, onUnclaimed: opts.onUnclaimed, sheet: sheetApi };
        body.innerHTML =
          '<div class="scn-wrap' + (camFirst ? ' scn-camfirst' : '') + '">' +
            '<div class="scn-stage"><div class="scn-ret"></div></div>' +
            '<form class="scn-field" autocomplete="off"' + (camFirst ? ' hidden' : '') + '>' +
              '<input type="text" class="scn-in" placeholder="MG-A7K2X" ' +
                'autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
                'enterkeyhint="go" inputmode="text" aria-label="Label code">' +
              '<button type="submit" class="scn-go">Look up</button>' +
            '</form>' +
            (camFirst ? '<button type="button" class="scn-alt scn-type">Type the code instead</button>'
              : cam.ok ? '<button type="button" class="scn-alt scn-cam">Use the camera</button>'
                       : '<div class="scn-hint">' + esc(REASON_TEXT[cam.reason] || '') + '</div>') +
            (camFirst ? '' : '<div class="scn-hint">A USB barcode scanner works here too — just scan.</div>') +
            '<div class="scn-status"></div>' +
            '<div class="scn-choices"></div>' +
          '</div>';

        _statusEl = body.querySelector('.scn-status');
        _reticleEl = body.querySelector('.scn-ret');
        var input = body.querySelector('.scn-in');
        var stage = body.querySelector('.scn-stage');

        body.querySelector('.scn-field').onsubmit = function (e) {
          e.preventDefault();
          var v = input.value.trim();
          if (v) handle(v);
        };
        // Some wedges emit Tab instead of Enter.
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Tab' && input.value.trim()) { e.preventDefault(); handle(input.value.trim()); }
        });
        var camBtn = body.querySelector('.scn-cam');
        if (camBtn) camBtn.onclick = function () { camBtn.remove(); startCamera(stage, _statusEl); };
        var typeBtn = body.querySelector('.scn-type');
        if (typeBtn) typeBtn.onclick = function () { typeBtn.remove(); body.querySelector('.scn-field').hidden = false; input.focus(); };

        bindTeardown();
        if (camFirst) startCamera(stage, _statusEl);   // the camera IS the sheet; a failure lands in .scn-status, the field one tap away
        else setTimeout(function () { input.focus(); }, 60);
      },
      onClose: function () { stopCamera(); unbindTeardown(); },
    });
  }

  /** Promise sugar for a surface already mid-flow ("scan the destination box"). */
  function requestOne(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      open(Object.assign({}, opts, {
        onResult: function (res) { if (!done) { done = true; resolve(res); } return true; },
      }));
    });
  }

  window.SCAN = {
    open: open,
    close: close,
    requestOne: requestOne,
    cameraAvailable: cameraAvailable,
    isNativeApp: isNativeApp,
    setBeep: function (on) { _beepOn = !!on; },
    _decoders: _decoders,
    _stopCamera: stopCamera,
    _tracksStopped: function () { return _tracksStopped; },
    _resetTrackCount: function () { _tracksStopped = 0; },
  };
})();
