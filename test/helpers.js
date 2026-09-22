'use strict';

const { Game } = require('../server/game');

// Deterministic PRNG (mulberry32) so failures are reproducible.
function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 0;
// card('red', '7'), card('blue', 'skip'), card(null, 'wild4')
function card(color, value) {
  return { id: `t${nextId++}`, color, value };
}

/**
 * A game with a fully specified table:
 *   rig(['a', 'b'], { hands: [[...], [...]], top, color, turn, drawPile, direction })
 * drawPile is listed top card last.
 */
function rig(playerIds, { hands, top, color, turn = 0, drawPile, direction = 1 } = {}) {
  const game = new Game(playerIds, { rng: seeded(42) });
  if (hands) hands.forEach((hand, i) => { game.players[i].hand = hand; });
  if (top) {
    game.discard = [top];
    game.activeColor = color ?? top.color;
  }
  if (drawPile) game.drawPile = drawPile;
  game.turn = turn;
  game.direction = direction;
  return game;
}

module.exports = { seeded, card, rig };
