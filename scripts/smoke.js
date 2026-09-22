'use strict';

// End-to-end smoke test against a running server:
//   node scripts/smoke.js https://your-app.onrender.com
// Loads the home page, creates a room, joins it, deals, and checks both
// players receive a 7-card hand over the live event stream.

// Minimal Server-Sent Events client on top of fetch.
class EventStream {
  constructor(url) {
    this.url = url;
    this.events = [];
    this.waiters = [];
    this.controller = new AbortController();
  }

  async open() {
    const res = await fetch(this.url, {
      headers: { Accept: 'text/event-stream' },
      signal: this.controller.signal,
    });
    if (!res.ok) throw new Error(`Event stream returned HTTP ${res.status}`);
    this.pump(res.body.pipeThrough(new TextDecoderStream()).getReader());
    return this;
  }

  async pump(reader) {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n/g, '\n');
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length) this.push({ event, data: JSON.parse(data.join('\n')) });
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.error = err;
    }
  }

  push(evt) {
    this.events.push(evt);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(evt)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(evt);
      }
    }
  }

  // Resolves with the first event (already received or future) matching `match`.
  waitFor(match, timeoutMs = 15_000, what = 'event') {
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeoutMs);
      this.waiters.push({ match, resolve: (evt) => { clearTimeout(timer); resolve(evt); } });
    });
  }

  close() {
    this.controller.abort();
  }
}

async function api(base, method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(new URL(path, base), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error || 'no body'}`);
  return json;
}

async function fetchWithWake(url, { attempts = 12, log }) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (i >= attempts) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i >= attempts) throw err;
    }
    log(`  waiting for the server to wake up (attempt ${i})...`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function runSmoke(base, { log = console.log, wakeAttempts = 12 } = {}) {
  const streams = [];
  const tokens = [];
  let code;
  try {
    const home = await fetchWithWake(new URL('/', base), { attempts: wakeAttempts, log });
    const html = await home.text();
    if (!/<title>[^<]*Runo/i.test(html)) throw new Error('Home page did not look like Runo');
    log('ok  home page loads');

    const health = await fetch(new URL('/api/health', base));
    if (health.status !== 200) throw new Error(`/api/health returned ${health.status}`);
    log('ok  /api/health returns 200');

    const host = await api(base, 'POST', '/api/rooms', { name: 'Smoke Host' });
    code = host.code;
    tokens.push(host.token);
    const guest = await api(base, 'POST', `/api/rooms/${code}/join`, { name: 'Smoke Guest' });
    tokens.push(guest.token);
    log(`ok  created room ${code} and joined a second player`);

    for (const player of [host, guest]) {
      const url = new URL(`/api/rooms/${code}/events`, base);
      url.searchParams.set('token', player.token);
      streams.push(await new EventStream(url).open());
    }
    const bothOnline = (e) => e.event === 'state' && e.data.players.length === 2 && e.data.players.every((p) => p.online);
    await streams[0].waitFor(bothOnline, 15_000, 'both players online');
    log('ok  both players connected to the live stream');

    await api(base, 'POST', `/api/rooms/${code}/actions`, { type: 'deal' }, host.token);
    log('ok  host dealt');

    const hands = await Promise.all(
      streams.map((s) => s.waitFor((e) => e.event === 'state' && e.data.phase === 'playing' && e.data.game, 15_000, 'dealt state')),
    );
    hands.forEach((evt, i) => {
      const snap = evt.data;
      if (snap.game.hand.length !== 7) throw new Error(`player ${i + 1} got ${snap.game.hand.length} cards`);
      if (!snap.players.every((p) => p.cardCount === 7)) throw new Error('card counts are not all 7');
      if (!/^[0-9]$/.test(snap.game.topCard.value)) throw new Error('starting discard is not a number card');
    });
    const [a, b] = hands.map((e) => new Set(e.data.game.hand.map((c) => c.id)));
    if ([...a].some((id) => b.has(id))) throw new Error('players share card ids');
    log('ok  both players received their own 7-card hand over the event stream');
    return { code };
  } finally {
    // Clean up: leaving as each player deletes the room.
    for (const token of tokens) {
      await api(base, 'POST', `/api/rooms/${code}/actions`, { type: 'leave' }, token).catch(() => {});
    }
    for (const s of streams) s.close();
  }
}

if (require.main === module) {
  const base = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:3000';
  console.log(`Smoke testing ${base}`);
  runSmoke(base).then(
    () => console.log('Smoke test passed.'),
    (err) => {
      console.error(`Smoke test FAILED: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = { runSmoke, EventStream, api };
