/* training-scientific-communication.js — V3.176.
 *
 * Lecture-style module with three interactive widgets:
 *
 *   1. Complexity / attention arc — 7 sliders (one per "beat") drive a
 *      canvas that plots the user's complexity curve (blue) plus a
 *      derived audience-attention curve (green). Red band marks the
 *      "you've lost them" zone. Presets pre-shape the sliders.
 *
 *   2. Protagonist picker — 6 cards. Clicking one swaps the
 *      `.protagonist-detail` block with a per-protagonist retelling of
 *      the same example science story.
 *
 *   3. Storyboard builder — 9 form fields generate a printable
 *      single-page storyboard sheet, gated on all required fields
 *      being filled.
 *
 * Plus TOC scroll-spy (same pattern as V3.163 paper writing).
 */
(function () {
  'use strict';

  function getCanvasCtx(id) {
    const c = document.getElementById(id);
    if (!c) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const cssW = rect.width  > 4 ? rect.width  : (parseFloat(c.getAttribute('width'))  || 700);
    const cssH = rect.height > 4 ? rect.height : (parseFloat(c.getAttribute('height')) || 280);
    c.width  = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, ctx, w: cssW, h: cssH };
  }

  // ── Attention model ───────────────────────────────────────────────
  // Simple discrete dynamical system over the 7 beats. Attention starts at
  // 1.0 and drains in proportion to current complexity; it recovers
  // exponentially toward 1.0 each step. The constants are tuned so a
  // monotonic ramp lands the audience deep in the red; an oscillating
  // arc stays near the green.

  const RECOVERY = 0.18;
  const DRAIN    = 0.030;       // per unit of complexity (0..10)
  const DANGER   = 0.30;         // below this = audience lost

  function attentionCurve(complexity) {
    const out = [1.0];
    for (let i = 1; i < complexity.length; i++) {
      const prev = out[i - 1];
      const c = complexity[i];
      // Recovery first (toward 1), then drain
      let next = prev + RECOVERY * (1 - prev) - DRAIN * c;
      next = Math.max(0, Math.min(1, next));
      out.push(next);
    }
    return out;
  }

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    arc: { complexity: [1, 3, 7, 2, 6, 3, 1] },
    prot: 'cells',
    story: {
      format: '', topic: '', prot: '', hook: '', arc: '',
      beat1: '', beat2: '', beat3: '', close: '',
    },
  };

  // ── Arc presets ──────────────────────────────────────────────────
  const ARC_PRESETS = {
    oscillate: [1, 3, 7, 2, 6, 3, 1],
    monotonic: [1, 2, 4, 5, 7, 9, 10],
    shallow:   [1, 2, 2, 2, 2, 2, 1],
    marathon:  [1, 6, 2, 7, 2, 6, 1],
    lightning: [2, 6, 9, 5, 2, 1, 1],
  };

  // ── Protagonist library ──────────────────────────────────────────
  // All six retellings cover the SAME underlying example: edge density
  // inverts the effect of matrix stiffness on tumor invasion. Different
  // protagonist = different framing of the same finding.
  const PROTAGONISTS = {
    cells: {
      title: 'The cells / organism as protagonist',
      sub: 'The default. Most common in basic-biology talks.',
      story: 'Patient-derived breast tumor cells, sitting in a 3-D matrix, "decide" whether to invade or stay put. We watched them in spheroids across a range of matrix stiffnesses and discovered the cells were doing something nobody had reported: their collective decision flipped sign depending on how densely packed they were at the spheroid edge. The story is the cells\' behavior — what they do, why they do it.',
      use: 'Best for basic-science audiences who want to hear about the biology of the system itself.',
    },
    patient: {
      title: 'The patient as protagonist',
      sub: 'Adds stakes. Powerful for clinical / translational audiences.',
      story: 'Two patients with histologically identical breast tumors. One recurs within a year; one is disease-free for a decade. Why? We hypothesized the difference is mechanical — not just molecular — and built a system to test it. The story isn\'t about cells; it\'s about why textbook-identical tumors behave so differently in the clinic and what the missing variable might be.',
      use: 'Best for clinical audiences, grant audiences where translational relevance matters, lay-audience outreach.',
    },
    lab: {
      title: 'The lab / researcher as protagonist',
      sub: 'The struggle and discovery. Mixed audiences relate to a person.',
      story: 'For three years the lab tried to make spheroid invasion experiments reproducible, and for three years they fought us. Different stiffnesses gave different results on different days. We thought we were doing something wrong. The story is about how the "irreproducibility" turned out to be a real biological signal — edge density was varying batch-to-batch — and how letting the data argue with us led to a result we hadn\'t set out to find.',
      use: 'Best for mixed audiences, lab meetings, and any context where the grit of the work itself is part of the message.',
    },
    data: {
      title: 'The data as protagonist',
      sub: 'When the surprise IS the data. Let it speak for itself.',
      story: 'Here\'s a scatter plot. Stiffness on x, invasion on y. By every prior report, this should be a single line. It\'s not. It\'s two clouds, one above and one below the trend, depending on a third variable. The talk is essentially: look at this plot. Now look at it colored by edge density. Now look at it again. Each replot is the next beat of the story.',
      use: 'Best when you have one striking dataset that makes the case visually. Less narrative, more "look."',
    },
    instrument: {
      title: 'The instrument / method as protagonist',
      sub: 'Methods-paper talks. "Here\'s a new tool, here\'s what it can do."',
      story: 'We built a system that measures edge density inside live spheroids in real time. Here\'s how it works, here\'s what it cost, here\'s what we calibrated against. Now here\'s what happens when we run it on the tumor-invasion question that\'s been unresolved for 20 years: the answer drops out cleanly. The story is the tool first, the biology as proof-of-concept.',
      use: 'Best when the methodological advance is the main contribution, or when introducing a platform you want others to adopt.',
    },
    antagonist: {
      title: 'The antagonist as protagonist',
      sub: 'The disease takes the lead. Tumor as the active agent.',
      story: 'Tumors are not passive objects we image. They are active mechanical systems that respond to the matrix they live in — and the way they respond determines whether they stay local or invade. The villain has a structure; once we map its rules, we can predict its behavior. The story frames the tumor as the protagonist whose moves we have finally learned to predict.',
      use: 'Best for advocacy talks, broad-public outreach, and grant audiences where the disease itself is the motivating subject.',
    },
  };

  // ── TAB 2: Arc canvas ─────────────────────────────────────────────

  function drawArc() {
    const c = getCanvasCtx('canvas-arc');
    if (!c) return;
    const { ctx, w, h } = c;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const padL = 50, padR = 18, padT = 14, padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // Danger zone (attention < 0.3)
    const dangerY = padT + plotH * (1 - DANGER);
    ctx.fillStyle = 'rgba(220, 38, 38, 0.10)';
    ctx.fillRect(padL, dangerY, plotW, padT + plotH - dangerY);
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, dangerY); ctx.lineTo(padL + plotW, dangerY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.fillText('audience lost (< 30%)', padL + 6, padT + plotH - 6);

    // Axes
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#475569';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('beat 1', padL + 2, padT + plotH + 14);
    ctx.fillText('beat 7', padL + plotW - 30, padT + plotH + 14);
    // Y-axis labels
    ctx.save();
    ctx.translate(14, padT + plotH / 2 + 10);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('attention / complexity', 0, 0);
    ctx.restore();
    ctx.fillText('1.0',  padL - 30, padT + 6);
    ctx.fillText('0.5',  padL - 30, padT + plotH / 2 + 4);
    ctx.fillText('0.0',  padL - 30, padT + plotH + 4);

    // Compute attention curve from current complexity
    const complexity = state.arc.complexity.slice();
    const attention = attentionCurve(complexity);
    const N = complexity.length;

    // Helper: beat index → x
    function bx(i) { return padL + (i / (N - 1)) * plotW; }
    // Complexity (0..10) → y
    function cy(c) { return padT + plotH - (c / 10) * plotH; }
    // Attention (0..1) → y
    function ay(a) { return padT + plotH - a * plotH; }

    // Complexity curve — blue
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = bx(i), y = cy(complexity[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Complexity points
    ctx.fillStyle = '#2563eb';
    for (let i = 0; i < N; i++) {
      ctx.beginPath();
      ctx.arc(bx(i), cy(complexity[i]), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Attention curve — green
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = bx(i), y = ay(attention[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Attention points colored by zone
    for (let i = 0; i < N; i++) {
      ctx.fillStyle = attention[i] < DANGER ? '#dc2626' : '#16a34a';
      ctx.beginPath();
      ctx.arc(bx(i), ay(attention[i]), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Legend
    ctx.fillStyle = '#1f2937';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('— complexity (blue)', padL + plotW - 200, padT + 12);
    ctx.fillText('-- audience attention (green)', padL + plotW - 200, padT + 26);

    // Verdict text
    const lostBeats = attention.filter(a => a < DANGER).length;
    const avgAtt = attention.reduce((a, b) => a + b, 0) / attention.length;
    const maxC = Math.max(...complexity);
    const minC = Math.min(...complexity);
    const swings = (() => {
      let n = 0;
      for (let i = 1; i < complexity.length; i++) {
        if ((complexity[i] - complexity[i - 1]) * (complexity[i - 1] - (complexity[i - 2] || complexity[0])) < 0) n++;
      }
      return n;
    })();

    const v = document.getElementById('arc-verdict');
    if (!v) return;
    v.classList.remove('is-warning', 'is-critical');

    let html;
    if (lostBeats >= 3) {
      v.classList.add('is-critical');
      html = '<strong>You\'ve lost the audience.</strong> Attention falls into the red zone for ' + lostBeats + ' of ' + N + ' beats. Average attention: ' + (avgAtt * 100).toFixed(0) + '%. Bring complexity back down at least once more — that\'s a "pull back broad" move.';
    } else if (lostBeats >= 1) {
      v.classList.add('is-warning');
      html = '<strong>Mostly held them.</strong> Attention dips below 30% at ' + lostBeats + ' beat(s). Average ' + (avgAtt * 100).toFixed(0) + '%. Tighten the recovery moves around your deepest beats.';
    } else if (maxC < 4) {
      v.classList.add('is-warning');
      html = '<strong>You never went deep.</strong> Complexity never rose above ' + maxC + ' — the audience will leave thinking it was a fine talk and remember none of the science. A real talk needs at least one cycle of genuine depth.';
    } else if (swings <= 1) {
      v.classList.add('is-warning');
      html = '<strong>One ramp, no recovery.</strong> Complexity moves in essentially one direction. Even if attention survives, the audience experiences this as a marathon, not a story. Plot the broad-resets between your technical beats.';
    } else {
      html = '<strong>Solid arc.</strong> ' + swings + ' direction changes, average attention ' + (avgAtt * 100).toFixed(0) + '%, peak depth ' + maxC + '. The audience is with you the whole way — each broad-reset earns the next deep dive.';
    }
    v.innerHTML = html;
  }

  function wireArcTab() {
    const sliders = document.querySelectorAll('#arc-controls input[type="range"]');
    sliders.forEach(s => {
      s.addEventListener('input', () => {
        const beat = parseInt(s.dataset.beat, 10);
        const val  = parseInt(s.value, 10);
        state.arc.complexity[beat] = val;
        const out = s.parentElement.querySelector('.v');
        if (out) out.textContent = val;
        drawArc();
      });
    });
    document.querySelectorAll('.arc-preset').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.arc-preset').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const preset = ARC_PRESETS[b.dataset.preset];
        if (!preset) return;
        state.arc.complexity = preset.slice();
        sliders.forEach(s => {
          const beat = parseInt(s.dataset.beat, 10);
          s.value = preset[beat];
          const out = s.parentElement.querySelector('.v');
          if (out) out.textContent = preset[beat];
        });
        drawArc();
      });
    });
  }

  // ── TAB 6: Protagonist picker ─────────────────────────────────────

  function drawProtagonist() {
    const p = PROTAGONISTS[state.prot] || PROTAGONISTS.cells;
    const el = document.getElementById('protagonist-detail');
    if (!el) return;
    el.innerHTML =
      '<div class="pd-h">' + escapeHtml(p.title) + '</div>' +
      '<div class="pd-sub">' + escapeHtml(p.sub) + '</div>' +
      '<div class="pd-example">' + escapeHtml(p.story) + '</div>' +
      '<p style="margin-top:8px;font-size:12.5px;color:var(--text-muted);"><strong>When to use:</strong> ' + escapeHtml(p.use) + '</p>';
  }

  function wireProtagonistPicker() {
    document.querySelectorAll('.protagonist-card').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.protagonist-card').forEach(x => x.classList.remove('is-active'));
        c.classList.add('is-active');
        state.prot = c.dataset.prot;
        drawProtagonist();
      });
    });
  }

  // ── TAB 10: Storyboard builder ────────────────────────────────────

  const FORMAT_LABELS = {
    elevator: '60-second elevator pitch',
    talk10:   '10-minute conference talk',
    seminar:  '45-minute seminar',
    poster:   'Conference poster',
  };
  const HOOK_LABELS = {
    statistic: 'Surprising statistic',
    patient:   'Patient / clinical story',
    image:     'Striking image',
    question:  'Bold question',
    counter:   'Counter-intuitive claim',
    personal:  'Personal motivation',
  };
  const ARC_LABELS = {
    hero:      'Hero\'s journey',
    mystery:   'Mystery',
    tragedy:   'Tragedy + redemption',
    discovery: 'Discovery',
    quest:     'Quest',
    conflict:  'Comparison / conflict',
  };
  const PROT_LABELS = {
    cells:      'Cells / organism',
    patient:    'Patient',
    lab:        'Lab / researcher',
    data:       'Data',
    instrument: 'Instrument / method',
    antagonist: 'Antagonist (disease)',
  };

  function drawStoryboard() {
    const s = state.story;
    const required = ['format', 'topic', 'prot', 'hook', 'arc', 'beat1', 'close'];
    const issues = [];
    const warnings = [];

    required.forEach(k => {
      const empty = !s[k] || !String(s[k]).trim();
      const labels = { format: 'format', topic: 'working title/claim', prot: 'protagonist', hook: 'opening hook', arc: 'classic arc', beat1: 'cycle 1 broad reset', close: 'closing message' };
      if (empty) issues.push('Pick a ' + labels[k] + '.');
    });

    // Format-aware warnings
    if (s.format === 'elevator' && (s.beat2 || s.beat3)) {
      warnings.push('Elevator pitches typically don\'t have multiple broad-reset cycles — one hook, one claim. Strip beats 2/3 unless you really have 60 seconds for them.');
    }
    if (s.format === 'seminar' && !s.beat3) {
      warnings.push('A 45-minute seminar usually needs more than two cycles. Sketch a third reset; you can always cut it later.');
    }
    if (s.format === 'poster' && s.hook === 'personal') {
      warnings.push('"Personal motivation" rarely works on a poster — posters are read silently. Consider a striking image or bold claim instead.');
    }
    if (s.topic && s.topic.length > 0 && s.topic.length < 25) {
      warnings.push('Your working title is short — make sure it states a claim, not just a topic ("X happens" rather than "investigating X").');
    }
    if (s.close && s.close.length > 200) {
      warnings.push('Closing message is over 200 characters — try to compress it to a single sentence the audience can carry out the door.');
    }

    const v = document.getElementById('sb-verdict');
    const ss = document.getElementById('sb-signoff');
    v.classList.remove('is-warning', 'is-critical');

    let html;
    if (issues.length) {
      v.classList.add('is-critical');
      html = '<strong>Not ready yet:</strong><ul style="margin:6px 0 0 18px;">' +
             issues.map(i => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul>';
      if (warnings.length) html += '<div style="margin-top:8px;font-size:13px;color:#475569;">Also worth fixing: ' + warnings.map(w => escapeHtml(w)).join(' ') + '</div>';
    } else if (warnings.length) {
      v.classList.add('is-warning');
      html = '<strong>Storyboard ready with notes:</strong><ul style="margin:6px 0 0 18px;">' +
             warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>';
    } else {
      html = '<strong>Storyboard ready.</strong> Print this and pin it next to your monitor while you build slides.';
    }
    v.innerHTML = html;

    // Sign-off sheet — show as soon as any required field is touched
    const anyTouched = required.some(k => s[k] && String(s[k]).trim());
    if (!anyTouched) {
      ss.style.display = 'none';
      return;
    }
    ss.style.display = '';
    document.getElementById('sb-out-format').textContent = FORMAT_LABELS[s.format] || '—';
    document.getElementById('sb-out-topic').textContent  = s.topic || '—';
    document.getElementById('sb-out-prot').textContent   = PROT_LABELS[s.prot] || '—';
    document.getElementById('sb-out-hook').textContent   = HOOK_LABELS[s.hook] || '—';
    document.getElementById('sb-out-arc').textContent    = ARC_LABELS[s.arc] || '—';
    document.getElementById('sb-out-b1').textContent     = s.beat1 || '—';
    document.getElementById('sb-out-b2').textContent     = s.beat2 || '—';
    document.getElementById('sb-out-b3').textContent     = s.beat3 || '—';
    document.getElementById('sb-out-close').textContent  = s.close || '—';
    document.getElementById('sb-out-date').textContent   = new Date().toISOString().slice(0, 10);
    const passEl = document.getElementById('sb-pass');
    const failEl = document.getElementById('sb-fail');
    if (issues.length) {
      passEl.style.display = 'none'; failEl.style.display = '';
    } else {
      passEl.style.display = ''; failEl.style.display = 'none';
    }
  }

  function wireStoryboard() {
    const map = {
      'sb-format': 'format', 'sb-topic': 'topic', 'sb-protagonist': 'prot',
      'sb-hook': 'hook', 'sb-arc': 'arc',
      'sb-beat1': 'beat1', 'sb-beat2': 'beat2', 'sb-beat3': 'beat3',
      'sb-close': 'close',
    };
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const key = map[id];
      const handler = (e) => {
        state.story[key] = e.target.value;
        drawStoryboard();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
  }

  // ── TOC scroll-spy ────────────────────────────────────────────────

  function wireToc() {
    const links = Array.from(document.querySelectorAll('.training-toc a'));
    if (!links.length) return;
    const sections = links
      .map(a => {
        const id = (a.getAttribute('href') || '').replace(/^#/, '');
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean);

    function findActiveSection() {
      const offset = 140;
      let active = sections[0];
      for (const s of sections) {
        const r = s.getBoundingClientRect();
        if (r.top - offset <= 0) active = s;
        else break;
      }
      return active;
    }
    function syncActive() {
      const a = findActiveSection();
      const aId = a ? a.id : null;
      links.forEach(link => {
        const linkId = (link.getAttribute('href') || '').replace(/^#/, '');
        link.classList.toggle('active', linkId === aId);
      });
    }
    let scheduled = false;
    function onScroll() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; syncActive(); });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    syncActive();
  }

  function wireResize() {
    let timer = null;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(drawArc, 120);
    };
    window.addEventListener('resize', handler);
    window.addEventListener('orientationchange', handler);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function init() {
    wireToc();
    wireArcTab();
    wireProtagonistPicker();
    wireStoryboard();
    wireResize();
    drawArc();
    drawProtagonist();
    drawStoryboard();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();
