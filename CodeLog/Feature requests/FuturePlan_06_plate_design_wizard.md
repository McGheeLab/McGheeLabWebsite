# FuturePlan 06 — Nodal design definitions + live run instances

> **Status:** ✅ implemented as **V3.330** (working tree; FTP + review
> pending). Plan of record:
> [`CodeLog/ClaudesPlan/V3.330_nodal_design_and_notebook_runtime.md`](../ClaudesPlan/V3.330_nodal_design_and_notebook_runtime.md).
> Abstract by design — no domain specifics.

## The idea

Make the **variable the primitive** and let **attributes give it
behavior**, authored as a **node-based dataflow graph**. A protocol is a
reusable *definition*. When a user opens that definition inside a run,
it **comes alive**: input variables become live controls, a generated
**item list** recomputes, the user assigns items into a **grid of
slots**, and **aggregate totals** roll up from the assignment. Run state
persists per-run; the definition is never mutated; on completion the run
**freezes** into an immutable record.

## Model

- **Variable = node; attribute = node type / sockets; wire = dataflow.**
  Node types: `input` (slider/number, scalar), `constant`, `choices`
  (a set of options — a generator; downstream becomes per-item),
  `ordered` (values with a monotonic ordering constraint — a generator),
  `equation` (computed; scope **inferred** — per-item iff downstream of a
  generator), `list` (terminal → an item list with per-item columns +
  a declarative merge/dedupe rule).
- **The graph compiles to the existing runtime** — an ordered array of
  formula entries (for the symbol-table evaluator) + item-list specs.
  No new evaluator; the reader-facing widgets are reused.
- **Definition vs run instance.** The definition holds the logic (a
  `design` block on the protocol). The run instance holds one user's
  inputs + assignments + computed results (a field on the run record).

## What was built (V3.330)

1. **Shared widget module** — interactive widgets in a per-mount context,
   mounted by both the read-only definition view and the run.
2. **Headless graph engine** — model + `compile` (topo-sort, cycle
   detection, scope inference) + `assembleRows` (single source of truth
   for list assembly).
3. **`design` block kind** + a **vanilla node canvas editor** (pan/zoom,
   wires, cycle/scope validation, per-node inspectors, insert-wired-input
   helper).
4. **Live run** — load a definition into a run → live inputs → computed
   item list → interactive grid assignment → live aggregate totals →
   freeze-to-immutable-record on completion.

## Notes / deferred

- Storage: the graph is a single plain-JSON `{nodes,edges}` blob
  (single-author, coarse-grained, last-write-wins). Escape hatch to
  per-node CRDT typing deferred until concurrent multi-author editing is
  a real need.
- Fully-featured editor extras (node search, copy/paste, undo/redo,
  comment groups, reusable sub-graphs) are deferred polish.
- mathjs `evaluate` remains the only code-execution surface
  (admin-trust threat model); a complexity budget for it is still open.
- Live browser verification (doc-view regression, canvas drag/wire,
  run round-trip + freeze) is pending — Node harnesses + syntax done.
