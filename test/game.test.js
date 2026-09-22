'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError, COLORS, createDeck, isLegal } = require('../server/game');
const { seeded, card, rig } = require('./helpers');

const filler = (n, color = 'green', value = '3') => Array.from({ length: n }, () => card(color, value));
const ids = (cards) => cards.map((c) => c.id);

test('deck has 108 cards with the right composition', () => {
  const deck = createDeck();
  assert.equal(deck.length, 108);
  for (const color of COLORS) {
    const cards = deck.filter((c) => c.color === color);
    assert.equal(cards.length, 25, `${color} count`);
    assert.equal(cards.filter((c) => c.value === '0').length, 1);
    for (let v = 1; v <= 9; v++) assert.equal(cards.filter((c) => c.value === String(v)).length, 2);
    for (const value of ['skip', 'reverse', 'draw2']) {
      assert.equal(cards.filter((c) => c.value === value).length, 2, `${color} ${value}`);
    }
  }
  assert.equal(deck.filter((c) => c.color === null && c.value === 'wild').length, 4);
  assert.equal(deck.filter((c) => c.color === null && c.value === 'wild4').length, 4);
});

test('deal: 7 cards each, number-card start, all 108 cards accounted for, unique ids', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const players = ['a', 'b', 'c', 'd'].slice(0, 2 + (seed % 3));
    const game = new Game(players, { rng: seeded(seed) });
    for (const p of game.players) assert.equal(p.hand.length, 7);
    assert.equal(game.discard.length, 1);
    assert.match(game.topCard.value, /^[0-9]$/);
    assert.equal(game.activeColor, game.topCard.color);
    const all = [...game.drawPile, ...game.discard, ...game.players.flatMap((p) => p.hand)];
    assert.equal(all.length, 108);
    assert.equal(new Set(ids(all)).size, 108);
    assert.equal(game.drawPile.length, 108 - 7 * players.length - 1);
    assert.equal(game.direction, 1);
    assert.ok(game.turn >= 0 && game.turn < players.length);
  }
});

test('deal: the starting discard is the first number card in the remaining pile', () => {
  // Pile top is the end of the array. 14 cards are dealt first, then the
  // wild and skip on top must be passed over for the red 5.
  const deck = [
    card('blue', '9'),
    card('red', '5'),
    card('green', 'skip'),
    card(null, 'wild'),
    ...filler(14, 'yellow', '1'),
  ];
  const [blue9, red5, skip, wild] = deck;
  const game = new Game(['a', 'b'], { rng: seeded(3), deck });
  assert.equal(game.topCard.id, red5.id);
  assert.equal(game.activeColor, 'red');
  assert.deepEqual(ids(game.drawPile), [blue9.id, skip.id, wild.id]);
});

test('deal: the first player is random', () => {
  const firsts = new Set();
  for (let seed = 1; seed <= 50; seed++) firsts.add(new Game(['a', 'b', 'c'], { rng: seeded(seed) }).turn);
  assert.deepEqual([...firsts].sort(), [0, 1, 2]);
});

test('only the current player may act', () => {
  const game = rig(['a', 'b'], { hands: [[card('red', '1'), card('red', '2')], [card('red', '3'), card('red', '4')]], top: card('red', '9'), turn: 0 });
  const bCard = game.players[1].hand[0];
  assert.throws(() => game.play('b', bCard.id), /not your turn/);
  assert.throws(() => game.draw('b'), /not your turn/);
  assert.throws(() => game.callRuno('b'), /not your turn/);
  assert.throws(() => game.play('zed', bCard.id), GameError);
  assert.equal(game.players[1].hand.length, 2);
  game.play('a', game.players[0].hand[0].id);
  assert.equal(game.currentPlayer.id, 'b');
  assert.throws(() => game.draw('a'), /not your turn/);
});

test('legal moves: active color, same value/symbol, or any wild', () => {
  const top = card('red', '7');
  assert.ok(isLegal(card('red', '2'), top, 'red'));
  assert.ok(isLegal(card('blue', '7'), top, 'red'));
  assert.ok(!isLegal(card('blue', '8'), top, 'red'));
  assert.ok(isLegal(card(null, 'wild'), top, 'red'));
  assert.ok(isLegal(card(null, 'wild4'), top, 'red'));
  assert.ok(isLegal(card('green', 'draw2'), card('red', 'draw2'), 'red'));
  assert.ok(isLegal(card('green', 'skip'), card('yellow', 'skip'), 'yellow'));
  assert.ok(!isLegal(card('green', 'skip'), card('yellow', 'reverse'), 'yellow'));
  // After a wild, only the chosen color (or another wild) matches.
  assert.ok(isLegal(card('blue', '4'), card(null, 'wild'), 'blue'));
  assert.ok(!isLegal(card('red', '4'), card(null, 'wild'), 'blue'));
});

test('an illegal play is rejected and changes nothing', () => {
  const bad = card('blue', '8');
  const game = rig(['a', 'b'], { hands: [[bad, card('red', '1')], filler(3)], top: card('red', '7') });
  assert.throws(() => game.play('a', bad.id), /can't play blue 8/);
  assert.equal(game.players[0].hand.length, 2);
  assert.equal(game.topCard.value, '7');
  assert.equal(game.turn, 0);
  assert.throws(() => game.play('a', 'nope'), /don't have that card/);
});

test('Wild +4 is legal even while holding the active color, and needs a color', () => {
  const plus4 = card(null, 'wild4');
  const game = rig(['a', 'b', 'c'], {
    hands: [[plus4, card('red', '1'), card('red', '2')], filler(3), filler(3)],
    top: card('red', '7'),
    drawPile: filler(10, 'yellow', '5'),
  });
  assert.throws(() => game.play('a', plus4.id), /Choose a color/);
  assert.throws(() => game.play('a', plus4.id, 'purple'), /Choose a color/);
  assert.equal(game.players[0].hand.length, 3);
  game.play('a', plus4.id, 'green');
  assert.equal(game.activeColor, 'green');
  assert.equal(game.topCard.id, plus4.id);
});

test('drawing ends the turn even when the drawn card is playable', () => {
  const playable = card('red', '5');
  const game = rig(['a', 'b'], {
    hands: [[card('red', '1'), card('red', '2')], filler(3)],
    top: card('red', '7'),
    drawPile: [card('blue', '1'), playable],
  });
  const event = game.draw('a');
  assert.equal(event.drawn, 1);
  assert.ok(game.players[0].hand.some((c) => c.id === playable.id));
  assert.equal(game.currentPlayer.id, 'b');
  assert.throws(() => game.play('a', playable.id), /not your turn/);
});

test('RUNO! can only be called on your turn with exactly one card', () => {
  const game = rig(['a', 'b'], {
    hands: [[card('red', '1'), card('red', '2')], [card('red', '3')]],
    top: card('red', '7'),
  });
  assert.throws(() => game.callRuno('a'), /exactly one card/); // two cards
  assert.throws(() => game.callRuno('b'), /not your turn/); // one card, not their turn
  game.play('a', game.players[0].hand[0].id); // a now has one card, turn passes to b
  assert.throws(() => game.callRuno('a'), /not your turn/);
  const event = game.callRuno('b');
  assert.equal(event.type, 'runo');
  assert.equal(game.players[1].calledRuno, true);
  assert.equal(game.currentPlayer.id, 'b', 'calling does not end the turn');
  assert.equal(game.callRuno('b').repeat, true, 'calling twice does nothing');
  assert.equal(game.players[1].calledRuno, true);
});

test('calling RUNO! then playing the last card wins', () => {
  const last = card('red', '4');
  const game = rig(['a', 'b'], { hands: [[last], filler(3)], top: card('red', '7') });
  game.callRuno('a');
  const event = game.play('a', last.id);
  assert.equal(event.won, true);
  assert.equal(game.status, 'finished');
  assert.equal(game.winnerId, 'a');
  assert.equal(game.players[0].calledRuno, false);
  assert.throws(() => game.draw('b'), /round is over/);
});

test('forgetting RUNO!: card stays in hand, draw 2, turn ends', () => {
  const last = card('red', '4');
  const game = rig(['a', 'b', 'c'], {
    hands: [[last], filler(3), filler(3)],
    top: card('red', '7'),
    drawPile: [card('blue', '1'), card('blue', '2'), card('blue', '3')],
  });
  const event = game.play('a', last.id);
  assert.equal(event.type, 'penalty');
  assert.equal(game.status, 'playing');
  const hand = game.players[0].hand;
  assert.equal(hand.length, 3);
  assert.ok(hand.some((c) => c.id === last.id), 'the attempted card stays in hand');
  assert.equal(game.topCard.value, '7', 'the card was not played');
  assert.equal(game.currentPlayer.id, 'b', 'the turn ends');
  assert.equal(game.drawPile.length, 1);
});

test('the RUNO! call is cleared by drawing', () => {
  const game = rig(['a', 'b'], {
    hands: [[card('blue', '1')], filler(3)],
    top: card('red', '7'),
    drawPile: filler(5, 'yellow', '8'),
  });
  game.callRuno('a');
  game.draw('a');
  assert.equal(game.players[0].calledRuno, false);
  assert.equal(game.players[0].hand.length, 2);
});

test('the RUNO! call is cleared by a penalty draw from +2', () => {
  const game = rig(['a', 'b'], {
    hands: [[card('red', '1')], [card('red', 'draw2'), card('red', '5')]],
    top: card('red', '7'),
    drawPile: filler(5, 'yellow', '8'),
  });
  game.players[0].calledRuno = true; // e.g. left over from their own turn
  game.turn = 1;
  game.play('b', game.players[1].hand[0].id);
  assert.equal(game.players[0].calledRuno, false);
  assert.equal(game.players[0].hand.length, 3);
});

test('Skip: 3 players skips the next player; 2 players plays again', () => {
  const three = rig(['a', 'b', 'c'], { hands: [[card('red', 'skip'), card('red', '1')], filler(3), filler(3)], top: card('red', '7') });
  three.play('a', three.players[0].hand[0].id);
  assert.equal(three.currentPlayer.id, 'c');

  const two = rig(['a', 'b'], { hands: [[card('red', 'skip'), card('red', '1')], filler(3)], top: card('red', '7') });
  two.play('a', two.players[0].hand[0].id);
  assert.equal(two.currentPlayer.id, 'a');
});

test('Reverse: 3 players flips direction; 2 players acts as a skip', () => {
  const three = rig(['a', 'b', 'c'], {
    hands: [filler(3), [card('red', 'reverse'), card('red', '1'), card('red', '2')], filler(3)],
    top: card('red', '7'),
    turn: 1,
  });
  three.play('b', three.players[1].hand[0].id);
  assert.equal(three.direction, -1);
  assert.equal(three.currentPlayer.id, 'a', 'goes back the other way');
  // The next plain card keeps going counter-clockwise: a -> c.
  three.players[0].hand = [card('red', '2'), card('red', '3')];
  three.play('a', three.players[0].hand[0].id);
  assert.equal(three.currentPlayer.id, 'c');

  const two = rig(['a', 'b'], { hands: [[card('red', 'reverse'), card('red', '1')], filler(3)], top: card('red', '7') });
  two.play('a', two.players[0].hand[0].id);
  assert.equal(two.currentPlayer.id, 'a');
});

test('+2 makes the next player draw 2 and lose their turn', () => {
  const game = rig(['a', 'b', 'c'], {
    hands: [[card('red', 'draw2'), card('red', '1')], filler(3), filler(3)],
    top: card('red', '7'),
    drawPile: filler(10, 'yellow', '8'),
  });
  const event = game.play('a', game.players[0].hand[0].id);
  assert.equal(event.victimId, 'b');
  assert.equal(game.players[1].hand.length, 5);
  assert.equal(game.players[2].hand.length, 3);
  assert.equal(game.currentPlayer.id, 'c');
});

test('Wild +4 targets the next player in the current direction', () => {
  const game = rig(['a', 'b', 'c', 'd'], {
    hands: [filler(3), [card(null, 'wild4'), card('red', '1')], filler(3), filler(3)],
    top: card('red', '7'),
    turn: 1,
    direction: -1,
    drawPile: filler(10, 'yellow', '8'),
  });
  game.play('b', game.players[1].hand[0].id, 'blue');
  assert.equal(game.players[0].hand.length, 7, 'a (counter-clockwise from b) draws 4');
  assert.equal(game.players[2].hand.length, 3);
  assert.equal(game.currentPlayer.id, 'd');
  assert.equal(game.activeColor, 'blue');
});

test('+2 and +4 in a 2-player game give the player another turn', () => {
  const game = rig(['a', 'b'], {
    hands: [[card('red', 'draw2'), card(null, 'wild4'), card('red', '1')], filler(3)],
    top: card('red', '7'),
    drawPile: filler(10, 'yellow', '8'),
  });
  game.play('a', game.players[0].hand[0].id);
  assert.equal(game.currentPlayer.id, 'a');
  game.play('a', game.players[0].hand[0].id, 'green');
  assert.equal(game.currentPlayer.id, 'a');
  assert.equal(game.players[1].hand.length, 9);
});

test('a final action card still takes effect', () => {
  const game = rig(['a', 'b', 'c'], {
    hands: [[card('red', 'draw2')], filler(3), filler(3)],
    top: card('red', '7'),
    drawPile: filler(10, 'yellow', '8'),
  });
  game.callRuno('a');
  const event = game.play('a', game.players[0].hand[0].id);
  assert.equal(event.won, true);
  assert.equal(game.players[1].hand.length, 5);
  assert.equal(game.winnerId, 'a');
});

test('an empty draw pile is rebuilt from the discards, keeping the top card', () => {
  const old = [card('green', '1'), card('green', '2'), card('green', '3')];
  const top = card('red', '7');
  const game = rig(['a', 'b'], { hands: [filler(2), filler(2)], top, drawPile: [] });
  game.discard = [...old, top];
  game.draw('a');
  assert.equal(game.topCard.id, top.id);
  assert.equal(game.discard.length, 1);
  assert.equal(game.drawPile.length, 2);
  const drawn = game.players[0].hand[2];
  assert.ok(ids(old).includes(drawn.id));
  assert.deepEqual(ids([...game.drawPile, drawn]).sort(), ids(old).sort());
});

test('with nothing left to draw, drawing gives no card but still ends the turn', () => {
  const game = rig(['a', 'b'], { hands: [filler(2), filler(2)], top: card('red', '7'), drawPile: [] });
  const event = game.draw('a');
  assert.equal(event.drawn, 0);
  assert.equal(game.players[0].hand.length, 2);
  assert.equal(game.currentPlayer.id, 'b');
});

test('a snapshot shows only the viewer\'s hand and never the draw pile', () => {
  const game = new Game(['a', 'b', 'c'], { rng: seeded(9) });
  const snap = game.snapshotFor('a');
  const json = JSON.stringify(snap);
  assert.deepEqual(ids(snap.hand), ids(game.players[0].hand));
  for (const other of [...game.players[1].hand, ...game.players[2].hand, ...game.drawPile]) {
    assert.ok(!json.includes(other.id), 'no hidden card ids leak');
  }
  assert.deepEqual(snap.players.map((p) => p.cardCount), [7, 7, 7]);
  assert.equal(snap.drawPileCount, game.drawPile.length);
  assert.ok(!('drawPile' in snap));
});

test('snapshot marks playable cards only on your turn', () => {
  const game = rig(['a', 'b'], {
    hands: [[card('red', '1'), card('blue', '2'), card(null, 'wild')], [card('red', '3')]],
    top: card('red', '7'),
  });
  assert.deepEqual(game.snapshotFor('a').hand.map((c) => c.playable), [true, false, true]);
  assert.deepEqual(game.snapshotFor('b').hand.map((c) => c.playable), [false]);
  assert.equal(game.snapshotFor('b').canCallRuno, false);
  game.turn = 1;
  assert.equal(game.snapshotFor('b').canCallRuno, true);
  game.callRuno('b');
  assert.equal(game.snapshotFor('b').canCallRuno, false);
  assert.equal(game.snapshotFor('a').players[1].calledRuno, true, 'others can see the call');
});
