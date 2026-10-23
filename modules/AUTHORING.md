# How Claude Builds an Interactive Learning Module

> **Read this before authoring any lesson in `modules/`.** It is the abstract
> spec for the McGhee Lab interactive-module pattern. When in doubt, copy the
> structure, CSS, and JS helper library verbatim from an existing built module
> in this repo — match a working module exactly rather than reinventing it.

---

## 0. What a module *is*

One **self-contained HTML file**. No build step, no framework, no external
dependencies except MathJax (CDN) and Firebase (only when the module ships
inside the site nav — see §7). Everything — markup, CSS, simulation code —
lives in that single file so it can be opened directly, FTP'd to GoDaddy, and
served as a static asset.

A module teaches **one topic across escalating tabs**, and every concept the
prose introduces has a **live interactive simulation** the student can drive.

---

## 1. Pedagogical contract (the part that matters most)

Every module obeys this learning arc:

1. **Open at the high-school level.** The first tab(s) assume only algebra and
   everyday intuition (springs, pushing, pulling, stretching honey). Lead with a
   physical picture and a hands-on sim *before* any equation.
2. **Escalate one idea per tab.** Each tab adds exactly one new concept and
   builds on the previous one. Never introduce two hard ideas at once.
3. **End each module at the sophomore-undergraduate level.** The final tab is
   the "level up": introduce the real governing equation, the proper
   nomenclature, and a worked example a 2nd-year engineering student would meet
   (e.g. Lennard-Jones `F=-dU/dr`, Hall–Petch, `σ=My/I`).
4. **Two depths, always.** Write so a student can either (a) stop at the
   surface-level intuition and still leave correct, or (b) drill into the
   equation box and worked example for the deep version. The sim must be
   legible at both depths.

Tone: concrete, second person ("pull the bond", "watch the grain"), curious,
never condescending. Define every symbol the first time it appears.

Each tab must contain, in this order (see §3 for the CSS classes):
- a **Background** section (the teaching prose + equation boxes),
- a **worked example**,
- a **key-takeaways** box (3–4 bullets),
- a **"Try this"** task list (what to do with the sim),
- a **scenario bar** (preset buttons),
- the **panel** (controls on the left, canvases + verdict on the right).

---

## 2. File skeleton

```
<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{Lesson Title} — {Course}</title>
  <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
  <style> … the house CSS (copy from the reference) … </style>
</head><body>
  <header><h1>…</h1><p class="subtitle">…</p></header>
  <div class="tab-bar"> … one .tab-btn per tab … </div>
  <main>
    <section id="tab-{key}" class="tab-content [active]"> … per §3 … </section>
    …
    <div class="sources"> … verified citations … </div>
  </main>
  <footer>…</footer>
  <script> … helper library (§5) + per-module state + draw functions … </script>
</body></html>
```

- Exactly one tab carries `class="tab-content active"` and its button carries
  `class="tab-btn active"` at load.
- Canvas elements use a fixed intrinsic `width`/`height` (e.g. `640×300`); the
  CSS scales them responsively and `setupCanvas` handles devicePixelRatio.

---

## 3. Required markup per tab

```html
<section id="tab-KEY" class="tab-content">
  <div class="background-section">
    <h2>Background: …</h2>
    <p>… intuition first …</p>
    <div class="equation-box">$$ … $$</div>
    <div class="worked-example"><p>… numbers plugged in …</p></div>
    <div class="key-takeaways"><ul><li>…</li></ul></div>
  </div>
  <div class="student-task"><ol><li>…</li></ol></div>
  <div class="scenario-bar">
    <span class="scenario-bar-label">Scenario:</span>
    <button class="scen-btn on" data-tab="KEY" data-scen="A" onclick="setScen('KEY','A')">…</button>
    <button class="scen-btn"    data-tab="KEY" data-scen="B" onclick="setScen('KEY','B')">…</button>
  </div>
  <div class="panel">
    <div class="ctrl"><h3>Controls</h3>
      <div class="ctrl-group"><label>Name <span id="v-KEY-x">val</span></label>
        <input type="range" id="s-KEY-x" min="…" max="…" step="…" value="…"></div>
      <div class="stats" id="st-KEY"></div>
    </div>
    <div class="viz">
      <div class="canvas-wrap"><div class="canvas-title">…</div><canvas id="cv-KEY" width="640" height="300"></canvas></div>
      <div class="val-verdict" id="vd-KEY"></div>
    </div>
  </div>
</section>
```

**ID naming convention (load-bearing — the wiring depends on it):**
- slider input: `s-{tab}-{param}`  ·  its value readout: `v-{tab}-{param}`
- stats block: `st-{tab}`  ·  verdict box: `vd-{tab}`  ·  canvas: `cv-{tab}` (`cv-{tab}2` for a second)

House CSS classes (copy the stylesheet from the reference file, don't reinvent):
`header/.subtitle`, `.tab-bar/.tab-btn(.active)`, `.tab-content(.active)`,
`.background-section`, `.equation-box`, `.worked-example`, `.key-takeaways`,
`.student-task`, `.scenario-bar/.scenario-bar-label/.scen-btn(.on)`, `.panel`,
`.ctrl/.ctrl-group`, `.stats/.stat-row(.highlight)`, `.viz/.canvas-wrap/.canvas-title`,
`.val-verdict(.good|.bad|.warn)`, `.sources`, `footer`. Palette lives in the
`COL` object. Dark-on-light theme; accent blue `#2563eb`, ink `#1e3a5f`.

---

## 4. Simulation design rules

- **Every tab has a working sim.** No decorative-only tabs.
- **Direct manipulation.** Sliders + scenario presets; the canvas redraws
  instantly on `input` (no "run" button). Scenario buttons just set slider
  values via `presetSlider` and re-draw.
- **Show the concept, not the numerics.** Prefer a synthetic, closed-form model
  that renders in <16 ms over a heavy numerical solver. Correct *behavior* and
  correct *scaling/units* matter more than physical exactness; if you
  approximate, keep the qualitative response faithful (right sign, right trend,
  right limits).
- **Two linked views are ideal:** a physical-picture canvas (atoms, grains, a
  bent beam) beside a plot canvas (force–displacement, stress–strain). The
  plot uses the `Chart` helper.
- **The verdict box narrates.** After each redraw, write one or two sentences
  into `vd-{tab}` interpreting what the student is seeing, and flip its class to
  `good`/`warn`/`bad` when there's a right/wrong regime (e.g. "Hooke's law is
  accurate here" vs "the bond is about to break — Hooke fails").
- **The stats block reports live numbers** via `setStat`, highlighting the one
  the tab is really about.
- Only animate when motion is the point (e.g. thermal jiggle); otherwise draw
  once per input. Guard every draw in `try/catch` so one broken tab can't kill
  the others.

---

## 5. The shared JS helper library

Copy these verbatim from the reference file's `<script>` — do **not** rewrite
them. They are the contract every draw function is built on:

- `setupCanvas(canvas)` → `{ctx,w,h}` with devicePixelRatio handled + cleared.
- `class Chart(ctx,w,h,margins)` with `setRange`, `toX/toY`, `grid`, `axes`,
  `hLine`, `vLine`, `legend` — all plotting goes through this.
- Primitives: `drawLine`, `arrow`, `springGlyph`, `dashpotGlyph`.
- Formatting: `fmt(v,d)`, `niceTicks(lo,hi,n)`.
- DOM: `setStat(id,rows)`, `setVerdict(id,cls,title,body)`, `val(id)`, `num(id)`.
- Random (seeded): `mulberry32(seed)`, `randn()`.

**Per-module control code** (adapt, don't copy):
- `activeTab` + a `scen` object holding each tab's current scenario key.
- `FMT` — map of `{tab}-{param}` → formatter for the slider readout + units.
- `wireAll()` — attaches `input` listeners to every slider, updates readout,
  calls `refreshActiveTab()`.
- `presetSlider(id,v)` and `setScen(tab,s)` — scenario presets.
- `DRAW` — map of `{tab: drawFn}`; `refreshActiveTab()` dispatches through it.
- Tab-button click handler: swap `.active`, set `activeTab`, redraw, (re)start anim.
- `window.resize` → `refreshActiveTab()`. On load: `wireAll()` then draw the
  default tab.

---

## 6. Content integrity

- **Cite real sources.** The `.sources` list must contain verifiable references
  (DOIs/textbooks). Never invent citations. If unsure of a value, state the
  scaling law rather than a fake precise number.
- Worked-example numbers must actually compute from the stated inputs.
- Equations render with MathJax (`$$…$$` display, `\( … \)` inline).

---

## 7. Registration & housekeeping

1. Save the file under a course folder: `modules/{course}/{NN-slug}.html`.
2. Add it to [`modules/manifest.json`](manifest.json) under the course's
   `folders` entry (create the folder entry with a `label` if new), with
   `{ "name": "...", "title": "..." }`, and bump `generated`.
3. Update `CodeLog/Updates/CHANGELOG.md` (Added) and, if a new course folder or
   dependency was introduced, `CodeLog/Architecture/ARCHITECTURE.md`.
4. If the module is surfaced in site navigation, keep the Firebase header
   includes from [`_template.html`](_template.html); standalone course modules
   (like this Basic Lessons set) omit them and are fully self-contained.

### 7.5 Optional: the whiteboard panel (V3.684)

A floating whiteboard beside the lesson, showing the class's **live** board, so a
class can be taught from the module and the board at once (laptop on the
projector, instructor writing on a tablet). Opt in per module — nothing is
injected automatically. Add to `<head>`, in this order (all `defer`, so they run
in document order):

```html
<meta name="ml-module-viewport" content="1">
<link rel="stylesheet" href="../../whiteboard-board.css">
<link rel="stylesheet" href="../shared/whiteboard-panel.css">
<script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-app-compat.js"></script>
<script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-auth-compat.js"></script>
<script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore-compat.js"></script>
<script defer src="https://www.gstatic.com/firebasejs/10.14.0/firebase-storage-compat.js"></script>
<script defer src="../../firebase-config.js"></script>
<script defer src="../../rm/js/icons.js"></script>
<script defer src="../../whiteboard.js"></script>
<script defer src="../shared/whiteboard-panel.js"></script>
```

Two further opt-in metas (V3.685) decide whose board the panel's second tab
shows and whether it can ever be shared:

```html
<meta name="ml-module-board" content="homework">   <!-- default: notes -->
<meta name="ml-module-key"   content="bme466-hw1"> <!-- default: the filename -->
```

- `notes` (the default) gives the student a board they may share read-only with
  classmates they pick. `homework` puts the board in a collection whose rules
  contain **no sharing clause at all**, so it can never be shared — and the
  panel renders no sharing control. Getting this wrong in the *other* direction
  would leak homework, which is why notes is the default only for modules that
  don't declare it and every homework module declares it explicitly.
- `ml-module-key` must contain **no underscore**: board ids are `{key}_{uid}`
  and the rules split on `_` to prove ownership. `ownerBoardId()` strips them
  defensively, but a key with an underscore will not round-trip to the id you
  expect.
- A homework module that wants the student's drawing in its results file calls
  `await window.ML_WHITEBOARD_EXPORT()` inside its existing `exportResults()`
  and folds the result into the payload it already downloads — never a second
  download, which the viewer's iframe sandbox blocks.

Reference implementations: `modules/bme466/01-diffusion-why-anything-moves.html`
(notes) and `modules/bme466/hw-01-diffusion-mass-transport.html` (homework).
What you need to know:

- **`<meta name="ml-module-viewport">` is load-bearing, not decorative.** The
  module viewer sizes an iframe one of two ways: modules with `#rail` (or this
  meta) get a viewport-height iframe and scroll internally; everything else is
  stretched to its full `scrollHeight` and the *parent* scrolls. In the second
  regime `position:fixed` pins to a viewport as tall as the whole document, so a
  floating panel scrolls away. Declare the meta on any module with a floating
  panel. A weekly module with `#rail` already satisfies the branch, but declare
  it anyway so the requirement is visible in the file.
- **Use `firebase-config.js`, never a second inlined config.** It is the same
  file the site loads, so the two cannot drift, and it carries the
  long-polling workaround an iframe would otherwise lack. (The
  `ML-CLOUD-SAVE` block in `hw-00-pretest.html` predates this and inlines its
  own — don't copy that part.)
- **No auth handshake is needed.** Firebase persists its session per origin
  under the default app and the module iframe is same-origin, so a user signed in
  on the site is already signed in here.
- **The panel needs `?class={scheduleId}`** to know whose board to show. The
  viewer adds it to the iframe src and the class page adds it to module links; a
  hand-written direct link must include it or the panel stays hidden.
- **It fails soft by design.** No class id, no network, not signed in, or no live
  board — the panel says so and the lesson is untouched. Never make lesson
  content depend on it.
- Instructors additionally get a **`→ Whiteboard`** button on every `<canvas>`.
  Keep sims drawing from primitives: an external image would taint the canvas and
  `toDataURL` would throw instead of returning a frame.

---

### 7.6 Simulations on the whiteboard (V3.736–737)

Every section of a weekly module is addressable from the whiteboard as
**module.tab.section** — `1.2.1` is module 1 (the lesson's position in the
class's Learning Modules list; a `01-` filename prefix wins ties), tab 2,
section 1, i.e. the block headed `h2 data-nav="2.1"`. Nothing to author:
the `data-nav` numbering you already write (§9.1) *is* the address.

Two embed modes, both served by the module file itself (no copies):

| URL | Shows |
|---|---|
| `lesson.html?embed=2.1` | the whole section — story, task, scenario bar, panel |
| `lesson.html?embed=2.1&sim=1` | the **simulation only** — scenario bar, control panel, canvases |

`whiteboard-panel.js` implements both (`setupEmbed`): it activates the
block's tab through the module's own tab button, hides every other block
and all page chrome, and never scales the document — the whiteboard lays
the module out at 1280×800 and scales the *iframe*. (Scaling inside the
module breaks `setupCanvas`, which reads `getBoundingClientRect` and writes
it back as the canvas width.) So a module must load the panel script (§7.5)
to be embeddable.

**Standalone simulation files.** `scripts/gen_simulations.py` writes one
page per simulation to `modules/<class>/simulations/N.T.S.html` (a thin
wrapper opening `…?embed=T.S&sim=1`, with a title bar and a link back to
the lesson) plus `simulations/index.json`. A section counts as a simulation
when its block contains a `<canvas>`. Run it after adding or renumbering a
module — `python3 scripts/gen_simulations.py --check` fails when the files
are stale. Homework (`hw-…`) and notes (`w01-…`, `R1-…`) have no numbers and
are skipped.

### 7.7 Icons: monochrome, never emoji (V3.861)

No colour emoji anywhere in a module — not in buttons, callouts, hints, canvas
labels or JS strings. A module stays self-contained, so it carries its own
inline sprite of exactly the icons it uses (Heroicons + Lucide, the same set
as the site — names in `scripts/icons.manifest.json`):

```html
<svg class="hi" aria-hidden="true"><use href="#hi-calculator"/></svg> Calc
```
```js
btn.innerHTML = HI.svg('play') + ' Run';              // markup string
HI.svg('dot', { solid: 1, tint: '#ef4444' });         // a coloured status dot
HI.draw(ctx, 'beer', x, y, 18, '#334155');            // onto a <canvas> (x,y = top-left)
```

Then run `python3 scripts/module_icons.py modules/<course>/<file>.html` — it
writes the sprite and `HI` between the `hi-icons` markers right after
`<body>` (never edit that block by hand; re-run after adding an icon).
`--check --all` is a release gate. `HI` is reserved: a module variable named
`HI` hides the helper and its icons silently stop drawing, so the tool refuses
a file that declares one. Text-only places (`title=`, `placeholder`,
`<option>`, canvas `fillText`, clipboard text) get words, not icons.

## 8. Authoring checklist (Definition of Done)

- [ ] Opens high-school, ends sophomore-undergraduate; one new idea per tab.
- [ ] Every tab: background + worked example + key takeaways + try-this +
      scenario bar + working sim.
- [ ] Sim redraws instantly on every slider/scenario change; no console errors.
- [ ] Stats + verdict update live and interpret the current state.
- [ ] Both depths readable (surface intuition AND the equation).
- [ ] Responsive (mobile CSS block present); canvases scale.
- [ ] Real, verified sources listed.
- [ ] No colour emoji; icons via the sprite (`module_icons.py --check` passes).
- [ ] Registered in `manifest.json`; CHANGELOG/ARCHITECTURE updated.

## 9. Weekly learning modules: lesson flow, presenter mode, animation gating

The F26 weekly *learning* modules (reference implementation:
`modules/bme466/01-diffusion-why-anything-moves.html`) extend the house pattern.
**The full standard-format spec — module arc, tab arc, section grammar, sim design
principles, QA protocol, and the Week-N replication checklist — lives in the course
repo at `F26Course/00-admin/LEARNING-MODULE-SPEC.md` (adopted 2026-08-26).** This
section keeps only the website-side implementation notes.
**Governing arc (instructor, 2026-08-26): every tab opens from a FUNDAMENTAL LENS —
as a simulation, not prose — and moves into synthesis.** A derivation should confirm a
number the student already measured, never introduce it (reference: Week-1 Tab 3, where
D/(μ·kBT) = 1 is measured in section 3.1 and only derived in 3.3). Statistical
quantities get the single-particle vs many-particle distinction made explicit
(Week-1 §2.4: x_rms is a probability radius, not a position).

Copy these four things into every new weekly module:

1. **Lesson-flow layout** — each tab is a scrollable stack of `.lesson-block`s
   (story `.background-section` → `.student-task` → optional `.scenario-bar` →
   `.panel.compact`), one concept per block, `h2 data-nav="N.M" data-title="…"`
   on every block heading.
2. **Section rail + Present mode** — the classroom teaches on TV screens, so the
   fixed left rail (built at boot from the `h2[data-nav]` anchors) is the
   instructor's position key, and ⛶ Present widens sections to the full screen,
   one section per viewport, with root-font steps (19–28 px; all sizes rem) and
   canvases re-rendered at matching zoom via the `PZ` logical-width divisor in
   `setupCanvas` (zero per-widget changes). `?present=1` autostarts. Works in the
   class-shell iframe because that iframe is viewport-sized.
3. **Animation gating without trusting IntersectionObserver** — widgets
   self-register (`defWidget`/`registerAnim`), one shared rAF loop steps only
   widgets whose tab is active AND whose canvas is near the viewport, and
   visibility is recomputed geometrically by `syncVis()` on boot/tab-switch/
   scroll/resize. IO is wired only as a bonus wake-up: in some headless builds it
   never fires at all, and QA that trusts it reports every sim dead.
4. **`reset` fires on every slider tick — guard any CONTINUOUS field (V3.691).**
   `wireAll()` calls `RESET[widget]()` on each `input` event, not just on a
   scenario change. That is right for a reset that clears an *event* (a fall you
   want to re-watch, a crossing counter), and wrong for one that seeds a
   continuous tracer field: a drag re-seeds on every tick, so the animation never
   settles and ends cold. Guard it:

   ```js
   let RESEED=false;                                   // raised at boot + in setScen()
   function keepField(a){ return !!(a && a.length && !RESEED); }
   function resetFoo(){ if(keepField(FOO.p))return; /* seed */ }
   ```

   Seed the field in **steady state** (positions spread across the whole cycle),
   not all at the start, or the first frames are empty. Widgets that pair
   `registerAnim` with `reset` and are worth auditing for this:
   `cell_culture/01-the-cabinet` (fixed), `cell_culture/02-the-incubator`
   (fixed V3.696), `bme466/01`, `bme466/02`, `equipment/01-the-balance`. Decide
   per widget — a re-seed is correct wherever a parameter change should restart
   the sample.

5. **`Chart` clears the whole canvas — pass `{keep:1}` beside artwork (V3.696).**
   The V3.687 fix that stopped curves stacking made the constructor wash the
   canvas, which silently erased anything the caller had already drawn beside the
   chart. `cell_culture/02`'s dish and `04`'s 200-bottle grid had both been
   invisible ever since, on a page reporting zero errors. Two rules:

   - a widget that draws a panel *and* a chart passes `{l,r,t,b,keep:1}`;
   - `Chart`'s margin `b` is a **bottom margin**, so a helper that takes a plot
     *floor* must convert (`b: h-floorY`). Passing a margin where a floor is
     expected gives a negative `ph` and draws an inverted chart over the other
     one, with no error anywhere.

6. **`h` is not the `height` attribute — it scales with width.** `setupCanvas`
   sets `h = w × (attrH/attrW)`, so a canvas authored at 660×330 is 948×474 on a
   wide screen. Fixed pixel y-offsets look right at the authored width and fall
   apart everywhere else: express vertical layout as fractions of `h`, and keep
   absolute offsets only for text, which does not scale. `getCv` publishes
   `dataset.cvw`/`cvh` so a harness can check this without page globals.

7. **`fmt()` falls through to `toExponential` below 0.001.** Any stat that can go
   very small needs its own formatter, or a reader gets `3.48e-5 %` in a table.

Headless QA gotchas (patchright): `page.evaluate` runs in an ISOLATED world —
main-page globals are invisible; drive the page with real DOM clicks/events and
read the stats DOM. `waitForFunction` evaluates in the MAIN world. And scroll the
*canvas* into view (not the section heading — the prose above it is taller than
the viewport), or the sim under test never steps. The shared rAF loop publishes
`canvas.dataset.frames` and, on a throw inside its own try/catch,
`canvas.dataset.animerr` — read those rather than inferring liveness, and
**checksum the whole image** to test whether a sim is moving: counting pixels of
a tracer's nominal colour measures the anti-aliased *labels* instead, and reports
a perfectly healthy animation as frozen.

**Worked examples (instructor, 2026-08-26):** every worked example is a
`details.worked` block — COLLAPSED by default, numbered steps with bold leads,
every equation displayed at its own step, symbolic assembly shown before any
numbers ("how the equations come together"), boxed ANSWER div at the end.
Reference implementation + CSS: Week-1 module (12 instances). Attribution
style: lecture-notes asides are titled "Note from Dr. McGhee", never "verbatim".
Range-input gotcha: assigned values SNAP to the step grid — never round-trip an
animation clock through a stepped slider (keep the clock in a variable; the
slider is display during play, authority when scrubbed).
