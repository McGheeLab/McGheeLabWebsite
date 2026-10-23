#!/usr/bin/env node
/* V3.768 — My Week's "Assigned to you" inbox filter.
 *
 * The lab-chore board is filled a semester ahead, and every assignment writes
 * the task into the assignee's queue immediately — so before this filter,
 * eight weeks of chores sat at the top of everyone's My Week at once. A chore
 * is only work once its week has arrived; everything else in the inbox (lab
 * meeting action items, PMR sends) carries a real deadline and must never be
 * hidden.
 *
 * Pure logic over rm/js/my-week.js's own source — the functions are lifted out
 * and run, so this test cannot drift from what the page does. Layer 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'rm/js/my-week.js'), 'utf8');

/* lift a top-level `function name(` … matching-brace block out of the source */
function lift(name) {
  const i = SRC.indexOf('  function ' + name + '(');
  if (i < 0) throw new Error('my-week.js no longer defines ' + name + '()');
  let depth = 0;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}' && --depth === 0) return SRC.slice(i, k + 1);
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

const make = new Function('state', 'FA',
  [lift('shiftDate'), lift('mondayOf'), lift('inboxItems')].join('\n') + '\nreturn inboxItems;');

/* the real weekIdFor from focus-areas.js, same lift */
const FA_SRC = fs.readFileSync(path.join(ROOT, 'rm/js/focus-areas.js'), 'utf8');
const FA = { weekIdFor: new Function(
  (() => { const i = FA_SRC.indexOf('  function weekIdFor(');
           let d = 0;
           for (let k = FA_SRC.indexOf('{', i); k < FA_SRC.length; k++) {
             if (FA_SRC[k] === '{') d++; else if (FA_SRC[k] === '}' && --d === 0) return FA_SRC.slice(i, k + 1);
           } })() + '\nreturn weekIdFor;')() };

const TASKS = [
  { id: 'chore-this',   source_ref: { kind: 'lab-chore', weekId: '2026-W38' }, due_date: '2026-09-18' },
  { id: 'chore-next',   source_ref: { kind: 'lab-chore', weekId: '2026-W39' }, due_date: '2026-09-25' },
  { id: 'chore-far',    source_ref: { kind: 'lab-chore', weekId: '2026-W42' }, due_date: '2026-10-16' },
  { id: 'chore-past',   source_ref: { kind: 'lab-chore', weekId: '2026-W37' }, due_date: '2026-09-11' },
  { id: 'chore-undated', source_ref: { kind: 'lab-chore', weekId: '2026-W39' }, due_date: 'TBD' },
  { id: 'action-item',  source_ref: { kind: 'meeting-action', meetingId: 'm1' }, due_date: '2026-10-02' },
  { id: 'plain-task',   due_date: 'TBD' },
];

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log('  FAIL ' + label + '\n        got  ' + got + '\n        want ' + want);
}

const inbox = make({ assigned: TASKS }, FA);
const ids = (monday) => inbox(monday).map(t => t.id).join(',');

eq('viewing this week: only this week\'s chore (and the overdue one)',
   ids('2026-09-14'), 'chore-this,chore-past,action-item,plain-task');
eq('paging to next week reveals next week\'s chore',
   ids('2026-09-21'), 'chore-this,chore-next,chore-past,chore-undated,action-item,plain-task');
eq('a chore four weeks out is hidden now',
   inbox('2026-09-14').some(t => t.id === 'chore-far'), false);
eq('…and appears once its own week is in view',
   inbox('2026-10-12').some(t => t.id === 'chore-far'), true);
eq('viewing a past week shows only what had started by then',
   ids('2026-09-07'), 'chore-past,action-item,plain-task');
eq('an overdue chore keeps showing',
   inbox('2026-09-14').some(t => t.id === 'chore-past'), true);
eq('action items are never week-filtered',
   inbox('2026-09-14').some(t => t.id === 'action-item'), true);

/* FOCUS_AREAS may not have loaded yet — a dated chore is still filtered by its
 * due date, and an undated one falls open rather than vanishing. */
const noFA = make({ assigned: TASKS }, null);
eq('without FOCUS_AREAS: dated chores still filtered, undated shown',
   noFA('2026-09-14').map(t => t.id).join(','),
   'chore-this,chore-past,chore-undated,action-item,plain-task');

/* V3.874 — a Scientia chore or reminder occurrence is dated work: held back until its week, overdue ones stay;
 * a Scientia task component (V3.872, source 'scientia' with no kind) is a plain task and never hidden. */
const SIS = [
  { id: 'sis-this', source: 'scientia', source_ref: { kind: 'scientia-when', label: 'Chore' }, due_date: '2026-09-16' },
  { id: 'sis-next', source: 'scientia', source_ref: { kind: 'scientia-when', label: 'Deadline' }, due_date: '2026-09-24' },
  { id: 'sis-late', source: 'scientia', source_ref: { kind: 'scientia-when', label: 'Reminder' }, due_date: '2026-09-02' },
  { id: 'sis-task', source: 'scientia', source_ref: { scientia: { docId: 'd1', blockId: 'b1' } }, due_date: '2026-10-30' },
];
const sis = make({ assigned: SIS }, FA);
eq('Scientia occurrences: this week + overdue shown, next week held back, a task component always shown',
   sis('2026-09-14').map(t => t.id).join(','), 'sis-this,sis-late,sis-task');
eq('…next week\'s occurrence appears when its week is in view',
   sis('2026-09-21').some(t => t.id === 'sis-next'), true);

console.log('my-week inbox: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
