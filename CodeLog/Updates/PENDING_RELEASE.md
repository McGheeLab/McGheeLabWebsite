# Pending Release — change ledger

> **What this is:** every small change gets ONE entry here (in addition to
> the normal CHANGELOG entry). When there are **5 or more entries**, or
> when Alex says **"push"**, the batch ships as one release:
>
> ```
> python3 scripts/release_push.py          # add --force under 5 entries
> ```
>
> That one command does the whole push from these entries: writes the Ourlab
> mobile changelog entry, bumps the TestFlight build number, bundles the web
> tree into the app, uploads the build, prints the ready-to-paste
> announcement, and moves these entries to **Shipped** below. Two things stay
> manual: the Cyberduck FTP, and pressing 📣 Send on
> `rm/pages/whats-new.html`.
>
> **Why the app is part of it:** Ourlab mobile bundles the `rm/` tree at
> build time, so an FTP-only push updates browser users and silently leaves
> phone users on old code. Every batch ships both halves, and the
> announcement names the build that carries them.
>
> **Entry format:** one line a lab member (not a developer) would
> understand — what they can now do, or what stopped being broken.
> Technical detail belongs in CHANGELOG, not here.

## Pending (3 changes — push at 5+)

1. **[V3.618]** Fixed: split view no longer shows a doubled header — reloading
   or coming back to a split while in a workflow used to draw the workflow
   bar twice (once on top, once inside each pane).

1. **[V3.616]** Capturing figures from papers just got obvious: the reader
   now **spots the figures for you** — hover one and click 🖼 to snip it
   straight to your Figure board picker. (⬚ Snip / Alt-drag still work for
   custom regions.) *(2026-08-12)*
2. **[V3.617]** Figure board polish: the zoom buttons are now one floating
   cluster on the canvas (top right), and the text boxes on figure,
   experiment, and note cards support **bold, italics, and bulleted/numbered
   lists** — the formatting buttons appear under the box while you're
   typing. *(2026-08-12)*

## Shipped

### V3.615 · app m-v0.3.4 (TestFlight build 11) — 2026-08-12

- Fixed: pinch-zooming a paper in the phone reader is now smooth — no more stutter/jump right after you let go.

### V3.614 · app m-v0.3.3 (TestFlight build 10) — 2026-08-11

- New What's New page (Settings → What's New) — see what changed in each app update, and get one notification per update batch instead of silence.
- Admins can now grant individual people specific paper-reader powers (annotate, create annotation groups, extension capture) from the Permissions page — including guests and collaborators, without full lab membership. Also fixed: "+ New group…" no longer errors for lab members who weren't on the editor allowlist — it only shows when you can actually use it.
- Fixed: booking equipment overnight (start one day, end the next) no longer claims it will bump everyone else booked on those days. It now only warns about bookings that genuinely overlap your hours.
- Fixed: highlighting library papers now works for everyone. The highlight color buttons were missing from the selection toolbar for anyone who'd never saved a custom palette (only the equation button showed) — everyone now gets the lab's standard 6 colors.
- Phone-app updates now go out with every release instead of lagging behind the website, and each release note tells you which TestFlight build has the changes.
- New 🧭 Figure board page in the paper editor — plan your paper's experiments and figures on a whiteboard-style canvas: add planned figures, the experiments that produce them, reference images, and notes, then connect them with arrows to map how the story flows.
- You can now snip figures out of papers you're reading — toggle ⬚ Snip in the reader (or hold Alt), drag a box over the figure, and hit 🖼. Your captures then show up in the Figure board's "📚 From library" picker so you can pin them next to the figures you're planning, with a link back to the source paper.
- Your mentor can now open your papers (read-only unless they're a coauthor) and work with you on the Figure board — and every board card has a 💬 thread so you and your advisor can discuss what each figure should show and which experiments to run.
- When someone works on your Figure board while you're away, you get one notification (not one per edit) — and when you open the board, everything that changed since your last visit is highlighted, with a ▶ Review button that walks you through the changes.
- The Library is now in the phone app — a new 📚 tab. You can search the lab library, read papers full-screen, press-and-hold to highlight (each color's meaning is spelled out), comment, put highlights in groups, tag evidence for your drafts, and add papers on the go by DOI or by uploading a PDF from Files. Everything syncs live with the desktop library.
- Phone reader zoom now snaps to the two zooms you actually read at — the whole page, or one column filling your screen (pinch near either and it locks in, with the column framed edge-to-edge). Double-tap flips between the same two.

