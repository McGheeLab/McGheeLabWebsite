# RM page usage analysis — 2026-10-21

**Question:** which RM pages are lab members actually using, which are not, and where is the data blind?
**Scope:** `mcgheelab.com/rm/` only (the lab dashboard). Public-site class modules and the teacher program are out of scope.
**Data pulled:** 2026-10-21 17:40 UTC, read-only, with the admin SDK (`CodeLog/Analysis/rm_usage_pull.js`).
**Follow-up this feeds:** for each weak page, decide *why* it is weak and whether to keep, fold, or retire it.

---

## 1. Headline findings

1. **RM has 7 real users, not 14.** 14 non-guest accounts exist; 4 are alumni who never sign in, and 3 current members
   (Hunain, Melayna, Madison) are near-zero. Everything below is about Alex, Cason, Gabriel, Alia, Allison, Cristobal and Zeke.
2. **The daily loop is small and clear:** Workflow shell → My Week → Tasks → Chat, plus Team Focus for the three mentors
   and Equipment for the four confocal users. The shell, My Week, Tasks and Team Focus alone are two-thirds of all measured
   page-time (76% counting the `admin-work` bucket); Chat and Equipment are the two largest features page-time cannot see.
3. **Chat is the most-used feature in RM and is nearly invisible to the tracker.** ~1,700 live messages since April,
   ~700/month since September, 9 authors, 148 files shared. 96% of September–October messages are DMs; `#general` had 47 posts.
4. **Half the nav is dormant.** Of 48 nav pages, **18 had no detectable activity of any kind in the last 90 days** (no
   page-time, no content write, no notification, no function call): Explorer, Grants, Biosketches, Facilities Doc, Teaching,
   Service, Chemical Safety, Inventory, Lab Members, Career, Pcard Helper, Receipts, Grant Accounts, Budget, Analytics,
   Travel, Classifier Settings, Split. Five more had one or two visits (Compliance, What's New, Projects, Outputs, Guests).
   Most are PI-only admin/finance pages whose data was written once, on 2026-04-30, and never again.
5. **Several workflows are "open loops" — people start them and nobody closes them:**
   tasks done 18 / 217 (8%), focus areas confirmed 4 / 33, huddle plans completed 56 / 369, PMRs submitted 1 / 9,
   procurement tickets approved 0 / 10 (all still `requested`), lab-meeting chores completed 10 across 15 weeks,
   notifications read 86 / 335 (26%). Training was completed by exactly one person (Cason, Jul–Aug) and no one since Sep 4.
6. **Nobody is on the phone app.** All 41 presence surfaces in the live snapshot are `client: web`; 0 are `app`. Every batch
   release still cuts a TestFlight build for it.
7. **The instrument is half-blind, which limits this analysis.** `labConfig/pageTracking` (set 2026-05-20) marks 17 pages
   `never` and collapses 14 more into one `admin-work` bucket; the tracker hard-skips `activity-overview` (which hosts the
   Tracker, Email, Year and Member Activity tabs); `?tab=` surfaces are indistinguishable. Fixing this is step zero before
   the "why" pass (see §6).

---

## 2. What was measured, and what could not be

| Signal | Source | Covers | Blind spots |
|---|---|---|---|
| **Page-time** | `trackerEntries/{uid}/entries/auto-pagetime-<slug>-<date>` written by `rm/js/page-time-tracker.js` on every RM page. One doc per user × page × day; `logged_windows` = 10-minute windows with ≥1 interaction. Data from 2026-05-15. 1,942 docs. | Pages whose mode is `tracked` (default). | `never` mode: dashboard, chat, huddle, projects, grant-builder, grant-biosketch, grant-facilities, teaching, service, chemicals, explorer, sharing, settings, profile, split-view, admin-permissions, api-usage. `admin` mode (all users' activity collapses into `admin-work`): finance, cv-editor, analytics, budget, projects-grants, receipts, pcard-helper, procurement, career, people, inventory, meetings, scheduler, equipment. Hard-skip: `activity-overview`. Tabs invisible. Guests not tracked. Stray hits on `never` pages (chat 16 windows, dashboard 41) are a known race on first load, not usage. |
| **Content writes** | Doc counts, authors and timestamps in `chatMessages`, `huddlePlans`, `equipmentBookings`, `procurementTickets`, `meetings`/`meetingTopics`/`labChores`, `schedules`, `taskMarket`, `protocols`, `papers`, `researchFoci`, `items`, `inventory`, `cvData`, `grantDrafts`, and per-user `tasks`, `notebook`, `dayPlans`, `focusAreas`, `pmr`, `customWorkflows`, `notifications`. | The `never`/`admin` pages, via what people created there. | Read-only visits leave no trace. |
| **Notifications** | `userData/{uid}/notifications` (335 docs since Aug). | Which features generate interrupts, and the read rate. | Only equipment, meetings, figure-board, releases, engage, procurement emit them. |
| **Cloud Functions** | Cloud Run request logs, last 30 days. | Server-side feature firing (chat, huddle, equipment, figure board, paper sync, library lookups). | Scheduled scrapers dominate the counts and say nothing about people. |
| **Presence snapshot** | `userPresence/{uid}` (29 docs, 41 surfaces). | Each user's most recent session: page + client (web/app). | A snapshot, not a history. |

**Units used below.** *Users 90d* = distinct lab members with ≥1 active window on the page between 2026-07-23 and 2026-10-21.
*User-days 30d* = sum over users of days with activity, 2026-09-21 to 2026-10-21 (max ≈ 7 users × 31 days ≈ 217).

---

## 3. Who is active

Weekly distinct active users (page-time) have been flat at **7–10** since the semester started (2026-09-03), with
32–42 user-days per week. Guests appear in those counts only on the Home page (Emma, Will, Claire, Sandor: 1–3 days each).

| Person | Role | Active days, last 90d | Top pages (active days) | Note |
|---|---|---|---|---|
| Alex | admin / PI | 80 | tasks 75, team-focus 74, my-week 55, shell 41, library 27, paper-builder 26, reader 25 | ~30% of all page-time is Alex |
| Gabriel | grad (editor) | 83 | team-focus 67, tasks 65, my-week 52, admin-work 42 | 565 chat msgs, 115 huddle plans, 41 bookings, 208 notebook entries |
| Cason | grad (editor) | 75 | team-focus 67, shell 65, tasks 56, my-week 48, paper-builder 25, pmr 18 | 508 chat msgs, 214 huddle plans, only person who did trainings, 695 manual tracker entries (stopped Aug 1) |
| Alia | grad (editor) | 38 | shell 38, my-week 33, admin-work 26, pmr 6 | Started Aug 29; 102 chat msgs, 16 bookings, 30 plans in Sep then 0 in Oct |
| Allison | undergrad | 36 | shell 21, my-week 20, tasks 19, library 13, reader 11 | 124 chat msgs, 50 plans, reads papers |
| Cristobal | undergrad | 27 | admin-work 27 (equipment), tasks 21, reader 6 | 28 confocal bookings, 3 chat msgs |
| Zeke | undergrad | 20 | lab-notebook 12, protocols 8, pmr 4 | Only consistent notebook/protocols user; 3 active days in Oct |
| Madison | undergrad | 12 | my-week 6 | Light |
| Hunain | postdoc (joined Sep 8) | 3 | — | Last seen Sep 21. Equipment sign-off Sep 15. **Onboarding did not take.** |
| Melayna | undergrad | 2 | chat, lab-overview | 7 chat msgs in Oct |
| Suraj, Ethan, Elija, Alex M. | alumni | 0–1 | — | Expected |

---

## 4. Page-by-page verdict

Tiers: **Core** (most active members, most weeks) · **Working** (a real subset uses it regularly) · **Niche** (1–2 people, or
one burst) · **Dormant** (no lab-member activity in 90 days) · **PI-only** (Alex is the only user) · **Unmeasured**.

### Activity

| Page | Tracking | Evidence | Verdict |
|---|---|---|---|
| Home (`/rm/`) | never | Presence shows it as a landing hop; guests' only page. | Unmeasured; keep (it is the door) |
| Workflow shell | tracked | 10 users 90d, 227 user-days 90d, 106 in 30d. 8 custom workflows made by 7 people (Cason 2, Alex 2, Gabriel, Allison, Alia, Cristobal). | **Core** — the real entry point; people do customise it |
| My Week (+ old `my-day`) | tracked | 9 users 90d; 104 user-days 30d. 294 day plans: Aug 112, Sep 128, Oct 50 (to the 21st). Fan-out used: tracker 272, huddle 242, notebook 242, task 15, equipment 4. 101 done / 155 planned / 35 skipped. | **Core**. Watch: **Cason made 0 plans in Oct after 56 in Sep** while his huddle plans continued (46) — ask him why |
| Team Focus | tracked | 4 users (Alex, Gabriel, Cason, Alia — the mentors); 74 user-days 30d. 33 focus areas, 28 still `proposed`, 4 confirmed, 6 carry tasks. | **Core for mentors**, but the sign-off step is not used |
| Activity Overview + Tracker / Email / Year / Member Activity tabs | hard-skipped | No page data possible. Proxies: manual tracker entries Cason 695 (Mar 31–Aug 1), Alex 35, Gabriel 1; `trackerData` opened by 8 people, last touch Sep 1; email archive + year review exist only for Alex. | **PI-only now**; Cason abandoned the tracker Aug 1 (the same week My Week started feeding it automatically) |
| PMR | tracked | 7 users 90d, but 10 user-days 30d (5 people). 9 PMR docs; fall drafts for Alia, Cason, Allison; 1 submitted ever (Cason, spring). | **Working but fading**; the submit/meeting loop is not closing |
| Calendar | tracked | 5 users all-time, 1 user-day 30d. `calendarEvents` only for 2 users. | **Dormant** |
| Tasks | tracked | 10 users 90d, 90 user-days 30d. Content: 217 non-email tasks, 115 are auto-created lab chores (Sep), **18 done**; 107 assigned by someone else. Alex's 1,844 tasks are mostly email-derived (1,758). | **Core by traffic, broken by outcome** — people look at tasks and do not close them in RM |
| Task Market (tasks?tab=market) | tab | 17 posts, last 2026-08-14; 7 accepted. All by Alex / Cason / Gabriel. | **Dormant since mid-Aug** |
| Explorer | never | No signal at all. | **Dormant** (likely) |

### Research

| Page | Tracking | Evidence | Verdict |
|---|---|---|---|
| Research Foci | tracked | 3 users 90d, **0 user-days 30d**. 21 foci docs, all authored by Alex, last edit Sep. | **PI-only, dormant** |
| Outputs | tracked | Alex, 2 days in July. | **Dormant** |
| Projects | never | Pre-May data: 2 users, 8 days. `items` project rows all created in the April seed; `projects` last touched Sep. | **Dormant** |
| Library (+Comments, Topics tabs) | tracked | 7 users 90d; 18 user-days 30d (4 people). 239 papers: 144 added in a July bulk import, 44 Aug, 37 Sep. Semantic Scholar lookups 68 in 30d. | **Working**; Alex-heavy, students light |
| Paper reader (`library-paper`) | tracked | 7 users 90d; 20 user-days 30d (4 people). `rm-library` reading events: Alex 12, Allison 5, Cason 2, Cristobal 2. Figure-board writes 363 in 30d. | **Working** |
| Library mobile pages | tracked | 3 users, 13 days; 2 user-days 30d. | **Niche** |
| Lab Notebook | tracked | 7 users 90d; 9 user-days 30d (5 people). 476 entries, but 242 are My Week stubs; direct authors are Gabriel (208) and Cason (139). Zeke is the only one who goes to the page itself. | **Working for 2–3 people**, mostly as a by-product of My Week |
| Protocols | tracked | 4 users 90d; 4 user-days 30d (2 people). 11 docs: 5 are "Node lesson" training copies, all 11 are `draft`, 2 are duplicates. Zero published protocols. | **Niche, not adopted** |
| Papers (paper-builder) | tracked | 7 users 90d; 23 user-days 30d (5 people). 7 papers; editor events Alex 22, Cason 9, Gabriel 3. 27 `deleteBuilderPaper` calls in 30d. | **Working** — Alex + Cason write, others visit |
| Grants (grant-builder) | never | 1 grant draft (2026-05-15). Grants were folded into the paper editor (CAREER lives in `papers`). | **Dormant / superseded** |
| Biosketches, Facilities Doc | never | No signal; `cvData` has 2 docs (Alex Jul 13, Cason Jul 26). | **Dormant** |
| Teaching | never | No signal; course rows are the April seed. | **Dormant / PI-only** |
| Service | never | 1 conference + 1 committee row from April. | **Dormant** |

### Operations

| Page | Tracking | Evidence | Verdict |
|---|---|---|---|
| Training landing + 19 `training-*` pages | tracked | 4 users all-time; **0 user-days 30d**. Essentially Cason, Jul 12–Sep 4 (16 of 19 landing-page days). `equipmentTraining`: 7 seeded Apr 11 + Hunain Sep 15. | **Niche** — one person completed it; new members are not routed through it |
| Chat | never | 1,719 live messages (Apr 95, Jul 82, Aug 303, Sep 729, Oct 509 by the 21st); 9 authors; 148 files; 5 thread replies; `onChatMessageCreate` 672 in 30d. Top channels since Sep are all DMs; `#general` 47. Voice-call functions: 0 calls in 30d. | **Core — the most-used feature in RM**. Threads and voice are unused |
| Huddle | never | 369 plans (Jul 45, Aug 122, Sep 119, Oct 78). Cason 214, Gabriel 115, Alex 21, Alia 16, Cristobal 3. 292 `planned` / 56 `completed` / 21 `skipped`; 9 plans ever had a joiner; 1 attached a protocol. `huddleSeen` 5 people. | **Core for 2 people, derived view for the rest** (242 plans came from My Week) |
| Meetings | admin | 20 meetings, all created by Alex (fall seed). Students: 8 topic suggestions (Cason 5, Sep 11), 10 chore completions in 15 weeks. 77 meeting notifications. | **PI-run**; student participation minimal |
| Scheduler | admin | 13 schedules: 6 Alex (courses, lab meeting, lab modules, 2 testers), 5 external teachers. | **Alex's teaching tool + teacher program**; not a lab-member page |
| Equipment | admin | 120 bookings (Aug 13, Sep 50, Oct 40). Gabriel 41, Cason 28, Cristobal 28, Alia 16, Hunain 1. 117 / 120 are the AX-R confocal. 228 reminder notifications. | **Core for the 4 confocal users** |

### Lab Admin

| Page | Tracking | Evidence | Verdict |
|---|---|---|---|
| Compliance | tracked | 1 visit (Alex, Aug 12). | **Dormant** |
| Chemical Safety | never | Inventory last written 2026-04-30. | **Dormant** |
| Inventory | admin | 775 rows, none written since the 2026-04-30 seed. 30 low-stock digests fired in 30d to no visible effect. | **Dormant** |
| Lab Members / Important People | admin | `people` 1 doc, `importantPeople` 4, last Apr 30. | **Dormant** |
| Career & Tenure | admin | 1 doc (Alex), written 2026-04-30. | **PI-only, dormant** |
| Procurement | admin | 10 tickets (Cason 7, Alia 3; Jul–Sep). **All 10 still `requested`** — none approved, ordered or received. Rewritten V3.813/814 (Oct). | **Low, and the approval loop never closed** before the rewrite |
| Pcard Helper, Receipts & Budget, Grant Accounts, Budget, Analytics, Travel | admin | Alex-only data: 32 receipts, 11 trips, 4 finance projects, `funding` 2 docs — every one written 2026-04-30 and never since. | **PI-only, dormant since the seed** |

### Settings

| Page | Tracking | Evidence | Verdict |
|---|---|---|---|
| Profile, Settings | never | `userSettings` for 4 people (notification / calendar / figure-board prefs). | **Light, unmeasured** |
| What's New | tracked | **1 visit ever (Alex, Aug 10).** 10 release notifications sent. | **Nobody reads release notes in RM** |
| CV Editor / CV Overview | admin | 2 CVs, last edits in July. | **Niche, dormant** |
| Classifier Settings | tracked | Alex, 2 days (Jun 27, Jul 20). | **PI-only, dormant** |
| API Usage, Permissions, Default Workflows, Guests | never / admin-only | Permissions 1 visit (May 20); Guests 1 day (Aug 13); Default Workflows is new (V3.811). | Admin tools; fine as-is |
| Teachers (admin-teachers) | tracked | Alex, 15 days 90d, 11 in 30d. | **Actively used by Alex** |
| Split | never | 1 visit (May 19). | **Dormant** |

### Pages on disk that are not in the nav (33 live + 16 redirect stubs)

- **Lab Overview Stats** (`lab-overview`, linked from Home): 6 users, 11 days all-time, 3 user-days 30d. Light.
- **paper-export**: Alex, 8 days. **admin-migrate**: three students landed on it once each in late Aug (worth knowing how).
- **Orphans with no inbound link**: `lab-tasks`, `grants`, `admin-tracker-migrate`, `citation-audit`, `icon-audit`, `layout-audit`
  (the last three are dev audits). `app-shell` is the phone shell; `library-public` is the share-link page.
- 16 redirect stubs (`my-day`, `task-market`, `sharing`, `funding`, …) are harmless but count toward the 97-file sprawl.

---

## 5. Patterns in the data (first-pass hypotheses for the "why" session)

These are hypotheses the numbers suggest, not conclusions. Each needs a conversation with the people named.

1. **Pages built for the PI's own workflow are single-user by construction.** Email, Year, Member Activity, finance ×6,
   People, Career, Inventory, Chemicals, Compliance, Research Foci, Outputs, Projects, Teaching, Service, Classifier,
   Scheduler. That is ~20 nav entries that students see and never need. They may be making the nav feel bigger than the lab.
2. **My Week absorbed the Tracker, Huddle and Notebook.** Fan-out writes 242 huddle plans and 242 notebook stubs; the manual
   tracker died the week My Week launched (Cason's last manual entry: Aug 1). Those three pages are now largely *views of My
   Week data*. Question: do they still need to be top-level destinations, or should they be tabs/views inside My Week?
3. **Status is recorded where the work is, not in RM.** Tasks 8% done, huddles 15% completed, focus 12% confirmed, PMR 1
   submitted, procurement 0 approved, chores 10/15 weeks. People plan in RM and close out in conversation (chat is ~700
   msgs/month). Either the closing step has to become one tap inside the surface they already use (chat/My Week), or we
   stop pretending RM holds completion state.
4. **Mentors use Team Focus heavily; mentees don't confirm.** 74 mentor user-days in 30 days versus 4 confirmations ever.
   The mentee half of the loop may live in My Week and never reach the `confirmed` state, or the confirm control isn't findable.
5. **Chat is 96% DMs.** Channels (`#general` 47, `#tfm-data`, `#shopping-list`, `#announcements`) are nearly idle. The lab is
   using RM chat as a messenger, not a Slack. Threads (5 replies) and voice (0 calls) are not used at all.
6. **Training only happened for one person, during summer.** No new member since Sep has touched a training page; Hunain
   got the equipment sign-off and then stopped using RM. There is no onboarding path that lands a new member on training.
7. **Protocols never crossed from "tool" to "habit."** 11 drafts, 0 published, 5 are lesson copies. Zeke is the only
   student who returns. Either the lab's protocols live elsewhere (Drive/paper), or authoring is too heavy.
8. **Nobody reads What's New (1 visit).** Release announcements reach people as notifications (26% read) and chat, not the page.
9. **The phone app has no users in the current snapshot.** Every TestFlight build in the batch release is shipping to no one
   we can see. Worth confirming with the lab before cutting the next build.
10. **The Oct dip is worth a look.** Day plans fell from 128 (Sep) to 50 (first 21 days of Oct); Cason went to 0; Alia went
    from 30 to 0. Either behaviour changed or something in the My Week → dayPlans write path did.

---

## 6. Recommended next steps (in order)

1. **Fix the measuring stick first (small code change, no new data model):**
   - set every `labConfig/pageTracking` mode to `tracked` (the `admin` aggregation served the dead hours model, V3.319);
   - remove `activity-overview` from `SKIP_SLUGS` or log it with its tab;
   - append `__tab__<x>` to the slug for `?tab=` pages so Tasks/Market, Library/Comments/Topics, People/Important,
     CV/Lab and the four Activity tabs separate;
   - stamp `client: web|app` on the entry (presence already computes it).
   Four weeks of clean data would answer most of §5 without guessing.
2. **Hold the "why" conversations** with the people the data names: Cason (My Week → 0 in Oct; tracker abandoned), Zeke
   (why notebook/protocols work for him), Alia (plans 30 → 0), Hunain (what would have made RM useful in week one),
   Allison/Cristobal (what they'd close in RM if it were one tap).
3. **Decide the fate of the 23 dormant nav pages** (18 silent + 5 single-visit, listed in §1.4) in three buckets: *hide from non-admins* (PI finance/admin set),
   *fold into a parent* (Outputs → Research Foci; Calendar → My Week; Huddle/Notebook/Tracker → My Week views; Grants →
   Papers, already true in data), *retire* (Explorer, Split, Compliance, Service, Teaching, Task Market, Projects).
   Retiring a page that is a workflow default or a stored `pageIds` entry needs the registry fallback checked first.
4. **Make closing a loop one tap where people already are** (chat or My Week) before building any new surface.

---

## Appendix — reproducing the pull

```bash
cd /Users/alexmcghee/Documents/GitHub/McGheeLabWebsite
mkdir -p /tmp/rm-usage
NODE_PATH=functions/node_modules node CodeLog/Analysis/rm_usage_pull.js /tmp/rm-usage
# writes users.json, tracker_entries.json, labConfig.json, userPresence.json, userData.json,
#        top_collections.json, top_rows.json, user_rows.json
```

Cloud Functions counts came from
`gcloud logging read 'logName="projects/mcgheelab-f56cc/logs/run.googleapis.com%2Frequests"' --freshness=30d`
grouped by `resource.labels.service_name`. Nothing was written to Firestore by this analysis.
