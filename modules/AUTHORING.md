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

---

## 8. Authoring checklist (Definition of Done)

- [ ] Opens high-school, ends sophomore-undergraduate; one new idea per tab.
- [ ] Every tab: background + worked example + key takeaways + try-this +
      scenario bar + working sim.
- [ ] Sim redraws instantly on every slider/scenario change; no console errors.
- [ ] Stats + verdict update live and interpret the current state.
- [ ] Both depths readable (surface intuition AND the equation).
- [ ] Responsive (mobile CSS block present); canvases scale.
- [ ] Real, verified sources listed.
- [ ] Registered in `manifest.json`; CHANGELOG/ARCHITECTURE updated.
