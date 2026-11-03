---
name: scientia-macro
description: Write a Scientia macro — a set of steps behind one /command for the notebook's navigation bar — as a .sis-macro.json file Gabe imports in Settings → Commands. Use when he asks for a /command that does several things ("make me a /command that starts a run and the timer", "a macro for my reading sessions", "turn these steps into one slash"). Not for a single built-in command (those exist already: /help lists them) and not for app code.
---

# /scientia-macro — steps behind one /command

A macro is a file. The app (V3.947, `scientia/src/11b-commands.js` `MACRO`) imports it from Settings → Commands → Import a macro…, or from the notebook folder's `macros/` on the desktop, and from then on `/slash` in the navigation bar (or typed in a component) runs its steps in order.

## What to do

1. **Read the vocabulary first, never from memory:**
   ```
   python scripts/scientia_macro.py list
   ```
   It prints every command with its arguments (`<needed>`, `[optional]`, the choices of a choice argument) and every + Insert row. Only these can be steps.
2. **Write the file** `<slash>.sis-macro.json`. On the desktop put it in the notebook folder's `macros/` (the folder in `%APPDATA%\ScientiaInSitu\config.json` → `notebook`; make `macros/` if it is missing); otherwise next to where Gabe asked. One macro per file.
3. **Check it:**
   ```
   python scripts/scientia_macro.py check <file>
   ```
   Fix what it reports until it says `ok`.
4. **Tell Gabe** how to import it (Settings → Commands → Import a macro…, or the file's button under "In the notebook folder's macros/" on the desktop) and what each step does, in order, in one short list.

## The file

```json
{ "format": "sis-macro/1", "name": "Start a gel run", "slash": "gelrun",
  "params": [{ "name": "title", "ask": "Title of the run", "default": "Gel run {date}" }],
  "steps": [
    { "cmd": "new", "args": { "type": "experiment", "title": "{title}" } },
    { "cmd": "insert", "args": { "row": "protocol", "pick": "Gel casting" } },
    { "cmd": "timer", "args": { "action": "start" } },
    { "cmd": "flag", "when": "{ask: Flag it for the weekly review?}" } ] }
```

- `format` is always `sis-macro/1`. `name` is what the list shows; `slash` is the command (letters, digits, dashes; not a built-in).
- `params`: what the macro asks for when it runs (or takes from the line: `/gelrun "Day 3"`). `default` may use the built-in placeholders.
- `steps` run in order. `cmd` is a command's slash; `args` are its arguments by name, as text. A step that fails stops the macro and says which.
- Placeholders in any text: `{param}`, and the built-ins `{date}` (2026-11-03), `{time}` (14:05), `{note}` (the note on screen), `{project}`.
- `pick` (any step whose command opens a picker, such as an insert row): the picker opens with that text already typed, and the macro waits for the choice.
- `when`: `"{ask: Question?}"` asks yes or no and skips the step on no; any other text skips the step when it is empty, `false`, `no` or `0` after placeholders are filled.
- An argument naming a note, a component, a project, a term, a paper… is resolved by name: the exact name, or the one match; several matches open a picker with the name typed. So a step may name something that does not exist yet only through `pick`.

## Rules

- Never a deleting or destructive step without `"when": "{ask: …}"` first. (There is no /delete; keep it so.)
- A step that depends on the note on screen (`/timer`, `/flag`, `/rename`, `/insert`…) must come after the step that opens or makes it (`/go`, `/new`, `/today`), or Gabe must be told to run it from the note.
- Choice arguments take one of the listed words exactly (`timer` → `start · pause · resume · stop`).
- Keep the name a sentence Gabe would say ("Start a gel run"), the slash short (`gelrun`).

## Three examples

**A run:** `/gelrun` above.

**A meeting note:**
```json
{ "format": "sis-macro/1", "name": "Meeting with Alex", "slash": "meet",
  "params": [{ "name": "about", "ask": "What is it about?" }],
  "steps": [
    { "cmd": "today" },
    { "cmd": "insert", "args": { "row": "component", "pick": "" } },
    { "cmd": "rename", "args": { "title": "Meeting · {about} · {date}" } },
    { "cmd": "timer", "args": { "action": "start" } } ] }
```

**A reading session:**
```json
{ "format": "sis-macro/1", "name": "Read a paper beside the note", "slash": "readnow",
  "params": [{ "name": "paper", "ask": "Which paper (part of its title)?" }],
  "steps": [
    { "cmd": "read", "args": { "paper": "{paper}" } },
    { "cmd": "timer", "args": { "action": "start" }, "when": "{ask: Time this session?}" } ] }
```

## What you do not do

- Don't invent commands: if a step Gabe wants has no command, say so and offer the closest built-ins (or note it as a command to add in `11b-commands.js`, which is app work, not a macro).
- Don't write the macro into `settings()` or the record by hand; the file and the import are the way.
- Don't change `scripts/scientia_macro.py` or the app to make a macro pass its check.
