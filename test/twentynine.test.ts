import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Card, mulberry32 } from '../src/engine/cards.js';
import {
  TNPlayed, TwentyNineGame, canAskTrump, cardPoints, createDeck32, legalPlays, teamOf, trickWinnerSeat,
} from '../src/engine/twentynine.js';
import { chooseAction, chooseBid, chooseTrump } from '../src/engine/twentynine-bot.js';

const c = (suit: Card['suit'], rank: number): Card => ({ suit, rank });
const p = (seat: number, card: Card, asTrump = false): TNPlayed => ({ seat, card, asTrump });

test('deck has 32 cards worth 28 points', () => {
  const deck = createDeck32();
  assert.equal(deck.length, 32);
  assert.equal(deck.reduce((a, x) => a + cardPoints(x), 0), 28);
});

test('card order inside a suit: J > 9 > A > 10 > K > Q > 8 > 7', () => {
  const order = [11, 9, 14, 10, 13, 12, 8, 7];
  for (let i = 0; i < order.length - 1; i++) {
    const trick = [p(0, c('H', order[i + 1])), p(1, c('H', order[i]))];
    assert.equal(trickWinnerSeat(trick, null), 1, `${order[i]} beats ${order[i + 1]}`);
  }
});

test('trick winner: revealed trump beats the led suit; unrevealed trump-suit discards do not', () => {
  const trick = [p(0, c('H', 14)), p(1, c('S', 7), true), p(2, c('H', 11)), p(3, c('S', 9), true)];
  assert.equal(trickWinnerSeat(trick, 'S'), 3);
  const discards = [p(0, c('H', 14)), p(1, c('S', 11), false), p(2, c('H', 8)), p(3, c('D', 9), false)];
  assert.equal(trickWinnerSeat(discards, 'S'), 0);
});

test('led trump suit is just the led suit even when revealed mid-trick', () => {
  const trick = [p(0, c('S', 11)), p(1, c('S', 7), false), p(2, c('S', 9), true)];
  assert.equal(trickWinnerSeat(trick, 'S'), 0);
});

test('legalPlays: must follow suit; trump only forced after reveal', () => {
  const hand = [c('S', 9), c('D', 7), c('D', 8)];
  const led = [p(0, c('H', 14))];
  assert.deepEqual(legalPlays(hand, led, 'S', false), hand);
  assert.deepEqual(legalPlays(hand, led, 'S', true), [c('S', 9)]);
  assert.deepEqual(legalPlays(hand, [p(0, c('D', 14))], 'S', true), [c('D', 7), c('D', 8)]);
  assert.deepEqual(legalPlays(hand, [], 'S', true), hand);
  assert.equal(canAskTrump(hand, led, false), true);
  assert.equal(canAskTrump(hand, [p(0, c('D', 14))], false), false);
  assert.equal(canAskTrump(hand, led, true), false);
  assert.equal(canAskTrump(hand, [], false), false);
});

test('bidding: ascending bids, passing, winner picks trump, hands grow to 8', () => {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(1) });
  g.start(0);
  assert.equal(g.phase, 'bidding');
  assert.equal(g.turn, 1);
  assert.ok(g.hands.every((h) => h.length === 4));

  assert.equal(g.placeBid(2, 16).ok, false, 'out of turn');
  assert.equal(g.placeBid(1, 15).ok, false, 'below minimum');
  assert.equal(g.placeBid(1, 29).ok, false, 'above maximum');
  assert.equal(g.placeBid(1, 16).ok, true);
  assert.equal(g.placeBid(2, 16).ok, false, 'must raise');
  assert.equal(g.placeBid(2, 0).ok, true);
  assert.equal(g.placeBid(3, 18).ok, true);
  assert.equal(g.placeBid(0, 0).ok, true);
  assert.equal(g.placeBid(1, 0).ok, true);
  assert.equal(g.phase, 'trump');
  assert.equal(g.declarer, 3);
  assert.equal(g.contract, 18);
  assert.equal(g.chooseTrump(1, 'S').ok, false, 'only the bidder');
  assert.equal(g.chooseTrump(3, 'X').ok, false);
  assert.equal(g.chooseTrump(3, 'D').ok, true);
  assert.equal(g.phase, 'playing');
  assert.ok(g.hands.every((h) => h.length === 8));
  assert.equal(g.turn, 1);
});

test('bidding: when everyone else passes the last seat is forced to bid', () => {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(2) });
  g.start(0); // bidding starts at seat 1, dealer 0 is last
  g.placeBid(1, 0);
  g.placeBid(2, 0);
  g.placeBid(3, 0);
  assert.equal(g.turn, 0);
  assert.equal(g.viewFor(0).forcedBid, true);
  assert.equal(g.placeBid(0, 0).ok, false);
  assert.equal(g.placeBid(0, 16).ok, true);
  assert.equal(g.phase, 'trump');
  assert.equal(g.declarer, 0);
});

test('bidding: 28 ends the auction at once', () => {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(3) });
  g.start(0);
  g.placeBid(1, 20);
  g.placeBid(2, 28);
  assert.equal(g.phase, 'trump');
  assert.equal(g.declarer, 2);
});

test('trump is hidden from everyone but the bidder until revealed', () => {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(4) });
  g.start(0);
  g.placeBid(1, 17);
  g.placeBid(2, 0);
  g.placeBid(3, 0);
  g.placeBid(0, 0);
  g.chooseTrump(1, 'H');
  assert.equal(g.viewFor(1).trumpSuit, 'H');
  assert.equal(g.viewFor(0).trumpSuit, null);
  assert.equal(g.viewFor(0).trumpHidden, true);
  assert.equal(g.viewFor(null).trumpSuit, null);
  assert.equal(g.viewFor(2).trumpSuit, null);
});

/** Plays a whole round with a stub where seat plays by simple rules; returns the game. */
function playOut(g: TwentyNineGame, onReveal?: (seat: number) => void): void {
  let guard = 0;
  while (g.phase === 'playing' && guard++ < 500) {
    const seat = g.turn;
    const act = chooseAction({
      hand: g.hands[seat],
      trick: g.trick,
      seat,
      declarer: g.declarer,
      trumpSuit: seat === g.declarer || g.trumpRevealed ? g.trumpSuit : null,
      trumpRevealed: g.trumpRevealed,
    });
    if (act.type === 'reveal') {
      const r = g.revealTrump(seat);
      assert.ok(r.ok, r.ok ? '' : r.error);
      onReveal?.(seat);
    } else {
      const r = g.playCard(seat, act.card);
      assert.ok(r.ok, r.ok ? '' : r.error);
    }
  }
}

function startRound(seed: number): TwentyNineGame {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(seed) });
  g.start(0);
  let guard = 0;
  while (g.phase === 'bidding' && guard++ < 50) {
    const seat = g.turn;
    const bid = chooseBid(g.hands[seat], 16, 28, g.highBid, g.forcedBid, mulberry32(seed + seat));
    assert.ok(g.placeBid(seat, bid).ok);
  }
  assert.equal(g.phase, 'trump');
  assert.ok(g.chooseTrump(g.declarer, chooseTrump(g.hands[g.declarer])).ok);
  return g;
}

test('revealTrump: only when you cannot follow, only on your turn, only once', () => {
  const g = startRound(11);
  assert.equal(g.revealTrump(g.turn).ok, false, 'cannot ask when leading');
  // Lead any card, then find a seat that cannot follow (if any in this deal), else craft one.
  g.playCard(g.turn, g.hands[g.turn][0]);
  const seat = g.turn;
  const led = g.trick[0].card.suit;
  const canFollow = g.hands[seat].some((x) => x.suit === led);
  const res = g.revealTrump(seat);
  assert.equal(res.ok, !canFollow);
  assert.equal(g.revealTrump((seat + 1) % 4).ok, false, 'not their turn');
});

test('whole rounds always end with exactly 29 card points and empty hands', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const g = startRound(seed);
    playOut(g);
    assert.ok(g.phase === 'roundEnd' || g.phase === 'finished', `seed ${seed}: ${g.phase}`);
    assert.equal(g.teamPoints[0] + g.teamPoints[1], 29, `seed ${seed}`);
    assert.ok(g.hands.every((h) => h.length === 0));
    assert.equal(g.tricksWon.reduce((a, b) => a + b, 0), 8);
    const last = g.history[g.history.length - 1];
    const dTeam = teamOf(g.declarer);
    assert.equal(last.success, last.teamPoints[dTeam] >= last.need);
    assert.equal(last.delta[dTeam], last.success ? 1 : -1);
    assert.equal(last.delta[1 - dTeam], 0);
  }
});

test('pair: K+Q of trump after the reveal moves the bidder need by 4', () => {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(5) });
  g.start(0);
  g.placeBid(1, 20);
  g.placeBid(2, 0);
  g.placeBid(3, 0);
  g.placeBid(0, 0);
  g.chooseTrump(1, 'S');
  // Craft the situation by hand.
  g.hands = [
    [c('H', 7), c('H', 8)],
    [c('S', 13), c('S', 12)],
    [c('D', 7), c('D', 8)],
    [c('C', 7), c('C', 8)],
  ];
  g.turn = 0;
  g.trumpRevealed = true;
  g.revealedBy = 0;
  g.playCard(0, c('H', 7));
  g.playCard(1, c('S', 13)); // seat 1 holds no heart: must play trump (has only trumps)
  assert.ok(g.pair, 'pair declared');
  assert.equal(g.pair!.seat, 1);
  assert.equal(g.need, 16); // 20 - 4 for the bidder's own team
});

test('pair for the other team raises the need', () => {
  const g = new TwentyNineGame({ targetScore: 6, rng: mulberry32(6) });
  g.start(0);
  g.placeBid(1, 20);
  g.placeBid(2, 0);
  g.placeBid(3, 0);
  g.placeBid(0, 0);
  g.chooseTrump(1, 'S');
  g.hands = [
    [c('S', 13), c('S', 12)],
    [c('H', 7), c('H', 8)],
    [c('D', 7), c('D', 8)],
    [c('C', 7), c('C', 8)],
  ];
  g.turn = 1;
  g.trumpRevealed = true;
  g.playCard(1, c('H', 7));
  g.playCard(2, c('D', 7));
  g.playCard(3, c('C', 7));
  g.playCard(0, c('S', 12));
  assert.equal(g.pair?.team, 0);
  assert.equal(g.need, 24);
});

test('full games finish, score only the bidder team by +-1, and rank the winners first', () => {
  for (let seed = 100; seed < 112; seed++) {
    const g = new TwentyNineGame({ targetScore: 3, rng: mulberry32(seed) });
    g.start(seed % 4);
    let guard = 0;
    while (g.phase !== 'finished' && guard++ < 400) {
      if (g.phase === 'roundEnd') g.nextRound();
      else if (g.phase === 'bidding') {
        const s = g.turn;
        assert.ok(g.placeBid(s, chooseBid(g.hands[s], 16, 28, g.highBid, g.forcedBid, mulberry32(seed * 7 + s))).ok);
      } else if (g.phase === 'trump') {
        assert.ok(g.chooseTrump(g.declarer, chooseTrump(g.hands[g.declarer])).ok);
      } else playOut(g);
    }
    assert.equal(g.phase, 'finished', `seed ${seed}`);
    assert.ok(g.winners && g.winners.length >= 2);
    assert.equal(g.ranking!.length, 4);
    assert.deepEqual(g.ranking!.slice(0, g.winners!.length).sort(), g.winners!.slice().sort());
    const w = g.winners![0];
    if (g.winners!.length === 2) {
      const wt = teamOf(w);
      assert.ok(g.totals[wt] >= 3 || g.totals[1 - wt] <= -3 || g.round >= g.config.maxRounds);
    }
  }
});

test('view of a spectator carries no hand', () => {
  const g = startRound(9);
  const v = g.viewFor(null);
  assert.deepEqual(v.myHand, []);
  assert.deepEqual(v.legal, []);
});
