'use strict';

// HTTP layer: JSON API, Server-Sent Events for live state, and the static
// frontend. Everything game-related lives in rooms.js / game.js.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { RoomManager } = require('./rooms');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 4 * 1024;
const HEARTBEAT_MS = 20_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- CORS -------------------------------------------------------------------

function parseAllowedOrigins(env) {
  const exact = new Set();
  const configured = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const origin of configured) exact.add(origin.replace(/\/+$/, ''));
  if (env.RENDER_EXTERNAL_URL) exact.add(env.RENDER_EXTERNAL_URL.replace(/\/+$/, ''));
  // With no explicit list, any localhost origin is allowed.
  return { exact, anyLocalhost: configured.length === 0 };
}

function isOriginAllowed(req, origin, allowed) {
  if (!origin) return true; // not a browser cross-origin request
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === req.headers.host) return true; // same origin
  if (allowed.exact.has(parsed.origin)) return true;
  return allowed.anyLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

// ---- rate limiting ------------------------------------------------------------

// Token bucket per client IP.
function createRateLimiter({ capacity = 60, refillPerSecond = 3, now = Date.now } = {}) {
  const buckets = new Map();
  return {
    allow(key) {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, at: t };
        buckets.set(key, bucket);
      }
      bucket.tokens = Math.min(capacity, bucket.tokens + ((t - bucket.at) / 1000) * refillPerSecond);
      bucket.at = t;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    prune() {
      const t = now();
      for (const [key, bucket] of buckets) {
        if (t - bucket.at > 10 * 60_000) buckets.delete(key);
      }
    },
  };
}

function clientIp(req) {
  const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return String(forwarded).trim() || req.socket.remoteAddress || 'unknown';
}

// ---- helpers --------------------------------------------------------------------

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'Request body is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (size === 0) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Request body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// ---- app --------------------------------------------------------------------------

function createApp({ manager = new RoomManager(), env = process.env, rateLimit } = {}) {
  const allowedOrigins = parseAllowedOrigins(env);
  const limiter = createRateLimiter(rateLimit);
  const streams = new Set();

  async function handleApi(req, res, url) {
    const origin = req.headers.origin;
    const corsHeaders = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (!isOriginAllowed(req, origin, allowedOrigins)) {
      return sendJson(res, 403, { error: 'This origin is not allowed.' }, { Vary: 'Origin' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    const route = url.pathname;
    if (route === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, rooms: manager.rooms.size }, corsHeaders);
    }

    if (!limiter.allow(clientIp(req))) {
      return sendJson(res, 429, { error: 'Too many requests. Slow down a little.' }, { ...corsHeaders, 'Retry-After': '5' });
    }

    try {
      if (route === '/api/lobbies' && req.method === 'GET') {
        return sendJson(res, 200, { lobbies: manager.lobbies() }, corsHeaders);
      }
      if (route === '/api/rooms' && req.method === 'POST') {
        const body = await readJson(req);
        const { room, player } = manager.createRoom(body.name);
        return sendJson(res, 201, { code: room.code, playerId: player.id, token: player.token, name: player.name }, corsHeaders);
      }

      const match = route.match(/^\/api\/rooms\/([0-9A-Fa-f]{6})\/(join|events|actions|state)$/);
      if (!match) throw new HttpError(404, 'Not found.');
      const [, code, endpoint] = match;

      if (endpoint === 'join' && req.method === 'POST') {
        const body = await readJson(req);
        const { room, player } = manager.joinRoom(code, body.name);
        return sendJson(res, 201, { code: room.code, playerId: player.id, token: player.token, name: player.name }, corsHeaders);
      }
      if (endpoint === 'events' && req.method === 'GET') {
        return openStream(req, res, code, url.searchParams.get('token'), corsHeaders);
      }
      if (endpoint === 'state' && req.method === 'GET') {
        const { room, player } = manager.session(code, bearerToken(req));
        return sendJson(res, 200, manager.snapshot(room, player), corsHeaders);
      }
      if (endpoint === 'actions' && req.method === 'POST') {
        const body = await readJson(req);
        const { room, player } = manager.session(code, bearerToken(req) || body.token);
        manager.perform(room, player, body);
        return sendJson(res, 200, { ok: true }, corsHeaders);
      }
      throw new HttpError(405, 'Method not allowed.');
    } catch (err) {
      if (err.status) {
        const headers = err.status === 413 ? { ...corsHeaders, Connection: 'close' } : corsHeaders;
        return sendJson(res, err.status, { error: err.message, code: err.code }, headers);
      }
      console.error(err);
      return sendJson(res, 500, { error: 'Something went wrong on the server.' }, corsHeaders);
    }
  }

  function openStream(req, res, code, token, corsHeaders) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    });
    res.write('retry: 3000\n\n');

    let session;
    try {
      session = manager.session(code, token);
    } catch (err) {
      res.end(`event: expired\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      return;
    }
    const { room, player } = session;

    let closed = false;
    const conn = {
      send(event, data) {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close() {
        if (closed) return;
        closed = true;
        res.end();
      },
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    streams.add(conn);

    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      streams.delete(conn);
      manager.disconnect(room, player, conn);
    });
    manager.connect(room, player, conn);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      relative = '/';
    }
    if (relative === '/' || relative === '') relative = '/index.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(404, SECURITY_HEADERS);
      return res.end('Not found');
    }
    try {
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found');
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url.pathname);
    handler.catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
      else res.end();
    });
  });

  const timers = [
    setInterval(() => manager.sweep(), 60_000),
    setInterval(() => limiter.prune(), 60_000),
  ];
  for (const t of timers) t.unref();
  server.on('close', () => timers.forEach(clearInterval));

  // Ends open event streams so server.close() can finish.
  server.closeStreams = () => {
    for (const conn of streams) conn.close();
  };

  return { server, manager };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApp();
  server.listen(port, () => console.log(`Runo is running at http://localhost:${port}`));
  const shutdown = () => {
    server.closeStreams();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp, createRateLimiter, isOriginAllowed, parseAllowedOrigins };
