'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, ROOM_IDLE_MS } = require('../server/rooms');
const { seeded, card } = require('./helpers');

// Stands in for an SSE stream: records every event it is sent.
function fakeConn() {
  return {
    events: [],
    closed: false,
    send(event, data) { this.events.push({ event, data }); },
    close() { this.closed = true; },
    last(event = 'state') { return this.events.filter((e) => e.event === event).at(-1)?.data; },
  };
}

function setup(names = ['Ada', 'Bea'], { now } = {}) {
  const manager = new RoomManager({ rng: seeded(7), now });
  const { room, player: host } = manager.createRoom(names[0]);
  const players = [host];
  for (const name of names.slice(1)) players.push(manager.joinRoom(room.code, name).player);
  const conns = players.map((p) => {
    const conn = fakeConn();
    manager.connect(room, p, conn);
    return conn;
  });
  return { manager, room, players, conns };
}

test('room codes are 6 uppercase hex characters and names are validated', () => {
  const manager = new RoomManager();
  const { room, player } = manager.createRoom('  Ada  ');
  assert.match(room.code, /^[0-9A-F]{6}$/);
  assert.equal(player.name, 'Ada');
  assert.equal(room.hostId, player.id);
  assert.throws(() => manager.createRoom('   '), /between 1 and 20/);
  assert.throws(() => manager.createRoom('x'.repeat(21)), /between 1 and 20/);
  assert.equal(manager.createRoom('x'.repeat(20)).player.name.length, 20);
  assert.throws(() => manager.joinRoom(room.code.toLowerCase(), 'ada'), /already has that name/);
  assert.equal(manager.joinRoom(room.code.toLowerCase(), 'Bea').room, room);
  assert.throws(() => manager.joinRoom('ZZZZZZ', 'Cal'), /6 characters/);
  assert.throws(() => manager.joinRoom('000000', 'Cal'), /No room/);
});

test('joining is rejected when the room is full or mid-round, allowed after a round', () => {
  const { manager, room, players } = setup(['Ada', 'Bea', 'Cal', 'Dee']);
  assert.throws(() => manager.joinRoom(room.code, 'Eve'), /full/);
  manager.leave(room, players[3]);
  manager.deal(room, players[0]);
  assert.throws(() => manager.joinRoom(room.code, 'Eve'), /round is in progress/);
  room.phase = 'finished';
  room.game = null;
  assert.ok(manager.joinRoom(room.code, 'Eve').player);
});

test('lobby list shows joinable rooms with a connected player', () => {
  const manager = new RoomManager();
  const a = manager.createRoom('Ada');
  assert.deepEqual(manager.lobbies(), [], 'nobody connected yet');
  manager.connect(a.room, a.player, fakeConn());
  assert.deepEqual(manager.lobbies(), [
    { code: a.room.code, hostName: 'Ada', players: 1, maxPlayers: 4, state: 'lobby' },
  ]);
  const b = manager.joinRoom(a.room.code, 'Bea');
  manager.connect(a.room, b.player, fakeConn());
  manager.deal(a.room, a.player);
  assert.deepEqual(manager.lobbies(), [], 'mid-round rooms are hidden');
});

test('only the host can deal, with 2+ players who are all connected', () => {
  const manager = new RoomManager();
  const { room, player: host } = manager.createRoom('Ada');
  manager.connect(room, host, fakeConn());
  assert.throws(() => manager.deal(room, host), /at least 2 players/);
  const { player: bea } = manager.joinRoom(room.code, 'Bea');
  assert.throws(() => manager.deal(room, host), /Waiting for Bea/);
  const beaConn = fakeConn();
  manager.connect(room, bea, beaConn);
  assert.throws(() => manager.deal(room, bea), /Only the host/);
  manager.deal(room, host);
  assert.equal(room.phase, 'playing');
  assert.throws(() => manager.deal(room, host), /already in progress/);
  const snap = beaConn.last();
  assert.equal(snap.game.hand.length, 7);
  assert.equal(room.log.at(-1).text, 'Ada dealt a new round.');
});

test('a disconnected player keeps their seat and hand and is shown offline', () => {
  const { manager, room, players, conns } = setup(['Ada', 'Bea']);
  manager.deal(room, players[0]);
  const handBefore = room.game.player(players[1].id).hand.map((c) => c.id);
  manager.disconnect(room, players[1], conns[1]);
  const adaView = conns[0].last();
  assert.equal(adaView.players[1].online, false);
  assert.equal(adaView.game.hand.length, 7);
  assert.equal(room.phase, 'playing');

  const again = fakeConn();
  const session = manager.session(room.code, players[1].token);
  manager.connect(session.room, session.player, again);
  assert.deepEqual(again.last().game.hand.map((c) => c.id), handBefore);
  assert.equal(conns[0].last().players[1].online, true);
});

test('state sent to a player hides other hands', () => {
  const { manager, room, players, conns } = setup(['Ada', 'Bea', 'Cal']);
  manager.deal(room, players[0]);
  const json = JSON.stringify(conns[0].last());
  for (const p of room.game.players.slice(1)) {
    for (const c of p.hand) assert.ok(!json.includes(c.id));
  }
  for (const c of room.game.drawPile) assert.ok(!json.includes(c.id));
  assert.ok(!json.includes(players[1].token), 'other tokens never leak');
  assert.deepEqual(conns[0].last().players.map((p) => p.cardCount), [7, 7, 7]);
});

test('winning ends the round, counts the win, and a rematch keeps win counts', () => {
  const { manager, room, players, conns } = setup(['Ada', 'Bea', 'Cal']);
  const [ada, bea] = players;
  manager.deal(room, ada);

  const game = room.game;
  game.turn = 1;
  game.discard = [card('red', '7')];
  game.activeColor = 'red';
  game.player(bea.id).hand = [card('red', '2')];
  game.player(ada.id).hand = [card('blue', '1'), card('blue', '2')];
  manager.callRuno(room, bea);
  assert.equal(conns[0].last().players[1].calledRuno, true);
  manager.play(room, bea, game.player(bea.id).hand[0].id);

  assert.equal(room.phase, 'finished');
  assert.equal(bea.wins, 1);
  const result = conns[2].last().result;
  assert.equal(result.winnerName, 'Bea');
  assert.deepEqual(result.standings.map((s) => s.name), ['Bea', 'Ada', 'Cal']);
  assert.deepEqual(result.standings.map((s) => s.cards), [0, 2, 7]);
  assert.equal(result.standings[0].wins, 1);
  assert.equal(room.log.at(-1).text, 'Bea won the round!');

  assert.throws(() => manager.deal(room, bea), /Only the host/);
  manager.deal(room, ada);
  assert.equal(room.phase, 'playing');
  assert.equal(room.result, null);
  assert.deepEqual(conns[0].last().players.map((p) => p.wins), [0, 1, 0]);
  for (const p of room.game.players) assert.equal(p.hand.length, 7);
});

test('a penalty and plays are written to the action log', () => {
  const { manager, room, players } = setup(['Ada', 'Bea']);
  const [ada, bea] = players;
  manager.deal(room, ada);
  const game = room.game;
  game.turn = 0;
  game.discard = [card('red', '7')];
  game.activeColor = 'red';
  game.player(ada.id).hand = [card(null, 'wild'), card('green', '3')];
  game.player(bea.id).hand = [card('green', '5'), card('green', '6')];
  manager.play(room, ada, game.player(ada.id).hand[0].id, 'green');
  manager.play(room, bea, game.player(bea.id).hand[0].id);
  manager.play(room, ada, game.player(ada.id).hand[0].id);
  const texts = room.log.map((e) => e.text);
  assert.ok(texts.includes('Ada played wild → green.'));
  assert.ok(texts.includes('Bea played green 5.'));
  assert.ok(texts.includes('Ada forgot RUNO. Two-card penalty!'));
  manager.draw(room, bea);
  assert.equal(room.log.at(-1).text, 'Bea drew a card.');
  assert.ok(room.log.length <= 6);
});

test('leaving mid-round cancels the round and passes host to the next seat', () => {
  const { manager, room, players, conns } = setup(['Ada', 'Bea', 'Cal']);
  const [ada, bea] = players;
  manager.deal(room, ada);
  manager.leave(room, ada);
  assert.equal(conns[0].last('left').message, 'You left the room.');
  assert.ok(conns[0].closed);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.game, null);
  assert.equal(room.hostId, bea.id);
  const texts = room.log.map((e) => e.text);
  assert.ok(texts.includes('Ada left.'));
  assert.ok(texts.includes('Round ended because a player left.'));
  assert.equal(conns[1].last().phase, 'lobby');
  assert.throws(() => manager.session(room.code, ada.token), /no longer available/);
});

test('the host can remove a player; others cannot', () => {
  const { manager, room, players, conns } = setup(['Ada', 'Bea', 'Cal']);
  const [ada, bea, cal] = players;
  assert.throws(() => manager.kick(room, bea, cal.id), /Only the host/);
  assert.throws(() => manager.kick(room, ada, ada.id), /Leave/);
  manager.deal(room, ada);
  manager.kick(room, ada, cal.id);
  assert.equal(conns[2].last('removed').message, 'The host removed you from the room.');
  assert.equal(room.players.length, 2);
  assert.equal(room.phase, 'lobby', 'removing someone mid-round cancels it');
});

test('the room is deleted when the last player leaves', () => {
  const { manager, room, players } = setup(['Ada', 'Bea']);
  manager.leave(room, players[1]);
  manager.leave(room, players[0]);
  assert.equal(manager.rooms.size, 0);
});

test('rooms with nobody connected for 2 hours expire', () => {
  let t = 1_000;
  const { manager, room, players, conns } = setup(['Ada', 'Bea'], { now: () => t });
  manager.disconnect(room, players[0], conns[0]);
  t += ROOM_IDLE_MS;
  manager.sweep();
  assert.equal(manager.rooms.size, 1, 'Bea is still connected');
  manager.disconnect(room, players[1], conns[1]);
  t += ROOM_IDLE_MS - 1;
  manager.sweep();
  assert.equal(manager.rooms.size, 1);
  t += 1;
  manager.sweep();
  assert.equal(manager.rooms.size, 0);
});

test('chat keeps the last 50 messages up to 240 characters, stored as plain text', () => {
  const { manager, room, players, conns } = setup(['Ada', 'Bea']);
  assert.throws(() => manager.chat(room, players[0], '   '), /Type a message/);
  assert.throws(() => manager.chat(room, players[0], 'x'.repeat(241)), /240/);
  manager.chat(room, players[0], '<script>alert(1)</script>');
  assert.equal(conns[1].last().chat.at(-1).text, '<script>alert(1)</script>');
  for (let i = 0; i < 60; i++) manager.chat(room, players[1], `msg ${i}`);
  assert.equal(room.chat.length, 50);
  assert.equal(room.chat.at(-1).text, 'msg 59');
});
