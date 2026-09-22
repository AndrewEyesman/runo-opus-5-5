# Runo

A small real-time multiplayer card game for 2–4 friends. It plays like UNO with a few house rules, most notably the **RUNO!** call. One person creates a room, the others join with a 6-character code or an invite link, and everyone plays from their own device.

It has no dependencies: a Node.js server (built-ins only) and a plain HTML/CSS/JS frontend.

## Run it

Requires Node.js 22 or newer.

```sh
npm start        # http://localhost:3000  (set PORT to change it)
npm test         # rules, rooms and HTTP tests (node --test)
npm run smoke -- http://localhost:3000   # end-to-end check against a running server
```

Open the page in two browsers (or `localhost` and `127.0.0.1` in one browser, since each origin keeps its own session), create a room in one and join from the other.

### Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`). |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API cross-origin. When unset, any `localhost`/`127.0.0.1` origin is allowed. The server's own origin always works. |
| `RENDER_EXTERNAL_URL` | Set automatically on Render; that origin is always allowed. |

### Deploy

`npm run deploy` deploys to Render's free tier and is safe to run repeatedly. It needs `RENDER_API_KEY` and a GitHub `origin` remote. It finds the web service named after the repository (for example `runo-foo`) or creates it with `plan: "free"`, triggers a deploy, waits until it is live, checks `/api/health` and prints the public URL.

## House rules

**Deck.** 108 cards: in each of red, yellow, green and blue there's one 0, two each of 1–9, two Skip, two Reverse and two +2. Add 4 Wild and 4 Wild +4.

**Deal.** 7 cards each. The starting discard is the first number card (0–9) in the remaining pile, so a round never starts on an action card or a Wild. A random player goes first, and play starts clockwise in join order.

**Your turn.** Do exactly one thing:

- **Play** a legal card: it matches the active color, or the top card's number or symbol, or it is a Wild / Wild +4. Wilds are always legal, even if you hold the active color, and nobody can challenge a +4.
- **Draw** one card. Drawing always ends your turn, even if the card you drew could be played. You may draw even when you could play. There is no separate pass.

If the draw pile runs out, every discard except the top card is shuffled into a new pile. If there is still nothing to draw, your turn simply ends.

**Action cards.**

- **Skip**: the next player loses their turn.
- **Reverse**: direction flips. With 2 players it acts as a Skip.
- **+2 / Wild +4**: the next player draws 2 / 4 and loses their turn. No stacking.
- **Wild / Wild +4**: you choose the new color.
- With 2 players, Skip, Reverse, +2 and +4 all give you another turn.
- No jump-ins and no 7-0 swapping.

**RUNO!** (the key house rule)

- Call it when you have **exactly one card left, on your own turn, before you play it**. You can't call with two or more cards or on someone else's turn.
- Calling doesn't end your turn; you still play or draw.
- Play your last card without calling and it bounces: you **keep the card, draw 2, and your turn ends**.
- Your call is cleared whenever you receive a card (drawing, a penalty, or a +2/+4) and whenever you play. Everyone can see who has called. Nobody can "catch" you; the penalty above is the only one.

**Winning.** The first player to empty their hand wins the round. A final action card still takes effect (a last +2 still makes the next player draw). There are no points, just a win count per player that lasts as long as the room. The host can deal again with the same players; win counts carry over and a new first player is picked at random.

## Rooms

- Enter a name (1–20 characters) and create a room or join one. Codes are 6 hex characters, and invite links look like `/?room=A1B2C3`.
- The main menu lists open rooms: not mid-round, fewer than 4 players, at least one person connected.
- The creator is the host. Only the host can deal, and only when there are 2+ players and everyone is connected. The host can remove players. If the host leaves, the next player in seat order becomes host.
- Leaving or being removed mid-round cancels the round for everyone, with no winner.
- Disconnecting is fine: your seat, hand and turn are kept and the game waits. Reloading the page reconnects you. Rooms with nobody connected for 2 hours are deleted.
- State is in memory only. If the server restarts (or a free Render instance sleeps), rooms are lost and players are returned to the main menu with a message.

## How it works

- `server/game.js`: pure rules for one round (deck, deal, legality, effects, RUNO!, snapshots).
- `server/rooms.js`: rooms, seats, host, chat, action log, and the per-player state pushed to clients.
- `server/index.js`: HTTP API, Server-Sent Events stream, static files, CORS, body limits, per-IP rate limit.
- `public/`: the browser client.

The server is authoritative. Clients send actions (`POST /api/rooms/:code/actions`) and receive their own view of the game over `GET /api/rooms/:code/events` (SSE). A client's view contains only its own hand, the other players' card counts, and never the draw pile.
