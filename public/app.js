'use strict';

(() => {
  // ---- tiny helpers ------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Builds DOM nodes. Strings are always inserted as text, never as HTML.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'style') Object.assign(el.style, value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    set(key, value) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch { /* storage unavailable: session just won't survive a reload */ }
    },
  };

  const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
  const VALUE_LABELS = { skip: 'Skip', reverse: 'Reverse', draw2: '+2', wild: 'Wild', wild4: 'Wild +4' };
  const FACE = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '', wild4: '+4' };
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, null: 4 };
  const VALUE_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2', 'wild', 'wild4'];

  const cardLabel = (c) =>
    c.color ? `${COLOR_NAMES[c.color]} ${VALUE_LABELS[c.value] ?? c.value}` : VALUE_LABELS[c.value];

  // ---- state -------------------------------------------------------------------

  const S = {
    session: store.get('runo:session'), // { code, token, playerId, name }
    snap: null,
    conn: 'idle',
    es: null,
    retry: 0,
    retryTimer: null,
    busy: false,
    tab: 'players',
    panelOpen: false,
    seenLogId: null,
    seenChatId: 0,
    unread: 0,
    prevHand: new Set(),
    prevTop: null,
    wasMyTurn: false,
    wildCardId: null,
    lobbyTimer: null,
  };

  // ---- sound ---------------------------------------------------------------------

  const Sound = {
    enabled: store.get('runo:sound') !== false,
    ctx: null,
    unlock() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    },
    tone(freq, at, dur, { type = 'triangle', gain = 0.14, to = null } = {}) {
      const ctx = this.ctx;
      const t = ctx.currentTime + at;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },
    play(name) {
      // Nothing plays until the player has interacted with the page.
      if (!this.enabled || !this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const T = (...a) => this.tone(...a);
      switch (name) {
        case 'deal':
          for (let i = 0; i < 7; i++) T(700 + i * 60, i * 0.055, 0.05, { type: 'square', gain: 0.05 });
          break;
        case 'play':
          T(240, 0, 0.14, { to: 110, gain: 0.2 });
          break;
        case 'draw':
          T(320, 0, 0.16, { type: 'sine', to: 640, gain: 0.12 });
          break;
        case 'penalty':
          T(220, 0, 0.18, { type: 'sawtooth', to: 140, gain: 0.08 });
          T(180, 0.18, 0.22, { type: 'sawtooth', to: 110, gain: 0.08 });
          break;
        case 'runo':
          T(660, 0, 0.12, { type: 'square', gain: 0.07 });
          T(990, 0.12, 0.22, { type: 'square', gain: 0.07 });
          break;
        case 'turn':
          T(880, 0, 0.35, { type: 'sine', gain: 0.12 });
          T(1320, 0.05, 0.3, { type: 'sine', gain: 0.05 });
          break;
        case 'win':
          [523, 659, 784, 1047].forEach((f, i) => T(f, i * 0.11, 0.3, { gain: 0.13 }));
          break;
        case 'end':
          T(392, 0, 0.2, { gain: 0.1 });
          T(330, 0.18, 0.3, { gain: 0.1 });
          break;
      }
    },
  };

  function unlockAudio() {
    Sound.unlock();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  }
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  function renderSoundToggles() {
    for (const btn of $$('.sound-toggle')) {
      btn.textContent = Sound.enabled ? 'Sound on' : 'Sound off';
      btn.setAttribute('aria-pressed', String(Sound.enabled));
    }
  }

  // ---- toasts & dialogs ---------------------------------------------------------------

  function toast(message, kind = 'error') {
    const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  for (const btn of $$('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());

  function confirmDialog({ title, body, ok }) {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    $('#confirm-ok').textContent = ok;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => {
      const onOk = () => dlg.close('ok');
      $('#confirm-ok').addEventListener('click', onOk, { once: true });
      dlg.addEventListener('close', () => {
        $('#confirm-ok').removeEventListener('click', onOk);
        resolve(dlg.returnValue === 'ok');
      }, { once: true });
    });
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast(done, 'info');
  }

  const inviteLink = (code) => `${location.origin}/?room=${code}`;

  // ---- API -----------------------------------------------------------------------------

  async function request(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { code: data.code });
    return data;
  }

  async function act(type, extra = {}) {
    if (!S.session) return false;
    try {
      await request('POST', `/api/rooms/${S.session.code}/actions`, { type, ...extra }, S.session.token);
      return true;
    } catch (err) {
      if (err.code === 'session_expired') endSession(err.message);
      else toast(err.message);
      return false;
    }
  }

  // ---- session & live connection ---------------------------------------------------------

  function startSession(data) {
    S.session = { code: data.code, token: data.token, playerId: data.playerId, name: data.name };
    store.set('runo:session', S.session);
    S.snap = null;
    S.seenLogId = null;
    S.seenChatId = 0;
    S.unread = 0;
    S.prevHand = new Set();
    S.prevTop = null;
    S.wasMyTurn = false;
    history.replaceState(null, '', `/?room=${data.code}`);
    connect();
    render();
  }

  function endSession(message) {
    disconnect();
    S.session = null;
    S.snap = null;
    store.set('runo:session', null);
    history.replaceState(null, '', '/');
    for (const dlg of $$('dialog[open]')) dlg.close();
    showNotice(message);
    render();
  }

  function disconnect() {
    clearTimeout(S.retryTimer);
    if (S.es) {
      S.es.close();
      S.es = null;
    }
    setConn('idle');
  }

  function connect() {
    if (!S.session) return;
    clearTimeout(S.retryTimer);
    if (S.es) S.es.close();
    setConn(S.snap ? 'reconnecting' : 'connecting');
    const { code, token } = S.session;
    const es = new EventSource(`/api/rooms/${code}/events?token=${encodeURIComponent(token)}`);
    S.es = es;

    es.addEventListener('state', (e) => {
      if (S.es !== es) return;
      S.retry = 0;
      setConn('connected');
      onState(JSON.parse(e.data));
    });
    const bail = (fallback) => (e) => {
      if (S.es !== es) return;
      let message = fallback;
      try { message = JSON.parse(e.data).message || fallback; } catch { /* keep fallback */ }
      endSession(message);
    };
    es.addEventListener('expired', bail('That room is gone. The server may have restarted or gone to sleep.'));
    es.addEventListener('removed', bail('The host removed you from the room.'));
    es.addEventListener('left', bail(''));
    es.onerror = () => {
      if (S.es !== es) return;
      es.close();
      S.es = null;
      setConn('reconnecting');
      const delay = Math.min(1000 * 2 ** S.retry, 10_000);
      S.retry++;
      S.retryTimer = setTimeout(connect, delay);
    };
  }

  function setConn(state) {
    S.conn = state;
    const el = $('#conn');
    const labels = { idle: '', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…' };
    el.textContent = labels[state];
    el.className = `conn ${state}`;
    document.body.classList.toggle('is-reconnecting', state === 'reconnecting');
  }

  // Page came back from the background: make sure the stream is alive.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (S.session && !S.es) connect();
    if (!S.session) refreshLobbies();
  });

  // ---- incoming state --------------------------------------------------------------------

  function onState(snap) {
    const prev = S.snap;
    S.snap = snap;
    playCues(prev, snap);
    const newChat = snap.chat.filter((m) => m.id > S.seenChatId && m.playerId !== snap.you).length;
    if (!chatVisible()) S.unread += prev ? newChat : 0;
    S.seenChatId = snap.chat.length ? snap.chat.at(-1).id : S.seenChatId;
    if (S.wildCardId && !(snap.game && snap.game.hand.some((c) => c.id === S.wildCardId) && snap.game.turnId === snap.you)) {
      $('#dlg-wild').close();
      S.wildCardId = null;
    }
    render();
  }

  function playCues(prev, snap) {
    const fresh = S.seenLogId === null ? [] : snap.log.filter((e) => e.id > S.seenLogId);
    if (snap.log.length) S.seenLogId = snap.log.at(-1).id;
    else if (S.seenLogId === null) S.seenLogId = 0;

    const kinds = new Set(fresh.map((e) => e.kind));
    const winEntry = fresh.find((e) => e.kind === 'win');
    if (winEntry) Sound.play(winEntry.actorId === snap.you ? 'win' : 'end');
    else if (kinds.has('deal')) Sound.play('deal');
    else if (kinds.has('penalty')) Sound.play('penalty');
    else if (kinds.has('runo')) Sound.play('runo');
    else if (kinds.has('play')) Sound.play('play');
    else if (kinds.has('draw')) Sound.play('draw');
    else if (kinds.has('cancel')) Sound.play('end');

    const myTurn = Boolean(snap.game && snap.game.turnId === snap.you);
    if (prev && myTurn && !S.wasMyTurn) setTimeout(() => Sound.play('turn'), kinds.size ? 320 : 0);
    S.wasMyTurn = myTurn;
  }

  // ---- menu ----------------------------------------------------------------------------------

  const nameInput = $('#name');
  nameInput.value = store.get('runo:name') || '';
  nameInput.addEventListener('input', () => store.set('runo:name', nameInput.value));

  function showNotice(message) {
    const el = $('#menu-notice');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function readName() {
    const name = nameInput.value.trim();
    if (!name || name.length > 20) {
      showNotice('Enter a name (1–20 characters) first.');
      nameInput.focus();
      return null;
    }
    store.set('runo:name', name);
    return name;
  }

  async function createRoom() {
    const name = readName();
    if (!name || S.busy) return;
    S.busy = true;
    try {
      startSession(await request('POST', '/api/rooms', { name }));
      showNotice('');
    } catch (err) {
      showNotice(err.message);
    } finally {
      S.busy = false;
    }
  }

  async function joinRoom(rawCode) {
    const name = readName();
    if (!name || S.busy) return;
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(code)) {
      showNotice('Room codes are 6 characters using 0–9 and A–F.');
      $('#join-code').focus();
      return;
    }
    S.busy = true;
    try {
      startSession(await request('POST', `/api/rooms/${code}/join`, { name }));
      showNotice('');
    } catch (err) {
      showNotice(err.message);
      refreshLobbies();
    } finally {
      S.busy = false;
    }
  }

  $('#btn-create').addEventListener('click', createRoom);
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom($('#join-code').value);
  });
  $('#join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
  });
  $('#btn-refresh').addEventListener('click', () => refreshLobbies(true));

  async function refreshLobbies(manual = false) {
    if (S.session) return;
    const list = $('#lobby-list');
    const btn = $('#btn-refresh');
    if (manual) btn.disabled = true;
    try {
      const { lobbies } = await request('GET', '/api/lobbies');
      list.replaceChildren(
        ...(lobbies.length
          ? lobbies.map((l) =>
            h('li', { class: 'lobby-item' },
              h('span', { class: 'lobby-seats', 'aria-hidden': 'true' },
                Array.from({ length: l.maxPlayers }, (_, i) => h('i', { class: i < l.players ? 'taken' : '' }))),
              h('span', { class: 'lobby-info' },
                h('strong', {}, `${l.hostName}'s room`),
                h('small', {}, `${l.players} of ${l.maxPlayers} seats taken${l.state === 'finished' ? ', between rounds' : ''}`)),
              h('button', { class: 'btn small', type: 'button', onclick: () => joinRoom(l.code), 'aria-label': `Join ${l.hostName}'s room` }, 'Join')))
          : [h('li', { class: 'empty' }, 'No open rooms right now. Create one and send your friends the code.')]),
      );
    } catch {
      list.replaceChildren(h('li', { class: 'empty' }, "Couldn't load open rooms. Try Refresh."));
    } finally {
      btn.disabled = false;
    }
  }

  // ---- rendering: shell -------------------------------------------------------------------

  function render() {
    const inRoom = Boolean(S.session);
    $('#booting').hidden = true;
    $('#menu').hidden = inRoom;
    $('#room').hidden = !inRoom;
    $('#topbar').hidden = !inRoom;
    document.body.dataset.view = inRoom ? (S.snap ? S.snap.phase : 'loading') : 'menu';

    clearInterval(S.lobbyTimer);
    if (!inRoom) {
      refreshLobbies();
      S.lobbyTimer = setInterval(() => document.visibilityState === 'visible' && refreshLobbies(), 5000);
      return;
    }

    $('#topbar-code').textContent = S.session.code;
    renderPanelChrome();
    if (!S.snap) {
      $('#stage').replaceChildren(h('div', { class: 'waiting-stage' }, h('p', {}, 'Finding your seat…')));
      return;
    }
    renderStage();
    renderPlayers();
    renderLog();
    renderChat();
  }

  function renderPanelChrome() {
    const open = S.panelOpen;
    document.body.classList.toggle('panel-open', open);
    $('#scrim').hidden = !open;
    $('#btn-panel').setAttribute('aria-expanded', String(open));
    for (const tab of $$('.panel-tabs [data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === S.tab));
    for (const pane of $$('.panel-body')) pane.hidden = pane.dataset.pane !== S.tab;
    if (chatVisible()) S.unread = 0;
    for (const badge of [$('#chat-badge'), $('#chat-badge-tab')]) {
      badge.textContent = S.unread > 9 ? '9+' : String(S.unread);
      badge.hidden = S.unread === 0;
    }
  }

  const wideLayout = window.matchMedia('(min-width: 1024px)');
  const chatVisible = () => S.tab === 'chat' && (S.panelOpen || wideLayout.matches);

  // ---- rendering: stage -------------------------------------------------------------------

  const me = () => S.snap.players.find((p) => p.id === S.snap.you);
  const host = () => S.snap.players.find((p) => p.isHost);
  const amHost = () => S.snap.hostId === S.snap.you;

  function renderStage() {
    const stage = $('#stage');
    const handScroll = $('.hand', stage)?.scrollLeft ?? 0;
    const { phase } = S.snap;
    const view = phase === 'playing' ? tableView() : phase === 'finished' ? resultsView() : lobbyView();
    stage.replaceChildren(view);
    const hand = $('.hand', stage);
    if (hand) hand.scrollLeft = handScroll;
  }

  function dealControls(label) {
    const { canDeal } = S.snap;
    if (amHost()) {
      return h('div', { class: 'deal-box' },
        h('button', { class: 'btn primary big', type: 'button', disabled: !canDeal.ok, onclick: () => act('deal') }, label),
        canDeal.ok ? null : h('p', { class: 'hint' }, canDeal.reason));
    }
    const hostName = host() ? host().name : 'the host';
    return h('div', { class: 'deal-box' },
      h('p', { class: 'waiting' }, h('span', { class: 'dots', 'aria-hidden': 'true' }), `Waiting for ${hostName} to deal.`),
      canDeal.ok ? null : h('p', { class: 'hint' }, canDeal.reason));
  }

  function lobbyView() {
    const { code, players, maxPlayers } = S.snap;
    const seats = [];
    for (let i = 0; i < maxPlayers; i++) {
      const p = players[i];
      seats.push(p
        ? h('li', { class: `seat${p.id === S.snap.you ? ' is-me' : ''}${p.online ? '' : ' is-offline'}` },
          h('span', { class: 'seat-card', 'aria-hidden': 'true' }, p.name.slice(0, 1).toUpperCase()),
          h('span', { class: 'seat-name' }, p.name,
            p.id === S.snap.you ? h('em', { class: 'tag' }, 'you') : null,
            p.isHost ? h('em', { class: 'tag host' }, 'host') : null),
          h('span', { class: 'seat-meta' },
            p.online ? null : h('span', { class: 'offline' }, 'offline '),
            winsLabel(p.wins)))
        : h('li', { class: 'seat open' },
          h('span', { class: 'seat-card', 'aria-hidden': 'true' }, '+'),
          h('span', { class: 'seat-name' }, 'Open seat')));
    }
    const canShare = typeof navigator.share === 'function';
    return h('section', { class: 'lobby' },
      h('div', { class: 'ticket' },
        h('p', { class: 'ticket-label' }, 'Room code'),
        h('button', { class: 'ticket-code', type: 'button', title: 'Copy code', onclick: () => copyText(code, 'Room code copied.') }, code),
        h('div', { class: 'ticket-actions' },
          h('button', { class: 'btn small', type: 'button', onclick: () => copyText(code, 'Room code copied.') }, 'Copy code'),
          h('button', { class: 'btn small', type: 'button', onclick: () => copyText(inviteLink(code), 'Invite link copied.') }, 'Copy invite link'),
          canShare ? h('button', { class: 'btn small', type: 'button', onclick: () => navigator.share({ title: 'Play Runo', text: `Join my Runo room: ${code}`, url: inviteLink(code) }).catch(() => {}) }, 'Share') : null)),
      h('h2', { class: 'section-title' }, `Players ${players.length}/${maxPlayers}`),
      h('ul', { class: 'seats' }, seats),
      dealControls('Deal the cards'));
  }

  const winsLabel = (n) => `${n} ${n === 1 ? 'win' : 'wins'}`;

  function resultsView() {
    const { result } = S.snap;
    const iWon = result && result.winnerId === S.snap.you;
    return h('section', { class: `results${iWon ? ' won' : ''}` },
      h('div', { class: 'results-head' },
        h('h1', {}, iWon ? 'You won the round!' : `${result ? result.winnerName : 'Someone'} won the round`),
        h('p', {}, iWon ? 'Your win is on the board.' : 'Better luck in the next deal.')),
      result ? h('ol', { class: 'standings' },
        result.standings.map((s, i) =>
          h('li', { class: i === 0 ? 'first' : '' },
            h('span', { class: 'place' }, String(i + 1)),
            h('span', { class: 'who' }, s.name, s.id === S.snap.you ? h('em', { class: 'tag' }, 'you') : null),
            h('span', { class: 'left' }, s.cards === 0 ? 'out' : `${s.cards} ${s.cards === 1 ? 'card' : 'cards'} left`),
            h('span', { class: 'wins' }, winsLabel(S.snap.players.find((p) => p.id === s.id)?.wins ?? s.wins))))) : null,
      dealControls('Play again'));
  }

  // One playing card. `size` is 'hand' | 'pile' | 'mini'.
  function cardEl(card, { tag = 'div', size = 'hand', ...props } = {}) {
    const face = FACE[card.value] ?? card.value;
    const isWild = card.color === null;
    return h(tag, {
      class: `card ${size} c-${card.color || 'wild'} v-${card.value}`,
      'aria-label': cardLabel(card),
      ...props,
    },
    h('span', { class: 'corner tl', 'aria-hidden': 'true' }, face || 'W'),
    h('span', { class: 'face', 'aria-hidden': 'true' },
      isWild ? h('span', { class: 'wheel' }, face ? h('b', {}, face) : null) : face),
    h('span', { class: 'corner br', 'aria-hidden': 'true' }, face || 'W'));
  }

  const cardBack = (extra = '') => h('div', { class: `card back ${extra}`, 'aria-hidden': 'true' }, h('span', { class: 'back-mark' }, 'R'));

  function sortHand(hand) {
    return [...hand].sort((a, b) =>
      COLOR_ORDER[a.color] - COLOR_ORDER[b.color] || VALUE_ORDER.indexOf(a.value) - VALUE_ORDER.indexOf(b.value));
  }

  function tableView() {
    const snap = S.snap;
    const game = snap.game;
    const myIndex = snap.players.findIndex((p) => p.id === snap.you);
    const others = [...snap.players.slice(myIndex + 1), ...snap.players.slice(0, myIndex)];
    const myTurn = game.turnId === snap.you;
    const turnPlayer = snap.players.find((p) => p.id === game.turnId);
    const self = me();

    // Opponents, in seat order starting after you.
    const opponents = h('ul', { class: `opponents n${others.length}` }, others.map((p) =>
      h('li', { class: `opp${p.id === game.turnId ? ' is-turn' : ''}${p.online ? '' : ' is-offline'}` },
        h('div', { class: 'opp-fan', 'aria-hidden': 'true' },
          Array.from({ length: Math.min(p.cardCount, 7) }, () => h('span', { class: 'mini-back' }))),
        h('div', { class: 'opp-name' }, p.name, p.isHost ? h('em', { class: 'tag host' }, 'host') : null),
        h('div', { class: 'opp-meta' },
          h('span', { class: 'count' }, `${p.cardCount} ${p.cardCount === 1 ? 'card' : 'cards'}`),
          p.calledRuno ? h('span', { class: 'runo-flag' }, 'RUNO!') : null,
          p.online ? null : h('span', { class: 'offline' }, 'offline')),
        p.id === game.turnId ? h('span', { class: 'sr-only' }, '(their turn)') : null)));

    // Turn banner.
    let title;
    let hint = '';
    const playable = game.hand.filter((c) => c.playable);
    if (myTurn) {
      title = 'Your turn';
      if (game.canCallRuno) hint = 'One card left: call RUNO! before you play it.';
      else if (game.hand.length === 1 && self.calledRuno) hint = 'RUNO! called. Play your last card.';
      else if (!playable.length) hint = 'Nothing fits. Draw a card.';
      else hint = 'Play a highlighted card, or draw.';
    } else {
      title = `${turnPlayer ? turnPlayer.name : 'Someone'}'s turn`;
      hint = turnPlayer && !turnPlayer.online ? `${turnPlayer.name} is offline. The game waits for them to come back.` : '';
    }

    const topChanged = S.prevTop !== game.topCard.id;
    S.prevTop = game.topCard.id;
    const clockwise = game.direction === 'clockwise';

    const center = h('div', { class: 'center' },
      h('div', { class: `turn-banner${myTurn ? ' mine' : ''}`, role: 'status' },
        h('strong', {}, title), hint ? h('span', {}, hint) : null),
      h('div', { class: 'piles' },
        h('button', {
          class: 'pile draw-pile',
          type: 'button',
          disabled: !myTurn,
          onclick: () => draw(),
          'aria-label': `Draw a card (${game.drawPileCount} left in the pile)`,
        }, cardBack('pile'), h('span', { class: 'pile-count' }, `${game.drawPileCount} left`)),
        h('div', { class: `discard active-${game.activeColor}` },
          cardEl(game.topCard, { size: 'pile' }),
          h('span', { class: 'pile-count' }, `${COLOR_NAMES[game.activeColor]} to play`))),
      h('div', { class: `direction ${clockwise ? 'cw' : 'ccw'}` },
        h('span', { class: 'dir-icon', 'aria-hidden': 'true' }, clockwise ? '↻' : '↺'),
        clockwise ? 'Clockwise' : 'Counter-clockwise'));
    if (topChanged) $('.discard .card', center).classList.add('landed');

    // Your hand.
    const sorted = sortHand(game.hand);
    const handEl = h('div', { class: `hand${myTurn ? ' my-turn' : ''}`, role: 'group', 'aria-label': 'Your hand' },
      sorted.map((c) => {
        const el = cardEl(c, {
          tag: 'button',
          type: 'button',
          disabled: !myTurn || !c.playable,
          'aria-label': `${cardLabel(c)}${myTurn ? (c.playable ? ', playable' : ', does not match') : ''}`,
          onclick: () => playCard(c),
        });
        if (myTurn && c.playable) el.classList.add('playable');
        if (myTurn && !c.playable) el.classList.add('dim');
        if (S.prevHand.size && !S.prevHand.has(c.id)) el.classList.add('fresh');
        return el;
      }));
    S.prevHand = new Set(game.hand.map((c) => c.id));

    const actions = h('div', { class: 'my-actions' },
      h('div', { class: 'me-label' },
        h('strong', {}, self.name),
        h('span', {}, `${game.hand.length} ${game.hand.length === 1 ? 'card' : 'cards'}`),
        self.calledRuno ? h('span', { class: 'runo-flag' }, 'RUNO!') : null),
      game.canCallRuno
        ? h('button', { class: 'btn runo', type: 'button', onclick: () => act('runo') }, 'RUNO!')
        : null,
      h('button', { class: 'btn', type: 'button', disabled: !myTurn, onclick: () => draw() }, 'Draw a card'));

    return h('section', { class: `table${myTurn ? ' my-turn' : ''}` },
      opponents, center, h('div', { class: 'me-area' }, actions, handEl));
  }

  async function draw() {
    if (S.busy) return;
    S.busy = true;
    await act('draw');
    S.busy = false;
  }

  async function playCard(card) {
    if (S.busy) return;
    if (card.color === null) {
      S.wildCardId = card.id;
      $('#dlg-wild').showModal();
      return;
    }
    S.busy = true;
    await act('play', { cardId: card.id });
    S.busy = false;
  }

  for (const swatch of $$('#dlg-wild .swatch')) {
    swatch.addEventListener('click', async () => {
      const cardId = S.wildCardId;
      S.wildCardId = null;
      $('#dlg-wild').close();
      if (!cardId || S.busy) return;
      S.busy = true;
      await act('play', { cardId, color: swatch.dataset.color });
      S.busy = false;
    });
  }
  $('#dlg-wild').addEventListener('close', () => { S.wildCardId = null; });

  // ---- rendering: side panel ------------------------------------------------------------------

  function renderPlayers() {
    const snap = S.snap;
    const playing = snap.phase === 'playing';
    $('#player-list').replaceChildren(...snap.players.map((p) =>
      h('li', { class: `prow${p.online ? '' : ' is-offline'}${playing && snap.game.turnId === p.id ? ' is-turn' : ''}` },
        h('span', { class: `dot ${p.online ? 'on' : 'off'}`, title: p.online ? 'Online' : 'Offline' }),
        h('span', { class: 'prow-main' },
          h('strong', {}, p.name),
          p.id === snap.you ? h('em', { class: 'tag' }, 'you') : null,
          p.isHost ? h('em', { class: 'tag host' }, 'host') : null,
          h('small', {},
            [p.online ? 'online' : 'offline',
              playing ? `${p.cardCount} ${p.cardCount === 1 ? 'card' : 'cards'}` : null,
              winsLabel(p.wins)].filter(Boolean).join(', '),
            p.calledRuno ? h('span', { class: 'runo-flag' }, 'RUNO!') : null)),
        amHost() && p.id !== snap.you
          ? h('button', { class: 'btn small ghost danger', type: 'button', onclick: () => removePlayer(p) }, 'Remove')
          : null)));
  }

  function renderLog() {
    const log = S.snap.log;
    $('#log-list').replaceChildren(...(log.length
      ? [...log].reverse().map((e) => h('li', { class: `log-${e.kind}` }, e.text))
      : [h('li', { class: 'empty' }, 'Nothing has happened yet.')]));
  }

  function renderChat() {
    const list = $('#chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const chat = S.snap.chat;
    list.replaceChildren(...(chat.length
      ? chat.map((m) => h('li', { class: m.playerId === S.snap.you ? 'mine' : '' },
        h('strong', {}, m.name), h('span', {}, m.text)))
      : [h('li', { class: 'empty' }, 'Say hi to the table.')]));
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (!(await act('chat', { text }))) input.value = text;
    const list = $('#chat-list');
    list.scrollTop = list.scrollHeight;
  });

  for (const tab of $$('.panel-tabs [data-tab]')) {
    tab.addEventListener('click', () => {
      S.tab = tab.dataset.tab;
      renderPanelChrome();
      if (S.tab === 'chat') {
        const list = $('#chat-list');
        list.scrollTop = list.scrollHeight;
      }
    });
  }
  const setPanel = (open) => {
    S.panelOpen = open;
    renderPanelChrome();
  };
  $('#btn-panel').addEventListener('click', () => setPanel(!S.panelOpen));
  $('#btn-panel-close').addEventListener('click', () => setPanel(false));
  $('#scrim').addEventListener('click', () => setPanel(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.panelOpen && !$('dialog[open]')) setPanel(false);
  });

  // ---- leaving & removing ---------------------------------------------------------------------

  const roundWarning = () =>
    S.snap && S.snap.phase === 'playing' ? ' This ends the current round for everyone, with no winner.' : '';

  async function removePlayer(p) {
    const ok = await confirmDialog({
      title: `Remove ${p.name}?`,
      body: `${p.name} will be sent back to the main menu.${roundWarning()}`,
      ok: 'Remove',
    });
    if (ok) act('kick', { playerId: p.id });
  }

  $('#btn-leave').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Leave this room?',
      body: `You'll lose your seat and your win count.${roundWarning()}`,
      ok: 'Leave room',
    });
    if (!ok) return;
    await act('leave');
    endSession('');
  });

  $('#topbar-code').addEventListener('click', () => copyText(inviteLink(S.session.code), 'Invite link copied.'));

  // ---- misc wiring --------------------------------------------------------------------------------

  for (const btn of $$('#btn-rules-top, #btn-rules-menu')) btn.addEventListener('click', () => $('#dlg-rules').showModal());
  for (const btn of $$('.sound-toggle')) {
    btn.addEventListener('click', () => {
      Sound.enabled = !Sound.enabled;
      store.set('runo:sound', Sound.enabled);
      renderSoundToggles();
      if (Sound.enabled) {
        Sound.unlock();
        Sound.play('play');
      }
    });
  }
  wideLayout.addEventListener('change', () => S.session && renderPanelChrome());

  // ---- boot -----------------------------------------------------------------------------------------

  renderSoundToggles();
  const params = new URLSearchParams(location.search);
  const invited = (params.get('room') || '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(invited)) $('#join-code').value = invited;

  if (S.session) {
    if (invited && invited !== S.session.code) {
      toast(`You're still seated in room ${S.session.code}. Leave it to join ${invited}.`, 'info');
    }
    connect();
  } else if (invited) {
    showNotice(`You're invited to room ${invited}. Enter your name and press Join.`);
  }
  render();
  if (!S.session) (nameInput.value ? $('#join-code') : nameInput).focus({ preventScroll: true });
})();
