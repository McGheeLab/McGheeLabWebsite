# FuturePlan 08 — Equipment Scheduler Upgrade

**Intent:** make `rm/pages/equipment.html` a trustworthy, pleasant way for
students to book time on shared lab instruments.

**Status:** Phase 1 shipped as V3.336; Phase 2 shipped as V3.339 (mobile
single-day calendar) + V3.340 (glance chips, duration quick-picks,
rebook). **Phase 3 shipped 2026-07-30 as a 5-release program** — V3.588
(criticality Soft/Firm/Hard over the existing `priority` enum), V3.594
(shift-change adjacency engine + co-operator notify + in-app notification
feed), V3.595 (morning-of / T-30 reminders + weekly manager digest),
V3.597 (notify-me watches, `equipmentWatches`), V3.598 (My Day watch
surface + home tile). Phase 3 went **beyond** the original sketch: the
notification engine is criticality-weighted so Soft bookings stay silent,
and 109 plain-node fixtures guard the decision matrices. Phases 4–5
(check-in / no-show tracking, server-side GCal sync) pending.

**Fixed decisions (2026-07-12):**
- Keep the displacement model (anyone can book over an occupied slot after
  the "I have permission" checkbox; displaced booking flips to
  `needs-rebooking`). Rules must permit exactly that cross-user mutation
  and nothing more.
- No recurring bookings in this upgrade cycle.

---

## Phase 1 — V3.336 "Trustworthy bookings" ✅ SHIPPED

Security hardening + availability enforcement. See
`CodeLog/ClaudesPlan/V3.336_equipment_security_availability.md`.

- firestore.rules: `equipmentBookings` rewritten from wide-open to one
  diff-constrained clause per client mutation (create-self, owner edit,
  owner cancel, owner re-confirm, displacement, manager approve/deny,
  gcal stamp). Sibling equipment collections read-tightened to
  `isLabMember() && collabMay(...)`.
- `availableHours`/`availableDays` now enforced in the booking flow
  (previously stored but decorative); admin/manager bypass for
  maintenance and supervised after-hours use.
- Weekday picker in the device admin modal (was hardcoded Mon–Fri).
- Closed slots greyed on the week grid + month view when a device filter
  is active; drag-to-book can't start in or extend into them.
- Booking modal shows the device's posted window live ("bookable
  Mon–Fri, 8 AM–6 PM") and flags violations before submit.
- `equipmentBookings (status, date)` composite index (needed by
  Sync All); shared TOAST adoption.

Deliberately NOT rule-enforced (client remains the policy layer):
duration vs maxDurationMin, availability windows, overlap detection —
rules guarantee identity, status-machine integrity, and field isolation.

## Phase 2 — V3.339–.340 "Student booking UX" ✅ SHIPPED

The page should be fast and pleasant on a phone in front of the
instrument.

- Mobile calendar rewrite: canonical breakpoint (drop the non-canonical
  768px), single-day view on narrow screens, larger touch targets.
- ~~Adopt `McgheeLab.ScheduleUtils`~~ — dropped: the module is not
  loaded by equipment.html, its `getWeekDays` returns label objects
  (not Dates), and its `getMonday` jumps to next week's Monday on
  Sundays; the local Sunday-safe helpers stay (see V3.339 plan).
- Equipment cards get live "free until HH:MM / next free slot" chips —
  availability at a glance without opening the calendar.
- Quick-book: tap a free slot → prefilled modal with duration chips
  honoring the device's min/max.
- My Bookings quick-rebook button (V3.340).

## Phase 3 — "Notifications + waitlist" (next)

Nobody misses a booking event; freed slots get refilled.

- Upcoming-booking reminders: `onSchedule` Cloud Function every 15 min
  (morning-of + T-30min), FCM via `functions/helpers/notify.js
  sendToUsers`, deduped with `reminded` flags stamped by the admin SDK
  (bypasses rules — no new client carve-out needed).
- Co-operator notified when named on a booking (extend
  `functions/equipment.js` triggers).
- Waitlist: new `equipmentWaitlist` collection ("notify me if a slot
  opens on {device} on {date} between X–Y"); `onDocumentUpdated` pings
  matching waitlisters when a booking flips to cancelled /
  needs-rebooking. Join-waitlist affordance in the conflict warning and
  My Bookings. Needs its own rules block + `equipmentId+date` index.
- Weekly manager digest (pending approvals + utilization preview).

## Phase 4 — "Usage & accountability"

Know whether booked time is actually used.

- Check-in / check-out buttons (booking detail, My Bookings, dashboard
  card) writing `checkedInAt` / `checkedOutAt` / `actualDurationMin` —
  additive rules clause: owner or co-operator, `hasOnly` those fields.
- No-show scheduled function: grace period configured in
  `equipmentSettings`; stamps `noShow:true`, notifies owner + manager.
- Admin Stats sub-tab: per-device booked vs used hours, no-show
  tracking, peak-hours strip.
- On check-out, write an activity-tracker entry (self-writes already
  allowed at firestore.rules `trackerEntries`).

## Phase 5 (optional) — "Server-side GCal sync"

Move the Google Calendar push into a Cloud Function (stored-credential
pattern like `functions/oauth.js`). Kills the sessionStorage token
re-auth dance, the hardcoded `America/Phoenix` timezone (moves to
`equipmentSettings`), and lets the gcal-stamp rules carve-out be
deleted (admin SDK bypasses rules).

---

**Why security-first:** every later phase adds narrow rule carve-outs on
top of the Phase 1 skeleton; availability-at-a-glance UX requires
availability data to be real and admin-editable first; and Phase 1
already gives students a visible win (greyed closed hours + posted
window messaging in the modal).
