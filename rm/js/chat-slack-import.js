/* ================================================================
   chat-slack-import.js — Slack copy-paste chat-log parser (V3.582)
   ================================================================
   Slack doesn't export DMs, so users copy the whole conversation and
   paste it into a .md/.txt file. This module turns that paste into an
   ordered message list ready for the chatImportSlackHistory Cloud
   Function. Pure parsing — no DOM, no Firestore — so it's testable
   standalone (node -e "...").

   Format (validated against a real 6k-line Slack paste):
     Name  [3:42 PM]        ← header: name, ≥2 spaces, bracketed time
     body line(s)…          ← accumulate verbatim (attachment noise
                              like "Zip" / "SP 240809.zip" is KEPT —
                              no lossy filtering)
     [3:45 PM]              ← bare time = new message, same author
     more body…

   Slack pastes carry clock times only (no dates), so times are parsed
   but ultimately dropped by the importer — order is what matters.
   A file that starts mid-message (no header yet) attributes that text
   to the '(unknown)' participant, which flows through the mapping
   step like any other name.

   Public surface:
     CHAT_SLACK_IMPORT.parse(text) →
       { ok, messages:[{author, time, text}],
         participants:[{name, count, isPseudo}], warnings:[], errors:[] }
     CHAT_SLACK_IMPORT.applyMapping(parsed, mapping) →
       [{authorUid, authorName, text}]
       // mapping: { slackName → {uid|null, displayName} | 'SKIP' }
   ================================================================ */
(function () {
  'use strict';

  const UNKNOWN = '(unknown)';
  const HEADER_RE = /^(.+?)\s{2,}\[(\d{1,2}:\d{2}\s?[AP]M)\]\s*$/;
  const CONT_RE = /^\[(\d{1,2}:\d{2}\s?[AP]M)\]\s*$/;
  // Slack system notices that parse as author names — the mapping UI
  // defaults these to "Don't import".
  const PSEUDO_RE = /^(A huddle happened|You missed a huddle|.* joined\.?|.* left\.?)$/i;

  function parse(text) {
    const out = { ok: false, messages: [], participants: [], warnings: [], errors: [] };
    if (typeof text !== 'string' || !text.trim()) {
      out.errors.push('Nothing to parse — the file/paste is empty.');
      return out;
    }

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let cur = null;           // { author, time, lines: [] }
    let curAuthor = UNKNOWN;  // carries across bare-time continuations
    const raw = [];
    const push = () => { if (cur) { raw.push(cur); cur = null; } };

    for (const line of lines) {
      const h = line.match(HEADER_RE);
      if (h) {
        push();
        curAuthor = h[1].trim();
        cur = { author: curAuthor, time: h[2], lines: [] };
        continue;
      }
      const c = line.match(CONT_RE);
      if (c) {
        push();
        cur = { author: curAuthor, time: c[1], lines: [] };
        continue;
      }
      // Orphan leading body (file starts mid-message): open an
      // '(unknown)' message so nothing is silently dropped.
      if (!cur) cur = { author: UNKNOWN, time: '', lines: [] };
      cur.lines.push(line);
    }
    push();

    let dropped = 0;
    for (const m of raw) {
      // Trim trailing whitespace per line, then strip leading/trailing
      // blank lines. Interior blank lines survive (multi-paragraph
      // messages are real in the sample).
      const body = m.lines.map((l) => l.replace(/\s+$/, ''));
      while (body.length && !body[0]) body.shift();
      while (body.length && !body[body.length - 1]) body.pop();
      const textOut = body.join('\n');
      if (!textOut) { dropped++; continue; }
      out.messages.push({ author: m.author, time: m.time, text: textOut });
    }

    if (dropped) out.warnings.push(`${dropped} empty message${dropped === 1 ? '' : 's'} dropped.`);
    if (!out.messages.length) {
      out.errors.push('No messages found — is this a Slack copy-paste? Expected lines like "Name  [3:42 PM]".');
      return out;
    }

    const counts = new Map();
    for (const m of out.messages) counts.set(m.author, (counts.get(m.author) || 0) + 1);
    out.participants = [...counts.entries()].map(([name, count]) => ({
      name,
      count,
      isPseudo: PSEUDO_RE.test(name),
    }));

    out.ok = true;
    return out;
  }

  /* mapping: { slackName → {uid: string|null, displayName: string} | 'SKIP' }
     Unmapped names fall back to name-only (uid:null, Slack name kept).
     'SKIP' drops that participant's messages; order of the rest holds. */
  function applyMapping(parsed, mapping) {
    const outMsgs = [];
    for (const m of (parsed && parsed.messages) || []) {
      const entry = mapping ? mapping[m.author] : null;
      if (entry === 'SKIP') continue;
      if (entry && typeof entry === 'object') {
        outMsgs.push({
          authorUid: entry.uid || null,
          authorName: entry.displayName || m.author,
          text: m.text,
        });
      } else {
        outMsgs.push({ authorUid: null, authorName: m.author, text: m.text });
      }
    }
    return outMsgs;
  }

  const api = { parse, applyMapping, UNKNOWN };
  if (typeof window !== 'undefined') window.CHAT_SLACK_IMPORT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node tests
})();
