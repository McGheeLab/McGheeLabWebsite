/* protocol-graph-editor.js — vanilla node-canvas editor for `design`
 * blocks (FuturePlan 06). No framework, no build step.
 *
 * mount(hostEl, {getGraph, setGraph, canEdit, expandable, viewKey}) →
 * {destroy, getGraph}. Renders a pan/zoom canvas of node cards + an SVG
 * wire overlay.
 *
 * Sockets are PER VARIABLE: a node's produced variables are output
 * sockets down the right edge; each incoming binding is an input socket
 * down the left edge. Every socket is colored by its variable's unit
 * dimension (volume / mass / length / …) via ProtocolGraph.categoryOf-
 * Unit + colorOfCategory. A legend maps color → dimension.
 *
 * A wire is a BINDING: drag from an output socket onto a target block →
 * an edge is created and a binding row appears inside the target,
 * where the user declares the role: `math` (the variable becomes a name
 * usable in an equation's expression, via the insert helper), `param`
 * (drives a chosen setting of the target), or `none`. List targets show
 * the binding as a structural feed. Wires are colored by the source
 * variable's dimension; connecting mismatched dimensions warns (soft).
 *
 * Node positions commit once on pointerup; pan/zoom is view-only
 * (localStorage), never persisted. Double-click the canvas (or the ⤢
 * button) opens a full-viewport popout hosting the same editor on the
 * same graph.
 *
 * Public surface: window.ProtocolGraphEditor.mount(hostEl, opts).
 */

(function () {
  var PG = function () { return window.ProtocolGraph; };

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var NODE_LABELS = {
    input: 'Input', constant: 'Constant', choices: 'Choices',
    ordered: 'Ordered set', equation: 'Equation', list: 'List',
    code: 'Code', cards: 'Cards', refs: 'References',
  };
  var NODE_ICONS = {
    input: 'adjustments-horizontal', constant: 'pin', choices: 'arrows-right-left',
    ordered: 'signal', equation: 'variable', list: 'clipboard-document-list',
    code: 'document', cards: 'chart-bar', refs: 'link',
  };
  var NODE_HINTS = {
    input: 'A value the protocol user sets at run time (slider or number).',
    constant: 'A fixed value the lab owns — pick common scientific constants from its Preset.',
    choices: 'A set of options; makes downstream calculations per-item.',
    ordered: 'Ordered values where each member stays below the next.',
    equation: 'Compute a new variable from the variables bound into it.',
    list: 'The generated item list — wire choices / ordered sets / per-item equations in.',
    code: 'A JavaScript snippet: wired variables become named arguments; return { output: value }.',
    cards: 'GATE: which variables show as result cards on the document.',
    refs: 'GATE: which values the editor’s Reference picker offers inline (card variables are included automatically).',
  };

  function mount(hostEl, opts) {
    opts = opts || {};
    var canEdit = opts.canEdit !== false;
    var expandable = opts.expandable !== false;
    var graph = PG().normalizeGraph(opts.getGraph ? opts.getGraph() : { nodes: [], edges: [] });
    var viewKey = 'pge:' + (opts.viewKey || 'default');

    var view = { x: 0, y: 0, scale: 1 };
    try {
      var saved = JSON.parse(localStorage.getItem(viewKey) || 'null');
      if (saved && typeof saved.scale === 'number') view = saved;
    } catch (e) {}

    hostEl.innerHTML = '';
    hostEl.classList.add('pge-host');

    // Palette + legend row
    var palette = document.createElement('div');
    palette.className = 'pge-palette';
    if (canEdit) {
      PG().NODE_TYPES.forEach(function (t) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pge-pal-btn pge-pal-' + t;
        ICON.label(b, NODE_ICONS[t], ' ' + NODE_LABELS[t]);
        b.title = NODE_HINTS[t];
        b.addEventListener('click', function () { addNode(t); });
        palette.appendChild(b);
      });
    }
    // V3.381 — recipe dropdown: insert a common pre-wired node pattern
    if (canEdit && (PG().RECIPES || []).length) {
      var recWrap = document.createElement('span');
      recWrap.className = 'pge-recipes';
      var recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'pge-pal-btn pge-recipes-btn';
      ICON.label(recBtn, 'sparkles', ' Recipes ▾');
      recBtn.title = 'Insert a common pre-wired node pattern';
      var recMenu = document.createElement('div');
      recMenu.className = 'pge-recipes-menu';
      recMenu.hidden = true;
      function closeRecipes() {
        recMenu.hidden = true;
        document.removeEventListener('pointerdown', recipesOutside, true);
      }
      function recipesOutside(e) {
        if (!document.contains(recWrap)) { document.removeEventListener('pointerdown', recipesOutside, true); return; }
        if (!recWrap.contains(e.target)) closeRecipes();
      }
      PG().RECIPES.forEach(function (r) {
        var it = document.createElement('button');
        it.type = 'button';
        it.className = 'pge-recipes-item';
        it.innerHTML = '<span class="pge-recipes-label">' + (r.icon ? ICON.render(r.icon) + ' ' : '') + esc(r.label) + '</span>' +
          '<span class="pge-recipes-hint">' + esc(r.hint || '') + '</span>';
        it.addEventListener('click', function (e) {
          e.stopPropagation();
          closeRecipes();
          insertRecipe(r);
        });
        recMenu.appendChild(it);
      });
      recBtn.addEventListener('click', function () {
        if (recMenu.hidden) {
          recMenu.hidden = false;
          document.addEventListener('pointerdown', recipesOutside, true);
        } else {
          closeRecipes();
        }
      });
      recWrap.appendChild(recBtn);
      recWrap.appendChild(recMenu);
      palette.appendChild(recWrap);
    }
    // V3.385 — guided tours: a per-node/per-pattern walkthrough that
    // rings the next control and advances when the user actually does it
    var toursHandle = null;
    // V3.389 — shared by the 🎓 menu and the mount handle's startTour()
    // (demo lessons auto-start their build tour via ?tour=<id>)
    function startTourById(id, o) {
      if (destroyed || !canEdit || !window.ProtocolGraphTours) return false;
      if (cheatEl) toggleCheat(); // the tour card takes the top-right corner
      // V3.403 — when the host page provides a tour starter (the
      // protocol editor's page-level host, which survives view switches
      // and canvas remounts), route there instead of the mount-owned
      // attach; the fallback below remains for hosts without one
      // (notebook design blocks).
      if (typeof opts.startTour === 'function') {
        var okPage = false;
        try { okPage = !!opts.startTour(id, o); } catch (e) {}
        return okPage;
      }
      if (!toursHandle) {
        toursHandle = window.ProtocolGraphTours.attach({
          hostEl: hostEl, viewport: viewport,
          getGraph: function () { return graph; },
          // build tours: "↺ Rebuild from scratch" clears the canvas so the
          // walkthrough can run on an empty graph
          resetGraph: function () {
            graph.nodes = []; graph.edges = [];
            persist(); render();
          },
          // host bookkeeping: lets the page re-arm + resume a tour whose
          // mount was torn down by a re-render (reason 'detached')
          onEnd: opts.onTourEnd,
        });
      }
      return !!toursHandle.start(id, o);
    }
    if (canEdit && window.ProtocolGraphTours) {
      var tourWrap = document.createElement('span');
      tourWrap.className = 'pge-recipes pge-tours';
      var tourBtn = document.createElement('button');
      tourBtn.type = 'button';
      tourBtn.className = 'pge-pal-btn pge-tours-btn';
      ICON.label(tourBtn, 'academic-cap', ' Tours ▾');
      tourBtn.title = 'Guided walkthroughs — learn each node and the common patterns';
      var tourMenu = document.createElement('div');
      tourMenu.className = 'pge-recipes-menu pge-tours-menu';
      tourMenu.hidden = true;
      function closeTours() {
        tourMenu.hidden = true;
        document.removeEventListener('pointerdown', toursOutside, true);
      }
      function toursOutside(e) {
        if (!document.contains(tourWrap)) { document.removeEventListener('pointerdown', toursOutside, true); return; }
        if (!tourWrap.contains(e.target)) closeTours();
      }
      (function buildTourMenu() {
        var items = window.ProtocolGraphTours.list();
        var lastGroup = null;
        var note = document.createElement('div');
        note.className = 'pge-tours-note';
        note.textContent = 'Tours build real nodes on this canvas — practice freely, delete the pieces after.';
        tourMenu.appendChild(note);
        items.forEach(function (t) {
          if (t.group !== lastGroup) {
            lastGroup = t.group;
            var gh = document.createElement('div');
            gh.className = 'pge-tours-group';
            gh.textContent = t.group;
            tourMenu.appendChild(gh);
          }
          var it = document.createElement('button');
          it.type = 'button';
          it.className = 'pge-recipes-item';
          it.innerHTML = '<span class="pge-recipes-label">' + (t.icon ? ICON.render(t.icon) + ' ' : '') + esc(t.title) + '</span>' +
            '<span class="pge-recipes-hint">' + esc(t.blurb || '') + '</span>';
          it.addEventListener('click', function (e) {
            e.stopPropagation();
            closeTours();
            startTourById(t.id);
          });
          tourMenu.appendChild(it);
        });
      })();
      tourBtn.addEventListener('click', function () {
        if (tourMenu.hidden) {
          tourMenu.hidden = false;
          document.addEventListener('pointerdown', toursOutside, true);
        } else {
          closeTours();
        }
      });
      tourWrap.appendChild(tourBtn);
      tourWrap.appendChild(tourMenu);
      palette.appendChild(tourWrap);
    }
    // view controls: zoom in/out, fit, tidy
    function palBtn(txt, title, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pge-pal-btn pge-view-btn';
      b.textContent = txt;
      b.title = title;
      b.addEventListener('click', fn);
      palette.appendChild(b);
      return b;
    }
    palBtn('⊕', 'Zoom in', function () { zoomBy(1.2); });
    palBtn('⊖', 'Zoom out', function () { zoomBy(1 / 1.2); });
    palBtn('⌖ Fit', 'Fit all nodes in view', fitView);
    palBtn('▤', 'Collapse / expand all nodes', function () {
      var collapse = graph.nodes.some(function (n) { return !n.collapsed; });
      graph.nodes.forEach(function (n) { n.collapsed = collapse; });
      if (canEdit) persist();
      render();
    });
    if (canEdit) palBtn('✤ Tidy', 'Auto-arrange nodes left → right by data flow', tidyLayout);
    palBtn('?', 'Canvas how-to (pan · wire · cut · …)', toggleCheat);
    var spacer = document.createElement('span');
    spacer.className = 'pge-pal-spacer';
    palette.appendChild(spacer);
    // unit legend
    var legend = document.createElement('div');
    legend.className = 'pge-legend';
    (PG().UNIT_CATEGORIES || []).forEach(function (c) {
      if (c.key === 'other' || c.key === 'none') return;
      var sw = document.createElement('span');
      sw.className = 'pge-legend-item';
      sw.innerHTML = '<span class="pge-legend-dot" style="background:' + c.color + '"></span>' + esc(c.label);
      legend.appendChild(sw);
    });
    palette.appendChild(legend);
    if (expandable) {
      var exp = document.createElement('button');
      exp.type = 'button';
      exp.className = 'pge-pal-btn pge-expand-btn';
      exp.textContent = '⤢ Expand';
      exp.title = 'Open a large popout editor';
      exp.addEventListener('click', openModal);
      palette.appendChild(exp);
    }
    hostEl.appendChild(palette);

    // Canvas viewport + world + wire layer
    var viewport = document.createElement('div');
    viewport.className = 'pge-viewport' + (opts.expandable === false ? ' pge-viewport-modal' : '');
    var world = document.createElement('div');
    world.className = 'pge-world';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pge-wires');
    world.appendChild(svg);
    viewport.appendChild(world);
    hostEl.appendChild(viewport);

    var strip = document.createElement('div');
    strip.className = 'pge-strip';
    hostEl.appendChild(strip);

    var nodeEls = {};          // nodeId → card
    var valEls = {};           // nodeId → live-value badge in the header
    var socketOut = {};        // nodeId → { varKey: dotEl }
    var socketIn = {};         // nodeId → { edgeId: dotEl }
    var wiring = null;         // { fromId, sourceVar, category } while dragging
    var sizeCache = {};        // nodeId → {w,h} (measured once per render)
    var routesByEdgeId = {};   // edgeId → {d, points} from the last drawWires
    var qtysCache = {};        // varName → resolved quantity (per render, V3.422)
    var ptCache = {};          // nodeId → {varName → pass-through var} (per render, V3.423)
    var _gradSeq = 0;          // unique ids for per-wire SVG gradients
    var mathInstance = null;   // mathjs, loaded async on boot (live badges)
    var destroyed = false;     // guards async callbacks after teardown

    function applyView() {
      world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
      try { localStorage.setItem(viewKey, JSON.stringify(view)); } catch (e) {}
    }
    function persist() { if (opts.setGraph) opts.setGraph(graph); }
    /* V3.416 — view-action counters on the viewport dataset. The guided
     * tours read these to VERIFY viewer drills (fit used, zoomed twice,
     * zoomed-to-node) — graph state can't see view gestures. */
    function bumpCounter(key) {
      try { viewport.dataset[key] = String((parseInt(viewport.dataset[key], 10) || 0) + 1); } catch (e) {}
    }
    function zoomBy(factor) {
      var rect = viewport.getBoundingClientRect();
      var cx = rect.width / 2, cy = rect.height / 2;
      var ns = Math.max(0.3, Math.min(2.2, view.scale * factor));
      // keep the viewport centre stable while zooming
      view.x = cx - ((cx - view.x) / view.scale) * ns;
      view.y = cy - ((cy - view.y) / view.scale) * ns;
      view.scale = ns;
      bumpCounter('pgeZooms');
      applyView(); drawWires();
    }
    function fitView() {
      bumpCounter('pgeFits');
      if (!graph.nodes.length) { view = { x: 0, y: 0, scale: 1 }; applyView(); drawWires(); return; }
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      graph.nodes.forEach(function (n) {
        var el = nodeEls[n.id];
        var w = el ? el.offsetWidth : 208, h = el ? el.offsetHeight : 180;
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + w); maxY = Math.max(maxY, n.y + h);
      });
      var rect = viewport.getBoundingClientRect();
      var pad = 30;
      var s = Math.min((rect.width - pad * 2) / (maxX - minX || 1),
                       (rect.height - pad * 2) / (maxY - minY || 1), 1.4);
      s = Math.max(0.3, Math.min(2.2, s));
      view.scale = s;
      view.x = (rect.width - (maxX - minX) * s) / 2 - minX * s;
      view.y = (rect.height - (maxY - minY) * s) / 2 - minY * s;
      applyView(); drawWires();
    }
    /* V3.416 — centre + zoom the view on one node (header ⌖ button or
     * double-clicking the card). Double-clicking empty canvas fits all. */
    function zoomToNode(n) {
      var el = nodeEls[n.id];
      var w = el ? el.offsetWidth : 224, h = el ? el.offsetHeight : 150;
      var rect = viewport.getBoundingClientRect();
      var s = Math.max(0.3, Math.min(2.2,
        Math.min(rect.width / (w + 160), rect.height / (h + 120), 1.6)));
      view.scale = s;
      view.x = rect.width / 2 - (n.x + w / 2) * s;
      view.y = rect.height / 2 - (n.y + h / 2) * s;
      bumpCounter('pgeZoomtos');
      applyView(); drawWires();
    }
    function tidyLayout() {
      if (!graph.nodes.length) return;
      // column = longest wire path from any source (cycles guarded)
      var memo = {}, visiting = {};
      function depth(id) {
        if (memo[id] !== undefined) return memo[id];
        if (visiting[id]) return 0;
        visiting[id] = true;
        var d = 0;
        graph.edges.forEach(function (e) { if (e.to === id) d = Math.max(d, depth(e.from) + 1); });
        visiting[id] = false;
        memo[id] = d;
        return d;
      }
      var cols = {};
      graph.nodes.forEach(function (n) {
        var d = depth(n.id);
        (cols[d] = cols[d] || []).push(n);
      });
      Object.keys(cols).sort(function (a, b) { return a - b; }).forEach(function (d) {
        var y = 40;
        cols[d].forEach(function (n) {
          n.x = 40 + d * 280;
          n.y = y;
          var el = nodeEls[n.id];
          y += (el ? el.offsetHeight : 180) + 36;
        });
      });
      persist(); render();
      requestAnimationFrame(fitView);
    }
    function nodeById(id) {
      for (var i = 0; i < graph.nodes.length; i++) if (graph.nodes[i].id === id) return graph.nodes[i];
      return null;
    }
    function nodeName(n) {
      var p = n.params || {};
      return p.name || p.field || p.label || n.type;
    }

    /* ── Compile feedback ─────────────────────────────────────── */
    function recompileFeedback() {
      var res = PG().compile(graph);
      Object.keys(nodeEls).forEach(function (id) {
        var el = nodeEls[id];
        el.classList.remove('pge-scope-item', 'pge-scope-scalar', 'pge-scope-list');
        var sc = res.scopeMap[id];
        if (sc) el.classList.add('pge-scope-' + sc);
      });
      // live value badges — best effort; needs mathjs + the kernel loaded.
      // mathjs is an ESM module (no window.math global); we hold the
      // instance loaded on boot in `mathInstance`.
      try {
        var M = mathInstance || window.math;
        if (M && window.ProtocolFormulas && !res.errors.length) {
          var tbl = window.ProtocolFormulas.buildSymbolTable(res.entries, M, {});
          graph.nodes.forEach(function (gn) {
            var badge = valEls[gn.id];
            if (!badge) return;
            if (res.scopeMap[gn.id] === 'item') { badge.textContent = 'per-item'; return; }
            var nm = (gn.params || {}).name;
            var sym = nm ? tbl[nm] : null;
            if (!sym || sym.error || typeof sym.value !== 'number' || !isFinite(sym.value)) { badge.textContent = ''; return; }
            var dec = (typeof (gn.params || {}).decimals === 'number') ? gn.params.decimals : 3;
            // V3.422 — prefer the symbol's unit: compile fills computed
            // composite labels (µL·mol) for undeclared equation results
            var bu = sym.unit || (gn.params || {}).unit || '';
            badge.textContent = '= ' + parseFloat(sym.value.toFixed(dec)) + (bu ? ' ' + bu : '');
          });
        }
      } catch (e) {}
      strip.innerHTML = '';
      if (res.errors.length) {
        strip.className = 'pge-strip pge-strip-error';
        ICON.label(strip, 'exclamation-triangle', ' ' + res.errors.join(' · '));
      } else if (res.warnings.length) {
        strip.className = 'pge-strip pge-strip-warn';
        strip.textContent = res.warnings.join(' · ');
      } else {
        strip.className = 'pge-strip pge-strip-ok';
        var n = res.datasets.length;
        strip.textContent = 'OK — ' + res.entries.length + ' variable(s), ' +
          n + ' list' + (n === 1 ? '' : 's') + '.';
      }
    }

    /* ── Wire geometry (rect-based, robust to zoom + nesting) ─── */
    function socketCenter(el) {
      if (!el) return null;
      var wr = world.getBoundingClientRect();
      var r = el.getBoundingClientRect();
      return { x: (r.left + r.width / 2 - wr.left) / view.scale, y: (r.top + r.height / 2 - wr.top) / view.scale };
    }
    function drawWires() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      routesByEdgeId = {};
      // node cards as world-coord obstacle rects (positions are already
      // world coords; sizes come from the per-render cache, so a node
      // drag needs no DOM reads beyond the existing socketCenter calls)
      var rects = graph.nodes.map(function (n) {
        var sz = sizeCache[n.id] || { w: 224, h: 180 };
        return { id: n.id, x0: n.x, y0: n.y, x1: n.x + sz.w, y1: n.y + sz.h };
      });
      var inputs = [];
      var edgeById = {};
      graph.edges.forEach(function (e) {
        var outEl = socketOut[e.from] && socketOut[e.from][_edgeSourceVar(e)];
        var inEl = socketIn[e.to] && socketIn[e.to][e.id];
        var a = socketCenter(outEl), b = socketCenter(inEl);
        if (!a || !b) return;
        inputs.push({ edgeId: e.id, from: e.from, to: e.to, a: a, b: b, fromKey: e.from + '|' + _edgeSourceVar(e) });
        edgeById[e.id] = e;
      });
      var routes = window.WireRouter ? window.WireRouter.routeAll(inputs, rects) : null;
      inputs.forEach(function (inp) {
        var e = edgeById[inp.edgeId];
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        var route = routes && routes[inp.edgeId];
        if (route) {
          path.setAttribute('d', route.d);
          routesByEdgeId[e.id] = route;
        } else {
          // fallback: the legacy simple bezier
          var dx = Math.max(30, Math.abs(inp.b.x - inp.a.x) / 2);
          path.setAttribute('d', 'M' + inp.a.x + ',' + inp.a.y + ' C' + (inp.a.x + dx) + ',' + inp.a.y +
            ' ' + (inp.b.x - dx) + ',' + inp.b.y + ' ' + inp.b.x + ',' + inp.b.y);
        }
        path.setAttribute('data-edge-id', e.id);
        var cat = _edgeCategory(e);
        path.setAttribute('class', 'pge-wire');
        // V3.422 — a mixed-unit variable's wire blends its constituent
        // dimension colors end-to-end (SVG strokes can't take the conic
        // pie, so a linear gradient along the run carries the identity)
        var wCats = _varCats(_edgeSourceVar(e));
        if (wCats && (Math.abs(inp.b.x - inp.a.x) > 1 || Math.abs(inp.b.y - inp.a.y) > 1)) {
          var gid = 'pgw-grad-' + (++_gradSeq);
          var grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
          grad.setAttribute('id', gid);
          grad.setAttribute('gradientUnits', 'userSpaceOnUse');
          grad.setAttribute('x1', inp.a.x); grad.setAttribute('y1', inp.a.y);
          grad.setAttribute('x2', inp.b.x); grad.setAttribute('y2', inp.b.y);
          wCats.forEach(function (c, ci) {
            var stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
            stop.setAttribute('offset', Math.round(ci * 100 / (wCats.length - 1)) + '%');
            stop.setAttribute('stop-color', PG().colorOfCategory(c));
            grad.appendChild(stop);
          });
          svg.appendChild(grad);
          path.setAttribute('stroke', 'url(#' + gid + ')');
        } else {
          path.setAttribute('stroke', PG().colorOfCategory(cat));
        }
        var tt = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        var toN = nodeById(e.to);
        tt.textContent = _edgeSourceVar(e) + ' → ' + (toN ? nodeName(toN) : '?') +
          (canEdit ? ' · click to remove · shift-drag to cut' : '');
        path.appendChild(tt);
        if (canEdit) {
          path.addEventListener('click', function (ev) {
            if (ev.shiftKey) return; // shift belongs to the cut gesture
            graph.edges = graph.edges.filter(function (x) { return x.id !== e.id; });
            persist(); render();
          });
        }
        svg.appendChild(path);
      });
    }
    function _edgeSourceVar(e) {
      var vars = PG().producedVars(nodeById(e.from));
      // honor the stored key when it still names a produced var; otherwise
      // fall back to the node's first var so a renamed/legacy source still
      // resolves (matches nodeSockets / _edgeCategory).
      if (e.sourceVar && vars.some(function (v) { return v.key === e.sourceVar; })) return e.sourceVar;
      // V3.423 — pass-through re-export: the from node RECEIVES this var
      var fromNode = nodeById(e.from);
      if (e.sourceVar && fromNode && _ptVars(fromNode)[e.sourceVar]) return e.sourceVar;
      if (vars.length) return vars[0].key;
      return e.sourceVar || '';
    }
    function _edgeCategory(e) {
      var sv = _edgeSourceVar(e);
      // V3.422 — resolve by name first, so a computed pure-volume var
      // colors as volume (not grey) and a mixed one falls to 'none'
      // (the pie/gradient carries its true identity).
      var q = sv && qtysCache[sv];
      if (q) {
        if (q.declared) return PG().categoryOfUnit(q.declared);
        var cats = PG().dimCategories(q.dim || {});
        return cats.length === 1 ? cats[0] : 'none';
      }
      var vars = PG().producedVars(nodeById(e.from));
      var v = vars.filter(function (x) { return x.key === sv; })[0] || vars[0];
      return v ? v.category : 'other';
    }

    /* ── Node cards — declaration-driven per-variable sockets ─────
     * Every produced variable gets a row with a LEFT dot (plug a value
     * in) and a RIGHT dot (pass the variable out). Settable fields
     * (min/max/step/default/decimals) get their own rows with a LEFT
     * param dot. Equations grow math-operand rows; lists grow feed
     * rows. Sockets come from producedVars()/inputSlots(), so they
     * exist BEFORE any wire — a binding is something you plug in, not a
     * hidden side-effect of a drag. A "+" footer arms a specific slot
     * for click-to-connect. */
    function makeCard(n) {
      var card = document.createElement('div');
      card.className = 'pge-node pge-node-' + n.type;
      card.style.left = n.x + 'px';
      card.style.top = n.y + 'px';
      socketOut[n.id] = {};
      socketIn[n.id] = {};
      if (n.collapsed) card.classList.add('pge-collapsed');

      // header
      var head = document.createElement('div');
      head.className = 'pge-node-head';
      var colBtn = document.createElement('button');
      colBtn.type = 'button';
      colBtn.className = 'pge-collapse';
      ICON.label(colBtn, n.collapsed ? 'chevron-right' : 'chevron-down');
      colBtn.title = n.collapsed ? 'Expand node' : 'Collapse node';
      colBtn.addEventListener('click', function (e) {
        e.stopPropagation(); n.collapsed = !n.collapsed; if (canEdit) persist(); render();
      });
      head.appendChild(colBtn);
      // V3.416 — jump the view straight to this node
      var zoomToBtn = document.createElement('button');
      zoomToBtn.type = 'button';
      zoomToBtn.className = 'pge-zoomto';
      zoomToBtn.textContent = '⌖';
      zoomToBtn.title = 'Zoom to this node (double-clicking the card works too)';
      zoomToBtn.addEventListener('click', function (e) {
        e.stopPropagation(); zoomToNode(n);
      });
      head.appendChild(zoomToBtn);
      var ttl = document.createElement('span');
      ttl.className = 'pge-node-title';
      var ttlText = ' ' + NODE_LABELS[n.type] + (nodeName(n) !== n.type ? (' · ' + nodeName(n)) : '');
      if (NODE_ICONS[n.type]) ICON.label(ttl, NODE_ICONS[n.type], ttlText);
      else ttl.textContent = ttlText;
      head.appendChild(ttl);
      if (n.type === 'input' || n.type === 'constant' || n.type === 'equation') {
        var badge = document.createElement('span');
        badge.className = 'pge-node-val';
        head.appendChild(badge);
        valEls[n.id] = badge;
      }
      card.appendChild(head);

      var body = document.createElement('div');
      body.className = 'pge-node-body';
      var rows = document.createElement('div');
      rows.className = 'pge-var-rows';
      body.appendChild(rows);

      var renderedEdges = {};   // edge ids already docked onto a slot

      // 1) OUTPUT rows — one per produced variable (left in-dot + label + right out-dot)
      var outs = PG().producedVars(n);
      outs.forEach(function (o) {
        var row = document.createElement('div');
        row.className = 'pge-var-row pge-var-output';
        // LEFT dot: constant's value is driveable (mirror); other output vars aren't.
        if (n.type === 'constant') {
          // V3.434 — the mirror modifier is retired: no NEW value
          // drivers can be armed, but a legacy protocol's existing one
          // still renders (and stays removable via its bound row).
          var vd = _driverEdge(n, 'value');
          if (vd) {
            row.appendChild(makeInDot(n.id, { role: 'param', paramField: 'value', arity: 'one',
              edgeId: vd.id, sourceVar: _edgeSourceVar(vd), category: _edgeCategory(vd),
              label: 'value' }));
            renderedEdges[vd.id] = true;
          } else {
            row.appendChild(makeInDot(n.id, { disabled: true,
              title: 'a fixed value — to display a variable on the document, use a Cards / References node' }));
          }
        } else {
          row.appendChild(makeInDot(n.id, { disabled: true,
            title: (n.type === 'choices' || n.type === 'ordered')
              ? 'generator output — feed the RIGHT dot into a List'
              : 'computed/settable via the rows below' }));
        }
        var main = document.createElement('div');
        main.className = 'pge-var-main';
        var multiCats = _varCats(o.key);
        main.appendChild(_swatch(o.category, multiCats, _dimNameOf(o.key)));
        var lab = document.createElement('span');
        lab.className = 'pge-var-label';
        var unitTxt = o.unit || _computedUnitOf(o.key);
        var dimNm = o.unit ? '' : _dimNameOf(o.key);
        var paren = dimNm && unitTxt ? (dimNm + ' · ' + unitTxt) : (dimNm || unitTxt);
        lab.textContent = o.label + (paren ? ' (' + paren + ')' : '');
        main.appendChild(lab);
        // constant: the value field lives here (disabled + driven when mirrored)
        if (n.type === 'constant') {
          var vDriver = _driverEdge(n, 'value');
          var vinp = document.createElement('input');
          vinp.type = 'number'; vinp.className = 'pge-var-input';
          vinp.value = (n.params.value === undefined || n.params.value === null) ? '' : String(n.params.value);
          vinp.disabled = !canEdit || !!vDriver;
          if (vDriver) { vinp.value = ''; vinp.placeholder = '↳ ' + _edgeSourceVar(vDriver); row.classList.add('pge-field-driven'); }
          vinp.addEventListener('change', function () {
            var num = parseFloat(vinp.value); n.params.value = isNaN(num) ? '' : num; persist(); recompileFeedback();
          });
          main.appendChild(vinp);
        }
        row.appendChild(main);
        row.appendChild(makeOutDot(n.id, o.key, o.category, multiCats));
        rows.appendChild(row);
      });
      // ghost when a source node has no name yet (no producedVars)
      if (!outs.length && (n.type === 'input' || n.type === 'constant' || n.type === 'equation')) {
        var grow = document.createElement('div');
        grow.className = 'pge-var-row pge-var-ghost';
        grow.appendChild(makeInDot(n.id, { disabled: true, title: 'name this node to enable its variable' }));
        var gm = document.createElement('span');
        gm.className = 'pge-var-label'; gm.textContent = 'name this node to enable output →';
        grow.appendChild(gm);
        rows.appendChild(grow);
      }

      // 2) SETTING rows — param slots (min/max/step/default, decimals); constant 'value' already on the output row
      PG().inputSlots(n).forEach(function (slot) {
        if (slot.kind !== 'param') return;
        if (n.type === 'constant' && slot.paramField === 'value') return;
        var driver = _driverEdge(n, slot.paramField);
        if (driver) renderedEdges[driver.id] = true;
        var row = document.createElement('div');
        row.className = 'pge-var-row pge-var-setting';
        row.appendChild(makeInDot(n.id, { role: 'param', paramField: slot.paramField, arity: 'one',
          edgeId: driver && driver.id, sourceVar: driver && _edgeSourceVar(driver),
          category: driver ? _edgeCategory(driver) : 'other', label: slot.label }));
        var main = document.createElement('div');
        main.className = 'pge-var-main';
        var lab = document.createElement('span');
        lab.className = 'pge-var-label'; lab.textContent = slot.label;
        main.appendChild(lab);
        var inp = document.createElement('input');
        inp.type = 'number'; inp.className = 'pge-var-input';
        var v = n.params[slot.paramField];
        inp.value = (v === undefined || v === null) ? '' : String(v);
        inp.disabled = !canEdit || !!driver;
        if (driver) { inp.value = ''; inp.placeholder = '↳ ' + _edgeSourceVar(driver); row.classList.add('pge-field-driven'); }
        inp.addEventListener('change', function () {
          var num = parseFloat(inp.value); n.params[slot.paramField] = isNaN(num) ? '' : num; persist(); recompileFeedback();
        });
        main.appendChild(inp);
        row.appendChild(main);
        // V3.423 — the driving variable re-exports on the right side
        if (driver) {
          var spd = _passDot(n, _edgeSourceVar(driver));
          if (spd) row.appendChild(spd);
        }
        rows.appendChild(row);
      });

      // 3) OPERAND rows (equation + code) — bound math edges + a trailing open dot
      if (n.type === 'equation' || n.type === 'code') {
        graph.edges.filter(function (e) { return e.to === n.id && PG().edgeRole(e, n.type) === 'math'; })
          .forEach(function (e) {
            renderedEdges[e.id] = true;
            rows.appendChild(_boundRow(n, e, 'math', 'operand'));
          });
        rows.appendChild(_openRow(n, { role: 'math', kind: 'math', arity: 'many' },
          n.type === 'code' ? 'plug a variable in as a script argument…' : 'drop a variable to use in the formula…'));
      }

      // 4) FEED rows (list) — bound structural edges + a trailing open dot
      if (n.type === 'list') {
        graph.edges.filter(function (e) { return e.to === n.id && PG().edgeRole(e, 'list') === 'structural'; })
          .forEach(function (e) {
            renderedEdges[e.id] = true;
            rows.appendChild(_boundRow(n, e, 'structural', 'feed'));
          });
        rows.appendChild(_openRow(n, { role: 'structural', kind: 'structural', arity: 'many' }, 'feed a choices / ordered set / per-item equation…'));
      }

      // 4b) DISPLAY rows (📊 Cards / 🔗 References gates) — wired vars + open dot
      if (n.type === 'cards' || n.type === 'refs') {
        graph.edges.filter(function (e) { return e.to === n.id && PG().edgeRole(e, n.type) === 'display'; })
          .forEach(function (e) {
            renderedEdges[e.id] = true;
            rows.appendChild(_boundRow(n, e, 'display', 'display'));
          });
        rows.appendChild(_openRow(n, { role: 'display', kind: 'display', arity: 'many' },
          n.type === 'cards' ? 'wire a variable to show it as a card…' : 'wire a variable to offer it inline…'));
      }

      // 5) LEFTOVER edges (legacy 'none' or anything unmatched) — keep visible + removable
      graph.edges.filter(function (e) { return e.to === n.id && !renderedEdges[e.id]; })
        .forEach(function (e) { rows.appendChild(_boundRow(n, e, PG().edgeRole(e, n.type), 'extra')); });

      // 6) CONFIG fields (identity + type editors that aren't sockets)
      if (!n.collapsed) {
        var fields = document.createElement('div');
        fields.className = 'pge-fields';
        _configFields(n, fields);
        body.appendChild(fields);
      }

      card.appendChild(body);

      // 7) "+" modifier footer
      if (canEdit && !n.collapsed) card.appendChild(_plusFooter(n, card));

      // delete + drag
      if (canEdit) {
        var del = document.createElement('button');
        del.type = 'button'; del.className = 'pge-node-del'; del.textContent = '×'; del.title = 'Delete node';
        del.addEventListener('click', function () {
          graph.nodes = graph.nodes.filter(function (x) { return x.id !== n.id; });
          graph.edges = graph.edges.filter(function (x) { return x.from !== n.id && x.to !== n.id; });
          persist(); render();
        });
        card.appendChild(del);
        head.addEventListener('pointerdown', function (e) {
          if (e.target !== head && !ttl.contains(e.target)) return;  // ttl holds an icon <svg> now
          e.preventDefault();
          var startX = e.clientX, startY = e.clientY, origX = n.x, origY = n.y;
          function move(ev) {
            n.x = Math.round((origX + (ev.clientX - startX) / view.scale) / 8) * 8;
            n.y = Math.round((origY + (ev.clientY - startY) / view.scale) / 8) * 8;
            card.style.left = n.x + 'px'; card.style.top = n.y + 'px'; drawWires();
          }
          function up() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); persist(); }
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
        });
      }

      nodeEls[n.id] = card;
      return card;
    }

    /* first incoming param edge that drives `field` on node n */
    function _driverEdge(n, field) {
      return graph.edges.filter(function (e) {
        return e.to === n.id && PG().edgeRole(e, n.type) === 'param' && (e.paramField || '') === field;
      })[0];
    }
    function _swatch(cat, cats, name) {
      var s = document.createElement('span');
      s.className = 'pge-var-swatch';
      s.style.background = (cats && cats.length > 1) ? dimBackground(cats) : PG().colorOfCategory(cat);
      if (cats && cats.length > 1) s.title = name ? (name + ' — ' + cats.join(' · ')) : cats.join(' · ');
      return s;
    }
    /* V3.422 — resolved pie cats for a variable: only when its unit is
     * COMPUTED and spans >1 category (declared units keep their single
     * color). Sees through node chains via qtysCache. */
    function _varCats(name) {
      var q = name && qtysCache[name];
      if (!q || q.declared || !q.computed) return null;
      var cats = PG().dimCategories(q.dim || {});
      return cats.length > 1 ? cats : null;
    }
    /* Composite unit label for a computed variable ('' when declared). */
    function _computedUnitOf(name) {
      var q = name && qtysCache[name];
      return (q && q.computed) ? PG().quantityLabel(q) : '';
    }
    /* V3.426 — canonical dimension name for a COMPUTED variable
     * (mass/volume = density); '' for declared/unnamed. The legend
     * stays fundamental-categories-only — derived quantities are
     * named inline where the variable appears. */
    function _dimNameOf(name) {
      var q = name && qtysCache[name];
      return (q && q.computed && !q.declared) ? PG().dimName(q.dim || {}) : '';
    }
    /* V3.423 — pass-through vars of a node, keyed by name (cached per render). */
    function _ptVars(n) {
      if (!ptCache[n.id]) {
        var m = {};
        PG().passThroughVars(graph, n).forEach(function (v) { m[v.key] = v; });
        ptCache[n.id] = m;
      }
      return ptCache[n.id];
    }
    /* Right-side re-export dot for a variable this node RECEIVES: wire
     * downstream from the nearest card instead of tracing back to the
     * producer. One per variable per card; skipped when the node itself
     * produces the name (its real out-dot already exists). Rendered for
     * viewers too — pass-through wires anchor on it. */
    function _passDot(n, sv) {
      var pt = sv && _ptVars(n)[sv];
      if (!pt || socketOut[n.id][sv]) return null;
      var q = qtysCache[sv];
      var cat = (q && !q.declared && q.computed)
        ? (PG().dimCategories(q.dim || {})[0] || pt.category) : pt.category;
      var d = makeOutDot(n.id, sv, cat, _varCats(sv));
      d.classList.add('pge-socket-pass');
      d.title = sv + ' — passes through this node: wire downstream from HERE (same variable, shorter wires)';
      return d;
    }

    /* A bound input row: left dot (docked to edge) + source chip + (equation) insert button + × remove. */
    function _boundRow(n, e, role, kind) {
      var row = document.createElement('div');
      row.className = 'pge-var-row pge-var-' + kind;
      var sv = _edgeSourceVar(e), cat = _edgeCategory(e);
      var svCats = _varCats(sv);
      row.appendChild(makeInDot(n.id, { role: role, paramField: e.paramField, arity: (kind === 'extra' && role === 'param') ? 'one' : 'many',
        edgeId: e.id, sourceVar: sv, category: cat, cats: svCats, label: e.paramField || role }));
      var main = document.createElement('div');
      main.className = 'pge-var-main';
      var chip = document.createElement('span');
      chip.className = 'pge-bind-chip';
      chip.style.borderColor = PG().colorOfCategory(cat);
      chip.innerHTML = '<span class="pge-bind-dot" style="background:' +
        (svCats ? dimBackground(svCats) : PG().colorOfCategory(cat)) + '"></span>' + esc(sv || '(var)');
      if (svCats) {
        var chipNm = _dimNameOf(sv);
        chip.title = sv + ' · ' + (chipNm ? chipNm + ' — ' + svCats.join('·') : svCats.join('·') + ' (mixed units)');
      }
      main.appendChild(chip);
      if (role === 'math' && n.type === 'equation') {
        // V3.407 — the formula pad owns insertion; this row just shows
        // WHICH pad alias (V1, L1, …) the wired variable answers to
        var aliasList = PG().equationAliases(graph, n, undefined, qtysCache);
        var mine = aliasList.filter(function (a) { return a.name === sv; })[0];
        var aTag = document.createElement('span');
        aTag.className = 'pge-bind-role-tag pge-bind-alias';
        aTag.textContent = mine ? mine.alias : 'math';
        aTag.title = mine ? ('On the formula pad as ' + mine.alias +
          (mine.unitLabel ? ' (' + mine.unitLabel + ')' : '')) : 'math input';
        if (mine && mine.cats && mine.cats.length > 1) {
          aTag.style.background = dimBackground(mine.cats);
          aTag.style.color = '#fff';
        } else if (mine) {
          aTag.style.borderColor = PG().colorOfCategory(mine.category);
        }
        main.appendChild(aTag);
      } else if (role === 'math' && n.type === 'code') {
        var atag = document.createElement('span');
        atag.className = 'pge-bind-role-tag';
        atag.textContent = 'argument';
        atag.title = 'Available in the script as ' + sv;
        main.appendChild(atag);
      } else if (role === 'display') {
        var dtag = document.createElement('span');
        dtag.className = 'pge-bind-role-tag';
        dtag.textContent = (n.type === 'cards') ? 'card' : 'inline';
        dtag.title = (n.type === 'cards')
          ? 'Shows as a result card on the document (and is referencable inline)'
          : 'Offered by the editor’s reference picker';
        main.appendChild(dtag);
      } else if (role !== 'param') {
        var tag = document.createElement('span');
        tag.className = 'pge-bind-role-tag';
        tag.textContent = (n.type === 'list') ? 'feeds list' : role;
        main.appendChild(tag);
      }
      row.appendChild(main);
      if (canEdit) {
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'pge-mini pge-row-rm'; rm.textContent = '×'; rm.title = 'Remove';
        rm.addEventListener('click', function () {
          graph.edges = graph.edges.filter(function (x) { return x.id !== e.id; });
          persist(); render();
        });
        row.appendChild(rm);
      }
      // V3.423 — a bound variable re-exports on the right side
      if (role === 'math' || role === 'param') {
        var pd = _passDot(n, sv);
        if (pd) row.appendChild(pd);
      }
      return row;
    }

    /* A trailing empty input row (the re-spawning dynamic dot). */
    function _openRow(n, slot, hint) {
      var row = document.createElement('div');
      row.className = 'pge-var-row pge-var-open';
      row.appendChild(makeInDot(n.id, { role: slot.role, arity: slot.arity, label: slot.role }));
      var main = document.createElement('div');
      main.className = 'pge-var-main pge-var-open-hint';
      main.textContent = hint;
      row.appendChild(main);
      return row;
    }

    /* Identity + type-specific config that isn't a socket. */
    function _configFields(n, body) {
      var p = n.params || (n.params = {});
      function field(key, label, type) {
        var wrap = document.createElement('label');
        wrap.className = 'pge-field';
        wrap.innerHTML = '<span>' + esc(label) + '</span>';
        var inp = document.createElement('input');
        inp.type = type || 'text';
        inp.value = (p[key] === undefined || p[key] === null) ? '' : String(p[key]);
        inp.disabled = !canEdit;
        inp.addEventListener('change', function () {
          if (type === 'number') { var num = parseFloat(inp.value); p[key] = isNaN(num) ? '' : num; } else { p[key] = inp.value; }
          // renaming a single-output node's variable: keep its outgoing
          // edges pointing at the new key so wires don't orphan.
          if (key === 'name' || key === 'field') {
            var pv = PG().producedVars(n);
            if (pv.length === 1) {
              var nk = pv[0].key;
              graph.edges.forEach(function (e) { if (e.from === n.id) e.sourceVar = nk; });
            }
          }
          persist(); recompileFeedback();
          if (key === 'name' || key === 'field' || key === 'label' || key === 'unit') render();
        });
        wrap.appendChild(inp);
        body.appendChild(wrap);
        return inp;
      }
      function widgetSelect() {
        var wrap = document.createElement('label');
        wrap.className = 'pge-field';
        wrap.innerHTML = '<span>Widget</span>';
        var sel = document.createElement('select');
        sel.className = 'pge-field-select';
        ['slider', 'number'].forEach(function (w) {
          var o = document.createElement('option'); o.value = w; o.textContent = w; sel.appendChild(o);
        });
        sel.value = (p.widget === 'number') ? 'number' : 'slider';
        sel.disabled = !canEdit;
        sel.addEventListener('change', function () { p.widget = sel.value; persist(); });
        wrap.appendChild(sel);
        body.appendChild(wrap);
      }
      /* Type → Unit dropdown pair (V3.400). The stored value is still
       * params.unit — the TYPE is derived via categoryOfUnit, so legacy
       * graphs work unchanged and non-catalog spellings (uL, hr) show
       * as Custom with the exact string preserved. Picking a type
       * narrows the unit list to that dimension's subset (error-proof),
       * and while the variable still wears its seeded placeholder name
       * it is auto-renamed <type>_XX. */
      function unitField(label, autoRename) {
        var wrap = document.createElement('label');
        wrap.className = 'pge-field';
        wrap.innerHTML = '<span>' + esc(label || 'Unit') + '</span>';
        var pair = document.createElement('span');
        pair.className = 'pge-unit-pair';
        var typeSel = document.createElement('select');
        typeSel.className = 'pge-field-select pge-unit-type';
        var unitSel = document.createElement('select');
        unitSel.className = 'pge-field-select pge-unit-unit';
        var custom = document.createElement('input');
        custom.type = 'text';
        custom.className = 'pge-unit-custom';
        custom.placeholder = 'unit';
        typeSel.disabled = unitSel.disabled = custom.disabled = !canEdit;
        [{ key: 'none', label: 'Unitless' }].concat(PG().unitTypeOptions(), [{ key: 'other', label: 'Custom…' }])
          .forEach(function (t) {
            var o = document.createElement('option');
            o.value = t.key; o.textContent = t.label;
            typeSel.appendChild(o);
          });
        function currentUnit() { return (p.unit == null) ? '' : String(p.unit); }
        function derivedCat() {
          var cur = currentUnit();
          if (cur === '') return 'none';
          var cat = PG().categoryOfUnit(cur);
          if (cat === 'other' || cat === 'none' || cat === 'categorical') return 'other';
          // recognized dimension but non-catalog spelling → Custom keeps it verbatim
          return PG().unitsForCategory(cat).indexOf(cur) >= 0 ? cat : 'other';
        }
        function refresh(catOverride) {
          var cur = currentUnit();
          var cat = catOverride || derivedCat();
          typeSel.value = cat;
          unitSel.innerHTML = '';
          unitSel.hidden = true; custom.hidden = true;
          if (cat !== 'none' && cat !== 'other') {
            PG().unitsForCategory(cat).forEach(function (u) {
              var o = document.createElement('option');
              o.value = u; o.textContent = u;
              unitSel.appendChild(o);
            });
            unitSel.value = cur;
            unitSel.hidden = false;
          } else if (cat === 'other') {
            custom.value = cur;
            custom.hidden = false;
          }
        }
        function commit(u) {
          p.unit = u;
          persist(); recompileFeedback(); render();
        }
        typeSel.addEventListener('change', function () {
          var cat = typeSel.value;
          if (cat === 'other') { refresh('other'); custom.focus(); return; } // commits when typed
          var next = '';
          if (cat !== 'none') {
            var units = PG().unitsForCategory(cat);
            next = units.indexOf(currentUnit()) >= 0 ? currentUnit() : units[0];
            // placeholder variables take the dimension's name: <type>_XX
            if (autoRename && p.name !== undefined && PG().isAutoName(p.name, n.id)) {
              var nm = PG().autoNameForCategory(graph, cat);
              if (nm) {
                p.name = nm;
                var pv = PG().producedVars(n);
                if (pv.length === 1) {
                  graph.edges.forEach(function (e) { if (e.from === n.id) e.sourceVar = pv[0].key; });
                }
              }
            }
          }
          commit(next);
        });
        unitSel.addEventListener('change', function () { commit(unitSel.value); });
        custom.addEventListener('change', function () { commit(custom.value); });
        refresh();
        pair.appendChild(typeSel);
        pair.appendChild(unitSel);
        pair.appendChild(custom);
        wrap.appendChild(pair);
        body.appendChild(wrap);
      }

      /* V3.428 — predefined scientific constants: one pick fills
       * name/label/value/unit. The select snaps back to its
       * placeholder so it reads as an ACTION, not a state. A name the
       * user typed by hand is kept; seeded (k_xxxx), auto, or
       * previously-preset names are replaced (collision-suffixed). */
      function constPreset() {
        var cat = PG().SCIENTIFIC_CONSTANTS || [];
        if (!cat.length) return;
        var wrap = document.createElement('label');
        wrap.className = 'pge-field';
        wrap.innerHTML = '<span>Preset</span>';
        var sel = document.createElement('select');
        sel.className = 'pge-field-select';
        var ph = document.createElement('option');
        ph.value = ''; ph.textContent = 'Common constants…';
        sel.appendChild(ph);
        cat.forEach(function (c, i) {
          var o = document.createElement('option');
          o.value = String(i);
          o.textContent = c.label + ' — ' + c.display + (c.unit ? ' ' + c.unit : '');
          o.title = c.note || '';
          sel.appendChild(o);
        });
        sel.disabled = !canEdit;
        sel.addEventListener('change', function () {
          var c = cat[parseInt(sel.value, 10)];
          sel.value = '';
          if (!c) return;
          var isPresetName = cat.some(function (cc) {
            return p.name === cc.key || String(p.name || '').indexOf(cc.key + '_') === 0;
          });
          if (!p.name || isPresetName || PG().isAutoName(p.name, n.id)) {
            var used = {};
            graph.nodes.forEach(function (gn) {
              if (gn.id === n.id) return;
              PG().producedVars(gn).forEach(function (v) { used[v.key] = true; });
            });
            var nm = c.key, k = 2;
            while (used[nm]) nm = c.key + '_' + (k++);
            p.name = nm;
            graph.edges.forEach(function (e2) { if (e2.from === n.id) e2.sourceVar = nm; });
          }
          p.label = c.label;
          p.value = c.value;
          p.unit = c.unit || '';
          persist(); recompileFeedback(); render();
        });
        wrap.appendChild(sel);
        body.appendChild(wrap);
      }

      if (n.type === 'input') {
        field('name', 'Name'); field('label', 'Label'); widgetSelect(); unitField('Unit', true); field('rangeHint', 'Hint');
      } else if (n.type === 'constant') {
        constPreset();
        field('name', 'Name'); field('label', 'Label'); unitField('Unit', true); field('decimals', 'Decimals (when mirrored)', 'number');
      } else if (n.type === 'choices') {
        field('field', 'Field'); field('label', 'Label');
        _optionRows(n, body);
        var lab = document.createElement('label');
        lab.className = 'pge-field pge-field-check';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = p.editable !== false; cb.disabled = !canEdit;
        cb.addEventListener('change', function () { p.editable = cb.checked; persist(); });
        lab.appendChild(cb); lab.appendChild(document.createTextNode(' editable at run time'));
        body.appendChild(lab);
      } else if (n.type === 'ordered') {
        field('field', 'Field'); field('label', 'Label'); unitField('Default unit (members)', false);
        _orderedItems(n, body);
      } else if (n.type === 'equation') {
        _equationResults(n, body);
      } else if (n.type === 'cards') {
        field('label', 'Panel label');
      } else if (n.type === 'refs') {
        field('label', 'Group label');
      } else if (n.type === 'list') {
        field('name', 'List name');
        _dedupe(n, body);
      } else if (n.type === 'code') {
        field('label', 'Label');
        _codeBody(n, body);
        _codeOutputs(n, body);
      }
    }

    /* Script body editor for a code node. Wired variables arrive as
     * named arguments; the script returns { outputName: value, … } (or
     * a bare number when exactly one output is declared). */
    function _codeBody(n, body) {
      var p = n.params;
      var wrap = document.createElement('div');
      wrap.className = 'pge-subgrid';
      var lab = document.createElement('div');
      lab.className = 'pge-sublabel';
      var args = graph.edges
        .filter(function (e) { return e.to === n.id && PG().edgeRole(e, 'code') === 'math'; })
        .map(function (e) { return _edgeSourceVar(e); })
        .filter(Boolean);
      lab.textContent = args.length
        ? 'Script — arguments: ' + args.join(', ')
        : 'Script — wire variables in to use them as arguments';
      wrap.appendChild(lab);
      var ta = document.createElement('textarea');
      ta.className = 'pge-code-body';
      ta.rows = 5;
      ta.spellcheck = false;
      ta.placeholder = 'return { result: 0 };';
      ta.value = (p.body == null) ? '' : String(p.body);
      ta.disabled = !canEdit;
      ta.addEventListener('change', function () { p.body = ta.value; persist(); recompileFeedback(); });
      wrap.appendChild(ta);
      body.appendChild(wrap);
    }

    /* V3.417 — multi-result equation support. results[0] mirrors back
     * to the legacy top-level params (name/expr/unit/decimals) so old
     * graphs, tour conditions, and per-item list assembly keep reading
     * the same fields. */
    function _ensureResults(p) {
      if (!Array.isArray(p.results) || !p.results.length) {
        p.results = PG().eqResults(p).map(function (x) {
          return { name: x.name || '', label: x.label || '', expr: x.expr || '', unit: x.unit || '', decimals: (typeof x.decimals === 'number') ? x.decimals : 3 };
        });
      }
    }
    function _mirrorEq(p) {
      var r0 = (Array.isArray(p.results) && p.results[0]) || null;
      if (!r0) return;
      p.name = r0.name; p.label = r0.label; p.expr = r0.expr;
      p.unit = r0.unit; p.decimals = r0.decimals;
    }
    /* Pie-wheel color for a COMPOUND dimension (volume·amount, mass/
     * volume …): equal conic wedges, one per constituent category. */
    function dimBackground(cats) {
      var segs = [], m = cats.length;
      cats.forEach(function (c, i) {
        var col = PG().colorOfCategory(c);
        segs.push(col + ' ' + Math.round(i * 100 / m) + '% ' + Math.round((i + 1) * 100 / m) + '%');
      });
      return 'conic-gradient(' + segs.join(', ') + ')';
    }
    /* V3.422 — per-result pie cats now come from _varCats (graph-wide
     * resolution), which also sees mixed units arriving from UPSTREAM
     * nodes — the old per-node computation could not. */
    /* One name/label/unit/decimals row + formula pad PER RESULT, an
     * "+ equation" appender, and per-result removal (wires from a
     * removed result go with it). Earlier results are usable in later
     * pads as local aliases — the multi-connector top edge comes free
     * from producedVars. */
    function _equationResults(n, body) {
      var p = n.params || (n.params = {});
      var rs = PG().eqResults(p);
      rs.forEach(function (r, ri) {
        var head = document.createElement('div');
        head.className = 'pge-eqres-head';
        var tag = document.createElement('span');
        tag.className = 'pge-eqres-tag';
        tag.textContent = 'Result ' + (ri + 1);
        head.appendChild(tag);
        if (canEdit && rs.length > 1) {
          var rm = document.createElement('button');
          rm.type = 'button'; rm.className = 'pge-mini'; rm.textContent = '×';
          rm.title = 'Remove this result (wires from it are removed too)';
          rm.addEventListener('click', function () {
            _ensureResults(p);
            var removed = (p.results[ri] || {}).name;
            p.results.splice(ri, 1);
            if (removed) {
              graph.edges = graph.edges.filter(function (e) { return !(e.from === n.id && e.sourceVar === removed); });
            }
            _mirrorEq(p);
            persist(); render();
          });
          head.appendChild(rm);
        }
        body.appendChild(head);
        var row = document.createElement('div');
        row.className = 'pge-subrow pge-subrow-ordered pge-eqres-row';
        [['name', 'name'], ['label', 'label']].forEach(function (kt) {
          var inp = document.createElement('input');
          inp.type = 'text'; inp.placeholder = kt[1];
          inp.value = (r[kt[0]] == null) ? '' : String(r[kt[0]]);
          inp.disabled = !canEdit;
          inp.addEventListener('change', function () {
            _ensureResults(p);
            var prev = p.results[ri][kt[0]];
            p.results[ri][kt[0]] = inp.value;
            // keep outgoing wires pointing at the renamed variable
            if (kt[0] === 'name' && prev && prev !== inp.value) {
              graph.edges.forEach(function (e) { if (e.from === n.id && e.sourceVar === prev) e.sourceVar = inp.value; });
            }
            _mirrorEq(p);
            persist(); render();
          });
          row.appendChild(inp);
        });
        row.appendChild(_unitCellSelect(r.unit, function (u) {
          _ensureResults(p);
          p.results[ri].unit = u;
          _mirrorEq(p);
          persist(); render();
        }));
        var dec = document.createElement('input');
        dec.type = 'number'; dec.placeholder = 'decimals'; dec.title = 'decimals';
        dec.value = (r.decimals == null) ? '' : String(r.decimals);
        dec.disabled = !canEdit;
        dec.addEventListener('change', function () {
          _ensureResults(p);
          var num = parseFloat(dec.value);
          p.results[ri].decimals = isNaN(num) ? 3 : num;
          _mirrorEq(p);
          persist(); recompileFeedback();
        });
        row.appendChild(dec);
        body.appendChild(row);
        _formulaPad(n, body, ri);
      });
      if (canEdit) {
        var add = document.createElement('button');
        add.type = 'button'; add.className = 'pge-mini pge-eqres-add';
        add.textContent = '+ equation';
        add.title = 'Add another result — earlier results are usable as variables in later equations of this node';
        add.addEventListener('click', function () {
          _ensureResults(p);
          p.results.push({ name: '', label: '', expr: '', unit: '', decimals: 3 });
          persist(); render();
        });
        body.appendChild(add);
      }
    }

    /* Click-built formula pad (V3.407) — replaces the free-text expr
     * field entirely. Wired math inputs appear as dimension-coded
     * alias buttons (V1 = first volume, L1 = first length, D1 = first
     * duration, X1 = unitless …); operators sit below; the click
     * grammar greys anything that would be a syntax error, so a
     * malformed formula can't be built. Unitless numbers go in via the
     * small number slot — a constant WITH a unit belongs in a wired
     * 📌 Constant node. `params.expr` underneath stays real-name
     * mathjs text (compile/doc/notebook untouched); hand-written or
     * imported exprs the pad can't represent render read-only with AC
     * as the way back. */
    function _formulaPad(n, body, resultIdx) {
      var p = n.params;
      var ri = resultIdx || 0;
      var r = PG().eqResults(p)[ri] || {};
      function _writeExpr(v) {
        _ensureResults(p);
        if (!p.results[ri]) p.results[ri] = { name: '', label: '', expr: '', unit: '', decimals: 3 };
        p.results[ri].expr = v;
        _mirrorEq(p);
      }
      var wrap = document.createElement('div');
      wrap.className = 'pge-fpad';
      // wires + THIS node's earlier results (local aliases)
      var aliases = PG().equationAliases(graph, n, ri, qtysCache);
      var aliasByName = {};
      aliases.forEach(function (a) { aliasByName[a.name] = a; });
      var parsed = PG().tokenizeExpr(r.expr || '');

      var toks = parsed.ok ? parsed.tokens.slice() : null; // null → raw (read-only) mode
      var allowed = toks ? PG().fpadNextAllowed(toks)
        : { operand: false, operator: false, close: false, complete: false };
      function commit() {
        _writeExpr(toks ? PG().serializeTokens(toks) : '');
        persist(); render();
      }
      function push(tk) { if (toks) { toks.push(tk); commit(); } }

      // V3.409 — tap a variable chip in the strip to SWAP it for another
      // wired variable in place (retarget without rebuilding the formula)
      var swapMenu = null;
      function closeSwap() {
        if (swapMenu && swapMenu.parentNode) swapMenu.parentNode.removeChild(swapMenu);
        swapMenu = null;
        document.removeEventListener('pointerdown', _swapOutside, true);
      }
      function _swapOutside(e) {
        if (!document.contains(wrap)) { closeSwap(); return; } // pad re-rendered away
        if (swapMenu && !swapMenu.contains(e.target)) closeSwap();
      }
      function openSwap(idx, anchor) {
        closeSwap();
        if (!toks || !aliases.length) return;
        var cur = toks[idx] && toks[idx].name;
        var menu = document.createElement('div');
        menu.className = 'pge-fpad-swap';
        var head = document.createElement('div');
        head.className = 'pge-fpad-swap-head';
        head.textContent = 'Swap variable for…';
        menu.appendChild(head);
        aliases.forEach(function (a) {
          var it = document.createElement('button');
          it.type = 'button';
          it.className = 'pge-fpad-swap-item' + (a.name === cur ? ' pge-fpad-swap-cur' : '');
          it.style.borderLeftColor = PG().colorOfCategory(a.category);
          it.innerHTML = '<b>' + esc(a.alias) + '</b> ' + esc(a.name) +
            (a.unitLabel ? ' <span class="pge-fpad-swap-unit">' + esc(a.unitLabel) + '</span>' : '');
          it.disabled = a.name === cur;
          it.title = a.name === cur ? 'already this variable' : ('replace with ' + a.name);
          it.addEventListener('click', function () {
            closeSwap();
            if (toks[idx] && toks[idx].t === 'var') {
              toks[idx].name = a.name;
              commit();
            }
          });
          menu.appendChild(it);
        });
        document.body.appendChild(menu);
        swapMenu = menu;
        var r = anchor.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(window.innerWidth - 210, r.left)) + 'px';
        menu.style.top = (r.bottom + 3) + 'px';
        document.addEventListener('pointerdown', _swapOutside, true);
      }

      var strip = document.createElement('div');
      strip.className = 'pge-fpad-expr';
      if (!parsed.ok) {
        var raw = document.createElement('span');
        raw.className = 'pge-fpad-raw';
        raw.textContent = r.expr || '';
        raw.title = 'Hand-written / imported formula using functions the pad doesn’t offer — AC clears it so you can rebuild.';
        strip.appendChild(raw);
      } else if (!parsed.tokens.length) {
        strip.innerHTML = '<span class="pge-fpad-empty">tap variables + operators below…</span>';
      } else {
        parsed.tokens.forEach(function (tk, idx) {
          var isVar = tk.t === 'var';
          var clickable = isVar && canEdit && !!toks;
          var chip = document.createElement(clickable ? 'button' : 'span');
          if (clickable) chip.type = 'button';
          chip.className = 'pge-fpad-tok pge-fpad-tok-' + tk.t;
          if (isVar) {
            var a = aliasByName[tk.name];
            chip.textContent = a ? a.alias : tk.name;
            var tkNm = _dimNameOf(tk.name);
            chip.title = tk.name + (a && a.unitLabel ? ' (' + a.unitLabel + ')' : '') + (tkNm ? ' · ' + tkNm : '');
            if (a && a.cats && a.cats.length > 1) {
              chip.style.background = dimBackground(a.cats);
              chip.style.color = '#fff';
              chip.style.borderColor = 'transparent';
            } else if (a) chip.style.borderColor = PG().colorOfCategory(a.category);
            else chip.classList.add('pge-fpad-tok-loose');
            if (clickable) {
              chip.classList.add('pge-fpad-tok-clickable');
              chip.title += ' — tap to swap';
              chip.addEventListener('click', function () { openSwap(idx, chip); });
            }
          } else if (tk.t === 'num') chip.textContent = tk.v;
          else if (tk.t === 'op') chip.textContent = { '*': '×', '/': '÷' }[tk.v] || tk.v;
          else if (tk.t === 'open') chip.textContent = '(';
          else if (tk.t === 'close') chip.textContent = ')';
          else if (tk.t === 'comma') chip.textContent = ',';
          else if (tk.t === 'func') chip.textContent = (tk.v === 'sqrt' ? '√(' : tk.v + '(');
          strip.appendChild(chip);
        });
      }
      wrap.appendChild(strip);
      if (!canEdit) { body.appendChild(wrap); return; }

      var vars = document.createElement('div');
      vars.className = 'pge-fpad-vars';
      aliases.forEach(function (a) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pge-fpad-varbtn';
        var mixed = a.cats && a.cats.length > 1;
        b.style.borderColor = mixed ? 'transparent' : PG().colorOfCategory(a.category);
        var aliasStyle = mixed
          ? ' style="background:' + dimBackground(a.cats) + ';color:#fff;border-radius:3px;padding:0 4px"' : '';
        b.innerHTML = '<span class="pge-fpad-alias"' + aliasStyle + '>' + esc(a.alias) + '</span>' +
          '<span class="pge-fpad-varname">' + esc(a.name) +
          (a.unitLabel ? ' <span class="pge-fpad-varunit">' + esc(a.unitLabel) + '</span>' : '') + '</span>';
        b.disabled = !toks || !allowed.operand;
        var bNm = _dimNameOf(a.name);
        b.title = a.name + (a.unitLabel ? ' (' + a.unitLabel + ')' : '') + (bNm ? ' · ' + bNm : '') +
          ' — tap to add' + (mixed && !bNm ? ' · mixed units: ' + a.cats.join('·') : '');
        b.addEventListener('click', function () { push({ t: 'var', name: a.name }); });
        vars.appendChild(b);
      });
      if (!aliases.length) {
        var hint = document.createElement('span');
        hint.className = 'pge-fpad-nohint';
        hint.textContent = 'wire variables in — they appear here as V1, L1, …';
        vars.appendChild(hint);
      }
      var numWrap = document.createElement('span');
      numWrap.className = 'pge-fpad-numwrap';
      var numIn = document.createElement('input');
      numIn.type = 'number';
      numIn.step = 'any';
      numIn.placeholder = '123';
      numIn.className = 'pge-fpad-num';
      numIn.disabled = !toks || !allowed.operand;
      numIn.title = 'Unitless number. A constant WITH a unit belongs in a Constant node, wired in.';
      var numBtn = document.createElement('button');
      numBtn.type = 'button';
      numBtn.className = 'pge-fpad-opbtn pge-fpad-numgo';
      numBtn.textContent = '↵';
      numBtn.title = numIn.title;
      numBtn.disabled = numIn.disabled;
      function pushNum() {
        var v = parseFloat(numIn.value);
        if (!isFinite(v)) return;
        push({ t: 'num', v: String(v) });
      }
      numBtn.addEventListener('click', pushNum);
      numIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); pushNum(); }
      });
      numWrap.appendChild(numIn);
      numWrap.appendChild(numBtn);
      vars.appendChild(numWrap);
      wrap.appendChild(vars);

      var ops = document.createElement('div');
      ops.className = 'pge-fpad-ops';
      function opBtn(label, title, enabled, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pge-fpad-opbtn';
        b.textContent = label;
        b.title = title;
        b.disabled = !enabled;
        b.addEventListener('click', fn);
        ops.appendChild(b);
      }
      var en = !!toks;
      opBtn('(', 'open a group', en && allowed.operand, function () { push({ t: 'open' }); });
      opBtn(')', 'close the group', en && allowed.close, function () { push({ t: 'close' }); });
      opBtn('+', 'add', en && allowed.operator, function () { push({ t: 'op', v: '+' }); });
      opBtn('−', 'subtract / negate', en && (allowed.operator || allowed.operand), function () { push({ t: 'op', v: '-' }); });
      opBtn('×', 'multiply', en && allowed.operator, function () { push({ t: 'op', v: '*' }); });
      opBtn('÷', 'divide', en && allowed.operator, function () { push({ t: 'op', v: '/' }); });
      opBtn('^', 'power', en && allowed.operator, function () { push({ t: 'op', v: '^' }); });
      opBtn('√(', 'square root', en && allowed.operand, function () { push({ t: 'func', v: 'sqrt' }); });
      opBtn('⌫', 'remove the last piece', en && toks.length > 0, function () { toks.pop(); commit(); });
      opBtn('AC', 'clear the formula and rebuild', true, function () {
        _writeExpr('');
        persist(); render();
      });
      wrap.appendChild(ops);

      if (toks && toks.length && !allowed.complete) {
        var note = document.createElement('div');
        note.className = 'pge-fpad-note';
        note.textContent = '… unfinished — needs ' + (allowed.operand ? 'a value' : 'a closing )');
        wrap.appendChild(note);
      }
      // V3.417 — dimensional consistency: warn on unit-mixing inside the
      // formula (+/− across dimensions, united exponents, …) and on a
      // declared unit that disagrees with what the math computes
      if (toks && toks.length && allowed.complete) {
        var qtyByName = {};
        aliases.forEach(function (a) { qtyByName[a.name] = a.qty || PG().quantityOfUnit(a.unit); });
        var chk = PG().checkTokenDims(toks, qtyByName);
        if (chk.ok) {
          var msgs = chk.warnings.slice();
          var declared = PG().quantityOfUnit(r.unit);
          if ((r.unit || '') !== '') {
            if (!PG().dimsEqual(declared.dim, chk.dim)) {
              msgs.push('declared unit "' + r.unit + '" is ' + PG().dimDisplay(declared.dim) + ', but the math computes ' + PG().dimDisplay(chk.dim));
            } else if (!PG().dimsEqual(declared.kinds, chk.kinds || {})) {
              msgs.push('declared unit "' + r.unit + '" is a different unit family than the math computes (°C vs K style)');
            } else if (declared.scale != null && chk.scale != null &&
                       Math.abs(declared.scale - chk.scale) / Math.max(Math.abs(declared.scale), Math.abs(chk.scale), 1e-300) > 1e-9) {
              var ratio = chk.scale / declared.scale;
              var v = ratio >= 1 ? ratio : 1 / ratio;
              var fmt = v >= 1e5 ? v.toExponential(0).replace('e+', 'e') : String(Math.round(v * 100) / 100);
              msgs.push('magnitude: the math computes ×' + fmt + ' ' + (ratio >= 1 ? 'larger' : 'smaller') + ' than "' + r.unit + '" — check the operand units');
            }
          }
          if (msgs.length) {
            var warn = document.createElement('div');
            warn.className = 'pge-fpad-unitwarn';
            ICON.label(warn, 'exclamation-triangle', ' ' + msgs.join(' · '));
            wrap.appendChild(warn);
          } else {
            var infoNm = PG().dimName(chk.dim);
            if (infoNm || PG().dimCategories(chk.dim).length > 1 ||
                Object.keys(chk.units || {}).length > 1) {
              var info = document.createElement('div');
              info.className = 'pge-fpad-unitinfo';
              var infoUl = PG().quantityLabel({ units: chk.units, dim: chk.dim }) || PG().dimLabel(chk.dim);
              info.textContent = 'computes to ' + (infoNm ? infoNm + ' (' + infoUl + ')' : infoUl);
              wrap.appendChild(info);
            }
          }
        }
      }
      body.appendChild(wrap);
    }

    /* Grouped unit <select> for grid rows (code outputs, ordered
     * members) — the same typed catalog as unitField in one control:
     * optgroups per dimension, a preserved "(custom)" option for
     * non-catalog values, and a custom… entry that swaps in a text
     * input. (V3.400) */
    function _unitCellSelect(cur, onCommit) {
      cur = (cur == null) ? '' : String(cur);
      var sel = document.createElement('select');
      sel.className = 'pge-unit-cell';
      sel.disabled = !canEdit;
      sel.title = 'Unit';
      var o0 = document.createElement('option');
      o0.value = ''; o0.textContent = '—';
      sel.appendChild(o0);
      var inCatalog = cur === '';
      PG().unitTypeOptions().forEach(function (t) {
        var og = document.createElement('optgroup');
        og.label = t.label;
        t.units.forEach(function (u) {
          var o = document.createElement('option');
          o.value = u; o.textContent = u;
          og.appendChild(o);
          if (u === cur) inCatalog = true;
        });
        sel.appendChild(og);
      });
      if (!inCatalog) {
        var oc = document.createElement('option');
        oc.value = cur; oc.textContent = cur + ' (custom)';
        sel.appendChild(oc);
      }
      var oCustom = document.createElement('option');
      oCustom.value = '__custom__'; oCustom.textContent = 'custom…';
      sel.appendChild(oCustom);
      sel.value = cur;
      sel.addEventListener('change', function () {
        if (sel.value === '__custom__') {
          var inp = document.createElement('input');
          inp.type = 'text'; inp.placeholder = 'unit'; inp.value = cur;
          inp.disabled = !canEdit;
          inp.addEventListener('change', function () { onCommit(inp.value); });
          sel.parentNode.replaceChild(inp, sel);
          inp.focus();
          return;
        }
        onCommit(sel.value);
      });
      return sel;
    }

    /* Declared outputs grid for a code node (name/label/unit/decimals). */
    function _codeOutputs(n, body) {
      var p = n.params; if (!Array.isArray(p.outputs)) p.outputs = [];
      var wrap = document.createElement('div'); wrap.className = 'pge-subgrid';
      wrap.innerHTML = '<div class="pge-sublabel">Outputs (matched to the returned keys)</div>';
      p.outputs.forEach(function (o, i) {
        var row = document.createElement('div'); row.className = 'pge-subrow pge-subrow-ordered';
        [['name', 'text'], ['label', 'text'], ['unit', 'unit'], ['decimals', 'number']].forEach(function (kt) {
          var k = kt[0];
          if (kt[1] === 'unit') {
            row.appendChild(_unitCellSelect(o.unit, function (u) {
              o.unit = u; persist(); render();
            }));
            return;
          }
          var inp = document.createElement('input'); inp.type = kt[1]; inp.placeholder = k;
          inp.value = (o[k] === undefined || o[k] === null) ? '' : String(o[k]);
          inp.disabled = !canEdit;
          inp.addEventListener('change', function () {
            var prev = o[k];
            o[k] = (kt[1] === 'number') ? (parseFloat(inp.value) || 0) : inp.value;
            // renaming an output: keep outgoing wires pointing at the new key
            if (k === 'name' && prev && prev !== o[k]) {
              graph.edges.forEach(function (e2) { if (e2.from === n.id && e2.sourceVar === prev) e2.sourceVar = o[k]; });
            }
            persist(); (k === 'name') ? render() : recompileFeedback();
          });
          row.appendChild(inp);
        });
        if (canEdit) {
          var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'pge-mini'; rm.textContent = '×';
          rm.addEventListener('click', function () { p.outputs.splice(i, 1); persist(); render(); });
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      if (canEdit) {
        var add = document.createElement('button'); add.type = 'button'; add.className = 'pge-mini'; add.textContent = '+ output';
        add.addEventListener('click', function () {
          p.outputs.push({ name: '', label: '', unit: '', decimals: 3 });
          persist(); render();
        });
        wrap.appendChild(add);
      }
      body.appendChild(wrap);
    }

    function _optionRows(n, body) {
      var p = n.params; if (!Array.isArray(p.options)) p.options = [];
      var wrap = document.createElement('div'); wrap.className = 'pge-subgrid';
      wrap.innerHTML = '<div class="pge-sublabel">Options</div>';
      p.options.forEach(function (opt, i) {
        var row = document.createElement('div'); row.className = 'pge-subrow';
        var inp = document.createElement('input'); inp.type = 'text'; inp.value = String(opt); inp.disabled = !canEdit;
        inp.addEventListener('change', function () { p.options[i] = inp.value; persist(); recompileFeedback(); });
        row.appendChild(inp);
        if (canEdit) {
          var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'pge-mini'; rm.textContent = '×';
          rm.addEventListener('click', function () { p.options.splice(i, 1); persist(); render(); });
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      if (canEdit) {
        var add = document.createElement('button'); add.type = 'button'; add.className = 'pge-mini'; add.textContent = '+ option';
        add.addEventListener('click', function () { p.options.push(''); persist(); render(); });
        wrap.appendChild(add);
      }
      body.appendChild(wrap);
    }

    function _orderedItems(n, body) {
      var p = n.params; if (!Array.isArray(p.items)) p.items = [];
      var wrap = document.createElement('div'); wrap.className = 'pge-subgrid';
      wrap.innerHTML = '<div class="pge-sublabel">Members (each &lt; the next)</div>';
      p.items.forEach(function (it, i) {
        var row = document.createElement('div'); row.className = 'pge-subrow pge-subrow-ordered';
        [['name', 'text'], ['default', 'number'], ['unit', 'unit'], ['min', 'number'], ['max', 'number'], ['step', 'number']].forEach(function (kt) {
          var k = kt[0];
          if (kt[1] === 'unit') {
            row.appendChild(_unitCellSelect(it.unit, function (u) {
              it.unit = u; persist(); render();
            }));
            return;
          }
          var inp = document.createElement('input'); inp.type = kt[1]; inp.placeholder = k;
          inp.value = (it[k] === undefined || it[k] === null) ? '' : String(it[k]); inp.disabled = !canEdit;
          inp.addEventListener('change', function () {
            it[k] = (kt[1] === 'number') ? (parseFloat(inp.value) || 0) : inp.value;
            persist(); (k === 'name') ? render() : recompileFeedback();
          });
          row.appendChild(inp);
        });
        if (canEdit) {
          var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'pge-mini'; rm.textContent = '×';
          rm.addEventListener('click', function () { p.items.splice(i, 1); persist(); render(); });
          row.appendChild(rm);
        }
        wrap.appendChild(row);
      });
      if (canEdit) {
        var add = document.createElement('button'); add.type = 'button'; add.className = 'pge-mini'; add.textContent = '+ member';
        add.addEventListener('click', function () { p.items.push({ name: '', default: 0, unit: p.unit || '', min: 1, max: 100, step: 1 }); persist(); render(); });
        wrap.appendChild(add);
      }
      body.appendChild(wrap);
    }

    function _dedupe(n, body) {
      var p = n.params; if (!p.dedupe || typeof p.dedupe !== 'object') p.dedupe = { when: '', ignore: [] };
      var wrap = document.createElement('div'); wrap.className = 'pge-subgrid';
      wrap.innerHTML = '<div class="pge-sublabel">Merge rule (optional)</div>';
      var whenInp = document.createElement('input'); whenInp.type = 'text'; whenInp.placeholder = 'when (row expr)';
      whenInp.value = p.dedupe.when || ''; whenInp.disabled = !canEdit;
      whenInp.addEventListener('change', function () { p.dedupe.when = whenInp.value; persist(); recompileFeedback(); });
      wrap.appendChild(whenInp);
      var ignInp = document.createElement('input'); ignInp.type = 'text'; ignInp.placeholder = 'ignore fields (csv)';
      ignInp.value = (p.dedupe.ignore || []).join(', '); ignInp.disabled = !canEdit;
      ignInp.addEventListener('change', function () {
        p.dedupe.ignore = ignInp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        persist(); recompileFeedback();
      });
      wrap.appendChild(ignInp);
      body.appendChild(wrap);
    }

    /* "+" footer: per-type menu of modifiers. Each item arms a specific
     * declared slot for click-to-connect, reveals an option, or adds a row. */
    function _plusFooter(n, card) {
      var foot = document.createElement('div');
      foot.className = 'pge-node-plus';
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'pge-plus-btn'; btn.textContent = '+ add modifier';
      foot.appendChild(btn);
      var menu = document.createElement('div');
      menu.className = 'pge-plus-menu'; menu.hidden = true;
      foot.appendChild(menu);
      function item(label, fn) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'pge-plus-item'; b.textContent = label;
        b.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = true; fn(); });
        menu.appendChild(b);
      }
      function armSlot(slotName) {
        // prefer an OPEN slot (the trailing dynamic dot / an unbound param);
        // fall back to a bound param dot (re-drive replaces it).
        var dot = card.querySelector('.pge-socket-in.pge-slot-open[data-slot="' + slotName + '"]') ||
                  card.querySelector('.pge-socket-in[data-slot="' + slotName + '"]:not(.pge-slot-disabled)');
        if (dot) armWire(dot);
        else flashStrip('That input is not available on this node.', 'warn');
      }
      var built = false;
      function build() {
        if (built) return; built = true;
        if (n.type === 'input') {
          ['min', 'max', 'step', 'default'].forEach(function (f) {
            item('Drive ' + f + ' from a variable…', function () { armSlot(f); });
          });
        } else if (n.type === 'cards' || n.type === 'refs') {
          item('Add variable…', function () { armSlot('display'); });
        } else if (n.type === 'equation') {
          item('Add math input…', function () { armSlot('math'); });
          item('Drive decimals from a variable…', function () { armSlot('decimals'); });
        } else if (n.type === 'choices') {
          item('Add option', function () { if (!Array.isArray(n.params.options)) n.params.options = []; n.params.options.push(''); persist(); render(); });
        } else if (n.type === 'ordered') {
          item('Add member', function () { if (!Array.isArray(n.params.items)) n.params.items = []; n.params.items.push({ name: '', default: 0, unit: n.params.unit || '', min: 1, max: 100, step: 1 }); persist(); render(); });
        } else if (n.type === 'list') {
          item('Accept a feed…', function () { armSlot('structural'); });
        } else if (n.type === 'code') {
          item('Add script argument…', function () { armSlot('math'); });
          item('Add output', function () {
            if (!Array.isArray(n.params.outputs)) n.params.outputs = [];
            n.params.outputs.push({ name: '', label: '', unit: '', decimals: 3 });
            persist(); render();
          });
        }
        item('Delete this node', function () {
          graph.nodes = graph.nodes.filter(function (x) { return x.id !== n.id; });
          graph.edges = graph.edges.filter(function (x) { return x.from !== n.id && x.to !== n.id; });
          persist(); render();
        });
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        build();
        menu.hidden = !menu.hidden;
        // flip the menu upward if it would spill past the viewport bottom
        if (!menu.hidden) {
          menu.classList.remove('pge-plus-menu-up');
          var vp = viewport.getBoundingClientRect();
          var mr = menu.getBoundingClientRect();
          if (mr.bottom > vp.bottom) menu.classList.add('pge-plus-menu-up');
        }
      });
      return foot;
    }

    /* ── Sockets ──────────────────────────────────────────────── */
    function makeOutDot(nodeId, key, category, cats) {
      var d = document.createElement('span');
      d.className = 'pge-socket pge-socket-out';
      if (cats && cats.length > 1) {
        d.style.background = dimBackground(cats);
        var dnm = _dimNameOf(key);
        d.title = key + ' · ' + (dnm ? dnm + ' (' + cats.join('·') + ')' : cats.join('·')) +
          (canEdit ? ' — drag to a left dot (fans out to many)' : '');
      } else {
        d.style.background = PG().colorOfCategory(category);
        d.title = key + ' · ' + category + (canEdit ? ' — drag to a left dot (fans out to many)' : '');
      }
      d._out = { nodeId: nodeId, sourceVar: key, category: category };
      socketOut[nodeId][key] = d;
      if (canEdit) d.addEventListener('pointerdown', function (e) { onDotDown(d, e); });
      return d;
    }
    function makeInDot(nodeId, opts) {
      var d = document.createElement('span');
      d.className = 'pge-socket pge-socket-in';
      d.dataset.slot = opts.paramField || opts.kind || opts.role || '';
      if (opts.disabled) {
        d.classList.add('pge-slot-disabled');
        d.title = opts.title || 'not a driveable input';
        return d;
      }
      d._slot = { nodeId: nodeId, role: opts.role, paramField: opts.paramField, arity: opts.arity || 'many' };
      if (opts.edgeId) {
        d.classList.add('pge-slot-bound');
        d.style.background = (opts.cats && opts.cats.length > 1)
          ? dimBackground(opts.cats) : PG().colorOfCategory(opts.category || 'other');
        socketIn[nodeId][opts.edgeId] = d;
        d.title = (opts.sourceVar || 'bound') + ' → ' + (opts.paramField || opts.role || 'input');
      } else {
        d.classList.add('pge-slot-open');
        d.title = 'plug a variable in here (' + (opts.label || opts.role || 'input') + ')';
      }
      if (canEdit) d.addEventListener('pointerdown', function (e) { onDotDown(d, e); });
      return d;
    }

    /* ── Wiring (bidirectional; role/field come from the dot, not a guess) ──
     * We capture the pointer on the origin dot and resolve the drop target
     * geometrically with elementFromPoint. Touch/pen pointers get implicit
     * capture to the pointerdown target, so relying on the target dot's own
     * pointerup would break wiring on touch — this path works for mouse,
     * pen, and touch alike. */
    function onDotDown(dot, e) {
      e.stopPropagation(); e.preventDefault();
      if (wiring && wiring.armed) { completeWireAt(dot); return; }
      startDrag(dot, e);
    }
    function _dotAt(x, y) {
      var el = document.elementFromPoint(x, y);
      while (el && el.nodeType === 1) {
        if (el.classList && el.classList.contains('pge-socket')) return el;
        el = el.parentNode;
      }
      return null;
    }
    function startDrag(dot, e) {
      if (dot._out) wiring = { originEnd: 'out', armed: false, nodeId: dot._out.nodeId, sourceVar: dot._out.sourceVar, category: dot._out.category, fromEl: dot };
      else if (dot._slot) wiring = { originEnd: 'in', armed: false, nodeId: dot._slot.nodeId, role: dot._slot.role, paramField: dot._slot.paramField, arity: dot._slot.arity, fromEl: dot };
      else return;
      document.body.classList.add('pge-wiring');
      markCandidates();
      var pid = e && e.pointerId;
      try { if (pid != null) dot.setPointerCapture(pid); } catch (_) {}
      var lastX = e ? e.clientX : 0, lastY = e ? e.clientY : 0;
      var move = function (ev) { lastX = ev.clientX; lastY = ev.clientY; drawTempWire(lastX, lastY); };
      var up = function (ev) {
        dot.removeEventListener('pointermove', move);
        dot.removeEventListener('pointerup', up);
        try { if (pid != null) dot.releasePointerCapture(pid); } catch (_) {}
        document.body.classList.remove('pge-wiring');
        var tx = ev ? ev.clientX : lastX, ty = ev ? ev.clientY : lastY;
        var target = _dotAt(tx, ty);
        if (wiring && !wiring.armed) {
          if (target && target !== dot) completeWireAt(target);
          else { flashStrip('No target — release on a dot to connect.', 'warn'); cancelWire(); }
        }
      };
      dot.addEventListener('pointermove', move);
      dot.addEventListener('pointerup', up);
    }
    function armWire(dot) {
      cancelWire();
      if (!dot._slot) return;
      wiring = { originEnd: 'in', armed: true, nodeId: dot._slot.nodeId, role: dot._slot.role, paramField: dot._slot.paramField, arity: dot._slot.arity, fromEl: dot };
      document.body.classList.add('pge-wiring');
      dot.classList.add('pge-slot-armed');
      markCandidates();
      flashStrip('Now click the variable (right dot) to connect.', 'warn');
    }
    function cancelWire() {
      wiring = null;
      document.body.classList.remove('pge-wiring');
      clearCandidates();
      drawWires();
    }
    function markCandidates() {
      if (!wiring) return;
      var sel = wiring.originEnd === 'out' ? '.pge-socket-in' : '.pge-socket-out';
      Array.prototype.forEach.call(world.querySelectorAll(sel), function (d) {
        if (d.classList.contains('pge-slot-disabled')) return;
        var other = wiring.originEnd === 'out' ? (d._slot && d._slot.nodeId) : (d._out && d._out.nodeId);
        if (!other || other === wiring.nodeId) return;
        // a categorical (choices) source can't drive a numeric param slot — don't tease it
        if (wiring.originEnd === 'out' && wiring.category === 'categorical' && d._slot && d._slot.role === 'param') return;
        d.classList.add('pge-compatible');
      });
    }
    function clearCandidates() {
      Array.prototype.forEach.call(world.querySelectorAll('.pge-compatible, .pge-slot-armed'), function (d) {
        d.classList.remove('pge-compatible', 'pge-slot-armed');
      });
    }
    function drawTempWire(cx, cy) {
      drawWires();
      var a = socketCenter(wiring.fromEl); if (!a) return;
      var wr = world.getBoundingClientRect();
      var wx = (cx - wr.left) / view.scale, wy = (cy - wr.top) / view.scale;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      var lead = wiring.originEnd === 'out' ? a : { x: wx, y: wy };
      var tail = wiring.originEnd === 'out' ? { x: wx, y: wy } : a;
      var dx = Math.max(30, Math.abs(tail.x - lead.x) / 2);
      path.setAttribute('d', 'M' + lead.x + ',' + lead.y + ' C' + (lead.x + dx) + ',' + lead.y + ' ' + (tail.x - dx) + ',' + tail.y + ' ' + tail.x + ',' + tail.y);
      path.setAttribute('class', 'pge-wire pge-wire-temp');
      path.setAttribute('stroke', PG().colorOfCategory(wiring.category || 'other'));
      svg.appendChild(path);
    }
    function completeWireAt(dot) {
      if (!wiring) return;
      var w = wiring, out, inn;
      if (w.originEnd === 'out') {
        if (!dot._slot) { cancelWire(); flashStrip('Drop onto a left (input) dot.', 'warn'); return; }
        out = { nodeId: w.nodeId, sourceVar: w.sourceVar, category: w.category };
        inn = dot._slot;
      } else {
        if (!dot._out) { cancelWire(); flashStrip('Connect to a right (output) dot.', 'warn'); return; }
        inn = { nodeId: w.nodeId, role: w.role, paramField: w.paramField, arity: w.arity };
        out = dot._out;
      }
      cancelWire();
      addBinding(out, inn);
    }
    function addBinding(out, inn) {
      if (out.nodeId === inn.nodeId) { flashStrip('Can’t wire a node to itself.', 'warn'); return; }
      if (PG().wouldCycle(graph, out.nodeId, inn.nodeId)) { flashStrip('That wire would create a cycle.'); return; }
      if (inn.role === 'param' && out.category === 'categorical') {
        flashStrip('A choices variable can’t drive a numeric setting.'); return;
      }
      // one structural feed per source node — a list dim comes from the
      // node, not a specific member, so a second edge would duplicate it
      if (inn.role === 'structural' && graph.edges.some(function (e) { return e.from === out.nodeId && e.to === inn.nodeId; })) {
        flashStrip('That source already feeds this list.', 'warn'); return;
      }
      var newKey = [out.nodeId, inn.nodeId, out.sourceVar || '', inn.role || '', inn.paramField || ''].join('|');
      var dup = graph.edges.some(function (e) {
        return [e.from, e.to, e.sourceVar || '', e.role || '', e.paramField || ''].join('|') === newKey;
      });
      if (dup) { flashStrip('Already wired.', 'warn'); return; }
      // single-arity param slot: replace whatever currently drives that field
      if (inn.arity === 'one' && inn.role === 'param') {
        var to = nodeById(inn.nodeId);
        graph.edges = graph.edges.filter(function (e) {
          return !(e.to === inn.nodeId && PG().edgeRole(e, to.type) === 'param' && (e.paramField || '') === (inn.paramField || ''));
        });
      }
      graph.edges.push(PG().newEdge(out.nodeId, inn.nodeId, { sourceVar: out.sourceVar, role: inn.role, paramField: inn.paramField }));
      // soft unit-mismatch warning on equation math inputs
      var target = nodeById(inn.nodeId);
      if (target && target.type === 'equation') {
        var cats = {};
        graph.edges.filter(function (e) { return e.to === inn.nodeId && PG().edgeRole(e, 'equation') === 'math'; }).forEach(function (e) {
          var c = _edgeCategory(e);
          if (c !== 'none' && c !== 'ratio' && c !== 'categorical' && c !== 'other') cats[c] = true;
        });
        if (Object.keys(cats).length > 1) { persist(); render(); flashStrip('Mixing dimensions: ' + Object.keys(cats).join(' + ') + ' — check units.', 'warn'); return; }
      }
      persist(); render();
    }

    function flashStrip(msg, kind) {
      strip.className = 'pge-strip pge-strip-' + (kind === 'warn' ? 'warn' : 'error');
      ICON.label(strip, 'exclamation-triangle', ' ' + msg);
      setTimeout(recompileFeedback, 2600);
    }

    /* ── Shift-drag wire cutting ───────────────────────────────
     * Hold shift + drag a line across wires: crossed wires highlight
     * live, and every crossed wire is deleted on release. Geometry runs
     * against the sampled polylines the router already produced. */
    function startCut(e) {
      e.preventDefault();
      var WR = window.WireRouter;
      if (!WR) return;
      document.body.classList.add('pge-cutting');
      // recompute the world rect per event so a mid-cut wheel-zoom or
      // scroll can't skew hit-testing
      function toWorld(ev) {
        var wr = world.getBoundingClientRect();
        return { x: (ev.clientX - wr.left) / view.scale, y: (ev.clientY - wr.top) / view.scale };
      }
      var pts = [toWorld(e)];
      var hitSet = {};
      var hitCount = 0;
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('class', 'pge-cutline');
      line.setAttribute('points', pts[0].x + ',' + pts[0].y);
      svg.appendChild(line);
      var minStep = 3 / view.scale; // ≥3 screen px between polyline points
      function move(ev) {
        var p = toWorld(ev);
        var last = pts[pts.length - 1];
        var dx = p.x - last.x, dy = p.y - last.y;
        if (dx * dx + dy * dy < minStep * minStep) return;
        pts.push(p);
        line.setAttribute('points', pts.map(function (q) { return q.x + ',' + q.y; }).join(' '));
        WR.hitsForSegment(last, p, routesByEdgeId).forEach(function (id) {
          if (hitSet[id]) return;
          hitSet[id] = true;
          hitCount++;
          var pe = svg.querySelector('path[data-edge-id="' + id + '"]');
          if (pe) pe.classList.add('pge-wire-cut-hit');
        });
      }
      function up() {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.classList.remove('pge-cutting');
        if (line.parentNode) line.parentNode.removeChild(line);
        if (destroyed) return; // editor torn down mid-gesture (e.g. live-sync remount)
        if (hitCount) {
          graph.edges = graph.edges.filter(function (x) { return !hitSet[x.id]; });
          persist(); render();
          strip.className = 'pge-strip pge-strip-ok';
          ICON.label(strip, 'scissors', ' Cut ' + hitCount + ' wire' + (hitCount === 1 ? '' : 's') + '.');
          setTimeout(recompileFeedback, 2000);
        } else {
          drawWires(); // clear any stray highlight
        }
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }

    /* ── Interaction cheatsheet (the "?" palette button) ─────── */
    var cheatEl = null;
    function toggleCheat() {
      if (cheatEl) {
        if (cheatEl.parentNode) cheatEl.parentNode.removeChild(cheatEl);
        cheatEl = null;
        return;
      }
      cheatEl = document.createElement('div');
      cheatEl.className = 'pge-cheat';
      cheatEl.innerHTML =
        '<div class="pge-cheat-head"><span>Canvas how-to</span>' +
        '<button type="button" class="pge-mini pge-cheat-close" title="Close">' + ICON.svg('x-mark') + '</button></div>' +
        '<ul>' +
        '<li><b>Pan</b> — drag the empty canvas</li>' +
        '<li><b>Zoom</b> — scroll wheel (or ⊕ / ⊖)</li>' +
        '<li><b>Zoom to a node</b> — its header ⌖, or double-click the card</li>' +
        '<li><b>Fit everything</b> — ⌖ Fit, or double-click empty canvas</li>' +
        '<li><b>Move a node</b> — drag its header</li>' +
        '<li><b>Wire</b> — drag a right dot onto a left dot (or “+ add modifier”)</li>' +
        '<li><b>Chain onward</b> — a bound variable re-exports as a ring dot on the node’s right: wire downstream from there</li>' +
        '<li><b>Delete a wire</b> — click it</li>' +
        '<li><b>Cut wires</b> — hold <b>Shift</b> and drag a line through them</li>' +
        '<li><b>Recipes</b> — insert common pre-wired patterns (' + ICON.svg('sparkles') + ' Recipes)</li>' +
        '<li><b>Expand</b> — the ⤢ button</li>' +
        '</ul>';
      cheatEl.querySelector('.pge-cheat-close').addEventListener('click', toggleCheat);
      viewport.appendChild(cheatEl);
    }

    /* V3.416 — new nodes land in OPEN canvas, never on top of an
     * existing card: probe outward from the desired spot until the
     * candidate rect clears every node (measured size when known). */
    function findFreeSpot(x, y) {
      var W = 224, H = 150, PAD = 26;
      function rectOf(n) {
        var sz = sizeCache[n.id] || {};
        return { x: n.x, y: n.y, w: sz.w || W, h: sz.h || H };
      }
      function clear(cx, cy) {
        return !graph.nodes.some(function (n) {
          var r = rectOf(n);
          return cx < r.x + r.w + PAD && cx + W + PAD > r.x &&
                 cy < r.y + r.h + PAD && cy + H + PAD > r.y;
        });
      }
      if (clear(x, y)) return { x: x, y: y };
      for (var ring = 1; ring <= 8; ring++) {
        var cands = [
          { x: x + ring * (W + PAD), y: y },
          { x: x, y: y + ring * (H + PAD) },
          { x: x + ring * (W + PAD), y: y + ring * (H + PAD) },
          { x: x - ring * (W + PAD), y: y },
          { x: x, y: y - ring * (H + PAD) },
        ];
        for (var i = 0; i < cands.length; i++) {
          if (clear(cands[i].x, cands[i].y)) return cands[i];
        }
      }
      // pathological density — stagger rather than stack
      return { x: x + 40 * (graph.nodes.length % 7), y: y + 40 * (graph.nodes.length % 5) };
    }
    function addNode(type) {
      var rect = viewport.getBoundingClientRect();
      var wx = (rect.width / 2 - view.x) / view.scale;
      var wy = (rect.height / 2 - view.y) / view.scale;
      var at = findFreeSpot(wx - 90, wy - 40);
      graph.nodes.push(PG().newNode(type, {}, at));
      persist(); render();
    }

    /* V3.381 — drop a pre-wired recipe at the viewport centre. */
    function insertRecipe(recipe) {
      var rect = viewport.getBoundingClientRect();
      var at = {
        x: (rect.width / 2 - view.x) / view.scale - 160,
        y: (rect.height / 2 - view.y) / view.scale - 140,
      };
      var made = PG().instantiateRecipe(recipe, graph, at);
      if (!made || !made.nodes.length) { flashStrip('Recipe could not be inserted.', 'warn'); return; }
      graph.nodes = graph.nodes.concat(made.nodes);
      graph.edges = graph.edges.concat(made.edges);
      persist(); render();
      strip.className = 'pge-strip pge-strip-ok';
      ICON.label(strip, 'sparkles', ' Added “' + recipe.label + '” — ' + made.nodes.length + ' nodes, ' + made.edges.length + ' wires.');
      setTimeout(recompileFeedback, 2600);
    }

    /* A small wired example (inputs → equation, choices → list) so a
     * first-time author starts from a working workflow, not a blank
     * canvas. Only offered while the graph is empty. */
    function seedStarter() {
      var mk = PG().newNode, ed = PG().newEdge;
      var volume = mk('input', { name: 'volume_each', label: 'Volume per item', widget: 'slider', min: 10, max: 500, step: 10, default: 100, unit: 'µL' }, { x: 40, y: 40 });
      var reps = mk('input', { name: 'replicates', label: 'Replicates', widget: 'slider', min: 1, max: 12, step: 1, default: 3, unit: '' }, { x: 40, y: 340 });
      var extra = mk('constant', { name: 'extra', label: 'Extra factor', value: 1.2, unit: '' }, { x: 40, y: 640 });
      var total = mk('equation', { name: 'total_volume', label: 'Total volume', expr: 'volume_each * replicates * extra', unit: 'µL', decimals: 1 }, { x: 360, y: 160 });
      var cond = mk('choices', { field: 'condition', label: 'Condition', options: ['A', 'B', 'C'] }, { x: 360, y: 540 });
      var items = mk('list', { name: 'items' }, { x: 680, y: 340 });
      graph.nodes = [volume, reps, extra, total, cond, items];
      graph.edges = [
        ed(volume.id, total.id, { sourceVar: 'volume_each', role: 'math' }),
        ed(reps.id, total.id, { sourceVar: 'replicates', role: 'math' }),
        ed(extra.id, total.id, { sourceVar: 'extra', role: 'math' }),
        ed(cond.id, items.id, { sourceVar: 'condition' }),
      ];
      persist(); render();
      requestAnimationFrame(fitView);
    }

    /* ── Pan / zoom / double-click-to-expand ──────────────────── */
    viewport.addEventListener('pointerdown', function (e) {
      var onCanvas = (e.target === viewport || e.target === world || e.target === svg);
      var onWire = !!(e.target && e.target.classList && e.target.classList.contains('pge-wire') &&
                      !e.target.classList.contains('pge-wire-temp'));
      if (canEdit && e.shiftKey && (onCanvas || onWire)) { startCut(e); return; }
      if (!onCanvas) return;
      // clicking empty canvas cancels an armed (click-to-connect) wire
      if (wiring && wiring.armed) { cancelWire(); return; }
      var startX = e.clientX, startY = e.clientY, ox = view.x, oy = view.y;
      function move(ev) { view.x = ox + (ev.clientX - startX); view.y = oy + (ev.clientY - startY); applyView(); }
      function up() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    viewport.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.1 : 0.9;
      view.scale = Math.max(0.3, Math.min(2.2, view.scale * factor));
      bumpCounter('pgeZooms');
      applyView(); drawWires();
    }, { passive: false });
    // V3.416 — double-click gestures: empty canvas = ⌖ Fit everything;
    // a node card = zoom to that node. (The popout keeps its ⤢ button —
    // dblclick-to-expand retired in favour of navigation.)
    viewport.addEventListener('dblclick', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (t === viewport || t === world || t === svg) { fitView(); return; }
      var card = t && t.closest ? t.closest('.pge-node') : null;
      if (!card) return;
      var n = graph.nodes.filter(function (x) { return nodeEls[x.id] === card; })[0];
      if (n) zoomToNode(n);
    });

    /* ── Popout modal (reuses this same editor on the same graph) ── */
    var modalHandle = null;
    function openModal() {
      if (modalHandle) return;
      var overlay = document.createElement('div');
      overlay.className = 'pge-modal';
      var card = document.createElement('div');
      card.className = 'pge-modal-card';
      var bar = document.createElement('div');
      bar.className = 'pge-modal-bar';
      bar.innerHTML = '<span>Node editor</span>';
      var close = document.createElement('button');
      close.type = 'button'; close.className = 'pge-pal-btn'; close.textContent = '✕ Close';
      bar.appendChild(close);
      var innerHost = document.createElement('div');
      innerHost.className = 'pge-modal-host';
      card.appendChild(bar); card.appendChild(innerHost);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var inner = mount(innerHost, {
        getGraph: opts.getGraph, setGraph: opts.setGraph,
        canEdit: canEdit, expandable: false, viewKey: (opts.viewKey || 'default') + ':modal',
      });
      function done() {
        try { inner.destroy(); } catch (e) {}
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        modalHandle = null;
        // re-read the (possibly edited) graph into the inline editor
        graph = PG().normalizeGraph(opts.getGraph ? opts.getGraph() : graph);
        render();
      }
      close.addEventListener('click', done);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(); });
      modalHandle = { overlay: overlay, done: done };
    }

    /* ── Full render ──────────────────────────────────────────── */
    function render() {
      // V3.422 — one graph-wide unit resolution per render: every dot,
      // chip, alias letter, and wire color below reads from this map,
      // so a composite unit computed upstream colors/labels correctly
      // downstream.
      qtysCache = PG().resolveQuantities(graph);
      ptCache = {};
      Object.keys(nodeEls).forEach(function (id) {
        if (nodeEls[id].parentNode) nodeEls[id].parentNode.removeChild(nodeEls[id]);
      });
      nodeEls = {}; valEls = {}; socketOut = {}; socketIn = {};
      var emptyEl = viewport.querySelector('.pge-empty');
      if (emptyEl) emptyEl.parentNode.removeChild(emptyEl);
      if (!graph.nodes.length) {
        var empty = document.createElement('div');
        empty.className = 'pge-empty';
        var msg = document.createElement('div');
        msg.textContent = canEdit
          ? 'Add nodes from the palette above. Each node shows its variables with a right dot (drag it out) and left dots (plug values in); use “+ add modifier” on a node to wire a binding.'
          : 'Empty design.';
        empty.appendChild(msg);
        if (canEdit) {
          var starter = document.createElement('button');
          starter.type = 'button';
          starter.className = 'pge-pal-btn pge-starter';
          ICON.label(starter, 'bolt', ' Build a starter workflow');
          starter.title = 'Two inputs and a constant feeding an equation, plus a choices set feeding an item list';
          starter.addEventListener('click', seedStarter);
          empty.appendChild(starter);
          var demoHint = document.createElement('div');
          demoHint.className = 'pge-empty-demo';
          demoHint.innerHTML = 'New to nodes? Load a ' + ICON.svg('academic-cap') + ' demo lesson from the protocols list, or try ' + ICON.svg('sparkles') + ' Recipes above.';
          empty.appendChild(demoHint);
        }
        viewport.appendChild(empty);
      }
      graph.nodes.forEach(function (n) { world.appendChild(makeCard(n)); });
      applyView();
      requestAnimationFrame(function () {
        // measure once per render; node drags then need no layout reads
        graph.nodes.forEach(function (n) {
          var el = nodeEls[n.id];
          if (el) sizeCache[n.id] = { w: el.offsetWidth || 224, h: el.offsetHeight || 180 };
        });
        drawWires(); recompileFeedback();
      });
    }

    render();

    // Load mathjs so the header value badges show live numbers (mathjs is
    // an ESM module — there is no window.math global). One re-feedback once
    // it resolves; guarded against teardown.
    if (window.ProtocolFormulas && window.ProtocolFormulas.ensureMathjs) {
      window.ProtocolFormulas.ensureMathjs().then(function (m) {
        if (destroyed) return;
        mathInstance = m;
        recompileFeedback();
      }).catch(function () {});
    }

    return {
      destroy: function () {
        destroyed = true;
        if (toursHandle) { try { toursHandle.destroy(); } catch (e) {} }
        if (modalHandle) modalHandle.done();
        hostEl.innerHTML = '';
        hostEl.classList.remove('pge-host');
      },
      getGraph: function () { return graph; },
      // V3.389 — start a guided tour programmatically (demo builds)
      startTour: startTourById,
    };
  }

  window.ProtocolGraphEditor = { mount: mount };
})();
