#!/usr/bin/env node
/* scientia_hub_dev.js — a local stand-in for the scientiaHub Cloud Function (V3.857).
   Same routes, same merge rules (functions/scientia-hub-core.js), in memory, one person.
   Used to run rm/scientia/scientia-cloud.py end to end against Gabe's real serve.py:

     node scripts/scientia_hub_dev.js                # http://127.0.0.1:8767
     DEV_OPEN=1 … (no auth at all)   PORT=…          # a bearer token of any value = the browser;
                                                     # X-Scientia-Key: sck_dev_<secret> = a key made via /api/cloud/key
   GET /files/<path> serves uploaded media. Nothing is written to disk. */
'use strict';
const http = require('http');
const C = require('../functions/scientia-hub-core');

const PORT = Number(process.env.PORT || 8767);
const hub = new C.MemoryHub(); hub.fileBase = 'http://127.0.0.1:' + PORT;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (status, body) => { const b = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Access-Control-Allow-Origin': '*' }); res.end(b); };
  try {
    if (u.pathname.startsWith('/files/')) {
      const f = hub.media.get(decodeURIComponent(u.pathname.slice(7))); if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.bytes.length }); res.end(f.bytes); return;
    }
    let who = null; const key = req.headers['x-scientia-key'], bearer = req.headers.authorization;
    if (bearer) who = { uid: 'dev', id: 'web', name: 'Online', kind: 'browser' };
    else if (key) { const m = /^sck_dev_([0-9a-f]{32})$/.exec(String(key)); const k = m && await hub.keyFind(m[1]); if (k) who = { uid: 'dev', id: k.id, name: k.name, kind: 'key' }; else return json(401, { ok: false, error: 'this key is not valid any more' }); }
    else if (process.env.DEV_OPEN) who = { uid: 'dev', id: 'web', name: 'Online', kind: 'browser' };
    if (!who && u.pathname !== '/api/sync/hello') return json(401, { ok: false, error: 'not signed in' });
    let body; const ct = String(req.headers['content-type'] || '');
    if (raw.length && ct.includes('json')) { try { body = JSON.parse(raw.toString('utf8')); } catch (e) { body = null; } }
    const query = {}; u.searchParams.forEach((v, k) => { query[k] = v; });
    const out = await C.route({ method: req.method, path: u.pathname, query, body, rawBody: raw, headers: req.headers }, { hub, who });
    json(out.status, out.body);
  } catch (e) { console.error(e); json(500, { ok: false, error: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => console.log('scientia dev hub on http://127.0.0.1:' + PORT + ' (sid ' + hub.st.sid + ')'));
