# Module Template — Pedagogy & Structure

This document captures the canonical pattern for building interactive HTML lesson notebooks in this course. The reference implementation is:

**[modules/module_13_validation/notebooks/01_model_validation.html](module_13_validation/notebooks/01_model_validation.html)**

When building a new module, copy that file as your starting point and adapt the content. This document explains the *why* behind each structural choice so you can adapt intelligently rather than mechanically.

---

## 1. Pedagogical Principles

These six principles drive every structural decision below.

### 1.1 Always ground in cancer biology
Per the [course philosophy](../CLAUDE.md), every concept lives inside a real in vitro problem (tumor spheroids, Transwell invasion, drug response, organ-on-chip, etc.). Students never see a method in the abstract — they see it solving a biology problem.

**Implication for the template:** the header subtitle, the equation box, the worked examples, the parameter sliders, and the verdict text all reference a specific cancer-biology context.

### 1.2 Show → Try → Reflect
Every concept is presented in three movements:
1. **Show** — equations and a worked example in the *background section*
2. **Try** — the student manipulates controls and watches results in the *interactive panel*
3. **Reflect** — a *verdict box* or *capstone tab* synthesizes what just happened

### 1.3 Compare-and-contrast scenarios
A single "good" demo is forgettable. Multiple scenarios — one correct + several distinct failure modes — make the concept stick. Students see what *right* looks like *and* what *wrong* looks like, side by side.

**Module 13 example:** the scenario toggle has 4 buttons (Proper Split, Improper Split, Overfit, Underfit), each isolating a distinct validation failure mode plus the high-noise preset for a fifth.

### 1.4 Linearize / transform when meaningful
For nonlinear models, raw R² is misleading. When possible, show the transformed view that justifies the metric (in Module 13: linearize the invasion model so observations should fall on `y = μt`).

### 1.5 Plain-language verdicts
Every interactive element produces a *verdict* — a short, plain-language interpretation: "what just happened?" + "what should you do about it?" Numbers without interpretation are noise.

### 1.6 Capstone synthesis
The last tab synthesizes the previous tabs. Two acceptable patterns:
- **Remedy tab** (Module 13's choice): show how to *fix* each failure mode introduced earlier
- **Integrative application**: use multiple techniques together on a new problem

Either way, the capstone tab references and ties together earlier tabs.

---

## 2. Top-Level Structure

```
┌─────────────────────────────────────────────────────────┐
│ HEADER  — Module title + cancer-application subtitle    │
├─────────────────────────────────────────────────────────┤
│ TAB BAR — 4–6 numbered tabs (progressive narrative)     │
├─────────────────────────────────────────────────────────┤
│ <main>                                                  │
│   ┌──────────── ACTIVE TAB SECTION ───────────────┐    │
│   │ 1. Background section (theory + equations)    │    │
│   │ 2. Student task (TRY THIS — read first)       │    │
│   │ 3. Scenario bar (interactive cases)            │    │
│   │ 4. Interactive panel (controls + plots + verdict)│  │
│   │ 5. (Optional) per-tab synthesis                │    │
│   └────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

Per-tab block ordering is enforced by CSS flexbox `order`, not HTML source order. This keeps semantic source order (background → scenario → interactive → task) for screen readers while presenting students with the pedagogically optimal visual order (background → task → scenario → interactive).

```css
.tab-content.active{display:flex;flex-direction:column}
.tab-content > .background-section{order:1}
.tab-content > .student-task{order:2}
.tab-content > .scenario-bar{order:3}
.tab-content > .panel{order:4}
```

---

## 3. The Tab Progression

Use **4–6 tabs**. Fewer than 4 and you don't have room to break the topic into digestible pieces; more than 6 and students get lost.

### Tab 1 — Introduction + Primary Concept
- The **only** tab a student must see to grasp the core idea
- Introduces the cancer-biology context in the background section
- Establishes the canonical mathematical model and parameters
- Provides the primary interactive view (e.g., calibration plot for Module 13)
- Sets up the scenarios that the rest of the module will explore

### Tabs 2 to N-1 — Diagnostic / Exploratory Lenses
Each middle tab focuses on **one diagnostic technique or perspective** applied to the same problem. The data and scenarios stay the same; the *lens* changes.

**Module 13 example:**
- Tab 2 = Residual diagnostics (residuals vs time + Q-Q plot)
- Tab 3 = Prediction vs observation (1:1 plot + 95% prediction interval)
- Tab 4 = Cross-validation (per-fold CV + external check)
- Tab 5 = Extrapolation (test at new physical conditions)

For other modules, adapt to the topic:
- A *sensitivity analysis* module's middle tabs might be: local sensitivity, Sobol indices, Morris screening, ranking comparison
- A *DOE* module's middle tabs might be: full factorial, fractional factorial, central composite, optimal designs

### Tab N — Capstone Synthesis
The last tab does one of two things:

**Option A — Remedy / refinement** *(Module 13's choice)*
Given each failure mode shown in Tabs 1–N-1, what's the appropriate fix? Module 13 maps:
- Improper split → pool data
- Overfit → simpler model
- Underfit → add missing physics
- High noise → more replicates / better measurements

This works well for *diagnostic* topics (validation, sensitivity, UQ).

**Option B — Integrative application**
Apply multiple techniques together on a new problem. For example, a calibration module's capstone might be: fit a model to a real dataset using each calibration approach taught earlier, then compare which one wins and why.

This works well for *constructive* topics (calibration, DOE, modeling).

---

## 4. Per-Tab Block Pattern

Every tab has the same five-block structure. Students learn the rhythm fast.

### 4.1 Background section (`.background-section`)
- Lead with the cancer-biology motivation
- Present the equation(s) in `.equation-box` (MathJax rendered)
- Include 1–2 `.worked-example` boxes showing concrete numbers
- 1–3 `<h3>` subsections; keep prose tight

### 4.2 Student task / "TRY THIS" (`.student-task`)
- Numbered steps the student should perform with the interactive
- Each step references a specific scenario or control
- Steps build narratively: try the baseline → try a failure case → compare
- Pedagogically positioned **before** the scenario bar so students read the recipe first
- Source order is after the panel; visual order is before — controlled by flexbox `order`

### 4.3 Scenario bar (`.scenario-bar`)
- Optional but strongly recommended for tabs that use scenarios
- 2–5 buttons, each representing a distinct case
- One scenario per failure mode; one is always the "right" baseline
- Synced across all tabs via shared `.scen-btn` class + `setScenario()` function

### 4.4 Interactive panel (`.panel`)
- Two-column grid: `.ctrl` (controls + stats) on the left, plots on the right
- Stacks to 1 column on mobile (≤ 900px)
- Each plot has a `.canvas-wrap` with a title and a `<canvas>` element
- Right column commonly has a `.chart-row` (2 plots) or `.chart-row-3` (3 plots)
- Stats panel (`.stats`) shows numerical results with `.stat-row` entries
- Verdict box (`.val-verdict`) gives plain-language interpretation

### 4.5 (Optional) Per-tab synthesis
A short paragraph or `.insight` box at the end summarizing what this tab teaches. Module 13 uses these sparingly — most synthesis happens in Tab 6.

---

## 5. The Cross-Cutting Features

These four features make the module feel cohesive and scientifically rigorous.

### 5.1 Scenario toggle (multi-case comparison)
- Single global state variable: `scenario = 'proper' | 'improper' | ...`
- All scenario buttons share the `.scen-btn` class
- One `setScenario(s)` function syncs all buttons (across all 6 tabs) and triggers `applyScenario()` + `refreshActiveTab()`
- `applyScenario()` swaps active datasets and refits the model
- Each scenario should illustrate a *distinct* concept — don't waste a button on a near-duplicate

### 5.2 Linearization / transformation discipline
When R² (or another metric) is reported, also show the visualization that justifies it. For nonlinear models: linearize via change-of-basis so the expected relationship becomes a straight line. Then plot data + expected line; deviations are interpretable.

In Module 13: `getLinearized()`, `calcLinR2Fn()`, `linearizedPredictionCurve()`, and the "Linearized View" canvas on every tab.

### 5.3 Verdict generator
Centralize verdict text via a single function:

```javascript
function generateVerdict(scenario, tab, metrics) {
    // Returns { kind: 'good'|'bad', html: '<strong>Diagnosis</strong>...' }
}
```

Each scenario contributes a *diagnosis* (what went wrong) and a *prescription* (what to do). Each tab contributes a *metric interpretation*. The function combines them. This avoids 30+ scattered verdict branches.

### 5.4 Mobile responsive
- Viewport meta tag (`<meta name="viewport" content="width=device-width, initial-scale=1.0">`) — already in the boilerplate
- Canvases use `width: 100%; height: auto; max-width: 100%` for aspect-preserving scaling
- `@media (max-width: 640px)` breakpoint resizes header, tab bar, scenario bar, controls, stats, verdict text
- `@media (max-width: 380px)` breakpoint stacks scenario buttons 1-per-row
- Window `resize` and `orientationchange` listeners call `refreshActiveTab()` so canvases redraw at new sizes

---

## 6. The JavaScript Architecture

These reusable patterns live in Module 13's `<script>` block. Copy them; adapt the model-specific parts.

### 6.1 The `fitResult` object
The single source of truth for "what model is currently active?". Each scenario produces a different `fitResult`:

```javascript
fitResult = {
    modelType: 'mechanistic' | 'polynomial' | ...,
    predict: (t) => Number,      // unified prediction call
    paramDisplay: [...],         // for stats panel
    D_for_lin: Number,           // parameter for linearization
    mu_for_lin: Number | null,   // null if no straight predicted line
    cov: [[...]] | null,         // null disables prediction interval
    showLinearized: boolean,
    showPredictionInterval: boolean
}
```

This abstraction lets every tab call `fitResult.predict(t)` without knowing which model is active.

### 6.2 Scenario state machine
- Module-level `scenario` variable
- `applyScenario()` reads `scenario`, picks the right datasets and fit, builds `fitResult`, updates display
- `setScenario(s)` updates state, syncs button classes, then calls `applyScenario()` and `refreshActiveTab()`

### 6.3 Tab refresh dispatcher
```javascript
function refreshActiveTab() {
    const tabId = document.querySelector('.tab-bar .tab-btn.active').dataset.tab;
    if (tabId === 'tab-id-1') drawTabOne();
    else if (tabId === 'tab-id-2') drawTabTwo();
    // ...
}
```

Called when scenarios change OR when the user switches tabs OR when the window resizes.

### 6.4 Generic chart helpers
- `getCanvasCtx(id)` — handles DPR + container sizing
- `chartArea`, `mapX`, `mapY`, `drawAxes`, `drawTicks`, `drawCircle`, `drawSquare`
- `drawLinearizedView(cfg)` — generic linearized scatter + line/curve renderer

These are model-agnostic — copy verbatim.

### 6.5 Statistics helpers
- `calcR2`, `calcRMSE`, `calcPearsonR`, `calcSkewness` — generic
- `getLinearized`, `calcLinR2`, `calcLinR2Fn` — Module 13 specific (invasion model linearization). For other models, write your own analogue.
- `fmtR2` — NaN-safe formatter for R² display (returns '--' on NaN)
- `normInv` — inverse normal CDF for Q-Q plots

---

## 7. How to Build a New Module

A practical step-by-step:

1. **Copy the canonical file** as your starting point:
   ```bash
   cp modules/module_13_validation/notebooks/01_model_validation.html \
      modules/module_XX_yourtopic/notebooks/01_yourname.html
   ```

2. **Replace the cancer application context:**
   - Header subtitle (line ~135): "Validating … against Transwell Assay" → your system
   - All references to "invasion", "Matrigel", "Transwell" throughout the background sections
   - Worked examples should use your problem's numbers

3. **Replace the mathematical model:**
   - `invasionModel(t, N0, D, L, mu)` → your governing equation
   - Constants `TRUE_N0, TRUE_D, TRUE_L, TRUE_MU` → your true parameters
   - `fitModel`, `approxCovariance` → adapt to your parameter set
   - `getLinearized` → your linearization (or remove if not applicable)

4. **Define your scenarios:**
   - What's the "right" baseline? (Module 13: proper split + mechanistic fit + default noise)
   - What 2–4 distinct failure modes do you want to demonstrate?
   - Each gets a button on the scenario bar
   - Each needs entries in `applyScenario()`, `buildFitResult()`, and `generateVerdict()`

5. **Adapt the tab structure:**
   - Decide tab count (4–6) and the title of each
   - For each tab, decide what *lens* it provides — what does the student see here that they don't see on other tabs?
   - Use the same per-tab pattern: background → student task → scenario bar → panel

6. **Build the capstone tab:**
   - Choose pattern A (remedy) or B (integration)
   - For pattern A: each scenario gets a remedy button in the panel; remedies refit and display before/after
   - For pattern B: a new dataset/problem requiring multiple techniques

7. **Update verdict text:**
   - One diagnosis per scenario (what went wrong)
   - One prescription per scenario (what to do)
   - One metric template per tab (what number to highlight)

8. **Update student tasks:**
   - Each step should reference a specific button or control
   - Steps walk through scenarios in order: baseline → failure modes → reflection
   - Final step should be a synthesis prompt

9. **Test:**
   - Open in browser; click through every scenario × every tab
   - Resize window to phone width; check responsiveness
   - Run the structural integrity check (see § 8)
   - Have one student or colleague work through the module end-to-end

---

## 8. Quality Checklist

A module is ready to publish when **all** of these are true:

### Pedagogy
- [ ] Header subtitle names a specific cancer-biology system
- [ ] Background section of every tab grounds the concept in that system
- [ ] At least one worked example with concrete numbers per major concept
- [ ] Student task on every tab; steps reference specific scenarios and controls
- [ ] Scenarios isolate distinct failure modes (no near-duplicates)
- [ ] Verdicts include diagnosis + prescription
- [ ] Capstone tab synthesizes earlier tabs

### Technical
- [ ] All R² / metric computations are correct (linearized where applicable)
- [ ] All `getElementById` refs resolve to existing IDs (run `python3 -c '...'` integrity check)
- [ ] CSS, JS braces, parens, brackets balanced
- [ ] `<div>` and `<section>` tags balanced
- [ ] JS parses cleanly: `node -e "new Function(require('fs').readFileSync('file.html').toString().match(/<script>([\s\S]*?)<\/script>/)[1])"`

### Responsive
- [ ] Renders cleanly at 1200px, 900px, 640px, 380px viewport widths
- [ ] Window resize triggers redraw (not stale canvas)
- [ ] Equations don't overflow horizontally on phones
- [ ] Scenario bar wraps cleanly on narrow viewports

### Course-level
- [ ] CHANGELOG updated (`CodeLog/Updates/CHANGELOG.md`)
- [ ] If new methods or models are introduced, literature review entry in `Research/`
- [ ] Module index in `syllabus/syllabus.md` reflects this content

---

## 9. The Reference Implementation

When in doubt, look at:

**[modules/module_13_validation/notebooks/01_model_validation.html](module_13_validation/notebooks/01_model_validation.html)**

Specific landmarks:

| Pattern | Search for |
|---|---|
| Header + tab bar | `<header>` near top of `<body>` |
| Per-tab section structure | `<section id="tab-calibration"` |
| Background section | `<div class="background-section">` |
| Student task | `<div class="student-task">` |
| Scenario bar | `<div class="scenario-bar">` |
| Interactive panel | `<div class="panel">` |
| Flexbox reorder rules | search CSS for `tab-content.active` |
| Mobile media queries | search CSS for `@media (max-width: 640px)` |
| Scenario state | search JS for `let scenario` |
| Fit result object | search JS for `function buildFitResult` |
| Verdict generator | search JS for `function generateVerdict` |
| Tab dispatcher | search JS for `function refreshActiveTab` |
| Resize handler | search JS for `scheduleResponsiveRedraw` |

---

## 10. When This Template Doesn't Apply

Not every lesson is a multi-tab interactive notebook. Some modules might be better served by:
- **Pure lecture HTML** — for purely conceptual lessons (e.g., a history of mathematical modeling)
- **Computational lab notebooks** (`.ipynb`) — for code-heavy work students will execute themselves
- **Reading + assignment** (no interactive HTML) — for theory-only weeks

Use this template when **all** of the following hold:
- The lesson has 3+ distinct sub-concepts that benefit from comparison
- Interaction (sliders, toggles, button clicks) genuinely aids understanding
- A static figure or single plot wouldn't suffice
- The concept can be motivated by a concrete cancer-biology system

If two or more conditions don't hold, consider a simpler format and don't force the template.
