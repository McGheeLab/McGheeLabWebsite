/* protocol-graph-tours.js — guided interactive tours for the node
 * canvas (V3.385).
 *
 * A tour is a sequence of steps. Each step shows an instruction card
 * pinned to the top-right of the page and (optionally) a gently pulsing
 * ring around the exact control to use next — a palette button, a
 * node's dot, a config panel, even page chrome like the view segment.
 * "Do" steps VERIFY themselves: each carries a `when(graph, base, H)`
 * condition evaluated ~4×/s against the live graph (plus the
 * `pge-wiring` armed state); when it turns true the card flips to
 * "✓ step complete — press Next" and waits (V3.396 — no auto-advance;
 * undoing the action re-arms the step). Explanation steps advance with
 * Next. Resume after a remount fast-skips already-satisfied steps
 * instantly. Steps flagged `practice: true` (viewer-skill drills like
 * collapse/tidy) are excluded from the already-built detection.
 *
 * Content: one tour per node type ("Meet the nodes") + pattern tours
 * ("Patterns & thinking"), each opening with how to THINK about the
 * node before touching it.
 *
 * Engine is selector-based and re-resolves targets every frame (the
 * editor tears down and rebuilds all cards on each render), positions
 * the ring from getBoundingClientRect (so it tracks pan/zoom/drag for
 * free), and self-heals if the canvas is unmounted mid-tour.
 *
 * Public surface: window.ProtocolGraphTours.{ list, attach }.
 *   attach({hostEl, viewport, getGraph, resetGraph, onEnd})
 *     → {start(id, {resumeAt}), stop, active, destroy}
 *   onEnd(reason, {id, stepIdx}) fires when a run ends — 'user' for an
 *   explicit close, 'detached' when the host DOM was torn down mid-run
 *   (a remount): the host re-arms and calls start(id, {resumeAt}) on
 *   the fresh mount, which fast-skips already-satisfied steps silently.
 */

(function () {
  var PG = function () { return window.ProtocolGraph; };

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── condition helpers ─────────────────────────────────────── */
  function countType(g, t) {
    var n = 0;
    ((g && g.nodes) || []).forEach(function (x) { if (x.type === t) n++; });
    return n;
  }
  function _typeMap(g) {
    var m = {};
    ((g && g.nodes) || []).forEach(function (n) { m[n.id] = n.type; });
    return m;
  }
  function _edgeMatch(g, types, e, m) {
    if (m.fromType && types[e.from] !== m.fromType) return false;
    if (m.toType && types[e.to] !== m.toType) return false;
    if (m.paramField && (e.paramField || '') !== m.paramField) return false;
    if (m.role) {
      var role = PG() ? PG().edgeRole(e, types[e.to]) : (e.role || '');
      if (role !== m.role) return false;
    }
    return true;
  }

  /* H = the helper kit handed to every step's `when`. `base` = snapshot
   * at step activation; `start` = snapshot at tour start (fresh = made
   * during this tour). */
  function makeH(g, base, start) {
    var startNodeIds = {}, startEdgeIds = {};
    ((start && start.nodes) || []).forEach(function (n) { startNodeIds[n.id] = true; });
    ((start && start.edges) || []).forEach(function (e) { startEdgeIds[e.id] = true; });
    var types = _typeMap(g);
    return {
      count: function (t) { return countType(g, t); },
      added: function (t) { return countType(g, t) > countType(base, t); },
      addedAtLeast: function (t, n) { return countType(g, t) - countType(base, t) >= n; },
      some: function (t, pred) {
        return ((g && g.nodes) || []).some(function (x) { return x.type === t && (!pred || pred(x)); });
      },
      fresh: function (t, pred) {
        return ((g && g.nodes) || []).some(function (x) {
          return x.type === t && !startNodeIds[x.id] && (!pred || pred(x));
        });
      },
      freshEdge: function (m) {
        return ((g && g.edges) || []).some(function (e) {
          return !startEdgeIds[e.id] && _edgeMatch(g, types, e, m || {});
        });
      },
      anyEdge: function (m) {
        return ((g && g.edges) || []).some(function (e) { return _edgeMatch(g, types, e, m || {}); });
      },
      wiring: function () {
        return !!(document.body && document.body.classList &&
                  document.body.classList.contains('pge-wiring'));
      },
    };
  }

  /* ── tour content ──────────────────────────────────────────────
   * Step: { title, text, why?, target?, targetLast?, when?, next?,
   *         practice? }
   *   target     CSS selector to ring (editor host first, then page)
   *   targetLast highlight the LAST match (the node just added)
   *   when       completion condition (card flips to ✓ + Next)
   *   next       true → manual Next button (explanation step)
   *   why        rationale strip rendered under the instruction
   *   practice   viewer-skill drill — ignored by the already-built
   *              (prebuilt) detection so legacy copies still gate    */

  var GROUP_NODES = 'Meet the nodes';
  var GROUP_PATTERNS = 'Patterns & thinking';
  var GROUP_BUILDS = 'Guided builds (lessons)';

  /* Count edges into the node whose params.name/field === targetName,
   * optionally filtered by role / paramField / source node type. Build
   * tours anchor on NAMES (not tour-freshness) so re-running a build on
   * an already-built copy auto-skips rather than sticking. */
  function edgesInto(g, targetName, role, paramField, fromType) {
    var types = _typeMap(g);
    var target = ((g && g.nodes) || []).filter(function (n) {
      var p = n.params || {};
      return p.name === targetName || p.field === targetName;
    })[0];
    if (!target) return 0;
    return ((g && g.edges) || []).filter(function (e) {
      if (e.to !== target.id) return false;
      if (fromType && types[e.from] !== fromType) return false;
      if (paramField && (e.paramField || '') !== paramField) return false;
      if (role) {
        var r = PG() ? PG().edgeRole(e, types[e.to]) : (e.role || '');
        if (r !== role) return false;
      }
      return true;
    }).length;
  }
  function _named(name) {
    return function (n) { var p = n.params || {}; return (p.name === name || p.field === name); };
  }

  function _hasNamedItems(min) {
    return function (n) {
      return ((n.params || {}).items || []).filter(function (it) {
        return it && String(it.name || '').trim();
      }).length >= min;
    };
  }

  var TOURS = [
    /* ── group: meet the nodes ── */
    {
      id: 'input', group: GROUP_NODES, icon: 'adjustments-horizontal', title: 'Inputs',
      blurb: 'The values the runner sets — your protocol’s front panel.',
      steps: [
        { title: 'How to think about Inputs', next: true,
          text: 'An <b>Input</b> is a question you ask whoever <b>runs</b> the protocol — “how much volume?”, “how many replicates?”. If the answer changes run to run, it’s an Input. If it never changes, it’s a Constant.' },
        { title: 'Add one', target: '.pge-pal-input',
          text: 'Click <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> in the palette to drop one on the canvas.',
          when: function (g, b, H) { return H.added('input'); } },
        { title: 'Name it for the bench', target: '.pge-node-input .pge-fields', targetLast: true, next: true,
          text: 'The <b>Name</b> is how equations and your write-up refer to it. Pick a unit <b>Type</b> (Volume, Mass, …) and its <b>unit</b> from the paired dropdowns — a placeholder auto-names itself <code>volume_01</code>-style, and you can rename it anything. The <b>Label</b> is what the runner reads. Set <b>Min/Max/Step</b> to the physically sensible range — guardrails now prevent nonsense later.' },
        { title: 'It’s already live', target: '.pge-node-input .pge-node-val', targetLast: true, next: true,
          text: 'The header badge shows the current value. Every surface — the document view’s sliders, <code>[!var:name]</code> chips in your prose — reads this same number, live.' },
      ],
      done: 'Inputs are the front panel. Next up: Constants — the decisions you’ve already made.',
    },
    {
      id: 'constant', group: GROUP_NODES, icon: 'pin', title: 'Constants',
      blurb: 'Named, unit-carrying decisions — never bare numbers in formulas.',
      steps: [
        { title: 'How to think about Constants', next: true,
          text: 'A <b>Constant</b> is a decision you’ve already made — a stock concentration, a safety factor. Naming it in a node (instead of hard-coding <code>1.2</code> inside a formula) gives it a unit, a tooltip, and <b>one place to change</b>.' },
        { title: 'Add one', target: '.pge-pal-constant',
          text: 'Click <b>' + ICON.svg('pin') + ' Constant</b>.',
          when: function (g, b, H) { return H.added('constant'); } },
        { title: 'Set its value + unit', target: '.pge-node-constant .pge-var-input', targetLast: true, next: true,
          text: 'Type the value right on the variable row, and give it a <b>unit</b> in the fields below — units color the dots, so mismatched wiring shows at a glance. Or skip the typing: the <b>' + ICON.svg('atom') + ' Preset</b> dropdown fills π, Avogadro, Boltzmann, gas constant, water density and friends — name, value, and unit in one tap.' },
        { title: 'Displaying values', target: '.pge-pal-cards', next: true,
          text: 'To SHOW any value on the document, wire it into a ' + ICON.svg('chart-bar') + ' <b>Cards</b> node (result card) or a ' + ICON.svg('link') + ' <b>References</b> node (offered inline by the editor’s ' + ICON.svg('link') + ' picker). Modifiers (<b>+ add modifier</b>) drive a node’s SETTINGS — an input’s max, an equation’s decimals.' },
      ],
    },
    {
      id: 'equation', group: GROUP_NODES, icon: 'variable', title: 'Equations',
      blurb: 'Every derived number should be an equation — no mental math in steps.',
      steps: [
        { title: 'How to think about Equations', next: true,
          text: 'An <b>Equation</b> states a relationship: “total = per-item ' + ICON.svg('x-mark') + ' count”. Write protocols so <b>every derived number is an Equation</b> — then nothing in your steps is mental math, and everything updates together.' },
        { title: 'It needs something to compute from', target: '.pge-pal-input',
          text: 'Add an <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> (if the canvas already has one, this step skips itself).',
          when: function (g, b, H) { return H.count('input') >= 1; } },
        { title: 'Add the equation', target: '.pge-pal-equation',
          text: 'Click <b>' + ICON.svg('variable') + ' Equation</b>.',
          when: function (g, b, H) { return H.added('equation'); } },
        { title: 'Wire a value in', target: '.pge-node-equation .pge-socket-in.pge-slot-open[data-slot="math"]', targetLast: true,
          text: 'Drag the Input’s <b>right dot</b> onto the equation’s pulsing open dot (“drop a variable…”). A wire = “this value is available in the formula”.',
          when: function (g, b, H) { return H.freshEdge({ toType: 'equation', role: 'math' }); } },
        { title: 'Build the formula', target: '.pge-node-equation .pge-fields', targetLast: true,
          text: 'Use the <b>formula pad</b>: tap the wired variable’s button (it shows a dimension alias like <b>V1</b> or <b>X1</b>), then an operator, then a number via the small <code>123</code> slot. No typing — buttons that would break the math stay greyed. Made a wrong pick? <b>Tap any variable chip in the strip to swap it</b> for another.',
          when: function (g, b, H) {
            return H.fresh('equation', function (n) { return String((n.params || {}).expr || '').trim().length > 0; });
          } },
        { title: 'Watch it compute', target: '.pge-node-equation .pge-node-val', targetLast: true, next: true,
          text: 'The badge shows the live result — and it recomputes everywhere the instant any wired value moves. Chain equations freely; they evaluate in dependency order.' },
        { title: 'One node, many results', next: true,
          text: '<b>+ equation</b> adds another result to the SAME node: its own name, unit, formula pad, and its own out-connector on the card. Later results can use earlier ones as variables — they appear on the pad automatically.',
          why: 'The pad also checks your DIMENSIONS: it warns when you add a volume to a mass, raise a united value to a united power, or declare a unit the math disagrees with. A result whose dimension is a combination (volume·amount) wears a pie-wheel dot of the constituent colors.' },
        { title: 'Units travel — and cancel', next: true,
          text: 'Leave a result’s unit blank and it CARRIES what the math made — <b>µL·mol</b>, <b>mL / min</b> — into every node you plug it into. Divide the mols back out downstream and the wire collapses to plain <b>µL</b> again; the doc reference, result card, and node badge all print the composite unit so a number is never a mystery. Combinations you’d recognize are called by NAME — mass/volume reads as <b>density</b>, amount/volume as <b>concentration</b> — while the color legend keeps only the fundamental dimensions.',
          why: 'Every variable a node RECEIVES also re-exports as a small ring dot on its right side. Chain the next node from that ring instead of dragging a wire all the way back across the canvas — same variable, shorter wires.' },
      ],
    },
    {
      id: 'choices', group: GROUP_NODES, icon: 'arrows-right-left', title: 'Choices sets',
      blurb: 'One Choices node = one categorical axis of your experiment.',
      steps: [
        { title: 'How to think about Choices', next: true,
          text: 'A <b>Choices</b> set is an <b>axis</b> of your experiment — treatment vs control, coating A/B/C. One Choices node per dimension you sweep.' },
        { title: 'Add one', target: '.pge-pal-choices',
          text: 'Click <b>' + ICON.svg('arrows-right-left') + ' Choices</b>.',
          when: function (g, b, H) { return H.added('choices'); } },
        { title: 'Name the axis + add options', target: '.pge-node-choices .pge-fields', targetLast: true,
          text: 'Give the <b>field</b> a name (e.g. <code>condition</code>) and add at least <b>two options</b> (+ option).',
          when: function (g, b, H) {
            return H.fresh('choices', function (n) {
              return ((n.params || {}).options || []).filter(function (o) { return String(o || '').trim(); }).length >= 2;
            });
          } },
        { title: 'Per-item scope', target: '.pge-node-choices', targetLast: true, next: true,
          text: 'Note the purple outline: a Choices set is a <b>generator</b> — anything computed downstream of it runs <b>once per option</b>, not once total. That’s the point: axes multiply.' },
        { title: 'Choices exist to feed a List', next: true,
          text: 'Alone it does nothing — wire it into a <b>' + ICON.svg('clipboard-document-list') + ' List</b> to turn options into experiment rows. The <i>Design an experiment grid</i> tour shows the payoff.' },
      ],
    },
    {
      id: 'ordered', group: GROUP_NODES, icon: 'signal', title: 'Ordered sets',
      blurb: 'Graded levels that must keep their order — each member is a live number.',
      steps: [
        { title: 'How to think about Ordered sets', next: true,
          text: 'An <b>Ordered</b> set holds graded <b>levels</b> that must stay in order — low &lt; mid &lt; high, small &lt; large. Each member is its own live variable, and the editor enforces <i>member &lt; next member</i>.' },
        { title: 'Add one', target: '.pge-pal-ordered',
          text: 'Click <b>' + ICON.svg('signal') + ' Ordered set</b>.',
          when: function (g, b, H) { return H.added('ordered'); } },
        { title: 'Name the field + add members', target: '.pge-node-ordered .pge-fields', targetLast: true,
          text: 'Name the <b>field</b> (e.g. <code>dose</code>) and add at least <b>two members</b> — each gets a name, default, unit, and range.',
          when: function (g, b, H) { return H.fresh('ordered', _hasNamedItems(2)); } },
        { title: 'Numbers, not just labels', next: true,
          text: 'Like Choices, an Ordered set is a generator: feed a List and every member becomes a row. Unlike Choices, members carry <b>numbers</b> — so per-item equations can compute with <code>dose_value</code>.' },
      ],
    },
    {
      id: 'list', group: GROUP_NODES, icon: 'clipboard-document-list', title: 'Lists',
      blurb: 'The experiment table at the end — design backward from it.',
      steps: [
        { title: 'How to think about Lists', next: true,
          text: 'The <b>List</b> is the punchline: it assembles <b>every combination</b> of the sets you wire in into an experiment table. Design workflows <b>backward</b> from it — what rows do you want? Those are your axes.' },
        { title: 'It needs at least one set', target: '.pge-pal-choices',
          text: 'Add a <b>' + ICON.svg('arrows-right-left') + ' Choices</b> (or ' + ICON.svg('signal') + ' Ordered) set — skipped if you already have one.',
          when: function (g, b, H) { return H.count('choices') + H.count('ordered') >= 1; } },
        { title: 'Add the list', target: '.pge-pal-list',
          text: 'Click <b>' + ICON.svg('clipboard-document-list') + ' List</b>.',
          when: function (g, b, H) { return H.added('list'); } },
        { title: 'Feed it', target: '.pge-node-list .pge-socket-in.pge-slot-open[data-slot="structural"]', targetLast: true,
          text: 'Drag the set’s <b>right dot</b> onto the list’s pulsing “feed…” dot. That’s a <b>structural</b> wire: “this set is one dimension of the table”.',
          when: function (g, b, H) { return H.freshEdge({ toType: 'list', role: 'structural' }); } },
        { title: 'Rows multiply', target: '.pge-strip', next: true,
          text: 'The status strip counts your lists. Wire a <b>second</b> set in and rows multiply (2 ' + ICON.svg('x-mark') + ' 3 = 6). The document view renders this table live, and the plate planner can lay it onto wells.' },
      ],
    },
    {
      id: 'gates', group: GROUP_NODES, icon: 'chart-bar', title: 'Cards & References',
      blurb: 'Gate what the document shows — cards on the page, references inline.',
      steps: [
        { title: 'Two gates, one idea', next: true,
          text: 'Nothing displays by itself: a ' + ICON.svg('chart-bar') + ' <b>Cards</b> node picks which variables render as result cards on the ' + ICON.svg('document-text') + ' Document, and a ' + ICON.svg('link') + ' <b>References</b> node picks which values the editor’s ' + ICON.svg('link') + ' picker offers for inline sentences. Everything ungated still COMPUTES — it just isn’t offered.',
          why: 'Big graphs breed intermediate numbers. Readers should see the handful that matter — you curate them by wiring.' },
        { title: 'Add a Cards node', target: '.pge-pal-cards',
          text: 'Click <b>' + ICON.svg('chart-bar') + ' Cards</b>.',
          when: function (g, b, H) { return H.added('cards'); } },
        { title: 'Wire a variable in', target: '.pge-node-cards .pge-socket-in', targetLast: true,
          text: 'Drag any variable’s <b>right dot</b> onto the Cards node’s pulsing dot — it now renders as a result card, with its units attached.',
          when: function (g, b, H) { return H.freshEdge({ toType: 'cards', role: 'display' }); } },
        { title: 'Cards are references too', next: true,
          text: 'Everything wired to ' + ICON.svg('chart-bar') + ' Cards is automatically offered by the ' + ICON.svg('link') + ' reference picker as well. Add a ' + ICON.svg('link') + ' <b>References</b> node for values you want inline WITHOUT a card — the picker groups variables under each gate node’s label.',
          why: 'Cards = on the page + referencable; References = referencable only. One wire per decision, and the picker stays short and findable.' },
      ],
    },
    {
      id: 'code', group: GROUP_NODES, icon: 'document', title: 'Code nodes',
      blurb: 'The escape hatch: real JavaScript for lookups, branching, rounding rules.',
      steps: [
        { title: 'How to think about Code', next: true,
          text: 'A <b>Code</b> node is the escape hatch for logic that’s awkward as one formula — lookups, branching, rounding conventions. <b>Prefer Equations</b> when you can (simpler, safer to share); reach for Code when you must.' },
        { title: 'Give it something to chew on', target: '.pge-pal-input',
          text: 'Add an <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> — skipped if one exists.',
          when: function (g, b, H) { return H.count('input') >= 1; } },
        { title: 'Add the code node', target: '.pge-pal-code',
          text: 'Click <b>' + ICON.svg('document') + ' Code</b>.',
          when: function (g, b, H) { return H.added('code'); } },
        { title: 'Wire an argument in', target: '.pge-node-code .pge-socket-in.pge-slot-open[data-slot="math"]', targetLast: true,
          text: 'Drag any <b>right dot</b> onto the code node’s pulsing “argument” dot. Rule 1: <b>wired variables arrive as arguments</b> with the same name.',
          when: function (g, b, H) { return H.freshEdge({ toType: 'code', role: 'math' }); } },
        { title: 'Return your outputs', target: '.pge-node-code .pge-fields', targetLast: true, next: true,
          text: 'Rule 2: the script <b>returns an object whose keys match the declared outputs</b> — e.g. <code>return { y: x * 2 };</code>. Declare outputs in the grid below the script (name / label / unit / decimals).' },
        { title: 'Errors stay contained', next: true,
          text: 'A typo or missing return key shows as ' + ICON.svg('exclamation-triangle') + ' on that output while everything else keeps computing. Scripts run at scalar scope (not per-row) in this version.' },
      ],
    },

    /* ── group: patterns & thinking ── */
    {
      id: 'think-first', group: GROUP_PATTERNS, icon: 'compass', title: 'From protocol to nodes',
      blurb: 'The four questions that turn any protocol into a node workflow.',
      steps: [
        { title: 'Think before you wire', next: true,
          text: 'Before dragging nodes, interrogate the protocol with <b>four questions</b>. This tour is pure thinking — no wiring.' },
        { title: '1 — What does the runner decide?', target: '.pge-pal-input', next: true,
          text: 'Volumes, counts, timings that change run to run → <b>' + ICON.svg('adjustments-horizontal') + ' Inputs</b>, with honest min/max guardrails.' },
        { title: '2 — What have you already decided?', target: '.pge-pal-constant', next: true,
          text: 'Stock concentrations, correction factors, plate geometry → <b>' + ICON.svg('pin') + ' Constants</b> with units. Never bare numbers inside formulas.' },
        { title: '3 — What varies by design?', target: '.pge-pal-choices', next: true,
          text: 'Each axis you sweep is a <b>' + ICON.svg('arrows-right-left') + ' Choices</b> (categories) or <b>' + ICON.svg('signal') + ' Ordered</b> (levels) feeding a <b>' + ICON.svg('clipboard-document-list') + ' List</b>. Rows = every combination — that list IS your experiment plan.' },
        { title: '4 — What’s computed?', target: '.pge-pal-equation', next: true,
          text: 'Every derived number is a <b>' + ICON.svg('variable') + ' Equation</b> (or <b>' + ICON.svg('document') + ' Code</b> for real logic), wired explicitly. If a step says “calculate…”, it should be a node, not arithmetic in prose.' },
        { title: 'Sanity-check, then publish', target: '.pge-strip', next: true,
          text: 'Watch the strip for errors, the dot <b>colors</b> for unit mismatches, and the outlines for scope (blue scalar / purple per-item). Then open the ' + ICON.svg('document-text') + ' Document view — that’s what your runner sees.' },
      ],
    },
    {
      id: 'pattern-dilution', group: GROUP_PATTERNS, icon: 'droplet', title: 'Bench math: dilution',
      blurb: 'Start from what you want; compute what to do.',
      steps: [
        { title: 'The bench-math pattern', next: true,
          text: 'Put what you <b>want</b> (final volume, final concentration) in as <b>Inputs</b>, and let <b>Equations</b> tell you what to <b>do</b> (stock to add, diluent to add) — never the reverse.' },
        { title: 'Insert the pattern', target: '.pge-recipes-btn',
          text: 'Open <b>' + ICON.svg('sparkles') + ' Recipes</b> and pick <b>' + ICON.svg('droplet') + ' Dilute a stock (C1·V1 = C2·V2)</b>.',
          when: function (g, b, H) { return H.addedAtLeast('equation', 2); } },
        { title: 'Read it like a sentence', target: '.pge-node-equation', targetLast: true, next: true,
          text: '<code>V1 = C2·V2/C1</code> — “to hit C2 in V2, add V1 of stock”; the second equation computes the diluent. The wires make every dependency visible.' },
        { title: 'Make it yours', next: true,
          text: 'Drag the C2 slider and watch both answers move — the runner gets these same sliders in the document view. Adapt the pattern by changing defaults, units, and ranges, or rewire it onto your own inputs.' },
      ],
    },
    {
      id: 'pattern-bindings', group: GROUP_PATTERNS, icon: 'adjustments-vertical', title: 'Drive settings (bindings)',
      blurb: 'Wire a VALUE into a SETTING — guardrails that follow your data.',
      steps: [
        { title: 'The guardrail pattern', next: true,
          text: 'A <b>binding</b> wires a value into a <b>setting</b> — a constant capping a slider’s max, a computed result seeding a default. Use bindings so runners can’t set impossible values.' },
        { title: 'You need a constant', target: '.pge-pal-constant',
          text: 'Add a <b>' + ICON.svg('pin') + ' Constant</b> (skipped if you have one) — it will be the cap.',
          when: function (g, b, H) { return H.count('constant') >= 1; } },
        { title: '…and an input to cap', target: '.pge-pal-input',
          text: 'Add an <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> (skipped if you have one).',
          when: function (g, b, H) { return H.count('input') >= 1; } },
        { title: 'Arm the setting', target: '.pge-node-input .pge-plus-btn', targetLast: true,
          text: 'On the Input, click <b>+ add modifier → Drive max from a variable…</b>. The max dot starts pulsing — it’s armed and waiting.',
          when: function (g, b, H) { return H.wiring() || H.freshEdge({ toType: 'input', role: 'param', paramField: 'max' }); } },
        { title: 'Complete the binding', target: '.pge-node-constant .pge-socket-out', targetLast: true,
          text: 'Now click the Constant’s <b>right dot</b>. (You can also just drag dot-to-dot — the menu exists so every binding is discoverable.)',
          when: function (g, b, H) { return H.freshEdge({ toType: 'input', role: 'param', paramField: 'max' }); } },
        { title: 'Driven', target: '.pge-node-input .pge-var-setting.pge-field-driven', targetLast: true, next: true,
          text: 'The max field now reads <b>' + ICON.svg('arrow-turn-down-right') + ' driven by…</b> and follows the constant live. Every numeric setting — min/max/step/default, a constant’s value, an equation’s decimals — can be driven this way.' },
      ],
    },
    {
      id: 'pattern-grid', group: GROUP_PATTERNS, icon: 'test-tube', title: 'Design an experiment grid',
      blurb: 'Axes → list → computed columns: the core design pattern.',
      steps: [
        { title: 'The core design pattern', next: true,
          text: 'One <b>Choices</b> per categorical axis, one <b>Ordered</b> per graded axis, a <b>List</b> to combine them, per-item <b>Equations</b> for computed columns. Rows = the product of your axes.' },
        { title: 'A categorical axis', target: '.pge-pal-choices',
          text: 'Add <b>' + ICON.svg('arrows-right-left') + ' Choices</b> with ≥2 options (skipped if present).',
          when: function (g, b, H) { return H.count('choices') >= 1; } },
        { title: 'A graded axis', target: '.pge-pal-ordered',
          text: 'Add <b>' + ICON.svg('signal') + ' Ordered</b> with a few members (skipped if present).',
          when: function (g, b, H) { return H.count('ordered') >= 1; } },
        { title: 'The table', target: '.pge-pal-list',
          text: 'Add the <b>' + ICON.svg('clipboard-document-list') + ' List</b>.',
          when: function (g, b, H) { return H.added('list'); } },
        { title: 'Wire the first axis in', target: '.pge-node-list .pge-socket-in.pge-slot-open[data-slot="structural"]', targetLast: true,
          text: 'Drag the Choices set’s right dot onto the list’s open “feed…” dot.',
          when: function (g, b, H) { return H.freshEdge({ fromType: 'choices', toType: 'list', role: 'structural' }); } },
        { title: 'Wire the second axis', target: '.pge-node-list .pge-socket-in.pge-slot-open[data-slot="structural"]', targetLast: true,
          text: 'Same move with the Ordered set — and watch the row count multiply.',
          when: function (g, b, H) { return H.freshEdge({ fromType: 'ordered', toType: 'list', role: 'structural' }); } },
        { title: 'Computed columns', next: true,
          text: 'Want a per-condition volume? Add an <b>Equation wired from a set</b> — it inherits per-item scope (purple) — then wire it into the List too: it becomes a <b>column</b>, one value per row.' },
        { title: 'To the bench', next: true,
          text: 'In the document view, a <b>Plate planner</b> block pointed at your list’s name lets the runner assign rows to wells with live master-batch totals. ' + ICON.svg('academic-cap') + ' Demos → Lesson 3 has a full working example.' },
      ],
    },

    /* ── group: guided builds — construct each demo lesson's workflow
     * yourself. Conditions anchor on the EXACT names the lesson's prose
     * tokens + plate planner reference, so the document lights up when
     * (and only when) the build matches. ── */
    {
      id: 'build-lesson-1', group: GROUP_BUILDS, build: true, icon: 'adjustments-horizontal', title: 'Build lesson 1 — variables & wires',
      blurb: 'Construct the two-inputs → equation workflow the lesson reads from.',
      steps: [
        { title: 'The goal', next: true,
          text: 'We’re building a small <b>reagent-prep protocol</b>: the reader picks a volume per sample and a replicate count, and the write-up’s <b>total volume updates itself</b>. When you’re done, the ' + ICON.svg('document-text') + ' Document has two draggable sliders and a sentence that quotes the computed total <b>by name</b> — the method text can never disagree with the math. You’ll place every piece yourself; type the names <b>exactly</b>.',
          why: 'This is the core idea of the whole node system: a protocol stops being static text and becomes a little machine the document runs.' },
        { title: 'Add the first Input — then frame it', target: '.pge-pal-input', practice: true,
          text: '<b>1)</b> Click <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> to drop the node. <b>2)</b> Click <b>⌖ Fit</b> to frame it. <b>3)</b> Zoom <b>out, then in</b> (mouse wheel or ⊖ / ⊕). The step ticks once you’ve done all three — naming comes next.',
          why: 'An Input is a decision the reader makes at the bench — making it a node lets everything downstream react to it. Fit + zoom are how you LIVE on this canvas; learn them with one node, before there are seven.',
          when: function (g, b, H) {
            if (H.count('input') < 1) return false;
            var vp = document.querySelector && document.querySelector('.pge-viewport');
            if (!vp || !vp.dataset) return false;
            return (parseInt(vp.dataset.pgeFits, 10) || 0) >= 1 &&
                   (parseInt(vp.dataset.pgeZooms, 10) || 0) >= 2;
          } },
        { title: 'Name it volume_each', target: '.pge-node-input .pge-fields', targetLast: true,
          text: 'In its fields, set <b>Name</b> to <code>volume_each</code>, label “Volume per item”, and pick unit Type <code>Volume</code> → <code>µL</code> from the dropdowns (a Default of 100 makes the numbers feel real).',
          why: 'The name is the variable’s identity everywhere — wires, formulas, and the lesson’s prose token all look it up by exactly this spelling. (Pick the unit type first and the node auto-names itself volume_01-style — just overwrite that with the lesson’s exact name.)',
          when: function (g, b, H) { return H.some('input', _named('volume_each')); } },
        { title: 'Viewer skill: collapse the node', target: '.pge-node-input .pge-collapse', targetLast: true, practice: true,
          text: 'Click the <b>' + ICON.svg('chevron-down') + '</b> in the node’s header — it collapses to a slim bar.',
          why: 'Collapsed nodes keep their dots, so wiring still works — they just hide their fields. On a crowded canvas you collapse everything you’re done configuring.',
          when: function (g, b, H) { return H.some('input', function (n) { return !!n.collapsed; }); } },
        { title: '…and expand it back', target: '.pge-node-input .pge-collapse', targetLast: true, practice: true,
          text: 'Click it again (<b>' + ICON.svg('chevron-right') + '</b>) to expand — we still need its fields.',
          why: 'Collapse is a VIEW state, not an edit: nothing about the workflow itself changed while it was folded.',
          when: function (g, b, H) { return H.some('input', function (n) { return !n.collapsed; }); } },
        { title: 'Add the second Input', target: '.pge-pal-input',
          text: 'Another <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> — notice it lands in <b>open canvas</b>, never on top of the first.',
          why: 'Replicate count is a separate bench decision. Separate decisions get separate nodes, so each one shows up as its own slider in the document.',
          when: function (g, b, H) { return H.count('input') >= 2; } },
        { title: 'Zoom to the new node', target: '.pge-node-input .pge-zoomto', targetLast: true, practice: true,
          text: 'Click the <b>⌖ in the new node’s header</b> — or just <b>double-click the card</b> — and the view dives straight to it. (<b>Double-click empty canvas</b> to Fit everything back.)',
          why: 'Zoom-to-node is the fastest way to work on ONE node in a busy graph: dive in, edit, double-click out.',
          when: function () {
            var vp = document.querySelector && document.querySelector('.pge-viewport');
            if (!vp || !vp.dataset) return false;
            return (parseInt(vp.dataset.pgeZoomtos, 10) || 0) >= 1;
          } },
        { title: 'Name it replicates', target: '.pge-node-input .pge-fields', targetLast: true,
          text: '<b>Name</b>: <code>replicates</code> (try Default 3, range 1–12, step 1).',
          why: 'Same naming contract: the document’s slider and prose find this variable by its exact name.',
          when: function (g, b, H) { return H.some('input', _named('replicates')); } },
        { title: 'Add the Equation', target: '.pge-pal-equation',
          text: 'Click <b>' + ICON.svg('variable') + ' Equation</b> — it will combine the two.',
          why: 'Equations are where DERIVED numbers live. The reader never types the total — it’s computed, so it’s always right, for any slider position.',
          when: function (g, b, H) { return H.count('equation') >= 1; } },
        { title: 'Name it total_volume', target: '.pge-node-equation .pge-fields', targetLast: true,
          text: '<b>Name</b>: <code>total_volume</code>; unit Type <code>Volume</code> → <code>µL</code>.',
          why: 'The lesson’s sentence “total volume to prepare is …” reads THIS name. Wrong spelling → the document shows “?” forever.',
          when: function (g, b, H) { return H.some('equation', _named('total_volume')); } },
        { title: 'Wire both inputs in', target: '.pge-node-equation .pge-socket-in.pge-slot-open[data-slot="math"]', targetLast: true,
          text: 'Drag <code>volume_each</code>’s right dot onto the equation’s open dot, then do the same with <code>replicates</code>.',
          why: 'A wire is PERMISSION: the equation may only use variables you explicitly feed it — you can see exactly what the total depends on. Wires also land on the formula pad in connection order, which sets their aliases: wire volume_each first and it becomes V1.',
          when: function (g) { return edgesInto(g, 'total_volume', 'math') >= 2; } },
        { title: 'Build the formula', target: '.pge-node-equation .pge-fields', targetLast: true,
          text: 'On the equation’s <b>formula pad</b>, tap <b>V1</b> (that’s <code>volume_each</code> — V for volume), then <b>' + ICON.svg('x-mark') + '</b>, then <b>X1</b> (<code>replicates</code>, unitless). The pad greys any button that would break the math — and if you tap the wrong variable, <b>tap its chip in the strip to swap it</b>.',
          why: 'Formulas are BUILT, not typed — variables arrive as dimension aliases (V1, L1, …) from their wires, unitless numbers via the 123 slot, and a constant WITH a unit comes in as a wired ' + ICON.svg('pin') + ' Constant. Typos are structurally impossible.',
          when: function (g, b, H) {
            return H.some('equation', function (n) {
              var e = String((n.params || {}).expr || '');
              return _named('total_volume')(n) && e.indexOf('volume_each') >= 0 && e.indexOf('replicates') >= 0;
            });
          } },
        { title: 'Everything placed — now Tidy', target: '.pge-view-btn[title^="Auto-arrange"]', practice: true,
          text: 'Last touch: click <b>✤ Tidy</b> — the nodes auto-arrange left → right in data-flow order.',
          why: 'Left-to-right is how a finished graph should read: decisions on the left, results on the right, wires all flowing one way. Tidy before you screenshot a design or hand it to a lab mate.',
          when: function (g, b) {
            return ((g && g.nodes) || []).some(function (n) {
              var m = ((b && b.nodes) || []).filter(function (x) { return x.id === n.id; })[0];
              return m && (m.x !== n.x || m.y !== n.y);
            });
          } },
        { title: 'Gate it for the document', target: '.pge-pal-cards',
          text: 'Add a <b>' + ICON.svg('chart-bar') + ' Cards</b> node, then drag <code>total_volume</code>’s <b>right dot</b> onto its pulsing dot.',
          why: 'Nothing displays by itself — a Cards node GATES what the document shows. Wiring total_volume makes it a result card AND automatically offers it to the ' + ICON.svg('link') + ' reference picker you’re about to use.',
          when: function (g, b, H) { return H.anyEdge({ toType: 'cards', role: 'display' }); } },
        { title: 'Now put it in the write-up', target: '.pre-viewseg-btn[data-view="editor"]', practice: true,
          text: 'Switch to the highlighted <b>' + ICON.svg('pencil') + ' Editor</b> — the protocol document your graph powers.',
          why: 'The Nodes view is the machine; the Editor is the write-up people actually read. Variable references are the bridge between the two.',
          when: function () {
            return !!(document.querySelector &&
              document.querySelector('.pre-viewseg-btn.active[data-view="editor"]'));
          } },
        { title: 'Reference the total', target: '#pre-refvar-btn', practice: true,
          text: 'Find the lesson text ending “Total volume to prepare:”. Click right there in the sentence, then press the highlighted <b>' + ICON.svg('link') + ' Reference</b> and pick <code>total_volume</code>.',
          why: 'References are picked, never typed — no syntax to memorize, no typos possible. The chip that lands in the sentence is the LIVE computed value, forever in sync with the sliders.',
          when: function () {
            return !!(document.querySelector &&
              document.querySelector('.proto-var[data-var="total_volume"]'));
          } },
        { title: 'It’s alive', next: true, target: '#pre-viewseg a.pre-viewseg-btn',
          text: 'Click anywhere outside the block — the reference renders as a live chip. Open the highlighted <b>' + ICON.svg('document-text') + ' Document</b> later and drag a slider: the sentence updates itself. (Opening it leaves the tour — press <b>Next ' + ICON.svg('chevron-right') + '</b> first to finish.)',
          why: 'That’s the whole loop: nodes compute, references read, and the write-up can never disagree with the math.' },
      ],
      done: 'Lesson 1 built: inputs → equation → a live reference in the write-up. Next rung: ' + ICON.svg('academic-cap') + ' Demos → <b>Lesson 2</b> — drive a node’s SETTINGS with bindings.',
    },
    {
      id: 'build-lesson-2', group: GROUP_BUILDS, build: true, icon: 'adjustments-vertical', title: 'Build lesson 2 — bindings & modifiers',
      blurb: 'Construct the cap→max binding and gate the dose onto the document.',
      steps: [
        { title: 'The goal', next: true,
          text: 'We’re building a <b>dosing protocol with a safety rail</b>: a lab-set cap that LIMITS how far the dose input can go, plus a ' + ICON.svg('chart-bar') + ' <b>Cards</b> gate that puts the chosen dose on the document. Two new skills: the <b>modifier</b> — a wire that drives a node’s <b>settings</b> (its max) instead of feeding its math — and the <b>display gate</b>. Names matter: <code>upper_cap</code>, <code>dose</code>.',
          why: 'Protocols carry policy, not just math — “never exceed X” should be enforced by the document itself, not by a warning sentence someone might skip.' },
        { title: 'Add a Constant', target: '.pge-pal-constant',
          text: 'Click <b>' + ICON.svg('pin') + ' Constant</b> — this will be the ceiling.',
          why: 'A Constant is a LAB-owned number, not a reader choice. Policy values (caps, stock concentrations) go here so readers can see them but never drag them.',
          when: function (g, b, H) { return H.count('constant') >= 1; } },
        { title: 'Name it upper_cap, value 100', target: '.pge-node-constant .pge-fields', targetLast: true,
          text: '<b>Name</b>: <code>upper_cap</code>; type <b>100</b> in its value box.',
          why: 'One named cap, written once. Change it here later and everything bound to it re-limits itself.',
          when: function (g, b, H) { return H.some('constant', _named('upper_cap')); } },
        { title: 'Add an Input', target: '.pge-pal-input',
          text: 'Click <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> — the slider to be capped.',
          why: 'The reader’s knob. Right now its max is just whatever you type — nothing enforces the lab’s policy yet.',
          when: function (g, b, H) { return H.count('input') >= 1; } },
        { title: 'Name it dose', target: '.pge-node-input .pge-fields', targetLast: true,
          text: '<b>Name</b>: <code>dose</code> (Default 10, Max 50 for now — the binding will take over the max).',
          why: 'Set a deliberately WRONG max so you can watch the binding overrule it in a moment.',
          when: function (g, b, H) { return H.some('input', _named('dose')); } },
        { title: 'Detail: pick the widget', target: '.pge-node-input .pge-fields', targetLast: true, practice: true,
          text: 'On <code>dose</code>, flip <b>Widget</b> from <code>slider</code> to <code>number</code> — the reader will type an exact dose instead of dragging.',
          why: 'The widget is a statement about precision: sliders invite exploration, number boxes demand an exact figure. (The <b>Hint</b> field below it is where you explain the sensible range in plain words.)',
          when: function (g, b, H) {
            return H.some('input', function (n) { return _named('dose')(n) && (n.params || {}).widget === 'number'; });
          } },
        { title: 'Arm the max setting', target: '.pge-node-input .pge-plus-btn', targetLast: true,
          text: 'On <code>dose</code>: <b>+ add modifier → Drive max from a variable…</b> — the max dot starts pulsing.',
          why: 'This is the modifier move: you’re not wiring INTO the math, you’re wiring INTO a setting. Arming tells the editor which setting the next wire should land on.',
          when: function (g, b, H) { return H.wiring() || edgesInto(g, 'dose', 'param', 'max') >= 1; } },
        { title: 'Complete the binding', target: '.pge-node-constant .pge-socket-out',
          text: 'Click <code>upper_cap</code>’s <b>right dot</b>. The max field flips to “' + ICON.svg('arrow-turn-down-right') + ' driven by upper_cap”.',
          why: 'Now the cap RULES the slider: no reader can pick a dose above upper_cap, in this protocol, ever. That’s policy enforced by structure.',
          when: function (g) { return edgesInto(g, 'dose', 'param', 'max') >= 1; } },
        { title: 'Viewer skill: go full screen', next: true, target: '.pge-expand-btn',
          text: 'Half-way breather. Click the highlighted <b>⛶ Expand</b> — the canvas pops out into a full-screen editor. Same graph, more room. Close it to come back, then press <b>Next ' + ICON.svg('chevron-right') + '</b>.',
          why: 'Binding-heavy graphs sprawl. The popout is the comfortable place for real layout work — and everything, this tour included, keeps running inside it.' },
        { title: 'Viewer skill: the ? cheatsheet', next: true, target: '.pge-view-btn[title^="Canvas how-to"]',
          text: 'The <b>?</b> button opens the canvas cheatsheet — pan, wire, cut, collapse, every gesture on one small card. Peek at it, then press <b>Next ' + ICON.svg('chevron-right') + '</b>.',
          why: 'You won’t remember every gesture from these lessons — you only need to remember where the reminder lives.' },
        { title: 'Add a Cards node', target: '.pge-pal-cards',
          text: 'Click <b>' + ICON.svg('chart-bar') + ' Cards</b> — the gate that decides what the document displays.',
          why: 'Nothing shows by itself anymore: the document renders exactly the variables you wire into a Cards node — a curated result panel, not a dump of every intermediate number.',
          when: function (g, b, H) { return H.added('cards'); } },
        { title: 'Gate the dose', target: '.pge-node-cards .pge-socket-in', targetLast: true,
          text: 'Drag <code>dose</code>’s <b>right dot</b> onto the Cards node’s pulsing dot.',
          why: 'That single wire is the display decision: dose now renders as a live result card on the ' + ICON.svg('document-text') + ' Document — and readers still can’t edit it there.',
          when: function (g, b, H) { return H.anyEdge({ toType: 'cards', role: 'display' }); } },
        { title: 'Cards are references too', next: true,
          text: 'Anything wired to ' + ICON.svg('chart-bar') + ' Cards is ALSO offered by the editor’s <b>' + ICON.svg('link') + ' reference picker</b>, automatically. Want a value inline in a sentence but NOT as a card? That’s what the separate ' + ICON.svg('link') + ' <b>References</b> gate node is for.',
          why: 'Two gates, one rule: Cards = show on the page (+ referencable); References = referencable only. Everything ungated still computes — it just isn’t offered.' },
        { title: 'Drill: cut the display wire', target: '.pge-wire', practice: true,
          text: '<b>Click the dose→Cards wire</b> to delete it (or Shift-drag a line through it) — the card would vanish from the document.',
          why: 'Wires are cheap on purpose: re-routing IS how designs evolve. Deleting a gate wire never deletes data — just the display decision.',
          when: function (g, b, H) { return !H.anyEdge({ toType: 'cards', role: 'display' }); } },
        { title: 'Drill: re-wire it', target: '.pge-node-cards .pge-socket-in', targetLast: true, practice: true,
          text: 'Rebuild it from memory: <code>dose</code>’s right dot onto the Cards node’s dot.',
          why: 'If you can delete and rebuild a wire without thinking, you own the mechanic — that confidence is the real lesson.',
          when: function (g, b, H) { return H.anyEdge({ toType: 'cards', role: 'display' }); } },
        { title: 'Find it in the picker', target: '.pre-viewseg-btn[data-view="editor"]', practice: true,
          text: 'Switch to the highlighted <b>' + ICON.svg('pencil') + ' Editor</b>, click into any sentence, then press <b>' + ICON.svg('link') + ' Reference</b> — your gated <code>dose</code> is right there under its ' + ICON.svg('chart-bar') + ' group.',
          why: 'The picker offers ONLY gated variables, grouped by their gate node — in a big protocol that’s the difference between finding the number and scrolling past forty.',
          when: function () {
            return !!(document.querySelector &&
              document.querySelector('.pre-var-popover:not([hidden]) .pre-var-group'));
          } },
        { title: 'Prove it', next: true, target: '#pre-viewseg a.pre-viewseg-btn',
          text: 'Raise <code>upper_cap</code>, then push <code>dose</code> past its old ceiling — typed values snap back to the cap, and lowering the cap pulls a saved dose DOWN with it. The highlighted <b>' + ICON.svg('document-text') + ' Document</b> shows the gated card, live.',
          why: 'Testing the rail is the point: you built a rule, not a suggestion. Try to break it and watch it hold.' },
      ],
      done: 'Bindings + gates built: a value drove a SETTING (max), a ' + ICON.svg('chart-bar') + ' Cards gate put dose on the document, and you cut + rebuilt a wire from memory. Next rung: ' + ICON.svg('academic-cap') + ' Demos → <b>Lesson 3</b> — sets, lists & plates.',
    },
    {
      id: 'build-lesson-3', group: GROUP_BUILDS, build: true, icon: 'test-tube', title: 'Build lesson 3 — sets, lists & plates',
      blurb: 'Construct the axes → experiment list the plate planner is wired to.',
      steps: [
        { title: 'The goal', next: true,
          text: 'We’re building the skeleton of <b>every designed experiment</b>: 2 treatments ' + ICON.svg('x-mark') + ' 3 doses = <b>6 conditions</b>, expanded into an experiment list that the document’s <b>plate planner</b> reads. When you’re done you can assign wells and get master-mix totals computed from <code>reps</code> ' + ICON.svg('x-mark') + ' <code>excess</code>. The planner is wired to exact names: list <code>conditions</code>, variables <code>reps</code> / <code>excess</code>, fields <code>treatment</code> / <code>dose</code>.',
          why: 'Enumerating conditions by hand is where experiments silently go wrong — a crossed list is generated, complete, and recounts itself when an axis changes.' },
        { title: 'Add a Choices set', target: '.pge-pal-choices',
          text: 'Click <b>' + ICON.svg('arrows-right-left') + ' Choices</b> — the categorical axis.',
          why: 'Treatments aren’t numbers, they’re BRANCHES of the experiment. A Choices set makes the branching explicit instead of burying it in prose.',
          when: function (g, b, H) { return H.count('choices') >= 1; } },
        { title: 'Field treatment, options Control + Drug', target: '.pge-node-choices .pge-fields', targetLast: true,
          text: '<b>Field</b>: <code>treatment</code>; add options <code>Control</code> and <code>Drug</code>.',
          why: 'The field name becomes a COLUMN in every experiment row; the options become its values. “Control” earns its place in the design, not a footnote.',
          when: function (g, b, H) {
            return H.some('choices', function (n) {
              var p = n.params || {};
              return p.field === 'treatment' &&
                (p.options || []).filter(function (o) { return String(o || '').trim(); }).length >= 2;
            });
          } },
        { title: 'Detail: lock the set', target: '.pge-node-choices .pge-fields', targetLast: true, practice: true,
          text: 'Untick <b>“editable at run time”</b> on the treatment set.',
          why: 'Locked = the DESIGN owns the branches; readers can’t quietly add a “Drug2” arm mid-run. Leave it editable only when improvising options at the bench is genuinely wanted.',
          when: function (g, b, H) {
            return H.some('choices', function (n) {
              var p = n.params || {};
              return p.field === 'treatment' && p.editable === false;
            });
          } },
        { title: 'Add an Ordered set', target: '.pge-pal-ordered',
          text: 'Click <b>' + ICON.svg('signal') + ' Ordered set</b> — the graded axis.',
          why: 'Doses are ordered AND numeric: each member carries a real value downstream math can use, which a plain Choices set can’t give you.',
          when: function (g, b, H) { return H.count('ordered') >= 1; } },
        { title: 'Field dose, members low / mid / high', target: '.pge-node-ordered .pge-fields', targetLast: true,
          text: '<b>Field</b>: <code>dose</code>; add three members named <code>low</code>, <code>mid</code>, <code>high</code> (defaults 1 / 10 / 50; pick <code>µM</code> from the unit dropdown’s Amount group).',
          why: 'Labels for humans, numbers for the math: the planner shows “low”, calculations see 1 µM. Each member also carries its own min/max/step — per-member guardrails, same idea as an Input’s range.',
          when: function (g, b, H) {
            return H.some('ordered', function (n) {
              var p = n.params || {};
              var names = (p.items || []).map(function (it) { return it && it.name; });
              return p.field === 'dose' && names.indexOf('low') >= 0 && names.indexOf('mid') >= 0 && names.indexOf('high') >= 0;
            });
          } },
        { title: 'Read the unit legend', next: true, target: '.pge-legend',
          text: 'Below the palette: the <b>unit legend</b>. Every socket dot on the canvas is colored by its dimension — µM doses match the Amount color here.',
          why: 'Color is the fastest wiring sanity-check there is: if you’re about to connect a blue (volume) dot to a teal (amount) equation, the legend tells you to stop and think.' },
        { title: 'Viewer skill: pan', next: true, target: '.pge-viewport',
          text: 'The canvas is filling up. <b>Drag any empty canvas</b> to pan the whole view (grab-hand cursor). Slide around, then press <b>Next ' + ICON.svg('chevron-right') + '</b>.',
          why: 'Pan + zoom + ⌖ Fit are how you live on a big graph: pan to your working area, zoom for detail, Fit to reorient.' },
        { title: 'Add reps', target: '.pge-pal-input',
          text: 'An <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> named <code>reps</code> (wells per experiment; Default 3, range 1–8).',
          why: 'Wells per condition stays a reader knob — the experiment scales up or down without touching the design itself.',
          when: function (g, b, H) { return H.some('input', _named('reps')); } },
        { title: 'Add excess', target: '.pge-pal-input',
          text: 'Another <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> named <code>excess</code> (prep factor; Default 1.2, range 1–2, step 0.05).',
          why: 'Pipetting loss is real. Master-mix totals get multiplied by this so the last well never runs dry.',
          when: function (g, b, H) { return H.some('input', _named('excess')); } },
        { title: 'Add the List — name it conditions', target: '.pge-pal-list',
          text: 'Click <b>' + ICON.svg('clipboard-document-list') + ' List</b> and set <b>List name</b> to <code>conditions</code> — <b>exactly</b>.',
          why: 'The List is the CROSSING machine: it multiplies every axis you feed it into experiment rows. And the name is load-bearing — the document’s plate planner is wired to <code>conditions</code>, letter for letter.',
          when: function (g, b, H) { return H.some('list', _named('conditions')); } },
        { title: 'Feed it the treatment axis', target: '.pge-node-list .pge-socket-in.pge-slot-open[data-slot="structural"]', targetLast: true,
          text: 'Drag <code>treatment</code>’s right dot onto the list’s open “feed…” dot.',
          why: 'Feeding an axis is what multiplies the list. One axis in → one row per treatment (2 so far).',
          when: function (g) { return edgesInto(g, 'conditions', 'structural', '', 'choices') >= 1; } },
        { title: 'Feed it the dose axis', target: '.pge-node-list .pge-socket-in.pge-slot-open[data-slot="structural"]', targetLast: true,
          text: 'Same move with the Ordered set — 2 ' + ICON.svg('x-mark') + ' 3 = <b>6 experiments</b>.',
          why: 'Every treatment now meets every dose — the full factorial, generated, with zero chance of a forgotten combination.',
          when: function (g) { return edgesInto(g, 'conditions', 'structural', '', 'ordered') >= 1; } },
        { title: 'Read the colored outlines', next: true, target: '.pge-scope-list', targetLast: true,
          text: 'Look at the node outlines: scalar nodes (one number) glow <b>blue</b>; the list and anything computed per-experiment glow <b>red / purple</b> — that’s item scope.',
          why: 'Scope shading tells you at a glance which values exist ONCE vs once-per-experiment — exactly the thing that decides where math is allowed to flow.' },
        { title: 'Detail: the merge rule', next: true, target: '.pge-node-list .pge-fields', targetLast: true,
          text: 'The list also carries a <b>Merge rule</b> (dedupe). Our 2 ' + ICON.svg('x-mark') + ' 3 grid has no duplicates — but when two rows would mean IDENTICAL prep (say, every treatment shares the same vehicle batch), the rule pools them into one.',
          why: 'This is how the GELS gold-standard protocol collapses 30 combinations into the batches you actually pipette — the design enumerates everything, the merge rule keeps the bench work minimal.' },
        { title: 'How you’ll lay out the plate', next: true,
          text: 'In a moment you’ll open the plate planner. Two ways to fill it: <b>drag</b> an experiment chip onto a well (drag a well to another to move/swap; drag a well off the plate to remove — tap still works on touch), or press <b>' + ICON.svg('cog-6-tooth') + ' Arrange</b> to lay them out automatically — <b>Fill direction</b> (row / column / snake), <b>Map factor → axis</b> (treatment down rows, dose across columns — the classic readable plate), <b>Spread replicates</b> (scatter reps, optionally skipping edge wells to dodge evaporation), or <b>Randomize</b> with a reproducible seed. “<b>+ Add plate ' + ICON.svg('chevron-down') + '</b>” drops in a 96 / 384 / 24-well grid.',
          why: 'Layout is experimental design, not decoration: mapping factors to axes makes a plate readable at a glance, and spreading / randomizing replicates removes position bias. Every arrangement is cosmetic to the reagent math — the totals only count wells, so you can reshuffle freely.' },
        { title: 'To the plates', next: true, target: '#pre-viewseg a.pre-viewseg-btn',
          text: 'Open the highlighted <b>' + ICON.svg('document-text') + ' Document</b>: your six experiments show in the table AND the <b>plate planner</b>. Drag them onto wells or ' + ICON.svg('cog-6-tooth') + ' Arrange them, and watch the master-batch totals scale with <code>reps</code> ' + ICON.svg('x-mark') + ' <code>excess</code> as you go.',
          why: 'The planner turns rows into wells, and reps × excess turn wells into how much you actually pipette — the design computes its own prep sheet.' },
      ],
      done: 'Lesson 3 built: axes → list → plates, drag-to-arrange + auto-arrange strategies, locked sets, merge rules. The core pattern of every designed experiment. Final rung: ' + ICON.svg('academic-cap') + ' Demos → <b>Lesson 4</b> — the code node and the full workflow.',
    },
    {
      id: 'build-lesson-4', group: GROUP_BUILDS, build: true, icon: 'document', title: 'Build lesson 4 — the code node',
      blurb: 'Construct the scripted cell-count with two named outputs.',
      steps: [
        { title: 'The goal', next: true,
          text: 'We’re building a <b>scripted cell-counting calculator</b>: two Inputs feed a <b>Code</b> node that returns two named outputs (<code>total_cells</code> and <code>millions</code>). The contract that keeps scripts safe here: wired variables arrive as <b>arguments</b>, and returned keys must match the declared <b>outputs</b>.',
          why: 'Equations handle formulas; Code handles LOGIC — branching, multiple outputs, anything one expression can’t say. And a broken script shows a contained ' + ICON.svg('exclamation-triangle') + ' error, never a broken protocol.' },
        { title: 'Add cells_per_mL', target: '.pge-pal-input',
          text: 'An <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> named <code>cells_per_mL</code> (try Default 1000000, range 100000–5000000).',
          why: 'Inputs stay the reader’s knobs — the script only TRANSFORMS them. This one is the first argument-to-be.',
          when: function (g, b, H) { return H.some('input', _named('cells_per_mL')); } },
        { title: 'Add volume_mL', target: '.pge-pal-input',
          text: 'Another <b>' + ICON.svg('adjustments-horizontal') + ' Input</b> named <code>volume_mL</code> (Default 10; unit Type <code>Volume</code> → <code>mL</code>).',
          why: 'Second knob, second argument. The script will see both by exactly these names.',
          when: function (g, b, H) { return H.some('input', _named('volume_mL')); } },
        { title: 'Add the Code node', target: '.pge-pal-code',
          text: 'Click <b>' + ICON.svg('document') + ' Code</b>.',
          why: 'One script, MULTIPLE named outputs — an Equation gives you one value; here we want total cells AND a millions-scaled version from the same computation.',
          when: function (g, b, H) { return H.count('code') >= 1; } },
        { title: 'Declare the outputs', target: '.pge-node-code .pge-fields', targetLast: true,
          text: 'In its outputs grid, declare <code>total_cells</code> (decimals 0) and <code>millions</code> (pick unit <code>M</code> from the Amount group, decimals 2) — “+ output” adds a row.',
          why: 'Declared outputs are the script’s PUBLIC PROMISE: each becomes a real variable the rest of the protocol (and the prose) can read. Declare first, return second.',
          when: function (g, b, H) {
            return H.some('code', function (n) {
              var names = ((n.params || {}).outputs || []).map(function (o) { return o && o.name; });
              return names.indexOf('total_cells') >= 0 && names.indexOf('millions') >= 0;
            });
          } },
        { title: 'Wire both arguments in', target: '.pge-node-code .pge-socket-in.pge-slot-open[data-slot="math"]', targetLast: true,
          text: 'Drag <code>cells_per_mL</code> and <code>volume_mL</code> onto the code node’s open “argument” dots.',
          why: 'Wires decide what the script can SEE: each wired variable arrives as a same-named argument. No wire, no access — a script can’t reach into the protocol uninvited.',
          when: function (g) {
            // code nodes have no params.name — count edges into any code node
            return ((g && g.nodes) || []).some(function (n) {
              if (n.type !== 'code') return false;
              return ((g.edges) || []).filter(function (e) { return e.to === n.id; }).length >= 2;
            });
          } },
        { title: 'Write the script', target: '.pge-node-code .pge-fields', targetLast: true,
          text: 'Set the script to:<br><code>var total = cells_per_mL * volume_mL;<br>return { total_cells: total, millions: total / 1e6 };</code>',
          why: 'The return keys must match the declared outputs EXACTLY — that’s how each value lands in its variable. A missing key errors that one output, nothing else.',
          when: function (g, b, H) {
            return H.some('code', function (n) {
              var body = String((n.params || {}).body || '');
              return body.indexOf('total_cells') >= 0 && body.indexOf('millions') >= 0 && body.indexOf('return') >= 0;
            });
          } },
        { title: 'Drill: break it on purpose', target: '.pge-node-code .pge-fields', targetLast: true, practice: true,
          text: 'Delete <code>millions: total / 1e6</code> from the return — watch <code>millions</code> flip to a contained <b>' + ICON.svg('exclamation-triangle') + ' error row</b> while <code>total_cells</code> keeps computing.',
          why: 'This is the safety contract in action: one broken output NEVER takes down the others or the protocol. Errors are contained, labeled, and point at exactly what’s missing.',
          when: function (g, b, H) {
            return H.some('code', function (n) {
              var body = String((n.params || {}).body || '');
              return body.indexOf('return') >= 0 && body.indexOf('millions') < 0;
            });
          } },
        { title: 'Drill: fix it', target: '.pge-node-code .pge-fields', targetLast: true, practice: true,
          text: 'Put <code>millions: total / 1e6</code> back — the ' + ICON.svg('exclamation-triangle') + ' clears the moment the returned keys match the declared outputs again.',
          why: 'Break → read the error → fix: that loop is how you’ll debug real scripts, and now you’ve done it once where nothing was at stake.',
          when: function (g, b, H) {
            return H.some('code', function (n) {
              var body = String((n.params || {}).body || '');
              return body.indexOf('total_cells') >= 0 && body.indexOf('millions') >= 0 && body.indexOf('return') >= 0;
            });
          } },
        { title: 'Drill: drop in a recipe', target: '.pge-recipes-btn', practice: true,
          text: 'Open <b>' + ICON.svg('sparkles') + ' Recipes</b> and insert <b>Script transform</b> — a pre-wired input → code pair lands on the canvas.',
          why: 'You hand-built this lesson to learn the pieces; recipes are how you’ll START real designs — drop a standard pattern, rename, extend.',
          when: function (g, b, H) { return H.count('code') >= 2; } },
        { title: 'Drill: wire surgery + cleanup', target: '.pge-wire', practice: true,
          text: 'Now remove the scratch pair: hold <b>Shift and drag a line</b> through its wire to cut it (or click the wire), then <b>' + ICON.svg('x-mark') + '</b> both scratch nodes.',
          why: 'Cut and delete are as cheap as create — a canvas you can fearlessly prune is a canvas you’ll keep tidy.',
          when: function (g, b, H) { return H.count('code') <= 1 && H.count('input') <= 2; } },
        { title: 'Read the results', next: true,
          text: 'Both outputs compute live, and the lesson’s prose reads them by name. The graph is done — now finish it like a real protocol.',
          why: 'Script outputs behave like any other variable downstream: reference them in prose, feed them onward, drive settings with them.' },
        { title: 'Finish like a pro: switch to ✎ Editor', target: '.pre-viewseg-btn[data-view="editor"]', practice: true,
          text: 'Switch to the highlighted <b>' + ICON.svg('pencil') + ' Editor</b> — time for the protocol lifecycle.',
          why: 'A design isn’t done when the graph computes — it’s done when the write-up is reviewed, marked complete, and versioned.',
          when: function () {
            return !!(document.querySelector &&
              document.querySelector('.pre-viewseg-btn.active[data-view="editor"]'));
          } },
        { title: 'Mark the section complete', target: '.pre-section-donebtn', targetLast: true, practice: true,
          text: 'Click <b>' + ICON.svg('check') + ' Mark complete</b> on the lesson section’s header — it flips to its final rendered form.',
          why: 'Complete = locked + rendered exactly as readers will see it. Section by section, this is how a draft becomes a runnable document.',
          when: function () {
            return !!(document.querySelector && document.querySelector('.pre-section-complete'));
          } },
        { title: 'The rest of the lifecycle', next: true, target: '#pre-save-version-btn',
          text: 'The topbar finishes the story: <b>' + ICON.svg('save') + ' Save version</b> snapshots this state, <b>' + ICON.svg('document') + ' Versions</b> browses history, <b>' + ICON.svg('git-fork') + ' Fork</b> copies any protocol into your own, and on every text block <b>' + ICON.svg('beaker') + '</b> references lab inventory just like <b>' + ICON.svg('link') + '</b> references variables.',
          why: 'Protocols are living documents — history, forks, and references keep them honest as they evolve.' },
      ],
      done: 'Lesson 4 done — and with it the full tour: nodes, wires, bindings, sets & plates, code, references, and the protocol lifecycle. You’ve touched every part of the system. Build something real.',
    },
  ];

  function list() {
    return TOURS.map(function (t) {
      return { id: t.id, group: t.group, icon: t.icon, title: t.title, blurb: t.blurb, steps: t.steps.length };
    });
  }

  /* ── engine ────────────────────────────────────────────────── */
  function attach(opts) {
    var hostEl = opts.hostEl, viewport = opts.viewport, getGraph = opts.getGraph;
    var resetGraph = opts.resetGraph;   // clears the canvas (build tours only)
    var onEnd = opts.onEnd;             // (reason, {id, stepIdx}) — see header
    var st = null;      // {tour, idx, base, start, satisfied, lastEval}
    var card = null, ring = null, raf = 0;

    function snap() {
      try { return JSON.parse(JSON.stringify(getGraph() || { nodes: [], edges: [] })); }
      catch (e) { return { nodes: [], edges: [] }; }
    }
    function ensureEls() {
      // V3.396 — body-level, position:fixed elements: the card pins to
      // the top-right of the PAGE (not the canvas widget) and neither
      // element dies to canvas transforms or overflow clipping; the ring
      // can now circle anything on the page (palette, nav bar, topbar)
      if (!ring) {
        ring = document.createElement('div');
        ring.className = 'pgt-ring';
        ring.hidden = true;
        document.body.appendChild(ring);
      }
      if (!card) {
        card = document.createElement('div');
        card.className = 'pgt-card';
        document.body.appendChild(card);
      }
    }
    function positionCard() {
      if (!card) return;
      // top-right of the page, tucked just below whatever chrome sits
      // above the canvas (topbar, nav) — tracks page scroll via the loop
      var top = 12;
      try {
        var vr = viewport.getBoundingClientRect();
        top = Math.max(12, vr.top + 12);
      } catch (e) {}
      card.style.top = top + 'px';
    }
    function targetEl(step) {
      if (!step || !step.target) return null;
      try {
        // search the canvas host first, then the whole page — steps may
        // target chrome OUTSIDE the editor (view segment, topbar)
        var scopes = [hostEl, document];
        for (var i = 0; i < scopes.length; i++) {
          var scope = scopes[i];
          if (!scope || !scope.querySelectorAll) continue;
          var all = scope.querySelectorAll(step.target);
          if (all.length) return step.targetLast ? all[all.length - 1] : all[0];
        }
        return null;
      } catch (e) { return null; }
    }
    function positionRing(el) {
      var r = el.getBoundingClientRect();
      var pad = 5;
      // hide if off the window; canvas-internal targets also clip to the
      // canvas box (panned/zoomed out of view), page chrome does not
      var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) {
        ring.hidden = true;
        return;
      }
      if (viewport.contains(el)) {
        var vr = viewport.getBoundingClientRect();
        if (r.right < vr.left || r.left > vr.right || r.bottom < vr.top || r.top > vr.bottom) {
          ring.hidden = true;
          return;
        }
      }
      ring.hidden = false;
      ring.style.left = (r.left - pad) + 'px';
      ring.style.top = (r.top - pad) + 'px';
      ring.style.width = (r.width + pad * 2) + 'px';
      ring.style.height = (r.height + pad * 2) + 'px';
    }
    function current() {
      return st && st.tour.steps[st.idx];
    }
    function renderCard(mode) {
      if (!st) return;
      positionCard();
      var t = st.tour;
      var total = t.steps.length;
      var html = '<div class="pgt-head"><span class="pgt-title">' + (t.icon ? ICON.render(t.icon) + ' ' : '') + esc(t.title) + '</span>' +
        '<button type="button" class="pgt-x" title="Exit tour">' + ICON.svg('x-mark') + '</button></div>';
      if (mode === 'done') {
        var rebuildBtn = (t.build && resetGraph)
          ? '<button type="button" class="pgt-rebuild">' + ICON.svg('arrow-uturn-left') + ' Rebuild from scratch</button>' : '';
        html += '<div class="pgt-step-title">' + ICON.svg('sparkles') + ' Tour complete</div>' +
          '<div class="pgt-text">' + (t.done ? t.done : 'Nice work — try another from ' + ICON.svg('academic-cap') + ' Tours.') + '</div>' +
          '<div class="pgt-foot"><span class="pgt-progress">' + total + ' / ' + total + '</span>' +
          '<span class="pgt-foot-btns">' + rebuildBtn +
          '<button type="button" class="pgt-btn pgt-close">Close</button></span></div>';
      } else if (mode === 'prebuilt') {
        // launched on an already-built graph: offer to clear + walk it
        html += '<div class="pgt-step-title">This copy is already built</div>' +
          '<div class="pgt-text">The workflow for this lesson already exists on the canvas. Rebuild it from an empty canvas to walk through every step, or just explore what’s here.</div>' +
          '<div class="pgt-foot"><span class="pgt-progress"></span><span class="pgt-foot-btns">' +
          (resetGraph ? '<button type="button" class="pgt-btn pgt-rebuild">' + ICON.svg('arrow-uturn-left') + ' Rebuild from scratch</button>' : '') +
          '<button type="button" class="pgt-close-link pgt-close">Just explore</button></span></div>';
      } else {
        var step = current();
        var satisfied = mode === 'satisfied';
        html += '<div class="pgt-step-title">' + esc(step.title || '') + '</div>' +
          '<div class="pgt-text">' + (step.text || '') + '</div>' +
          (step.why ? '<div class="pgt-why"><span class="pgt-why-tag">Why</span> ' + step.why + '</div>' : '') +
          '<div class="pgt-foot"><span class="pgt-progress">' + (st.idx + 1) + ' / ' + total + '</span>' +
          '<span class="pgt-foot-btns">' +
          (step.when && !satisfied ? '<button type="button" class="pgt-skip" title="Skip this step">skip</button>' : '') +
          // V3.396 — no auto-advance: a completed do-step waits for an
          // explicit Next, so the learner reads what happened
          (step.next || satisfied ? '<button type="button" class="pgt-btn pgt-next">Next ' + ICON.svg('chevron-right') + '</button>' : '') +
          '</span></div>';
        if (step.when && !satisfied) {
          html += '<div class="pgt-waiting">● waiting for you…</div>';
        }
        if (satisfied) {
          html += '<div class="pgt-waiting pgt-done-line">' + ICON.svg('check') + ' step complete — press Next</div>';
        }
      }
      card.classList.toggle('pgt-done', mode === 'satisfied');
      card.innerHTML = html;
      var x = card.querySelector('.pgt-x');
      if (x) x.addEventListener('click', function () { stop('user'); });
      var closeB = card.querySelector('.pgt-close');
      if (closeB) closeB.addEventListener('click', function () { stop('user'); });
      var nextB = card.querySelector('.pgt-next');
      if (nextB) nextB.addEventListener('click', function () { activate(st.idx + 1); });
      var skipB = card.querySelector('.pgt-skip');
      if (skipB) skipB.addEventListener('click', function () { activate(st.idx + 1); });
      var rebuildB = card.querySelector('.pgt-rebuild');
      if (rebuildB) rebuildB.addEventListener('click', function () {
        if (!st) return;
        var id = st.tour.id;
        if (resetGraph) { try { resetGraph(); } catch (e) {} }
        start(id); // fresh snapshot over the now-empty canvas → no auto-skip
      });
    }
    function activate(i, fast) {
      if (!st) return;
      card.classList.remove('pgt-done');
      if (i >= st.tour.steps.length) {
        st.idx = st.tour.steps.length;
        ring.hidden = true;
        renderCard('done');
        return;
      }
      st.idx = i;
      st.base = snap();
      st.satisfied = false;
      // a step whose condition is already satisfied: when resuming
      // (`fast`) skip it INSTANTLY so a restart lands on the current
      // step; otherwise show it in its completed state — V3.396: no
      // auto-advance, the learner presses Next
      var step = current();
      if (step.when) {
        var ok = false;
        try { ok = !!step.when(getGraph(), st.base, makeH(getGraph(), st.base, st.start)); } catch (e) {}
        if (ok && fast) { activate(i + 1, true); return; }
        if (ok) { st.satisfied = true; renderCard('satisfied'); return; }
      }
      renderCard();
    }
    function loop(ts) {
      if (!st) return;
      if (!document.contains(viewport)) { stop('detached'); return; }
      raf = requestAnimationFrame(loop);
      positionCard();
      var step = current();
      if (!step) { ring.hidden = true; return; }
      // completed step: the action's done — retire the ring, the card's
      // Next button is the affordance now
      if (st.satisfied) {
        ring.hidden = true;
      } else {
        var el = targetEl(step);
        if (el) positionRing(el);
        else ring.hidden = true;
      }
      if (step.when && ts - (st.lastEval || 0) > 250) {
        st.lastEval = ts;
        var ok = false;
        try { ok = !!step.when(getGraph(), st.base, makeH(getGraph(), st.base, st.start)); } catch (e) {}
        // V3.396 — no auto-advance: flip between waiting ⇄ completed
        // (undoing the action re-arms the step), advance only on Next
        if (ok !== st.satisfied) {
          st.satisfied = ok;
          renderCard(ok ? 'satisfied' : undefined);
        }
      }
    }
    function start(tourId, o) {
      var tour = null;
      TOURS.forEach(function (t) { if (t.id === tourId) tour = t; });
      if (!tour) return false;
      stop('restart');
      ensureEls();
      // resumeAt (the host remounted mid-run): re-enter at the recorded
      // step, fast-skipping anything already satisfied — and bypass the
      // prebuilt gate, which is only for cold launches on legacy copies
      var resumeAt = (o && typeof o.resumeAt === 'number' && o.resumeAt >= 0)
        ? Math.min(o.resumeAt, tour.steps.length) : null;
      st = { tour: tour, idx: -1, base: null, start: snap(), satisfied: false, lastEval: 0 };
      card.hidden = false;
      positionCard();
      // A build tour launched on an ALREADY-COMPLETE graph (every do-step
      // condition already true — e.g. a pre-populated legacy copy) would
      // just auto-skip to the end. Instead offer rebuild / explore.
      if (tour.build && resumeAt === null) {
        var g0 = getGraph();
        // practice steps (viewer-skill drills) don't count toward
        // "already built" — a legacy pre-populated copy satisfies every
        // BUILD condition but has never collapsed/tidied anything
        var doSteps = tour.steps.filter(function (s) { return s.when && !s.practice; });
        var allDone = doSteps.length && doSteps.every(function (s) {
          try { return !!s.when(g0, g0, makeH(g0, g0, g0)); } catch (e) { return false; }
        });
        if (allDone) { renderCard('prebuilt'); return true; }
      }
      if (resumeAt === null) activate(0);
      else activate(resumeAt, true);
      raf = requestAnimationFrame(loop);
      return true;
    }
    function stop(reason) {
      var info = st ? { id: st.tour.id, stepIdx: st.idx } : null;
      st = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (ring) ring.hidden = true;
      if (card) { card.hidden = true; card.innerHTML = ''; }
      // report how the run ended so the host can re-arm a tour that a
      // remount tore down ('detached') vs one closed on purpose ('user');
      // 'restart' (start over start) stays internal
      if (info && typeof onEnd === 'function' && (reason === 'user' || reason === 'detached')) {
        try { onEnd(reason, info); } catch (e) {}
      }
    }
    function destroy() {
      stop('detached');
      if (ring && ring.parentNode) ring.parentNode.removeChild(ring);
      if (card && card.parentNode) card.parentNode.removeChild(card);
      ring = null; card = null;
    }
    return {
      start: start,
      stop: function () { stop('user'); },
      active: function () { return !!st; },
      destroy: destroy,
    };
  }

  window.ProtocolGraphTours = { list: list, attach: attach, _TOURS: TOURS, _makeH: makeH };
})();
