# FuturePlan 05 — Ourlab Platform: Slack, Tenancy, Mobile + Push

> **Status:** future plan — not yet in production, **except the "Ops now" Slack import below, which should run immediately.**
> **Origin:** wishlist roadmap session, 2026-07-11. Reconciled with the prior `CodeLog/ClaudesPlan/V3.244_ourlab_mobile_v1.md` (see "Reconciliation" note below).
> **To activate:** pick the next release below, get `V{next}` from `git log --oneline -5`, write `CodeLog/ClaudesPlan/V{next}_{slug}.md` from that release's spec, then implement per the release ritual. Order within each workstream matters; the Notifications release must land **before** mobile push.

## Context

Wishlist items: *"formally take the RM into the ourlab concept… have mcgheelab as the first user and we need to keep all of our stuff as is"*; *"chat should act like slack — migrate existing slack messages and files in; i want notifications to work… android and ios… part of the mcgheelab app we are building for the phone under the ourlab.app concept."*

What exploration found (2026-07-11) — the wishlist overstates what's missing:

- **Chat is already ~95% a Slack clone** (`rm/js/chat.js`, 3690 lines: channels, DMs + group DMs, threads, reactions, file attachments, mentions, unread/mention badges, pins, read receipts, search).
- **Web FCM push already works end-to-end**: `functions/chat.js` → `functions/helpers/notify.js` `sendToUsers`, per-app toggles at `userSettings/{uid}.notifications.apps.*`, token registry at `users/{uid}/pushTokens`, VAPID key live in `push-notifications.js`, SW at `firebase-messaging-sw.js`.
- **The Slack importer exists and is complete** (`scripts/slack_export.py`, 671 lines, idempotent on `slackTs`, checkpoint/resume) — it has just never been run against prod.
- **No tenancy exists**: zero `labId` anywhere; rules assume one lab per Firebase project. Only ~39 real branding strings + the Firebase config couple the code to McGheeLab. Firebase config is hardcoded in **four** spots: `firebase-config.js`, `.firebaserc`, `rm/js/firebase-bridge.js` (~lines 5-17), and `firebase-messaging-sw.js` (~lines 12-18) — the SW one matters because service workers can't read `window.*`.

## Locked decisions

- **Project-per-tenant**: each lab = its own Firebase project sharing the same code + rules. McGheeLab (`mcgheelab-f56cc`) untouched, all data kept as-is. No labId retrofit.
- **Slack**: historical import now; continuous sync during a transition period; then cutoff.
- **Push v1 set**: chat mentions + DMs, all channel messages (per-channel mute), task events, PMR/meeting reminders.
- **Mobile v1 = notifications-first**: shell + native auth + push + wrapped web pages. The richer native screens (Today digest, receipt capture, voice notebook) are deferred to mobile v1.x.

---

## Workstream A — Slack

### ⚠️ Ops now (no version, no code) — historical import
**Check the Slack plan tier first** — on a free plan the API returns only the last 90 days, so history is actively expiring and this should run ASAP.
1. Provision an `xoxp-` user token (scopes: users:read, channels:read+history, groups:read+history, im:read+history, mpim:read+history, files:read, reactions:read); fill `scripts/.env`.
2. Run ladder: `--dry-run` (review the email→uid user map) → `--channels general --skip-files` (verify rendering, threads, reactions, "from Slack" badge in RM chat) → `--skip-dms` full channels+files → full run with DMs.
3. Idempotent on `slackTs`; checkpoint/resume built in — safe to re-run.

### Release A1 — continuous sync
**Scheduled poller, not Events API** (reuses the proven idempotent mapping; no public webhook URL / 3-second-ack complexity; 5-min staleness is fine at lab volume; polling self-heals via cursors). **New `functions/slack-sync.js`**: `onSchedule('every 5 minutes')` (pattern from `functions/ics-scraper.js`); cursor state at `chatConfig/slackSync` `{enabled, channelCursors, userMap, lastRunAt}`; `conversations.history` with `oldest=cursor`; threads via `conversations.replies`; token via `defineSecret('SLACK_SYNC_TOKEN')`; plus an `slackSyncNow` HTTPS admin twin for manual runs. **Sync scope: public + private channels only** — DMs were one-shot in the import; new DMs happen in RM. No rules changes (Admin SDK). Deploy: functions only.

### Release A2 — cutoff (post-stability, ~4–6 weeks after A1)
Announce a date → set `chatConfig/slackSync.enabled=false` → final Slack message pointing to RM chat → archive Slack channels → remove the function in a later cleanup version.

## Workstream B — Ourlab tenancy (project-per-tenant)

### Release B1 — tenant config layer (two seams)
- **Boot/config seam — new root `tenant.js`** (SW-safe): `self.OURLAB_TENANT = {tenantId, platformName:'Ourlab', tenantName:'McGhee Lab', domain, firebaseConfig, vapidKey}` — the ONLY file that differs per tenant deployment. Consumers: `firebase-config.js`, `rm/js/firebase-bridge.js`, `firebase-messaging-sw.js` via `importScripts('/tenant.js')` (also parameterize the `mcgheelab-` IndexedDB/tag prefixes there), `push-notifications.js` (VAPID key). Keep current literals as fallback for one version.
- **UI seam — new `rm/js/branding.js`** (the abstraction the never-shipped V3.243/V3.244 plans specced): exposes `platformName`/`tenantName`/`logoUrl`/`primaryColor`, reading `tenant.js` first and overlaying runtime `labConfig/branding` `{labName, piName, logoPath, accentColor}` (existing labConfig rules already cover it). Route the ~39 real branding strings (headers/titles/footers/manifest) through it; the mobile shell later reads the same values via a bridge call.
- **Riskiest change is the SW** — test the push round-trip on prod immediately after FTP.
- Open question to settle at planning time: header lockup wording ("Ourlab — McGhee Lab" vs "McGhee Lab on Ourlab" vs "Ourlab" + tenant chip).

### Release B2 — namespace rename
`window.McgheeLab` → `window.Ourlab` with a same-object alias (`window.McgheeLab = window.Ourlab`) kept **≥3 versions** — FTP deploys are non-atomic and clients hold mixed caches. Sweep ~9 files' reads; grep-verify zero bare `McgheeLab` reads before eventually dropping the alias in a later version.

### Release B3 — provisioning runbook
**New `docs/ourlab-provisioning.md` + `scripts/provision_tenant.sh`**: `gcloud projects create` → enable Auth/Firestore/Storage → deploy rules/indexes/functions with a multi-project `.firebaserc` → seed `labConfig/branding`, `labConfig/extensionMembers` (rules `get()` it), `chatConfig/settings`, first admin `users/{uid}` → per-tenant secrets → static host + `tenant.js` + Auth authorized domain. Includes the **platform manifest** (platform files: rm/, functions/, rules, firebase-config.js, user-system.js, push files, sw.js; McGhee-only files: content.json, Images/, main SPA, cv-builder.js, Data/, poster/). **Repo split deferred** until tenant #2 actually signs — the manifest makes it mechanical later; splitting now breaks the single-FTP deploy and local dev mount for zero benefit.

## Workstream C — Notifications completion (one release, **before mobile push**)

Coverage audit at planning time: chat (all modes) ✅, task-assigned ✅. Add:
- **`functions/task-reminders.js`** — daily 07:00 America/Phoenix: subtasks due today per user → one digest push (may need a collection-group index on `userData/*/tasks (due_date, done)`).
- **`functions/meeting-reminders.js`** — meetings tomorrow + PMR `meeting_date` tomorrow (field added in FuturePlan 04 Release C2) → attendees / owner + admin.
- **`functions/pmr-comments.js`** — onDocumentCreated on PMR comments → owner or thread participants.
- **Platform-aware payload fix in `functions/helpers/notify.js`** — today's messages are data-only, which does **not display on backgrounded iOS**. Branch on the token's `platform` field: web = data-only unchanged; ios/android = add `notification` + `apns`/`android` blocks. **This must land before mobile push or iOS notifications silently won't display.**
- New appKey toggles in `rm/pages/settings.html`.

> **Reconciliation with V3.244:** that plan proposed building push from scratch on a new `users/{uid}/devices/{deviceId}` collection with its own digest functions — but the FCM substrate has since shipped in a different shape (`notify.js` `sendToUsers`, the `pushTokens` registry, per-app toggles). Build on the shipped substrate: add `platform`/`deviceId`/`lastSeen` fields to existing `pushTokens` docs rather than forking a `devices` collection. V3.244's per-event triggers map onto the functions above. Its native-screen product vision and offline/OTA architecture are adopted in Workstream D.

## Workstream D — ourlab-mobile (new sibling repo `github.com/McGheeLab/OurlabMobile`, own m-version line)

App id `app.ourlab.mobile`, display name "Ourlab", McGheeLab as tenant #1.

**Architecture (correction from V3.244):** do **not** use a pure remote-URL wrapper — the lab needs ~2h offline (basement BSL-2), and a remote WebView is dead offline. Instead:
- **Bundle the `rm/` tree into `www/`** (build-time sync from this repo);
- **Firebase IndexedDB persistence** for offline data;
- **Capacitor Live Updates (`@capgo/capacitor-updater`)** for OTA JS/CSS/HTML fixes without store review;
- **Firebase Remote Config** flags gating every native feature (instant kill switch).
- Bundling + native screens + push also sidestep Apple 4.2 "minimum functionality" rejections.

### m-v0.1 — scaffold + shell + native auth
Capacitor iOS+Android; bottom tab bar `[Today][Tasks][Tracker][Scan][More]`; WebView host that injects auth state + an `OurlabBridge` (`isCapacitor()`, haptics; barcode/quick-log stubs for v1.x); Live Updates + Remote Config wired. Native sign-in via `@capacitor-firebase/authentication` (Google both platforms, **Apple on iOS** per App Store guideline 4.8) → WebView inherits the session via shared WebView storage — no second login. Two OAuth client IDs (iOS bundle id, Android SHA-1). Small web-repo patch branches sign-in on `Capacitor.isNativePlatform()`.

### m-v0.2 — native push
`@capacitor-firebase/messaging` (FCM tokens on both platforms → `notify.js` `sendEach` unchanged); tokens land in the existing `users/{uid}/pushTokens` registry with `platform` / `deviceId` (`@capacitor/device`) / `lastSeen`; APNs .p8 key uploaded to Firebase console; notification tap → `data.url` deep-link routes into the target WebView (`?focus=<id>`); per-device timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` for the daily digest; **suppress the web SW token path inside the app** to avoid double notifications. **Depends on Workstream C's payload fix.**

### m-v1.0 — stores (notifications-first v1)
Apple Dev ($99/yr) + Play ($25); Sign in with Apple; privacy policy + App Store nutrition labels / Play Data Safety; icons/splash via `@capacitor/assets`; **pre-promoted reviewer demo account** (the guest-pending overlay would look broken to a reviewer); TestFlight + Play internal beta with the lab first. **v1 = shell + auth + push + wrapped web pages (Tasks, Chat, Tracker, Notebook)** — this delivers the wishlist's stated value: notifications on Android and iOS.

### Deferred to mobile v1.x (phone-wins tier)
Native **Today digest** (read-only aggregation, push-tap target); **Receipt capture** (camera → ML Kit/Vision OCR → `functions/parse-receipt.js` Claude-vision fallback → `users/{uid}/receipts/{id}`; serves the stored inventory-receipt need; per-user cost quota); **Voice notebook** (live-caption → `functions/transcribe-voicenote.js` Whisper + Claude cleanup → `users/{uid}/notebook/{id}`, strictly per-user); `OurlabBridge` barcode scan on Chemicals/Equipment + activity quick-log. This is the richer V3.244 vision — sequence it after v1 is in the lab's hands.

---

## Release ritual

1. `CodeLog/ClaudesPlan/V{n}_{slug}.md` before implementation (web repo; mobile repo gets its own plan docs). 2. CHANGELOG + ARCHITECTURE updates + sw.js CACHE_VERSION bump per web release. 3. Deploy order: **firestore rules/indexes/storage → functions → FTP web → app build/OTA**. 4. `python3 scripts/version_push.py` (web repo).

## Rollback

- slack-sync: kill switch at `chatConfig/slackSync.enabled=false`; function redeploy of previous revision.
- Slack import: idempotent on `slackTs`; always ladder `--dry-run` → one channel first.
- tenant.js/branding: literals kept as fallback one version; git revert + re-FTP. Namespace alias held ≥3 versions makes B2 safely revertible.
- Mobile: OTA bundle revert → Remote Config flag flip → expedited store review only for native-layer breakage.

## Open questions

1. **Slack plan tier** — free vs paid decides how much history the import can recover. Check before anything else.
2. Header lockup wording (B1).
3. When does ourlab.app DNS/hosting actually get set up — needed by mobile v1.0 branding, not before.
4. Apple 4.2 review outcome — bundled + native value should pass, but keep the Remote Config kill switches ready.

## Verification (end-to-end)

- Post in Slack → message appears in RM chat ≤5 min (threads + reactions intact).
- Edit `tenant.js` labName locally → nav/header rebrand without touching rm/ files.
- Push round-trip on prod web immediately after the SW change (B1).
- TestFlight install → chat mention push arrives on a locked phone → tap deep-links into the right channel; same on Android internal track.
- Provisioning dry-run: `provision_tenant.sh` against a scratch Firebase project produces a working empty-lab RM login.
