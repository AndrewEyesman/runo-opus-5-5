'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/index');
const { runSmoke, EventStream, api } = require('../scripts/smoke');

async function start(options = {}) {
  const app = createApp({ env: {}, ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app,
    base,
    async stop() {
      app.server.closeStreams();
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    },
  };
}

test('smoke: home page, create, join, deal, hands over the event stream', async () => {
  const app = await start();
  try {
    await runSmoke(app.base, { log: () => {}, wakeAttempts: 1 });
    assert.equal(app.manager.rooms.size, 0, 'smoke test cleans up after itself');
  } finally {
    await app.stop();
  }
});

test('an unknown session gets an "expired" event instead of a broken stream', async () => {
  const app = await start();
  try {
    const stream = await new EventStream(`${app.base}/api/rooms/ABCDEF/events?token=nope`).open();
    const evt = await stream.waitFor((e) => e.event === 'expired', 5000);
    assert.match(evt.data.message, /no longer available/);
    stream.close();
    const res = await fetch(`${app.base}/api/rooms/ABCDEF/state`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'session_expired');
  } finally {
    await app.stop();
  }
});

test('illegal actions are rejected with a readable error', async () => {
  const app = await start();
  try {
    const host = await api(app.base, 'POST', '/api/rooms', { name: 'Ada' });
    const guest = await api(app.base, 'POST', `/api/rooms/${host.code}/join`, { name: 'Bea' });
    const post = (token, body) =>
      fetch(`${app.base}/api/rooms/${host.code}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    let res = await post(guest.token, { type: 'deal' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'Only the host can deal.');
    res = await post(host.token, { type: 'deal' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Waiting for Ada, Bea to reconnect/);
    res = await post(host.token, { type: 'fly' });
    assert.equal((await res.json()).error, 'Unknown action.');
  } finally {
    await app.stop();
  }
});

test('CORS: same origin and allowed origins pass, others are refused', async () => {
  const app = await start({
    env: { ALLOWED_ORIGINS: 'https://friends.example', RENDER_EXTERNAL_URL: 'https://runo.onrender.com' },
  });
  try {
    const lobbies = (origin) => fetch(`${app.base}/api/lobbies`, { headers: { Origin: origin } });
    assert.equal((await lobbies('https://evil.example')).status, 403);
    assert.equal((await lobbies('http://localhost:5173')).status, 403, 'localhost only by default');
    const allowed = await lobbies('https://friends.example');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://friends.example');
    assert.equal((await lobbies('https://runo.onrender.com')).status, 200);
    assert.equal((await lobbies(app.base)).status, 200, 'the server\'s own origin');

    const preflight = await fetch(`${app.base}/api/rooms`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://friends.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
  } finally {
    await app.stop();
  }

  const local = await start();
  try {
    const res = await fetch(`${local.base}/api/lobbies`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(res.status, 200, 'default allows localhost');
  } finally {
    await local.stop();
  }
});

test('oversized bodies and floods are refused', async () => {
  const app = await start({ rateLimit: { capacity: 5, refillPerSecond: 0.001 } });
  try {
    const big = await fetch(`${app.base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(10_000) }),
    });
    assert.equal(big.status, 413);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(`${app.base}/api/lobbies`)).status);
    assert.equal(statuses.at(-1), 429);
    assert.equal((await fetch(`${app.base}/api/health`)).status, 200, 'health is never rate limited');
  } finally {
    await app.stop();
  }
});

test('static files are served and path traversal is blocked', async () => {
  const app = await start();
  try {
    const home = await fetch(`${app.base}/?room=A1B2C3`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${app.base}/app.js`)).status, 200);
    assert.equal((await fetch(`${app.base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/%2e%2e/server/index.js`)).status, 404);
  } finally {
    await app.stop();
  }
});
