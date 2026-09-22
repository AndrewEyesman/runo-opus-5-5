'use strict';

// Pure game rules for one round of Runo. No I/O, no timers: the room layer
// (rooms.js) drives it and turns the returned events into log lines.

const crypto = require('node:crypto');

const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTION_VALUES = ['skip', 'reverse', 'draw2'];
const HAND_SIZE = 7;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GameError';
    this.status = status;
  }
}

function createDeck() {
  const cards = [];
  const add = (color, value) => cards.push({ id: '', color, value });
  for (const color of COLORS) {
    add(color, '0');
    for (let v = 1; v <= 9; v++) {
      add(color, String(v));
      add(color, String(v));
    }
    for (const value of ACTION_VALUES) {
      add(color, value);
      add(color, value);
    }
  }
  for (let i = 0; i < 4; i++) add(null, 'wild');
  for (let i = 0; i < 4; i++) add(null, 'wild4');
  return cards;
}

// Fisher-Yates, in place. `rng` returns a float in [0, 1).
function shuffle(cards, rng = Math.random) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

const isNumberCard = (card) => /^[0-9]$/.test(card.value);
const isWild = (card) => card.color === null;

function isLegal(card, topCard, activeColor) {
  if (isWild(card)) return true;
  if (card.color === activeColor) return true;
  return card.value === topCard.value;
}

const VALUE_LABELS = { skip: 'skip', reverse: 'reverse', draw2: '+2', wild: 'wild', wild4: 'wild +4' };

function describeCard(card) {
  const label = VALUE_LABELS[card.value] ?? card.value;
  return isWild(card) ? label : `${card.color} ${label}`;
}

class Game {
  /**
   * Deals a fresh round. `playerIds` is in seat order (clockwise).
   * Options: rng (for shuffles, first player and card ids); deck (tests only:
   * a pre-ordered deck to use instead of a shuffled one, top card last).
   */
  constructor(playerIds, { rng = Math.random, deck = null } = {}) {
    if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
      throw new GameError(`A round needs ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
    }
    this.rng = rng;
    this.players = playerIds.map((id) => ({ id, hand: [], calledRuno: false }));
    this.direction = 1; // 1 = clockwise (seat order), -1 = counter-clockwise
    this.status = 'playing';
    this.winnerId = null;

    // Card ids are random per round so they reveal nothing about the deck.
    this.drawPile = deck ? deck.map((c) => ({ ...c })) : shuffle(createDeck(), rng);
    const ids = new Set();
    for (const card of this.drawPile) {
      if (card.id && !ids.has(card.id)) {
        ids.add(card.id);
        continue;
      }
      do card.id = randomId(rng);
      while (ids.has(card.id));
      ids.add(card.id);
    }
    this.discard = [];

    // The top of the draw pile is the end of the array.
    for (let round = 0; round < HAND_SIZE; round++) {
      for (const p of this.players) p.hand.push(this.drawPile.pop());
    }

    let start = -1;
    for (let i = this.drawPile.length - 1; i >= 0; i--) {
      if (isNumberCard(this.drawPile[i])) {
        start = i;
        break;
      }
    }
    const [first] = this.drawPile.splice(start, 1);
    this.discard.push(first);
    this.activeColor = first.color;

    this.turn = Math.floor(rng() * this.players.length);
  }

  get topCard() {
    return this.discard[this.discard.length - 1];
  }

  get currentPlayer() {
    return this.players[this.turn];
  }

  player(playerId) {
    return this.players.find((p) => p.id === playerId);
  }

  // Seat index `steps` places from the current turn in the current direction.
  indexFrom(steps) {
    const n = this.players.length;
    return (((this.turn + steps * this.direction) % n) + n) % n;
  }

  advance(steps) {
    this.turn = this.indexFrom(steps);
  }

  assertTurn(playerId) {
    if (this.status !== 'playing') throw new GameError('The round is over.', 409);
    if (!this.player(playerId)) throw new GameError("You're not in this round.", 403);
    if (this.currentPlayer.id !== playerId) throw new GameError("It's not your turn.", 409);
    return this.currentPlayer;
  }

  isPlayable(card) {
    return isLegal(card, this.topCard, this.activeColor);
  }

  // Every discard except the top card becomes the new, shuffled draw pile.
  reshuffle() {
    const top = this.discard.pop();
    this.drawPile = shuffle(this.discard, this.rng);
    this.discard = [top];
  }

  drawCards(player, count) {
    let received = 0;
    for (let i = 0; i < count; i++) {
      if (this.drawPile.length === 0) this.reshuffle();
      if (this.drawPile.length === 0) break;
      player.hand.push(this.drawPile.pop());
      received++;
    }
    if (received > 0) player.calledRuno = false;
    return received;
  }

  play(playerId, cardId, chosenColor) {
    const player = this.assertTurn(playerId);
    const index = player.hand.findIndex((c) => c.id === cardId);
    if (index === -1) throw new GameError("You don't have that card.");
    const card = player.hand[index];

    if (!this.isPlayable(card)) {
      const top = this.topCard;
      const valueHint = isWild(top) ? '' : ` or a ${VALUE_LABELS[top.value] ?? top.value}`;
      throw new GameError(
        `You can't play ${describeCard(card)} there. Play ${this.activeColor}${valueHint}, or a wild.`,
      );
    }
    if (isWild(card) && !COLORS.includes(chosenColor)) {
      throw new GameError('Choose a color for your wild: red, yellow, green or blue.');
    }

    // Playing your last card without having called RUNO! fails as a penalty.
    if (player.hand.length === 1 && !player.calledRuno) {
      const drawn = this.drawCards(player, 2);
      this.advance(1);
      return { type: 'penalty', playerId, card, drawn };
    }

    player.hand.splice(index, 1);
    player.calledRuno = false;
    this.discard.push(card);
    this.activeColor = isWild(card) ? chosenColor : card.color;

    const event = { type: 'play', playerId, card, color: this.activeColor };
    const twoPlayers = this.players.length === 2;

    switch (card.value) {
      case 'skip':
        event.skippedId = this.players[this.indexFrom(1)].id;
        this.advance(2);
        break;
      case 'reverse':
        this.direction *= -1;
        if (twoPlayers) {
          // Acts as a skip: the same player goes again.
          event.skippedId = this.players[this.indexFrom(1)].id;
          this.advance(2);
        } else {
          this.advance(1);
        }
        break;
      case 'draw2':
      case 'wild4': {
        const victim = this.players[this.indexFrom(1)];
        event.victimId = victim.id;
        event.drawn = this.drawCards(victim, card.value === 'draw2' ? 2 : 4);
        this.advance(2);
        break;
      }
      default:
        this.advance(1);
    }

    if (player.hand.length === 0) {
      this.status = 'finished';
      this.winnerId = playerId;
      event.won = true;
    }
    return event;
  }

  draw(playerId) {
    const player = this.assertTurn(playerId);
    const drawn = this.drawCards(player, 1);
    this.advance(1);
    return { type: 'draw', playerId, drawn };
  }

  callRuno(playerId) {
    const player = this.assertTurn(playerId);
    if (player.hand.length !== 1) {
      throw new GameError('You can only call RUNO! when you have exactly one card left.');
    }
    if (player.calledRuno) return { type: 'runo', playerId, repeat: true };
    player.calledRuno = true;
    return { type: 'runo', playerId };
  }

  // What `viewerId` is allowed to see: their own hand, everyone else's counts.
  snapshotFor(viewerId) {
    const viewer = this.player(viewerId);
    const myTurn = this.status === 'playing' && this.currentPlayer.id === viewerId;
    return {
      status: this.status,
      turnId: this.currentPlayer.id,
      direction: this.direction === 1 ? 'clockwise' : 'counterclockwise',
      topCard: { ...this.topCard },
      activeColor: this.activeColor,
      drawPileCount: this.drawPile.length,
      discardCount: this.discard.length,
      winnerId: this.winnerId,
      players: this.players.map((p) => ({
        id: p.id,
        cardCount: p.hand.length,
        calledRuno: p.calledRuno,
      })),
      hand: viewer
        ? viewer.hand.map((c) => ({ ...c, playable: myTurn && this.isPlayable(c) }))
        : [],
      canCallRuno: Boolean(viewer && myTurn && viewer.hand.length === 1 && !viewer.calledRuno),
    };
  }
}

function randomId(rng) {
  // With the default rng use crypto; with a seeded rng stay deterministic.
  if (rng === Math.random) return crypto.randomBytes(5).toString('hex');
  return Math.floor(rng() * 0xffffffffff).toString(16).padStart(10, '0');
}

module.exports = {
  COLORS,
  HAND_SIZE,
  MIN_PLAYERS,
  MAX_PLAYERS,
  Game,
  GameError,
  createDeck,
  shuffle,
  isLegal,
  isNumberCard,
  describeCard,
};
