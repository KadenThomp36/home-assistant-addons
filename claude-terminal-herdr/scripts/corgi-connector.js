#!/usr/bin/env node
// corgi-connector — zero-dependency per-server daemon for Corgi (herdr remote management).
// Runs next to a herdr server. Exposes over HTTP (bearer-token auth):
//   GET  /health                     server + herdr liveness
//   POST /rpc        {method,params} one NDJSON round-trip to herdr.sock
//   GET  /events?subs=<json>         SSE stream of herdr subscription events
//   GET  /transcripts                list of *.jsonl transcript files
//   GET  /transcript?path=&offset=&limit=   raw bytes of a transcript from offset
//   GET  /transcript-stream?path=&offset=   SSE of complete new lines as they are appended
//   GET  /skills                     Claude skills/commands available on this machine
//
// Config via env:
//   CORGI_TOKEN     (required) shared secret
//   CORGI_PORT      default 9130
//   CORGI_BIND      default 0.0.0.0
//   HERDR_SOCK      default ~/.config/herdr/herdr.sock
//   CLAUDE_PROJECTS default ~/.claude/projects

'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TOKEN = process.env.CORGI_TOKEN;
if (!TOKEN) { console.error('CORGI_TOKEN is required'); process.exit(1); }
const PORT = Number(process.env.CORGI_PORT || 9130);
const BIND = process.env.CORGI_BIND || '0.0.0.0';
const HOME = os.homedir();
const SOCK = process.env.HERDR_SOCK || path.join(HOME, '.config/herdr/herdr.sock');
const PROJECTS = process.env.CLAUDE_PROJECTS || path.join(HOME, '.claude/projects');
const MAX_CHUNK = 4 * 1024 * 1024; // max transcript bytes per request

function tokenOk(req, url) {
  const h = req.headers.authorization || '';
  const supplied = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || '');
  if (supplied.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// One NDJSON request/response round trip against herdr.sock (herdr closes after replying).
function herdrRpc(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('herdr rpc timeout')); }, timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: 'corgi', method, params: params || {} }) + '\n');
    });
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        sock.destroy();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('close', () => { clearTimeout(timer); if (!buf.includes('\n')) reject(new Error('herdr closed connection')); });
  });
}

function listTranscripts() {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(abs);
          out.push({ path: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch { /* raced with deletion */ }
      }
    }
  };
  walk(PROJECTS, '', 0);
  return out;
}

function safeTranscriptPath(rel) {
  const abs = path.resolve(PROJECTS, rel);
  if (!abs.startsWith(path.resolve(PROJECTS) + path.sep)) return null;
  if (!abs.endsWith('.jsonl')) return null;
  return abs;
}

function parseSkillMd(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return null; }
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : '';
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1];
  const description = (fm.match(/^description:\s*(.+)$/m) || [])[1];
  return { name: (name || path.basename(path.dirname(file))).trim(), description: (description || '').trim().slice(0, 300) };
}

function listSkills() {
  const out = [];
  const seen = new Set();
  const addFrom = (root, source, depth) => {
    const walk = (dir, d) => {
      if (d > depth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, d + 1);
        else if (e.name === 'SKILL.md') {
          const s = parseSkillMd(abs);
          if (s && !seen.has(s.name)) { seen.add(s.name); out.push({ ...s, source }); }
        }
      }
    };
    walk(root, 0);
  };
  addFrom(path.join(HOME, '.claude/skills'), 'user', 2);
  addFrom(path.join(HOME, '.claude/plugins/cache'), 'plugin', 5);
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!tokenOk(req, url)) return json(res, 401, { error: 'unauthorized' });

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      let herdr = null;
      try {
        const r = await herdrRpc('ping', {}, 3000);
        herdr = r.result || null;
      } catch { /* herdr down; still healthy as a connector */ }
      return json(res, 200, { ok: true, host: os.hostname(), herdr, projects: PROJECTS, now: Date.now() });
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const { method, params, timeout_ms } = JSON.parse(body);
          if (typeof method !== 'string') return json(res, 400, { error: 'method required' });
          const r = await herdrRpc(method, params, Math.min(Number(timeout_ms) || 30000, 120000));
          return json(res, 200, r);
        } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      let subs;
      try { subs = JSON.parse(url.searchParams.get('subs') || '[]'); } catch { return json(res, 400, { error: 'bad subs' }); }
      if (!Array.isArray(subs) || subs.length === 0) return json(res, 400, { error: 'subs required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(':ok\n\n');
      const sock = net.connect(SOCK);
      let buf = '';
      sock.on('connect', () => {
        sock.write(JSON.stringify({ id: 'corgi-ev', method: 'events.subscribe', params: { subscriptions: subs } }) + '\n');
      });
      sock.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) res.write('data: ' + line + '\n\n');
        }
      });
      const bye = () => { try { sock.destroy(); } catch {} try { res.end(); } catch {} clearInterval(hb); };
      const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { bye(); } }, 15000);
      sock.on('error', bye);
      sock.on('close', bye);
      req.on('close', bye);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/transcripts') {
      return json(res, 200, { files: listTranscripts() });
    }

    if (req.method === 'GET' && url.pathname === '/skills') {
      return json(res, 200, { skills: listSkills() });
    }

    if (req.method === 'GET' && url.pathname === '/transcript-stream') {
      const abs = safeTranscriptPath(url.searchParams.get('path') || '');
      if (!abs) return json(res, 400, { error: 'bad path' });
      let offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      let partial = ''; // carry incomplete trailing line between polls
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(':ok\n\n');
      let busy = false;
      const pump = () => {
        if (busy) return;
        busy = true;
        fs.stat(abs, (err, st) => {
          if (err || st.size <= offset) { busy = false; return; }
          const stream = fs.createReadStream(abs, { start: offset, end: st.size - 1 });
          let buf = '';
          stream.on('data', (d) => { buf += d; });
          stream.on('end', () => {
            offset = st.size;
            const chunk = partial + buf;
            const lines = chunk.split('\n');
            partial = lines.pop();
            const complete = lines.filter((l) => l.trim());
            if (complete.length) {
              try { res.write('data: ' + JSON.stringify({ offset, lines: complete }) + '\n\n'); } catch {}
            }
            busy = false;
          });
          stream.on('error', () => { busy = false; });
        });
      };
      const poll = setInterval(pump, 700);
      const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { bye(); } }, 15000);
      let watcher = null;
      try { watcher = fs.watch(abs, pump); } catch { /* poll covers it */ }
      const bye = () => { clearInterval(poll); clearInterval(hb); watcher?.close(); try { res.end(); } catch {} };
      req.on('close', bye);
      pump();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/transcript') {
      const abs = safeTranscriptPath(url.searchParams.get('path') || '');
      if (!abs) return json(res, 400, { error: 'bad path' });
      let st;
      try { st = fs.statSync(abs); } catch { return json(res, 404, { error: 'not found' }); }
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const limit = Math.min(Number(url.searchParams.get('limit') || MAX_CHUNK), MAX_CHUNK);
      const end = Math.min(st.size, offset + limit);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-file-size': String(st.size),
        'x-next-offset': String(end),
      });
      if (end <= offset) return res.end();
      fs.createReadStream(abs, { start: offset, end: end - 1 }).pipe(res);
      return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    try { json(res, 500, { error: String(e.message || e) }); } catch {}
  }
});

server.listen(PORT, BIND, () => {
  console.log(`corgi-connector listening on ${BIND}:${PORT} (herdr: ${SOCK}, projects: ${PROJECTS})`);
});
