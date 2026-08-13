/* wire-router.js — pure wire-routing + cut geometry for the protocol
 * node canvas (V3.379).
 *
 * Routing = short waypoint polylines smoothed with Catmull-Rom → cubic
 * beziers. Per edge: classify forward/backward; optionally insert a fan
 * waypoint when several wires leave the same out-dot; then iteratively
 * insert FLAT DETOUR PAIRS around inflated node rects the sampled curve
 * passes through (side chosen by where the straight chord passes the
 * rect; per-(rect,side) lane counters spread parallel detours). Backward
 * edges loop around both endpoint cards (cheaper of above/below), with
 * the long run pushed clear of corridor cards. A clear straight edge
 * reproduces the pre-V3.379 simple bezier EXACTLY (regression-stable).
 *
 * Every route returns {edgeId, d, points} — `d` is the SVG path string,
 * `points` the analytically-sampled polyline (10 samples per segment).
 * The same samples serve the shift-drag CUT feature: segIntersect /
 * hitsForSegment / polylineHits do segment-segment tests against them.
 *
 * All math in world coordinates. Deterministic (no Date/random): fan
 * order keys on (target y, target x, edge id); lane counters fill in
 * caller-supplied edge order. DOM-free — loadable in Node (window shim)
 * for the verification harness.
 *
 * Public surface: window.WireRouter.
 */

(function () {
  var PAD = 12;        // obstacle rect inflation around a card
  var CLEAR = 8;       // detour lane clearance beyond the inflated edge
  var ESC = 12;        // clearance escalation per re-offense (esc ≤ 2)
  var LANE_GAP = 7;    // spacing between parallel wires in one lane
  var FAN_X = 28;      // x-advance of the fan waypoint past the out-dot
  var FAN_GAP = 14;    // vertical pitch between fanned wires
  var FAN_MIN_DX = 80; // skip fanning on short forward gaps
  var STUB_B = 32;     // horizontal stub for backward loops
  var LOOP_CLEAR = 16; // clearance of a loop's long run past rects
  var SPS = 10;        // polyline samples per bezier segment
  var MAX_ITER = 4;    // obstacle-resolution passes per edge
  var ARM_MIN = 24, ARM_MAX = 60; // end-tangent arm clamps (multi-seg)
  var TMAX = 80;       // interior tangent magnitude clamp

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function hyp(x, y) { return Math.sqrt(x * x + y * y); }

  function inflate(rect, pad) {
    return { id: rect.id, x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
  }
  function pointInRect(p, r) {
    return r.x0 < p.x && p.x < r.x1 && r.y0 < p.y && p.y < r.y1;
  }
  function chordY(a, b, x) {
    return a.y + (b.y - a.y) * (x - a.x) / Math.max(8, b.x - a.x);
  }
  function cubicPoint(b0, b1, b2, b3, t) {
    var u = 1 - t;
    var w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return { x: w0 * b0.x + w1 * b1.x + w2 * b2.x + w3 * b3.x,
             y: w0 * b0.y + w1 * b1.y + w2 * b2.y + w3 * b3.y };
  }

  /* Catmull-Rom-style tangents → per-pair cubic segments. Horizontal
   * end tangents keep the socket exit/entry aesthetic; a single-segment
   * path reproduces the legacy `dx = max(30, |Δx|/2)` bezier exactly. */
  function smooth(waypoints) {
    var P = waypoints;
    var n = P.length - 1;
    var segs = [];
    if (n < 1) return segs;
    if (n === 1) {
      var arm = Math.max(30, Math.abs(P[1].x - P[0].x) / 2);
      segs.push({ p0: P[0], c1: { x: P[0].x + arm, y: P[0].y }, c2: { x: P[1].x - arm, y: P[1].y }, p1: P[1] });
      return segs;
    }
    var m = [];
    var s0 = clamp((P[1].x - P[0].x) / 2, ARM_MIN, ARM_MAX);
    m[0] = { x: 3 * s0, y: 0 };
    for (var i = 1; i < n; i++) {
      var t = { x: (P[i + 1].x - P[i - 1].x) / 2, y: (P[i + 1].y - P[i - 1].y) / 2 };
      var L = hyp(t.x, t.y);
      if (L > TMAX) { t.x *= TMAX / L; t.y *= TMAX / L; }
      m[i] = t;
    }
    var sn = clamp((P[n].x - P[n - 1].x) / 2, ARM_MIN, ARM_MAX);
    m[n] = { x: 3 * sn, y: 0 };
    for (i = 0; i < n; i++) {
      segs.push({
        p0: P[i],
        c1: { x: P[i].x + m[i].x / 3, y: P[i].y + m[i].y / 3 },
        c2: { x: P[i + 1].x - m[i + 1].x / 3, y: P[i + 1].y - m[i + 1].y / 3 },
        p1: P[i + 1],
      });
    }
    return segs;
  }

  function sampleSegs(segs, perSeg) {
    perSeg = perSeg || SPS;
    if (!segs.length) return [];
    var pts = [{ x: segs[0].p0.x, y: segs[0].p0.y }];
    segs.forEach(function (s) {
      for (var j = 1; j <= perSeg; j++) pts.push(cubicPoint(s.p0, s.c1, s.c2, s.p1, j / perSeg));
    });
    return pts;
  }

  function pathD(segs) {
    if (!segs.length) return '';
    var d = 'M' + r2(segs[0].p0.x) + ',' + r2(segs[0].p0.y);
    segs.forEach(function (s) {
      d += ' C' + r2(s.c1.x) + ',' + r2(s.c1.y) +
           ' ' + r2(s.c2.x) + ',' + r2(s.c2.y) +
           ' ' + r2(s.p1.x) + ',' + r2(s.p1.y);
    });
    return d;
  }

  /* First sampled point (index ≥ 1) strictly inside a non-accepted rect. */
  function firstHit(points, rects, acceptedIds) {
    for (var j = 1; j < points.length; j++) {
      for (var k = 0; k < rects.length; k++) {
        var R = rects[k];
        if (acceptedIds && acceptedIds[R.id]) continue;
        if (pointInRect(points[j], R)) return { j: j, rect: R };
      }
    }
    return null;
  }

  function countHits(points, rects) {
    var n = 0;
    for (var j = 0; j < points.length; j++) {
      for (var k = 0; k < rects.length; k++) {
        if (pointInRect(points[j], rects[k])) { n++; break; }
      }
    }
    return n;
  }

  /* Flat detour pair (or single midpoint) at lane height yD spanning the
   * inflated rect between segment endpoints Pk → Pk1. Null = no room. */
  function detourFor(rect, pk, pk1, yD) {
    var d1x = Math.max(rect.x0, pk.x + 8);
    var d2x = Math.min(rect.x1, pk1.x - 8);
    if (d2x - d1x >= 16) return [{ x: d1x, y: yD }, { x: d2x, y: yD }];
    if (pk1.x - pk.x >= 24) return [{ x: (d1x + d2x) / 2, y: yD }];
    return null;
  }

  /* Forward route with obstacle detours. `rawObstacles` excludes the
   * edge's own endpoint nodes. `fan` = {i,k} within the out-dot group.
   * `lanes` is the shared per-drawWires lane-counter object. */
  function routeForward(a, b, rawObstacles, fan, lanes) {
    var infl = [], raw = [];
    (rawObstacles || []).forEach(function (r) {
      var R = inflate(r, PAD);
      if (pointInRect(a, R) || pointInRect(b, R)) return; // can't route around what we start inside
      if (!(R.x1 > a.x - 40 && R.x0 < b.x + 40)) return;  // x-prefilter
      infl.push(R); raw.push(r);
    });
    var W = [a, b];
    if (fan && fan.k > 1 && (b.x - a.x) > FAN_MIN_DX) {
      var F = { x: a.x + FAN_X, y: a.y + (fan.i - (fan.k - 1) / 2) * FAN_GAP };
      var blocked = infl.some(function (R) { return pointInRect(F, R); });
      if (!blocked) W = [a, F, b];
    }
    var accepted = {};     // rect.id → true (stop detouring this rect)
    var detourState = {};  // rect.id → {esc, side, lane}
    var best = null;
    for (var iter = 0; iter <= MAX_ITER; iter++) {
      var segs = smooth(W);
      var points = sampleSegs(segs, SPS);
      var hits = countHits(points, raw);
      if (!best || hits <= best.hits) best = { waypoints: W.slice(), segs: segs, points: points, hits: hits };
      var hit = firstHit(points, infl, accepted);
      if (!hit || iter === MAX_ITER) break;
      var R = hit.rect;
      var st = detourState[R.id];
      if (st) {
        // re-offense: push the existing detour further out, then give up
        st.esc += 1;
        if (st.esc > 2) { accepted[R.id] = true; continue; }
        var clr = CLEAR + st.esc * ESC + st.lane * LANE_GAP;
        var ny = (st.side === 'top') ? R.y0 - clr : R.y1 + clr;
        W.forEach(function (w) { if (w.rect === R.id) w.y = ny; });
      } else {
        var segIdx = clamp(Math.floor((hit.j - 1) / SPS), 0, W.length - 2);
        var Pk = W[segIdx], Pk1 = W[segIdx + 1];
        var cx = clamp((R.x0 + R.x1) / 2, Math.min(a.x, b.x), Math.max(a.x, b.x));
        var side = (chordY(a, b, cx) <= (R.y0 + R.y1) / 2) ? 'top' : 'bottom';
        var laneKey = R.id + '|' + side;
        var lane = lanes[laneKey] || 0;
        lanes[laneKey] = lane + 1;
        var yD = (side === 'top') ? R.y0 - (CLEAR + lane * LANE_GAP) : R.y1 + (CLEAR + lane * LANE_GAP);
        var det = detourFor(R, Pk, Pk1, yD);
        if (!det) { accepted[R.id] = true; continue; }
        det.forEach(function (w) { w.rect = R.id; });
        detourState[R.id] = { esc: 0, side: side, lane: lane };
        W = W.slice(0, segIdx + 1).concat(det, W.slice(segIdx + 1));
      }
    }
    return best;
  }

  function _synthRect(p) {
    return { id: '', x0: p.x - 1, y0: p.y - 1, x1: p.x + 1, y1: p.y + 1 };
  }

  /* Backward route: loop above or below both endpoint cards (cheaper
   * total vertical travel), long run pushed clear of corridor cards. */
  function routeBackward(a, b, srcRect, dstRect, rawObstacles, fanIndex, lanes) {
    var Ra = inflate(srcRect || _synthRect(a), PAD);
    var Rb = inflate(dstRect || _synthRect(b), PAD);
    var xr = a.x + STUB_B + 8 * (fanIndex || 0);
    var xl = b.x - STUB_B;
    var yA = Math.min(Ra.y0, Rb.y0) - LOOP_CLEAR;
    var yB = Math.max(Ra.y1, Rb.y1) + LOOP_CLEAR;
    var costA = (a.y - yA) + (b.y - yA);
    var costB = (yB - a.y) + (yB - b.y);
    var side = (costA <= costB) ? 'top' : 'bottom';
    var yLoop = (side === 'top') ? yA : yB;
    var corridor = (rawObstacles || []).map(function (r) { return inflate(r, PAD); })
      .filter(function (R) { return R.x1 > xl - 8 && R.x0 < xr + 8; });
    var changed = true, guard = 0;
    while (changed && guard++ <= corridor.length + 2) {
      changed = false;
      corridor.forEach(function (R) {
        if (R.y0 - LOOP_CLEAR < yLoop && yLoop < R.y1 + LOOP_CLEAR) {
          yLoop = (side === 'top') ? R.y0 - LOOP_CLEAR : R.y1 + LOOP_CLEAR;
          changed = true;
        }
      });
    }
    var laneKey = 'loop|' + ((dstRect && dstRect.id) || 'x') + '|' + side;
    var lane = lanes[laneKey] || 0;
    lanes[laneKey] = lane + 1;
    yLoop += (side === 'top' ? -1 : 1) * lane * LANE_GAP;
    var W0 = [a, { x: xr, y: a.y }, { x: xr, y: yLoop }, { x: xl, y: yLoop }, { x: xl, y: b.y }, b];
    // drop degenerate corners (riser height ~0) so tangents stay sane
    var W = [W0[0]];
    for (var i = 1; i < W0.length; i++) {
      var p = W[W.length - 1], q = W0[i];
      if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) W.push(q);
    }
    if (W.length < 2) W.push({ x: b.x, y: b.y });
    var segs = smooth(W);
    var points = sampleSegs(segs, SPS);
    return { waypoints: W, segs: segs, points: points, hits: countHits(points, rawObstacles || []) };
  }

  /* Fan groups: edges sharing an out-dot (same fromKey) get {i,k} with a
   * stable order (target y, target x, edge id) so the fan never crosses
   * at the dot and never flickers between redraws. */
  function computeFanGroups(edgeInputs) {
    var groups = {};
    (edgeInputs || []).forEach(function (ei) {
      var k = ei.fromKey || (ei.from + '|');
      (groups[k] = groups[k] || []).push(ei);
    });
    var out = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) { out[g[0].edgeId] = { i: 0, k: 1 }; return; }
      var sorted = g.slice().sort(function (x, y) {
        if (x.b.y !== y.b.y) return x.b.y - y.b.y;
        if (x.b.x !== y.b.x) return x.b.x - y.b.x;
        return x.edgeId < y.edgeId ? -1 : (x.edgeId > y.edgeId ? 1 : 0);
      });
      sorted.forEach(function (ei, i) { out[ei.edgeId] = { i: i, k: sorted.length }; });
    });
    return out;
  }

  function routeEdge(a, b, srcRect, dstRect, rawObstacles, fan, lanes) {
    lanes = lanes || {};
    if (b.x < a.x) return routeBackward(a, b, srcRect, dstRect, rawObstacles, (fan && fan.i) || 0, lanes);
    return routeForward(a, b, rawObstacles, fan, lanes);
  }

  /* edgeInputs: [{edgeId, from, to, a:{x,y}, b:{x,y}, fromKey}]
   * rects: RAW card rects [{id, x0, y0, x1, y1}] (uninflated).
   * → { edgeId: {edgeId, d, points} } */
  function routeAll(edgeInputs, rects) {
    var rectById = {};
    (rects || []).forEach(function (r) { rectById[r.id] = r; });
    var lanes = {};
    var fans = computeFanGroups(edgeInputs);
    var out = {};
    (edgeInputs || []).forEach(function (ei) {
      var a = ei.a, b = ei.b;
      if (!a || !b || !isFinite(a.x) || !isFinite(a.y) || !isFinite(b.x) || !isFinite(b.y)) return;
      var obstacles = (rects || []).filter(function (r) { return r.id !== ei.from && r.id !== ei.to; });
      var r = routeEdge(a, b, rectById[ei.from], rectById[ei.to], obstacles, fans[ei.edgeId], lanes);
      if (!r || !r.segs || !r.segs.length) return;
      out[ei.edgeId] = { edgeId: ei.edgeId, d: pathD(r.segs), points: r.points };
    });
    return out;
  }

  /* ── Cut geometry ──────────────────────────────────────────── */
  function _orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  function _onSeg(a, b, c) {
    return Math.min(a.x, b.x) - 1e-9 <= c.x && c.x <= Math.max(a.x, b.x) + 1e-9 &&
           Math.min(a.y, b.y) - 1e-9 <= c.y && c.y <= Math.max(a.y, b.y) + 1e-9;
  }
  function segIntersect(p1, p2, p3, p4) {
    var d1 = _orient(p3, p4, p1), d2 = _orient(p3, p4, p2);
    var d3 = _orient(p1, p2, p3), d4 = _orient(p1, p2, p4);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    if (d1 === 0 && _onSeg(p3, p4, p1)) return true;
    if (d2 === 0 && _onSeg(p3, p4, p2)) return true;
    if (d3 === 0 && _onSeg(p1, p2, p3)) return true;
    if (d4 === 0 && _onSeg(p1, p2, p4)) return true;
    return false;
  }

  /* Edge ids whose sampled polyline crosses the segment p1→p2. */
  function hitsForSegment(p1, p2, routesByEdgeId) {
    var hits = [];
    Object.keys(routesByEdgeId || {}).forEach(function (id) {
      var pts = routesByEdgeId[id] && routesByEdgeId[id].points;
      if (!pts || pts.length < 2) return;
      for (var i = 0; i < pts.length - 1; i++) {
        if (segIntersect(p1, p2, pts[i], pts[i + 1])) { hits.push(id); return; }
      }
    });
    return hits;
  }

  /* Edge ids crossed by any segment of the cut polyline. */
  function polylineHits(cutPts, routesByEdgeId) {
    var seen = {};
    var out = [];
    for (var i = 0; i < (cutPts || []).length - 1; i++) {
      hitsForSegment(cutPts[i], cutPts[i + 1], routesByEdgeId).forEach(function (id) {
        if (seen[id]) return;
        seen[id] = true;
        out.push(id);
      });
    }
    return out;
  }

  window.WireRouter = {
    inflate: inflate,
    pointInRect: pointInRect,
    chordY: chordY,
    cubicPoint: cubicPoint,
    smooth: smooth,
    sampleSegs: sampleSegs,
    pathD: pathD,
    firstHit: firstHit,
    countHits: countHits,
    detourFor: detourFor,
    routeForward: routeForward,
    routeBackward: routeBackward,
    routeEdge: routeEdge,
    computeFanGroups: computeFanGroups,
    routeAll: routeAll,
    segIntersect: segIntersect,
    hitsForSegment: hitsForSegment,
    polylineHits: polylineHits,
    CONST: { PAD: PAD, CLEAR: CLEAR, ESC: ESC, LANE_GAP: LANE_GAP, FAN_X: FAN_X, FAN_GAP: FAN_GAP,
             FAN_MIN_DX: FAN_MIN_DX, STUB_B: STUB_B, LOOP_CLEAR: LOOP_CLEAR, SPS: SPS,
             MAX_ITER: MAX_ITER, ARM_MIN: ARM_MIN, ARM_MAX: ARM_MAX, TMAX: TMAX },
  };
})();
