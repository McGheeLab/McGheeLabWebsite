/* ================================================================
   class-notify.js — Teacher-class assignment/submission pushes (V3.671)
   ================================================================
   Teacher program R2. Cross-user notifications the client cannot
   write itself (students and teachers are role:'guest' — they can
   never write another user's feed):

     assignments/{id}  onWritten —
       • status transitions to 'published' → notify every ACTIVE
         enrollee of the class (query needs the composite index
         enrollments(scheduleId ASC, status ASC)).

     submissions/{id}  onWritten —
       • created, or student edit (status/text/submittedAt) → notify
         the teacher, deep-linked to the gradebook
       • grade appears or changes → notify the student

   Teachers/students may have no push tokens (public-site users) —
   sendToUsers no-ops for them and the feed item still lands in
   userData/{uid}/notifications for whenever they get the app.
   ================================================================ */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const APP_KEY = 'classes';

const onAssignmentWrite = onDocumentWritten('assignments/{assignmentId}', async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return; // deletions are silent

  // Only the transition INTO 'published' fans out — edits to an already
  // published assignment stay quiet (the due-date nag is R3+ territory).
  if (after.status !== 'published' || (before && before.status === 'published')) return;

  const db = getFirestore();
  const messaging = getMessaging();

  const enrolled = await db.collection('enrollments')
    .where('scheduleId', '==', after.scheduleId)
    .where('status', '==', 'active')
    .get();
  const studentUids = enrolled.docs.map((d) => d.data().studentUid).filter(Boolean);
  if (!studentUids.length) return;

  const due = after.dueDate ? ` — due ${after.dueDate}` : '';
  await notifyUsers(db, messaging, studentUids, {
    title: 'New assignment',
    body: `"${after.title || 'Assignment'}"${due}`,
    url: '/#/dashboard',
    tag: `class-assign-${event.params.assignmentId}`
  }, APP_KEY, 'class-assignment');
});

const onSubmissionWrite = onDocumentWritten('submissions/{submissionId}', async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;

  const db = getFirestore();
  const messaging = getMessaging();
  const student = after.studentName || 'A student';

  // 1. Grade appeared or changed → tell the student.
  const gradeBefore = JSON.stringify((before && before.grade) || null);
  const gradeAfter = JSON.stringify(after.grade || null);
  if (after.grade && gradeBefore !== gradeAfter) {
    if (after.studentUid) {
      await notifyUsers(db, messaging, [after.studentUid], {
        title: 'Assignment graded',
        body: `Your work was marked ${after.grade.outcome || 'graded'}` +
              (after.grade.score != null ? ` (${after.grade.score})` : ''),
        url: '/#/dashboard',
        tag: `class-grade-${event.params.submissionId}`
      }, APP_KEY, 'class-grade');
    }
    return; // a grade write is the teacher's own action — don't echo it back
  }

  // 2. New submission, or a student edit to status/text → tell the teacher.
  const studentEdited = !before
    || before.status !== after.status
    || (before.text || '') !== (after.text || '')
    || String(before.submittedAt || '') !== String(after.submittedAt || '');
  if (studentEdited && after.teacherUid && after.teacherUid !== after.lastEditedBy) {
    const what = after.status === 'done' ? 'marked an assignment done' : 'submitted a response';
    await notifyUsers(db, messaging, [after.teacherUid], {
      title: before ? 'Submission updated' : 'New submission',
      body: `${student} ${what}`,
      url: `/#/teach/${after.scheduleId}/gradebook`,
      tag: `class-sub-${event.params.submissionId}`
    }, APP_KEY, 'class-submission');
  }
});

module.exports = { onAssignmentWrite, onSubmissionWrite };
