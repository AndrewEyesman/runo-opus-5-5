'use strict';

// Rooms, seats, sessions, chat and the action log. Owns every Game and pushes
// a personalised snapshot to each connected player whenever something changes.

const crypto = require('node:crypto');
const { Game, GameError, MIN_PLAYERS, MAX_PLAYERS, describeCard } = require('./game');

const NAME_MAX = 20;
const CHAT_MAX = 240;
const CHAT_KEEP = 50;
const LOG_KEEP = 6;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;

// Strip control characters and trim.
function clean(text) {
  return String(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim();
}

function validateName(raw) {
  const name = clean(raw).replace(/\s+/g, ' ');
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX) {
    throw new GameError(`Enter a name between 1 and ${NAME_MAX} characters.`);
  }
  return name;
}

function normalizeCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(code)) throw new GameError('Room codes are 6 characters, 0–9 and A–F.');
  return code;
}

const isOnline = (p) => p.conns.size > 0;

class RoomManager {
  constructor({ rng = Math.random, now = Date.now } = {}) {
    this.rng = rng;
    this.now = now;
    this.rooms = new Map();
  }

  // ---- sessions -----------------------------------------------------------

  createRoom(rawName) {
    const name = validateName(rawName);
    let code;
    do code = crypto.randomBytes(3).toString('hex').toUpperCase();
    while (this.rooms.has(code));

    const room = {
      code,
      hostId: null,
      players: [],
      phase: 'lobby', // lobby | playing | finished
      game: null,
      result: null,
      log: [],
      chat: [],
      seq: 0,
      emptySince: this.now(),
    };
    const player = this.addPlayer(room, name);
    room.hostId = player.id;
    this.rooms.set(code, room);
    this.log(room, `${name} created the room.`, 'join', player.id);
    return { room, player };
  }

  joinRoom(rawCode, rawName) {
    const name = validateName(rawName);
    const room = this.rooms.get(normalizeCode(rawCode));
    if (!room) throw new GameError('No room with that code. Check the code and try again.', 404);
    if (room.phase === 'playing') {
      throw new GameError('A round is in progress in that room. Try again when it ends.', 409);
    }
    if (room.players.length >= MAX_PLAYERS) throw new GameError('That room is full.', 409);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('Someone in that room already has that name.', 409);
    }
    const player = this.addPlayer(room, name);
    this.log(room, `${name} joined.`, 'join', player.id);
    this.broadcast(room);
    return { room, player };
  }

  addPlayer(room, name) {
    const player = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(24).toString('base64url'),
      name,
      wins: 0,
      conns: new Set(),
    };
    room.players.push(player);
    return player;
  }

  // Returns { room, player } or throws a 404 marked as an expired session.
  session(rawCode, token) {
    const room = this.rooms.get(String(rawCode ?? '').toUpperCase());
    const player = room && token ? room.players.find((p) => p.token === token) : null;
    if (!player) {
      const err = new GameError('That game is no longer available. The room may have closed or the server restarted.', 404);
      err.code = 'session_expired';
      throw err;
    }
    return { room, player };
  }

  lobbies() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.phase === 'playing') continue;
      if (room.players.length >= MAX_PLAYERS) continue;
      if (!room.players.some(isOnline)) continue;
      const host = room.players.find((p) => p.id === room.hostId);
      list.push({
        code: room.code,
        hostName: host ? host.name : '?',
        players: room.players.length,
        maxPlayers: MAX_PLAYERS,
        state: room.phase,
      });
    }
    return list;
  }

  // ---- live connections ---------------------------------------------------

  // `conn` must provide send(event, data) and close().
  connect(room, player, conn) {
    player.conns.add(conn);
    room.emptySince = null;
    this.broadcast(room);
  }

  disconnect(room, player, conn) {
    if (!player.conns.delete(conn)) return;
    if (!room.players.some(isOnline)) room.emptySince = this.now();
    if (this.rooms.get(room.code) === room) this.broadcast(room);
  }

  broadcast(room) {
    for (const player of room.players) {
      if (player.conns.size === 0) continue;
      const snap = this.snapshot(room, player);
      for (const conn of player.conns) conn.send('state', snap);
    }
  }

  // Delete rooms nobody has been connected to for two hours.
  sweep() {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince >= ROOM_IDLE_MS) this.rooms.delete(code);
    }
  }

  // ---- actions --------------------------------------------------------------

  perform(room, player, action) {
    const type = action && action.type;
    switch (type) {
      case 'deal': return this.deal(room, player);
      case 'play': return this.play(room, player, action.cardId, action.color);
      case 'draw': return this.draw(room, player);
      case 'runo': return this.callRuno(room, player);
      case 'chat': return this.chat(room, player, action.text);
      case 'leave': return this.leave(room, player);
      case 'kick': return this.kick(room, player, action.playerId);
      default: throw new GameError('Unknown action.');
    }
  }

  dealBlocker(room) {
    if (room.phase === 'playing') return 'A round is already in progress.';
    if (room.players.length < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players to deal.`;
    const offline = room.players.filter((p) => !isOnline(p));
    if (offline.length) {
      const names = offline.map((p) => p.name).join(', ');
      return `Waiting for ${names} to reconnect.`;
    }
    return null;
  }

  deal(room, player) {
    if (player.id !== room.hostId) throw new GameError('Only the host can deal.', 403);
    const blocker = this.dealBlocker(room);
    if (blocker) throw new GameError(blocker, 409);
    room.game = new Game(room.players.map((p) => p.id), { rng: this.rng });
    room.phase = 'playing';
    room.result = null;
    this.log(room, `${player.name} dealt a new round.`, 'deal', player.id);
    this.broadcast(room);
  }

  activeGame(room) {
    if (room.phase !== 'playing' || !room.game) throw new GameError('No round is in progress.', 409);
    return room.game;
  }

  play(room, player, cardId, color) {
    const event = this.activeGame(room).play(player.id, String(cardId ?? ''), color);
    const name = (id) => this.nameOf(room, id);

    if (event.type === 'penalty') {
      this.log(room, `${player.name} forgot RUNO. Two-card penalty!`, 'penalty', player.id);
    } else {
      let text = `${player.name} played ${describeCard(event.card)}`;
      if (event.card.color === null) text += ` → ${event.color}`;
      text += '.';
      if (event.victimId) text += ` ${name(event.victimId)} draws ${event.drawn}.`;
      else if (event.skippedId) text += ` ${name(event.skippedId)} is skipped.`;
      else if (event.card.value === 'reverse') text += ' Direction reversed.';
      this.log(room, text, 'play', player.id);
      if (event.won) this.finishRound(room, player);
    }
    this.broadcast(room);
  }

  draw(room, player) {
    const event = this.activeGame(room).draw(player.id);
    const text = event.drawn
      ? `${player.name} drew a card.`
      : `${player.name} tried to draw, but there are no cards left.`;
    this.log(room, text, 'draw', player.id);
    this.broadcast(room);
  }

  callRuno(room, player) {
    const event = this.activeGame(room).callRuno(player.id);
    if (event.repeat) return;
    this.log(room, `${player.name} called RUNO!`, 'runo', player.id);
    this.broadcast(room);
  }

  finishRound(room, winner) {
    const game = room.game;
    winner.wins += 1;
    const seat = (id) => room.players.findIndex((p) => p.id === id);
    const standings = game.players
      .map((gp) => {
        const p = room.players.find((rp) => rp.id === gp.id);
        return { id: gp.id, name: p.name, cards: gp.hand.length, wins: p.wins };
      })
      .sort((a, b) => {
        if (a.id === winner.id) return -1;
        if (b.id === winner.id) return 1;
        return a.cards - b.cards || seat(a.id) - seat(b.id);
      });
    room.result = { winnerId: winner.id, winnerName: winner.name, standings };
    room.phase = 'finished';
    room.game = null;
    this.log(room, `${winner.name} won the round!`, 'win', winner.id);
  }

  chat(room, player, raw) {
    const text = clean(raw);
    if (!text) throw new GameError('Type a message first.');
    if ([...text].length > CHAT_MAX) throw new GameError(`Messages can be up to ${CHAT_MAX} characters.`);
    room.chat.push({ id: ++room.seq, playerId: player.id, name: player.name, text, at: this.now() });
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    this.broadcast(room);
  }

  leave(room, player) {
    this.removePlayer(room, player, `${player.name} left.`, {
      event: 'left',
      message: 'You left the room.',
    });
  }

  kick(room, host, targetId) {
    if (host.id !== room.hostId) throw new GameError('Only the host can remove players.', 403);
    if (targetId === host.id) throw new GameError("You can't remove yourself. Use Leave instead.");
    const target = room.players.find((p) => p.id === targetId);
    if (!target) throw new GameError('That player is no longer in the room.', 404);
    this.removePlayer(room, target, `${target.name} was removed by the host.`, {
      event: 'removed',
      message: 'The host removed you from the room.',
    });
  }

  removePlayer(room, player, logText, notice) {
    const index = room.players.indexOf(player);
    room.players.splice(index, 1);
    for (const conn of player.conns) {
      conn.send(notice.event, { message: notice.message });
      conn.close();
    }
    player.conns.clear();

    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return;
    }

    this.log(room, logText, 'leave', player.id);
    if (room.phase === 'playing') {
      room.phase = 'lobby';
      room.game = null;
      this.log(room, 'Round ended because a player left.', 'cancel');
    }
    if (room.hostId === player.id) {
      const next = room.players[index % room.players.length];
      room.hostId = next.id;
      this.log(room, `${next.name} is now the host.`, 'host', next.id);
    }
    if (!room.players.some(isOnline)) room.emptySince ??= this.now();
    this.broadcast(room);
  }

  // ---- views ----------------------------------------------------------------

  nameOf(room, id) {
    const p = room.players.find((pl) => pl.id === id);
    return p ? p.name : 'Someone';
  }

  log(room, text, kind, actorId = null) {
    room.log.push({ id: ++room.seq, text, kind, actorId });
    if (room.log.length > LOG_KEEP) room.log.splice(0, room.log.length - LOG_KEEP);
  }

  snapshot(room, viewer) {
    const game = room.phase === 'playing' ? room.game.snapshotFor(viewer.id) : null;
    const gameInfo = (id) => (game ? game.players.find((gp) => gp.id === id) : null);
    const blocker = this.dealBlocker(room);
    return {
      code: room.code,
      you: viewer.id,
      hostId: room.hostId,
      phase: room.phase,
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p) => {
        const info = gameInfo(p.id);
        return {
          id: p.id,
          name: p.name,
          wins: p.wins,
          online: isOnline(p),
          isHost: p.id === room.hostId,
          cardCount: info ? info.cardCount : null,
          calledRuno: info ? info.calledRuno : false,
        };
      }),
      game: game && {
        turnId: game.turnId,
        direction: game.direction,
        topCard: game.topCard,
        activeColor: game.activeColor,
        drawPileCount: game.drawPileCount,
        discardCount: game.discardCount,
        hand: game.hand,
        canCallRuno: game.canCallRuno,
      },
      result: room.result,
      canDeal: { ok: blocker === null, reason: blocker },
      log: room.log,
      chat: room.chat,
    };
  }
}

module.exports = { RoomManager, validateName, normalizeCode, NAME_MAX, CHAT_MAX, ROOM_IDLE_MS };
