#!/usr/bin/env bash
# ============================================================================
# V3.646 full test suite — one command.
#
#   bash scripts/tests/run-all.sh
#
# Layers, cheapest first, because a failure in an early layer explains failures
# in every later one:
#
#   1. node fixtures      pure logic, no emulator, no browser  (~1s)
#   2. cross-repo parity  RM's label-id port vs LabelPrinter's ids.js
#   3. LabelPrinter       its own six checks, incl. the QR decode round-trip
#   4. rules              real firestore.rules on the emulator (49 + 136 cases)
#   5. E2E journeys       real modules + real rules + real signed-in users
#   6. browser journeys   the actual DOM a person's fingers touch
#
# Layers 4-5 need a JDK 21+ (firebase-tools 15 rejects older). This machine's
# system JDK is 8, so set JAVA_HOME to something newer, e.g.
#   JAVA_HOME=/path/to/jdk-21 bash scripts/tests/run-all.sh
# Layer 6 needs a local http server, which this script starts and stops itself.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
ROOT="$PWD"
FAILED=()
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }
record() { [ "$1" -eq 0 ] || FAILED+=("$2"); }

step "1. node fixtures (pure logic)"
for t in functions/test/*.test.js; do
  out=$(node "$t" 2>&1); rc=$?
  printf '   %-44s %s\n' "$(basename "$t")" "$(echo "$out" | grep -oE '[0-9]+ passed, [0-9]+ failed' | tail -1)"
  record $rc "$(basename "$t")"
done

# V3.681 — pure logic, so it belongs in layer 1: who gets notified when a
# BME466 assignment is published (and the fail-open rule for a student with no
# section on file). Mirrors bme466Section() in class-builder.js.
out=$(node scripts/tests/bme466-audience.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "bme466-audience.test.mjs" "$(echo "$out" | grep -E 'checks ·' | tail -1)"
echo "$out" | grep -E "^ FAIL " | sed 's/^/   /'
record $rc "bme466-audience"

# V3.906 / V3.909 — the paper builder's export and journal-look contracts:
# prose → LaTeX escaping, and the rules the PDF and the Document view share
# (TeX hyphenation, Knuth–Plass, class vs spec looks, column capacity).
for t in paper-tex-escape paper-typeset paper-grant-rules paper-prose-tex; do
  out=$(node scripts/tests/$t.test.mjs 2>&1); rc=$?
  printf '   %-44s %s\n' "$t.test.mjs" "$(echo "$out" | tail -1)"
  record $rc "$t"
done

# V3.710 — the advice register. Pure string checks over the module SOURCE, so it
# belongs in layer 1. It guards the other register: not "is this consistent and
# numerically right" (everything else does that) but "would a reader who acted on
# this sentence be worse off". Seeded from the audit that followed Alex catching
# "stop and autoclave the batch" in Cell Culture Lesson 4.
out=$(node scripts/tests/module-advice.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "module-advice.test.mjs" "$(echo "$out" | grep -E 'advice register:' | tail -1)"
echo "$out" | grep -E "^ FAIL " | sed 's/^/   /'
record $rc "module-advice"

# V3.716 — Learning Modules placements. Pure logic over class-builder.js source,
# so layer 1. Guards the bug that a second "Learning Modules" section rendered a
# COPY of the first (renderSectionBody called renderModulesBody without passing
# `section`), plus the routing half: two placements of the same filename must
# open their own folder. Also pins the two invariants that protect data —
# nothing is lost when a section is deleted, and teacher-classes stay untouched.
out=$(node scripts/tests/module-placements.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "module-placements.test.mjs" "$(echo "$out" | grep -E 'module placements:' | tail -1)"
echo "$out" | grep -E "^ FAIL " | sed 's/^/   /'
record $rc "module-placements"

# V3.884 — the one recorder's shared timeline (rm/js/recorder-core.js): marks and
# sections, wall ↔ audio around gaps, the line being spoken, the ink drawn at a
# moment, and the speech-to-text cost estimate a person sees before paying.
out=$(node scripts/tests/recorder-core.test.cjs 2>&1); rc=$?
printf '   %-44s %s\n' "recorder-core.test.cjs" "$(echo "$out" | grep -E 'recorder-core:' | tail -1)"
echo "$out" | grep -E "^✗ " | sed 's/^/   /'
record $rc "recorder-core"

# V3.717 — the research map's card graph (specialty → concept → grant → aim →
# output). Pure logic over research-data.js, so layer 1. Attribution is DERIVED
# (a focusArea points at a card; the walk up `links` finds its grant), which
# means a wrong walk puts work under the wrong grant and NOTHING throws — these
# are the only thing standing between that and a silently wrong grant review.
out=$(node scripts/tests/research-graph.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "research-graph.test.mjs" "$(echo "$out" | grep -E 'passed,' | tail -1)"
echo "$out" | grep -E "^  FAIL " | sed 's/^/  /'
record $rc "research-graph"

# V3.742 — paper bundle round trip. The papers list can check a draft out as a
# .paperbundle.zip and import it BACK INTO THE SAME PAPER by replacing the tree,
# so anything the exporter writes that the builder ignores is deleted on every
# cycle. serialize → buildInto → serialize must be a byte-identical fixed point.
out=$(node scripts/tests/paper-bundle-roundtrip.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "paper-bundle-roundtrip.test.mjs" "$(echo "$out" | grep -E 'passed,' | tail -1)"
echo "$out" | grep -E "^  FAIL " | sed 's/^/  /'
record $rc "paper-bundle-roundtrip"

# V3.717 — the focus pickers over that graph: Team Focus's grants-only semester
# dropdown and My Week's grant → aim/output cascade. Caught the analysis rows
# being built without their card's `links`, which dropped every analysis out of
# its grant's optgroup while the card itself sat in the right one.
out=$(node scripts/tests/research-pickers.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "research-pickers.test.mjs" "$(echo "$out" | grep -E 'passed,' | tail -1)"
echo "$out" | grep -E "^  FAIL " | sed 's/^/  /'
record $rc "research-pickers"

# V3.768 — My Week's "Assigned to you" inbox. Pure logic over my-week.js's own
# source (the functions are lifted out and run, so the test can't drift from the
# page). Guards the bug where a chore board filled a semester ahead put eight
# weeks of chores at the top of everybody's My Week at once — and the other half
# of it, that meeting action items must never be week-filtered away.
out=$(node scripts/tests/myweek-inbox.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "myweek-inbox.test.mjs" "$(echo "$out" | grep -E 'passed,' | tail -1)"
echo "$out" | grep -E "^  FAIL " | sed 's/^/  /'
record $rc "myweek-inbox"

# V3.813 — Procurement v2 state machine. Pure logic over the SAME bytes the
# page ships (rm/js/procurement-core.js): who may do what at each stage, the
# patch each action writes, inbox per role, report math, CSV, restock plan.
out=$(node scripts/tests/procurement-core.test.mjs 2>&1); rc=$?
printf '   %-44s %s\n' "procurement-core.test.mjs" "$(echo "$out" | grep -E 'procurement-core:' | tail -1)"
echo "$out" | grep -E "^  FAIL " | sed 's/^/   /'
record $rc "procurement-core"

step "2. cross-repo label-code parity"
out=$(node scripts/tests/label-id-parity.test.mjs 2>&1); rc=$?
note "$(echo "$out" | tail -1)"
record $rc "label-id-parity"

step "3. LabelPrinter (sibling repo)"
LP="$ROOT/../LabelPrinter"
if [ -d "$LP" ]; then
  for t in check_qr check_reagent check_ids check_exports check_caltarget check_pipeline; do
    (cd "$LP" && node "tests/$t.mjs" >/dev/null 2>&1); rc=$?
    [ $rc -eq 0 ] && printf '   ok   %s\n' "$t" || printf '   FAIL %s\n' "$t"
    record $rc "LabelPrinter/$t"
  done
  note "check_qr includes the decode round-trip that caught the transposed placeFormat()."
else
  note "SKIP — no LabelPrinter checkout beside this repo"
fi

# ── emulator layers ────────────────────────────────────────────────────────
JV=0
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JV=$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')
elif command -v java >/dev/null 2>&1; then
  JV=$(java -version 2>&1 | head -1 | grep -oE '"([0-9]+)' | tr -d '"')
fi
if [ "${JV:-0}" -ge 21 ] 2>/dev/null; then
  step "4. firestore.rules on the emulator"
  out=$(cd scripts/tests && firebase emulators:exec --only firestore \
        --project demo-mcgheelab-inv "node inventory-rules.test.mjs" 2>&1); rc=$?
  note "$(echo "$out" | grep -E 'ok, .*HOLE' | tail -1)"
  echo "$out" | grep -E "  (HOLE|BREAK) " | sed 's/^/   /'
  record $rc "inventory-rules"

  out=$(cd scripts/tests && firebase emulators:exec --only firestore \
        --project demo-mcgheelab-hwp "node hw-progress-rules.test.mjs" 2>&1); rc=$?
  note "$(echo "$out" | grep -E 'checks ·' | tail -1)"
  echo "$out" | grep -E "  (HOLE|BREAK) " | sed 's/^/   /'
  record $rc "hw-progress-rules"

  # V3.685 — board families. The load-bearing case is that a homework board
  # stays unreadable by a classmate even when sharedWithUids names them.
  out=$(cd scripts/tests && firebase emulators:exec --only firestore \
        --project demo-mcgheelab-wb "node whiteboard-rules.test.mjs" 2>&1); rc=$?
  note "$(echo "$out" | grep -E 'Whiteboard rules —' | tail -1)"
  echo "$out" | grep -E "  (HOLE|BREAK) " | sed 's/^/   /'
  record $rc "whiteboard-rules"

  # V3.741 — paper checkout lock. The load-bearing cases: while a paper is
  # checked out only the HOLDER appends yjs_updates (admins included are denied),
  # and a coauthor may write nothing on the projects row but the five lock /
  # activity fields.
  out=$(cd scripts/tests && firebase emulators:exec --only firestore \
        --project demo-mcgheelab-paper "node paper-checkout-rules.test.mjs" 2>&1); rc=$?
  note "$(echo "$out" | grep -E '[0-9]+ ok, ' | tail -1)"
  echo "$out" | grep -E "  (HOLE|BREAK) " | sed 's/^/   /'
  record $rc "paper-checkout-rules"

  # V3.743 — Lab Meetings remodel. The load-bearing cases: a GUEST can no
  # longer read or rewrite meetings (the old block was `request.auth != null`);
  # `presenters` and chore `completions` are maps keyed by uid so a member may
  # touch only their OWN key; a coordinator can run the schedule but cannot
  # appoint coordinators; and isMeetingCoordinator() with no config doc denies
  # instead of raising (which would have locked admins out too).
  out=$(cd scripts/tests && firebase emulators:exec --only firestore \
        --project demo-mcgheelab-mtg "node meetings-rules.test.mjs" 2>&1); rc=$?
  note "$(echo "$out" | grep -E 'Meetings rules —' | tail -1)"
  echo "$out" | grep -E "  (HOLE|BREAK) " | sed 's/^/   /'
  record $rc "meetings-rules"

  # V3.813 — Procurement v2 transition table. The load-bearing cases: a
  # requester cannot approve their own ticket (V3.44 let them), an approver
  # cannot order without the order cap, nobody skips approval, identity fields
  # are frozen, and a note from anyone never opens the status.
  out=$(cd scripts/tests && firebase emulators:exec --only firestore \
        --project demo-mcgheelab-proc "node procurement-rules.test.mjs" 2>&1); rc=$?
  note "$(echo "$out" | grep -E 'Procurement rules —' | tail -1)"
  echo "$out" | grep -E "  (HOLE|BREAK) " | sed 's/^/   /'
  record $rc "procurement-rules"

  step "5. end-to-end user journeys (real modules, real rules, real users)"
  out=$(cd scripts/tests && firebase emulators:exec --only firestore,auth \
        --project demo-mcgheelab-e2e "node inventory-e2e.test.mjs" 2>&1); rc=$?
  echo "$out" | grep -E "^── " | sed 's/^/   /'
  note "$(echo "$out" | grep -E 'E2E journeys:' | tail -1)"
  echo "$out" | grep -E "^  FAIL " | sed 's/^/   /'
  record $rc "inventory-e2e"

  # V3.813 — the procurement core driving the real rules as real users through
  # the whole loop (question, re-approval, one PO for two tickets, restock of a
  # tracked item by a member AND a manager, legacy V3.44 ticket).
  out=$(cd scripts/tests && AUTH_EMU_PORT=9299 firebase emulators:exec --config firebase.proc.json --only firestore,auth \
        --project demo-mcgheelab-proc-e2e "node procurement-e2e.test.mjs" 2>&1); rc=$?
  echo "$out" | grep -E "^── " | sed 's/^/   /'
  note "$(echo "$out" | grep -E 'E2E journeys:' | tail -1)"
  echo "$out" | grep -E "^  FAIL " | sed 's/^/   /'
  record $rc "procurement-e2e"
else
  step "4-5. emulator layers"
  note "SKIP — need a JDK 21+ (found ${JV:-none}). Set JAVA_HOME and re-run."
fi

# ── browser layer ──────────────────────────────────────────────────────────
step "6. browser journeys (the DOM a person touches)"
BROWSER="$HOME/.claude/skills/browser-automation/browser.mjs"
if [ -f "$BROWSER" ]; then
  python3 -m http.server 8777 >/dev/null 2>&1 &
  SRV=$!
  sleep 2
  # v3743-meetings-selftest drives the real Lab Meetings modules against an
  # in-page Firestore stub: derived agenda times, debounced minutes writes,
  # action item → My Week task hand-off, chore fill, swap accept, seed math.
  for page in v3646-selftest v3646-ui-journey v3647-selftest v3647-caret v3649-selftest v3724-selftest v3743-meetings-selftest v3813-procurement-selftest; do
    res=$(node "$BROWSER" "http://localhost:8777/scripts/tests/$page.html" \
          --wait "#r[data-done='1']" \
          --eval "(()=>{const e=document.getElementById('r');return e.dataset.pass+' passed, '+e.dataset.fail+' failed'+(e.dataset.detail?' | '+e.dataset.detail:'');})()" 2>&1)
    line=$(echo "$res" | grep -E '^eval' | sed 's/^eval *//')
    errs=$(echo "$res" | grep -E 'console errors/warnings \([1-9]' || true)
    printf '   %-22s %s\n' "$page" "$line"
    [ -n "$errs" ] && { printf '   %s\n' "$errs"; FAILED+=("$page console errors"); }
    echo "$line" | grep -qE '"?0 failed|, 0 failed' || FAILED+=("$page")
  done
  kill $SRV 2>/dev/null
  wait $SRV 2>/dev/null
else
  note "SKIP — browser-automation skill not found at $BROWSER"
fi

# ── verdict ────────────────────────────────────────────────────────────────
printf '\n%s\n' "$(printf '=%.0s' {1..70})"
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mALL LAYERS GREEN\033[0m\n'
  exit 0
fi
printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
exit 1
