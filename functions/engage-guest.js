/* ================================================================
   engage-guest.js — teachers post a classroom visit WITHOUT an account
   (V3.808)
   ================================================================
   Alex: "I need to be able to have teachers add engagement opportunities
   as a guest, so they do not need to sign in." The signed-in path (Google
   sign-in → #/engage steps 1–7) stays; this is the no-account front door,
   mcgheelab.com/#/invite-a-scientist.

   How it holds together without an identity:

     • The teacher fills ONE form. `submit` stores it as
       engageGuestPosts/{guestId} (status 'pending') and returns a random
       MANAGE TOKEN. The token is the teacher's key: their private page is
       mcgheelab.com/#/invite-a-scientist/{token}. It rides in the URL
       fragment, so it never reaches a server log or a Referer header.
     • engageGuestPosts is admin-only in the rules. Every guest read and
       write goes through THIS endpoint, which finds the post by token and
       acts with the Admin SDK — so the rules on engageRequests /
       engageOpportunities stay uid-based and unchanged for everyone else.
     • The McGhee Lab reviews each post (admin Engagement tab) before it
       goes live: Publish writes a normal approved listing
       engageProfiles/guest_{guestId} (+ private/contact) and a normal
       engageOpportunities doc with teacherUid 'guest_{guestId}'. From
       there presenters see and sign up exactly as for any teacher.
     • The teacher accepts / declines sign-ups, marks the confirmation
       email sent, cancels a visit, closes a panel, or withdraws — all by
       token, mirroring step 7 of engage-hub.js (same date rules, same
       auto-decline notes). recountOpportunity in engage-notify.js keeps
       the public counts, as before.

   The site cannot email the teacher (no mail server; the Gmail scope on
   file is read-only), so admins are pushed on every new post and every
   guest sign-up, and the admin tab has "Email the teacher" mailto links.

   Abuse limits: a hidden honeypot field, 5 posts per IP per hour
   (engageGuestRate/{ipHash}, never readable by a client), and a cap of
   MAX_PENDING posts waiting for review.

   `handle(db, body, ctx)` is the whole behaviour and takes its Firestore
   and side effects as arguments, so functions/test/engage-guest.test.js
   runs it against the Firestore emulator. GET is a health probe.
   ================================================================ */

const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { notifyUsers } = require('./helpers/notify');

const ACTIVITY_TYPES = ['guest-talk', 'demo', 'lab-tour', 'career-chat'];
const FORMATS = ['at-school', 'visit-uofa', 'virtual'];
const SCHOOL_TYPES = ['high-school', 'community-college', 'other'];
const MAX_DATES = 12;
const MAX_PRESENTERS = 6;
const RATE_PER_HOUR = 5;
const MAX_PENDING = 200;
const TZ = 'America/Phoenix';
const MANAGE_BASE = 'https://mcgheelab.com/#/invite-a-scientist/';
const ADMIN_URL = '/rm/pages/admin-teachers.html?tab=engage';
const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;
const DECLINE_NOTES = {
  filled: 'Another presenter was accepted for this opportunity. Thank you for offering — please look for another.',
  enough: 'This opportunity has enough presenters now. Thank you for offering — please look for another.',
  withdrawn: 'This opportunity was withdrawn. Thank you for offering — please look for another.'
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

/* ---------------- validation ---------------- */

function text(v, max, { min = 0, field, required = false } = {}) {
  const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  if (required && !s) throw bad(`${field} is required.`);
  if (s && s.length < min) throw bad(`${field} is too short.`);
  if (s.length > max) throw bad(`${field} is too long (at most ${max} characters).`);
  return s;
}
// Multi-line text keeps its line breaks (notes, arrival instructions).
function para(v, max, field) {
  const s = (v == null ? '' : String(v)).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (s.length > max) throw bad(`${field} is too long (at most ${max} characters).`);
  return s;
}
function picks(v, allowed, field) {
  const arr = Array.isArray(v) ? [...new Set(v.map(String))] : [];
  if (!arr.length) throw bad(`Choose at least one: ${field}.`);
  if (arr.some(x => !allowed.includes(x))) throw bad(`${field} has a choice we don't recognise.`);
  return arr;
}
// Today's date where the classes are (Arizona has no DST), as YYYY-MM-DD.
function todayIn(tz, now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now || new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanDates(v, today) {
  const rows = Array.isArray(v) ? v : [];
  if (!rows.length) throw bad('Add at least one date that would work.');
  if (rows.length > MAX_DATES) throw bad(`At most ${MAX_DATES} dates, please.`);
  const latest = addDaysISO(today, 400);
  const seen = new Set();
  const out = rows.map((r) => {
    const date = String((r && r.date) || '');
    const startTime = String((r && r.startTime) || '');
    const endTime = String((r && r.endTime) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00Z'))) throw bad('One of the dates is not a real date.');
    if (date < today) throw bad(`${date} has already passed.`);
    if (date > latest) throw bad(`${date} is more than a year away.`);
    if (!HHMM.test(startTime) || !HHMM.test(endTime)) throw bad(`Give a start and end time for ${date}.`);
    if (endTime <= startTime) throw bad(`The end time on ${date} is before its start time.`);
    if (seen.has(date)) throw bad(`${date} is listed twice.`);
    seen.add(date);
    return { date, startTime, endTime };
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// The one validated shape a guest post holds. Used by submit and update.
function cleanPost(b, today) {
  const email = text(b.email, 200, { field: 'Your email', required: true }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("That email address doesn't look right.");
  const formats = picks(b.formats, FORMATS, 'where the visit happens');
  const size = Number(b.classSize);
  if (!Number.isInteger(size) || size < 1 || size > 500) throw bad('Class size should be a number between 1 and 500.');
  const wanted = Number(b.presentersWanted || 1);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > MAX_PRESENTERS) throw bad(`Presenters wanted should be 1 to ${MAX_PRESENTERS}.`);
  const schoolType = String(b.schoolType || '');
  if (schoolType && !SCHOOL_TYPES.includes(schoolType)) throw bad("School type isn't one we recognise.");
  const address = text(b.address, 300, { field: 'Street address' });
  if (formats.includes('at-school') && !address) throw bad('Add the school’s street address, so a presenter you accept knows where to go.');
  return {
    teacher: {
      name: text(b.name, 120, { field: 'Your name', required: true, min: 2 }),
      email,
      phone: text(b.phone, 40, { field: 'Phone' })
    },
    listing: {
      school: text(b.school, 160, { field: 'School', required: true, min: 2 }),
      schoolType,
      city: text(b.city, 80, { field: 'City', required: true }),
      state: text(b.state, 40, { field: 'State' }) || 'AZ',
      subject: text(b.subject, 120, { field: 'Subject', required: true }),
      grade: text(b.grade, 40, { field: 'Grade level', required: true }),
      classSize: size
    },
    opportunity: {
      title: text(b.title, 140, { field: 'What you’d like', required: true, min: 4 }),
      activityTypes: picks(b.activityTypes, ACTIVITY_TYPES, 'kind of visit'),
      formats,
      topic: text(b.topic, 300, { field: 'Topic' }),
      presentersWanted: wanted,
      dates: cleanDates(b.dates, today)
    },
    location: {
      address,
      room: text(b.room, 80, { field: 'Room' }),
      arrivalNotes: para(b.arrivalNotes, 600, 'Check-in notes')
    },
    noteToLab: para(b.noteToLab, 1000, 'Note to the lab')
  };
}

/* ---------------- reads ---------------- */

const iso = (t) => (t && typeof t.toDate === 'function') ? t.toDate().toISOString() : (t || null);

async function postByToken(db, token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new HttpError(404, 'This link isn’t valid. Check that you copied all of it.');
  const snap = await db.collection('engageGuestPosts').where('manageToken', '==', String(token)).limit(1).get();
  if (snap.empty) throw new HttpError(404, 'This link isn’t valid. Check that you copied all of it.');
  const doc = snap.docs[0];
  return { ref: doc.ref, id: doc.id, data: doc.data() };
}

async function requestsFor(db, oppId) {
  if (!oppId) return [];
  const snap = await db.collection('engageRequests').where('opportunityId', '==', oppId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// What the teacher's page is allowed to see of a sign-up. The presenter's
// email address only once the teacher has accepted them (it's needed for
// the confirmation email) — the signed-in panel showed it always.
function requestView(r, review) {
  const v = {
    id: r.id, status: r.status,
    requesterName: r.requesterName || '', requesterAffiliation: r.requesterAffiliation || '',
    requesterTitle: r.requesterTitle || '', requesterBio: r.requesterBio || '',
    dates: Array.isArray(r.dates) ? r.dates : [], okWithOthers: !!r.okWithOthers,
    activityType: r.activityType || '', format: r.format || '', topic: r.topic || '', message: r.message || '',
    date: r.date || '', startTime: r.startTime || '', endTime: r.endTime || '',
    expectedStudents: r.expectedStudents || null, teacherNote: r.teacherNote || '',
    location: r.location || null, emailedAt: iso(r.emailedAt), createdAt: iso(r.createdAt)
  };
  if (r.status === 'confirmed') v.requesterEmail = r.requesterEmail || '';
  if (review) {
    v.review = {
      rating: review.rating, engagement: review.engagement, studentsReached: review.studentsReached || null,
      wouldReturn: review.wouldReturn || '', wentWell: review.wentWell || '', improve: review.improve || ''
    };
  }
  return v;
}

function oppView(o) {
  if (!o) return null;
  return {
    id: o.id, status: o.status, title: o.title || '', dates: o.dates || [], dateKeys: o.dateKeys || [],
    bookedDate: o.bookedDate || null, acceptedRequestIds: o.acceptedRequestIds || [],
    presentersWanted: o.presentersWanted || 1, pendingCount: o.pendingCount || 0, acceptedCount: o.acceptedCount || 0,
    activityTypes: o.activityTypes || [], formats: o.formats || [], topic: o.topic || '', classContext: o.classContext || {}
  };
}

async function fullView(db, post) {
  const p = post.data;
  let opp = null;
  if (p.opportunityId) {
    const s = await db.collection('engageOpportunities').doc(p.opportunityId).get();
    if (s.exists) opp = { id: s.id, ...s.data() };
  }
  const reqs = opp ? await requestsFor(db, opp.id) : [];
  const reviews = await Promise.all(reqs.map(r => r.status === 'confirmed'
    ? db.collection('engageReviews').doc(r.id).get().then(s => s.exists ? s.data() : null).catch(() => null)
    : Promise.resolve(null)));
  return {
    guestId: post.id,
    post: {
      status: p.status, labNote: p.labNote || '',
      teacher: p.teacher, listing: p.listing, opportunity: p.opportunity, location: p.location,
      noteToLab: p.noteToLab || '', createdAt: iso(p.createdAt), publishedAt: iso(p.publishedAt),
      withdrawnAt: iso(p.withdrawnAt)
    },
    opportunity: oppView(opp),
    requests: reqs.map((r, i) => requestView(r, reviews[i]))
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
    manageUrl: MANAGE_BASE + p.manageToken
  };
}

/* ---------------- writes ---------------- */

async function rateLimit(db, ip, now) {
  const key = crypto.createHash('sha256').update('engage-guest|' + String(ip || 'unknown')).digest('hex').slice(0, 40);
  const ref = db.collection('engageGuestRate').doc(key);
  const cutoff = now.getTime() - 3600 * 1000;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const stamps = (s.exists ? (s.data().stamps || []) : []).filter(t => t > cutoff);
    if (stamps.length >= RATE_PER_HOUR) {
      throw new HttpError(429, 'That’s a lot of posts from one place in an hour. Please try again later, or email the McGhee Lab.');
    }
    stamps.push(now.getTime());
    tx.set(ref, { stamps, updatedAt: FieldValue.serverTimestamp() });
  });
}

async function declinePending(db, oppId, exceptId, note) {
  const reqs = await requestsFor(db, oppId);
  const losers = reqs.filter(r => r.status === 'pending' && r.id !== exceptId);
  await Promise.all(losers.map(r => db.collection('engageRequests').doc(r.id).update({
    status: 'declined', teacherNote: note, decidedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
  }).catch(e => console.warn(`[engageGuest] auto-decline ${r.id}: ${e && e.message}`))));
  return losers.length;
}

function requirePublished(post) {
  if (post.data.status !== 'published' || !post.data.opportunityId) {
    throw new HttpError(409, post.data.status === 'pending'
      ? 'The McGhee Lab hasn’t published this yet, so there are no sign-ups to answer.'
      : 'This post isn’t live any more.');
  }
}

async function requestOf(db, post, requestId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(requestId || ''))) throw bad('Missing sign-up.');
  const ref = db.collection('engageRequests').doc(String(requestId));
  const s = await ref.get();
  if (!s.exists || s.data().opportunityId !== post.data.opportunityId) throw new HttpError(404, 'That sign-up isn’t on your post.');
  return { ref, data: { id: s.id, ...s.data() } };
}

async function handle(db, body, ctx) {
  body = body || {};
  ctx = ctx || {};
  const now = ctx.now || new Date();
  const action = String(body.action || '');
  const stamp = () => FieldValue.serverTimestamp();

  if (action === 'submit') {
    // Honeypot: a field people never see. Bots fill every field.
    if (String(body.company_url || '').trim()) throw bad('Could not post this. Please email the McGhee Lab.');
    const clean = cleanPost(body, todayIn(TZ, now));
    await rateLimit(db, ctx.ip, now);
    const pending = await db.collection('engageGuestPosts').where('status', '==', 'pending').count().get();
    if (pending.data().count >= MAX_PENDING) {
      throw new HttpError(503, 'We have a lot of posts waiting for review right now. Please email the McGhee Lab instead.');
    }
    const ref = db.collection('engageGuestPosts').doc();
    const token = crypto.randomBytes(24).toString('base64url');
    await ref.set({
      ...clean,
      status: 'pending',
      manageToken: token,
      teacherUid: 'guest_' + ref.id,
      createdAt: stamp(), updatedAt: stamp()
    });
    if (ctx.notifyAdmins) {
      await ctx.notifyAdmins({
        title: 'New visit post to review',
        body: `${clean.teacher.name} (${clean.listing.school}) posted "${clean.opportunity.title}" without an account — review it to put it live.`,
        url: ADMIN_URL,
        tag: `engage-guest-${ref.id}`
      }).catch(e => console.warn('[engageGuest] notify failed', e && e.message));
    }
    return { ok: true, guestId: ref.id, token, manageUrl: MANAGE_BASE + token };
  }

  const post = await postByToken(db, body.token);
  const p = post.data;

  if (action === 'get') {
    post.ref.update({ lastViewedAt: stamp() }).catch(() => {});
    return fullView(db, post);
  }

  if (action === 'update') {
    if (p.status !== 'pending') throw new HttpError(409, 'Only a post waiting for review can be edited. Email the McGhee Lab to change a live one.');
    const clean = cleanPost(body, todayIn(TZ, now));
    await post.ref.update({ ...clean, updatedAt: stamp() });
    return fullView(db, await postByToken(db, body.token));
  }

  if (action === 'withdraw') {
    if (p.status === 'withdrawn') return fullView(db, post);
    if (p.status === 'declined') throw new HttpError(409, 'The lab didn’t publish this post, so there’s nothing to withdraw.');
    let declined = 0;
    if (p.opportunityId) {
      await db.collection('engageOpportunities').doc(p.opportunityId)
        .update({ status: 'closed', updatedAt: stamp() })
        .catch(e => console.warn('[engageGuest] close', e && e.message));
      declined = await declinePending(db, p.opportunityId, null, DECLINE_NOTES.withdrawn);
    }
    await post.ref.update({ status: 'withdrawn', withdrawnAt: stamp(), updatedAt: stamp() });
    return { ...(await fullView(db, await postByToken(db, body.token))), declined };
  }

  // Everything below answers sign-ups on a live opportunity.
  requirePublished(post);
  const oppRef = db.collection('engageOpportunities').doc(p.opportunityId);

  if (action === 'enough') {
    const o = await oppRef.get();
    if (!o.exists) throw new HttpError(404, 'This post isn’t live any more.');
    if (!(o.data().acceptedRequestIds || []).length) throw new HttpError(409, 'Accept at least one presenter first.');
    const declined = await declinePending(db, p.opportunityId, null, DECLINE_NOTES.enough);
    await oppRef.update({ status: 'booked', updatedAt: stamp() });
    return { ...(await fullView(db, post)), declined };
  }

  const req = await requestOf(db, post, body.requestId);

  if (action === 'decide') {
    const decision = String(body.decision || '');
    if (!['confirmed', 'declined'].includes(decision)) throw bad('Accept or decline?');
    const note = text(body.note, 300, { field: 'Note' });
    if (decision === 'declined') {
      if (req.data.status !== 'pending') throw new HttpError(409, 'This sign-up was already answered.');
      await req.ref.update({ status: 'declined', ...(note ? { teacherNote: note } : {}), decidedAt: stamp(), updatedAt: stamp() });
      return fullView(db, post);
    }
    const students = Number(body.expectedStudents);
    if (!Number.isInteger(students) || students < 1 || students > 500) throw bad('Say roughly how many students they should expect.');
    const date = String(body.date || '');
    let filled = false;
    await db.runTransaction(async (tx) => {
      const [rs, os] = await Promise.all([tx.get(req.ref), tx.get(oppRef)]);
      if (!rs.exists || rs.data().status !== 'pending') throw new HttpError(409, 'This sign-up was already answered.');
      if (!os.exists) throw new HttpError(404, 'This post isn’t live any more.');
      const r = rs.data(), o = os.data();
      const wanted = o.presentersWanted || 1;
      const accepted = o.acceptedRequestIds || [];
      if (o.status !== 'open' || accepted.length >= wanted) throw new HttpError(409, 'This opportunity is already filled.');
      const keys = o.dateKeys || (o.dates || []).map(d => d.date);
      if (!(r.dates || []).includes(date) || !keys.includes(date)) throw bad('Pick one of the dates this presenter can do.');
      if (o.bookedDate && o.bookedDate !== date) throw bad(`The date is already set to ${o.bookedDate} for the other presenters.`);
      const when = (o.dates || []).find(d => d.date === date) || {};
      const loc = p.location || {};
      const patch = {
        status: 'confirmed', date, startTime: when.startTime || '', endTime: when.endTime || '',
        expectedStudents: students, decidedAt: stamp(), updatedAt: stamp()
      };
      if (note) patch.teacherNote = note;
      if (loc.address) {
        patch.location = { address: loc.address, room: loc.room || '', phone: (p.teacher && p.teacher.phone) || '', arrivalNotes: loc.arrivalNotes || '' };
      }
      const ids = [...new Set([...accepted, rs.id])];
      const oPatch = { acceptedRequestIds: ids, bookedDate: o.bookedDate || date, updatedAt: stamp() };
      if (ids.length >= wanted) { oPatch.status = 'booked'; filled = true; }
      tx.update(req.ref, patch);
      tx.update(oppRef, oPatch);
    });
    const declined = filled ? await declinePending(db, p.opportunityId, req.data.id, DECLINE_NOTES.filled) : 0;
    return { ...(await fullView(db, post)), declined };
  }

  if (action === 'emailed') {
    if (req.data.status !== 'confirmed') throw new HttpError(409, 'Only an accepted visit has an email to send.');
    await req.ref.update({ emailedAt: stamp(), updatedAt: stamp() });
    return fullView(db, post);
  }

  if (action === 'cancel') {
    if (req.data.status !== 'confirmed') throw new HttpError(409, 'Only an accepted visit can be cancelled.');
    await req.ref.update({ status: 'cancelled', decidedAt: stamp(), updatedAt: stamp() });
    await db.runTransaction(async (tx) => {
      const os = await tx.get(oppRef);
      if (!os.exists) return;
      const o = os.data();
      const left = (o.acceptedRequestIds || []).filter(x => x !== req.data.id);
      const oPatch = { acceptedRequestIds: left, updatedAt: stamp() };
      if (!left.length) oPatch.bookedDate = null;
      const today = todayIn(TZ, now);
      const ahead = (o.dates || []).some(d => d.date >= today);
      if (o.status === 'booked' && ahead) oPatch.status = 'open';
      tx.update(oppRef, oPatch);
    });
    return fullView(db, post);
  }

  throw bad('Unknown action.');
}

/* ---------------- HTTP wrapper ---------------- */

async function notifyAdmins(db, notif) {
  const snap = await db.collection('users').where('role', '==', 'admin').get();
  const uids = snap.docs.map(d => d.id);
  if (!uids.length) return 0;
  return notifyUsers(db, getMessaging(), uids, notif, 'engage', 'engage-guest');
}

const engageGuest = onRequest({
  cors: true,
  maxInstances: 3,
  memory: '256MiB',
  timeoutSeconds: 30,
}, async (req, res) => {
  if (req.method === 'GET') { res.status(200).send('engageGuest ok'); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const db = getFirestore();
  try {
    const out = await handle(db, body, { ip, now: new Date(), notifyAdmins: (n) => notifyAdmins(db, n) });
    res.status(200).json(out);
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
    console.error('[engageGuest]', body.action, e);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again, or email the McGhee Lab.' });
  }
});

module.exports = { engageGuest, handle, cleanPost, todayIn, HttpError, MANAGE_BASE, DECLINE_NOTES };
