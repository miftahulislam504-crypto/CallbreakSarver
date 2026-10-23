# 29 and Poker

The server now runs three games, each as its own Colyseus room type:

| Room name    | Class              | Engine                    | Seats |
|--------------|--------------------|---------------------------|-------|
| `callbreak`  | `CallBreakRoom`    | `engine/game.ts`          | 4     |
| `twentynine` | `TwentyNineRoom`   | `engine/twentynine.ts`    | 4     |
| `poker`      | `PokerRoom`        | `engine/poker.ts`         | 2-6   |

`TwentyNineRoom` and `PokerRoom` share `rooms/TableRoom.ts` (seats, host, bots, reconnect, avatars, voice,
metadata). `CallBreakRoom` is unchanged except that it now takes its small helpers from `rooms/common.ts`.

`GET /rooms` lists Call Break rooms (what older apps expect). Use `GET /rooms?game=twentynine` or
`GET /rooms?game=poker` for the others.

## 29 (rules as implemented)

- 4 players, partners sit opposite (seats 0+2 against 1+3). 32 cards (7 to A).
- Card order: J, 9, A, 10, K, Q, 8, 7. Points: J=3, 9=2, A=1, 10=1 (28), plus 1 for the last trick (29).
- Each player gets 4 cards, then bids 16-28 (or passes). Bidding runs round the table; if everyone else passes,
  the last player must bid 16. A bid of 28 ends the auction at once.
- The bidder secretly picks the trump suit, then everyone gets 4 more cards. The player left of the dealer leads.
- Follow suit if you can. A player who cannot follow may ask for trump to be shown (`reveal`). From then on, a player
  who cannot follow must play trump if they hold it. Before that, trump cards played as discards are ordinary cards.
- Pair: after trump is shown, playing the K or Q of trump while still holding the other declares a pair.
  The bidder's team then needs 4 points fewer; if the other team declares it, the bidder needs 4 more.
- Scoring: the bidder's team gets +1 game point if it reaches its target, otherwise -1. First team to
  +N wins (or the other team reaches -N). N is the room's `targetScore` (2-30, default 3).
- Messages: `bid {bid}` (0 = pass), `trump {suit}`, `play {suit, rank}`, `reveal`, `setTarget {targetScore}`.

## Poker (rules as implemented)

- No-limit Texas Hold'em, play-money chips only. Freezeout: play until one player has all the chips
  (or 120 hands, then the biggest stack wins).
- Starting chips 500 / 1000 / 2000 / 5000. Blinds start at 1/100 and 1/50 of the stack and go up every 8 hands.
- Heads-up: the button is the small blind and acts first before the flop. Side pots, split pots (odd chip to the
  first winner left of the button), short all-ins that do not reopen the betting, and uncalled bets are handled.
- A player who runs out of time checks if that is free, otherwise folds. After two missed turns a bot plays for them.
- Messages: `act {type: fold|check|call|raise|allin, amount}` (`amount` = total bet for the street),
  `setChips {startingChips}`.
- Other players' hole cards are never sent, except at a showdown.

## Tests

```
npm run test:29       # 29 engine (pure, no network)
npm run test:poker    # poker engine and bots (pure, no network)
npm run test:rooms    # room integration tests for 29 and poker (needs the real Colyseus install)
npm run test:all      # everything
npm run typecheck
```

The two engines were also played to the end with bots many times (all seat counts, chips conserved to the unit).
The `*-room.test.ts` files follow the style of `room.test.ts`; they need `npm install` first.
