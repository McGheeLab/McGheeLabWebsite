/* training-phd-triangle.js — interactive PhD-triangle module.
 *
 * Wires up:
 *   - Three pillar vertices in the SVG to their side panels
 *     (.training-pillar-panel) — click/keyboard to switch
 *   - Three sliders to a recomputed inner triangle (scaled toward the
 *     centroid by score/5) + a verdict generator that produces plain-
 *     language diagnosis + prescription
 *
 * No Firestore reads/writes — self-assessment is component-local.
 *
 * Introduced V3.162.
 */
(function () {
  'use strict';

  // Canonical outer-triangle vertices (must match the SVG polygon
  // points="300,60 60,480 540,480" — keep in sync).
  const OUTER = {
    communication: { x: 300, y: 60 },
    creativity:    { x:  60, y: 480 },
    grit:          { x: 540, y: 480 },
  };
  // Centroid = arithmetic mean of the three vertices = (300, 340).
  const CENTROID = { x: 300, y: 340 };

  const PILLARS = ['communication', 'creativity', 'grit'];
  const PILLAR_LABELS = {
    communication: 'Communication',
    creativity:    'Creativity',
    grit:          'Grit',
  };

  // ── Triangle recompute ────────────────────────────────────────────

  function scoreToInnerVertex(pillar, score) {
    // Score 1..5 → factor 0.2..1.0 toward the outer vertex from the centroid.
    const outer = OUTER[pillar];
    const factor = Math.max(0.05, Math.min(1, score / 5));
    return {
      x: CENTROID.x + (outer.x - CENTROID.x) * factor,
      y: CENTROID.y + (outer.y - CENTROID.y) * factor,
    };
  }

  function redrawInnerTriangle(scores) {
    const poly = document.getElementById('inner-triangle');
    if (!poly) return;
    const c = scoreToInnerVertex('communication', scores.communication);
    const cr = scoreToInnerVertex('creativity', scores.creativity);
    const g = scoreToInnerVertex('grit', scores.grit);
    poly.setAttribute(
      'points',
      `${c.x},${c.y} ${cr.x},${cr.y} ${g.x},${g.y}`
    );
  }

  // ── Verdict generator ─────────────────────────────────────────────

  function generateVerdict(scores) {
    const entries = PILLARS.map(p => ({ pillar: p, score: scores[p] }));
    const min = entries.reduce((a, b) => (a.score <= b.score ? a : b));
    const max = entries.reduce((a, b) => (a.score >= b.score ? a : b));
    const avg = (scores.communication + scores.creativity + scores.grit) / 3;
    const spread = max.score - min.score;

    let kind = 'mixed';
    let text = '';

    if (avg >= 4.5 && spread <= 1) {
      kind = 'good';
      text = '<strong>Well-developed across all three pillars.</strong> ' +
             'Keep stretching — the next move is depth (research program, ' +
             'mentorship of newer students), not breadth.';
    } else if (avg <= 2 && spread <= 1) {
      kind = 'mixed';
      text = '<strong>Early-stage on every pillar.</strong> Pick ' +
             '<em>one</em> to focus on this quarter — Communication is ' +
             'usually the easiest place to start because written drafts ' +
             'create feedback opportunities that exercise the other two.';
    } else if (spread === 0) {
      kind = avg >= 3.5 ? 'good' : 'mixed';
      text = '<strong>Balanced.</strong> All three pillars at level ' +
             scores.communication + '. ' +
             (avg >= 3.5
                ? 'Push the ceiling — try a stretch experience that exercises whichever pillar feels most aspirational.'
                : 'Pick one pillar to be your "growth pillar" for the next 90 days and put deliberate time into it.');
    } else if (spread >= 3) {
      kind = 'mixed';
      text = '<strong>' + PILLAR_LABELS[max.pillar] + ' is your strongest pillar (' + max.score + '/5); ' +
             PILLAR_LABELS[min.pillar] + ' is the weakest (' + min.score + '/5).</strong> ' +
             'That gap will limit you. Spend the next quarter deliberately ' +
             'leaning into ' + PILLAR_LABELS[min.pillar].toLowerCase() + ' — ' +
             promptForPillar(min.pillar) + ' Your stronger pillar can ' +
             'carry you while you grow the weaker one.';
    } else {
      kind = 'mixed';
      text = '<strong>Slight tilt toward ' + PILLAR_LABELS[max.pillar].toLowerCase() + '.</strong> ' +
             'Not a problem yet, but a useful next step is to put a small, ' +
             'concrete commitment around ' + PILLAR_LABELS[min.pillar].toLowerCase() + ' — ' +
             promptForPillar(min.pillar);
    }

    return { kind, text };
  }

  function promptForPillar(pillar) {
    if (pillar === 'communication') {
      return 'draft a section of your next paper this month rather than waiting for results to be "done".';
    }
    if (pillar === 'creativity') {
      return 'read three papers from an adjacent field and bring one cross-pollination idea to lab meeting.';
    }
    return 'name the next experiment you\'re anxious about, write down what failure would mean, and run it anyway.';
  }

  // ── Wire-up ───────────────────────────────────────────────────────

  function readScores() {
    return {
      communication: parseInt(document.getElementById('score-communication').value, 10) || 1,
      creativity:    parseInt(document.getElementById('score-creativity').value, 10) || 1,
      grit:          parseInt(document.getElementById('score-grit').value, 10) || 1,
    };
  }

  function applyScores() {
    const scores = readScores();
    document.getElementById('score-communication-out').textContent = scores.communication;
    document.getElementById('score-creativity-out').textContent    = scores.creativity;
    document.getElementById('score-grit-out').textContent          = scores.grit;
    redrawInnerTriangle(scores);
    const v = generateVerdict(scores);
    const vEl = document.getElementById('triangle-verdict');
    if (vEl) {
      vEl.classList.remove('is-mixed');
      if (v.kind === 'mixed') vEl.classList.add('is-mixed');
      vEl.innerHTML = v.text;
    }
  }

  function setActivePillar(pillar) {
    // Vertex highlight
    document.querySelectorAll('.pillar-vertex').forEach(v => {
      v.classList.toggle('is-active', v.dataset.pillar === pillar);
    });
    // Side-panel swap
    document.querySelectorAll('.training-pillar-panel').forEach(p => {
      p.classList.toggle('is-active', p.dataset.pillarPanel === pillar);
    });
  }

  function wirePillarVertices() {
    document.querySelectorAll('.pillar-vertex').forEach(v => {
      const pillar = v.dataset.pillar;
      v.addEventListener('click', () => setActivePillar(pillar));
      v.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setActivePillar(pillar);
        }
      });
    });
  }

  function wireSliders() {
    ['score-communication', 'score-creativity', 'score-grit'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', applyScores);
      el.addEventListener('change', applyScores);
    });
  }

  function init() {
    wirePillarVertices();
    wireSliders();
    applyScores();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
      firebridge.whenAuthResolved().then(init).catch(init);
    } else {
      init();
    }
  });
})();
