import test from 'node:test';
import assert from 'node:assert/strict';
import { Card, createDeck, mulberry32, shuffle, sameCard } from '../src/engine/cards.js';
import { CallBreakGame } from '../src/engine/game.js';
import { PlayedCard, legalPlays, needsRedeal, roundScore10, trickWinnerSeat } from '../src/engine/rules.js';
import { chooseBid, chooseCard } from '../src/engine/bot.js';

const c = (suit: Card['suit'], rank: number): Card => ({ suit, rank });
const p = (seat: number, suit: Card['suit'], rank: number): PlayedCard => ({ seat, card: c(suit, rank) });

test('deck has 52 unique cards; shuffle keeps them', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((x) => `${x.suit}${x.rank}`)).size, 52);
  const s = shuffle(deck, mulberry32(1));
  assert.equal(s.length, 52);
  assert.equal(new Set(s.map((x) => `${x.suit}${x.rank}`)).size, 52);
  assert.notDeepEqual(s, deck);
});

test('trick winner: highest lead suit wins, spade trumps', () => {
  assert.equal(trickWinnerSeat([p(0, 'H', 5), p(1, 'H', 12), p(2, 'D', 14), p(3, 'H', 9)]), 1);
  assert.equal(trickWinnerSeat([p(0, 'H', 5), p(1, 'S', 2), p(2, 'H', 14), p(3, 'S', 3)]), 3);
  assert.equal(trickWinnerSeat([p(2, 'S', 7), p(3, 'S', 9), p(0, 'H', 14), p(1, 'S', 8)]), 3);
});

test('legal plays: lead = anything', () => {
  const hand = [c('H', 3), c('S', 9)];
  assert.equal(legalPlays(hand, []).length, 2);
});

test('legal plays: must follow suit and beat if possible', () => {
  const hand = [c('H', 3), c('H', 10), c('H', 13), c('S', 2)];
  const trick = [p(0, 'H', 9)];
  const legal = legalPlays(hand, trick);
  assert.deepEqual(legal.map((x) => x.rank).sort((a, b) => a - b), [10, 13]);
});

test('legal plays: follow suit with lower cards when cannot beat', () => {
  const hand = [c('H', 3), c('H', 4), c('S', 2)];
  const legal = legalPlays(hand, [p(0, 'H', 12)]);
  assert.equal(legal.length, 2);
  assert.ok(legal.every((x) => x.suit === 'H'));
});

test('legal plays: trick already trumped -> any card of lead suit', () => {
  const hand = [c('H', 3), c('H', 13), c('S', 2)];
  const legal = legalPlays(hand, [p(0, 'H', 9), p(1, 'S', 4)]);
  assert.equal(legal.length, 2);
  assert.ok(legal.every((x) => x.suit === 'H'));
});

test('legal plays: cannot follow -> must trump, and over-trump if a spade is winning', () => {
  const hand = [c('D', 3), c('S', 2), c('S', 9), c('S', 12)];
  assert.deepEqual(
    legalPlays(hand, [p(0, 'H', 9)]).map((x) => x.rank).sort((a, b) => a - b),
    [2, 9, 12],
  );
  assert.deepEqual(
    legalPlays(hand, [p(0, 'H', 9), p(1, 'S', 8)]).map((x) => x.rank).sort((a, b) => a - b),
    [9, 12],
  );
  // cannot over-trump -> any spade
  assert.equal(legalPlays(hand, [p(0, 'H', 9), p(1, 'S', 14)]).length, 3);
});

test('legal plays: no lead suit and no spade -> anything', () => {
  const hand = [c('D', 3), c('C', 9)];
  assert.equal(legalPlays(hand, [p(0, 'H', 9)]).length, 2);
});

test('legal plays: spade lead -> must play higher spade if possible', () => {
  const hand = [c('S', 3), c('S', 10), c('H', 14)];
  const legal = legalPlays(hand, [p(0, 'S', 8)]);
  assert.deepEqual(legal, [c('S', 10)]);
});

test('redeal rules', () => {
  const noSpade = [c('H', 14), c('D', 14), c('C', 14)];
  const ok = [c('S', 2), c('H', 14)];
  const low = [c('S', 2), c('H', 9)];
  const rules = { noSpade: true, allBelow: 10 };
  assert.equal(needsRedeal([ok, ok, ok, ok], rules), false);
  assert.equal(needsRedeal([ok, noSpade, ok, ok], rules), true);
  assert.equal(needsRedeal([ok, low, ok, ok], rules), true);
  assert.equal(needsRedeal([ok, low, ok, ok], { noSpade: true, allBelow: null }), false);
});

test('round score: bid met = +bid, short = -bid, double or more = -bid (whole points)', () => {
  assert.equal(roundScore10(3, 3), 30);
  assert.equal(roundScore10(3, 4), 30); // no bonus for an extra trick
  assert.equal(roundScore10(3, 5), 30); // 5 is still under double
  assert.equal(roundScore10(3, 2), -30);
  assert.equal(roundScore10(3, 6), -30); // exactly double
  assert.equal(roundScore10(3, 9), -30); // more than double
  assert.equal(roundScore10(1, 1), 10);
  assert.equal(roundScore10(1, 2), -10); // 2 is already double of 1
  assert.equal(roundScore10(1, 0), -10);
  assert.equal(roundScore10(2, 3), 20);
  assert.equal(roundScore10(2, 4), -20);
  assert.equal(roundScore10(4, 7), 40);
  assert.equal(roundScore10(4, 8), -40);
  assert.equal(roundScore10(7, 13), 70); // a 7 can never be doubled
  assert.equal(roundScore10(8, 7), -80);
  assert.equal(roundScore10(0, 0), 0); // no-bid round, nothing won
  assert.equal(roundScore10(5, 5) % 10, 0);
});

test('game: with dealPhase, a deal waits in "dealing" until beginRound()', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(7), dealPhase: true });
  g.start(2);
  assert.equal(g.phase, 'dealing');
  assert.ok(g.hands.every((h) => h.length === 13));
  assert.equal(g.placeBid(3, 2).ok, false); // cannot bid while cards are being dealt
  assert.equal(g.playCard(3, g.hands[3][0]).ok, false);
  assert.equal(g.beginRound().ok, true);
  assert.equal(g.phase, 'bidding');
  assert.equal(g.turn, 3); // left of the dealer
  assert.equal(g.beginRound().ok, false); // only valid once
});

test('game: dealPhase also applies to later rounds and to a no-bid round', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(9), dealPhase: true, noBidRounds: 1 });
  g.start(0);
  assert.equal(g.phase, 'dealing');
  g.beginRound();
  assert.equal(g.phase, 'playing'); // round 1 has no bidding
  while (g.phase === 'playing') g.playCard(g.turn, g.legalMoves(g.turn)[0]);
  assert.equal(g.phase, 'roundEnd');
  g.nextRound();
  assert.equal(g.phase, 'dealing');
  g.beginRound();
  assert.equal(g.phase, 'bidding');
});

test('game: deal gives 13 cards each, 52 unique, bidding starts left of dealer', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(7) });
  g.start(0);
  assert.equal(g.phase, 'bidding');
  assert.ok(g.hands.every((h) => h.length === 13));
  assert.equal(new Set(g.hands.flat().map((x) => `${x.suit}${x.rank}`)).size, 52);
  assert.equal(g.turn, 1);
  // every hand has a spade (redeal rule)
  assert.ok(g.hands.every((h) => h.some((x) => x.suit === 'S')));
});

test('game: bidding validates turn and range, then moves to playing', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(3) });
  g.start(0);
  assert.equal(g.placeBid(0, 3).ok, false); // not your turn
  assert.equal(g.placeBid(1, 0).ok, false); // below min
  assert.equal(g.placeBid(1, 9).ok, false); // above max
  assert.equal(g.placeBid(1, 2.5).ok, false);
  assert.equal(g.placeBid(1, 2).ok, true);
  assert.equal(g.placeBid(2, 3).ok, true);
  assert.equal(g.placeBid(3, 1).ok, true);
  assert.equal(g.phase, 'bidding');
  assert.equal(g.placeBid(0, 4).ok, true);
  assert.equal(g.phase, 'playing');
  assert.equal(g.turn, 1);
});

test('game: rejects cards not in hand, out of turn, and illegal cards', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(11) });
  g.start(0);
  [1, 2, 3, 0].forEach((s) => g.placeBid(s, 2));
  assert.equal(g.playCard(2, g.hands[2][0]).ok, false); // wrong turn
  const other = g.hands[2][0];
  assert.equal(g.playCard(1, other).ok, false); // not in seat 1's hand
  assert.equal(g.playCard(1, { suit: 'X' as any, rank: 3 }).ok, false);
  const first = g.legalMoves(1)[0];
  assert.equal(g.playCard(1, first).ok, true);
  // seat 2 now has to obey the rules
  const hand2 = g.hands[2];
  const legal2 = g.legalMoves(2);
  const illegal = hand2.find((x) => !legal2.some((l) => sameCard(l, x)));
  if (illegal) assert.equal(g.playCard(2, illegal).ok, false);
});

/** Play a full game with bots in every seat, checking invariants all along. */
function simulate(seed: number, target: number) {
  const g = new CallBreakGame({ targetScore: target, rng: mulberry32(seed) });
  g.start(seed % 4);
  let guard = 0;
  while (g.phase !== 'finished') {
    assert.ok(++guard < 20000, 'simulation stuck');
    if (g.phase === 'bidding') {
      const r = g.placeBid(g.turn, chooseBid(g.hands[g.turn], g.config.minBid, g.config.maxBid));
      assert.ok(r.ok, 'bot bid rejected');
    } else if (g.phase === 'playing') {
      const seat = g.turn;
      const card = chooseCard({
        hand: g.hands[seat],
        trick: g.trick,
        seat,
        bid: g.bids[seat]!,
        tricksWon: g.tricksWon[seat],
      });
      const r = g.playCard(seat, card);
      assert.ok(r.ok, `bot played illegal card: ${r.ok ? '' : r.error}`);
    } else if (g.phase === 'roundEnd') {
      const last = g.history[g.history.length - 1];
      assert.equal(last.tricks.reduce((a, b) => a + b, 0), 13);
      assert.ok(g.nextRound().ok);
    }
  }
  return g;
}

test('simulation: bots finish full games for many seeds and targets', () => {
  for (const target of [29, 49, 99]) {
    for (let seed = 1; seed <= 30; seed++) {
      const g = simulate(seed * 31 + target, target);
      assert.equal(g.phase, 'finished');
      assert.ok(g.winners && g.winners.length >= 1);
      const best = Math.max(...g.totals10);
      assert.ok(g.winners.every((w) => g.totals10[w] === best));
      if (g.history.length < g.config.maxRounds) {
        assert.ok(best >= target * 10, 'ended before target without hitting the round cap');
        assert.equal(g.winners.length, 1, 'tie at the top must not end the game early');
      }
      // all rounds consistent
      for (const r of g.history) {
        assert.equal(r.tricks.reduce((a, b) => a + b, 0), 13);
        r.scores10.forEach((s, i) => assert.equal(s, roundScore10(r.bids[i], r.tricks[i])));
      }
      assert.deepEqual(
        g.totals10,
        [0, 1, 2, 3].map((s) => g.history.reduce((a, r) => a + r.scores10[s], 0)),
      );
    }
  }
});

test("view never leaks opponents' hands", () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(5) });
  g.start(0);
  const v = g.viewFor(2);
  assert.equal(v.myHand.length, 13);
  assert.deepEqual(v.handCounts, [13, 13, 13, 13]);
  const json = JSON.stringify(v);
  for (const seat of [0, 1, 3]) {
    for (const card of g.hands[seat]) assert.equal(json.includes(JSON.stringify(card)), false);
  }
  assert.equal(g.viewFor(null).myHand.length, 0);
});

test('tie at the top after reaching the target keeps the game going', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(9) });
  g.start(0);
  // fake: force the end-of-round check by manipulating totals before the final trick
  g.totals10 = [300, 300, 0, 0];
  // play the round out with bots
  while (g.phase === 'bidding' || g.phase === 'playing') {
    if (g.phase === 'bidding') g.placeBid(g.turn, 1);
    else {
      const seat = g.turn;
      g.playCard(seat, chooseCard({ hand: g.hands[seat], trick: g.trick, seat, bid: 1, tricksWon: g.tricksWon[seat] }));
    }
  }
  // Seats 0 and 1 started tied above target; after one round they only stay tied if equal scores,
  // otherwise a single leader above target ends it. Either outcome must be internally consistent.
  const max = Math.max(...g.totals10);
  const leaders = g.totals10.filter((t) => t === max).length;
  if (g.phase === 'finished') assert.equal(leaders, 1);
  else assert.equal(g.phase, 'roundEnd');
});

test('no-bid round: dealt straight into play, bids rejected, scored as tricks won, then bidding resumes', () => {
  const g = new CallBreakGame({ targetScore: 99, noBidRounds: 1, rng: mulberry32(21) });
  g.start(0);
  assert.equal(g.phase, 'playing');
  assert.equal(g.noBid, true);
  assert.equal(g.turn, 1);
  assert.equal(g.placeBid(1, 2).ok, false);
  assert.ok(g.viewFor(1).bids.every((b) => b === null));

  while (g.phase === 'playing') {
    const seat = g.turn;
    const r = g.playCard(seat, chooseCard({ hand: g.hands[seat], trick: g.trick, seat, bid: 13, tricksWon: g.tricksWon[seat] }));
    assert.ok(r.ok);
  }
  assert.equal(g.phase, 'roundEnd');
  const r1 = g.history[0];
  assert.deepEqual(r1.bids, r1.tricks);
  assert.deepEqual(r1.scores10, r1.tricks.map((t) => t * 10));
  assert.equal(r1.scores10.reduce((a, b) => a + b, 0), 130);

  assert.ok(g.nextRound().ok);
  assert.equal(g.round, 2);
  assert.equal(g.noBid, false);
  assert.equal(g.phase, 'bidding');
});

test('noBidRounds defaults to 0: round 1 starts with bidding', () => {
  const g = new CallBreakGame({ targetScore: 29, rng: mulberry32(2) });
  g.start(0);
  assert.equal(g.phase, 'bidding');
});
