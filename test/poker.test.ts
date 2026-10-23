import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Card, mulberry32 } from '../src/engine/cards.js';
import { PokerGame, bestHand, categoryOf, evaluate5 } from '../src/engine/poker.js';
import { chenScore, chooseAction } from '../src/engine/poker-bot.js';

const c = (suit: Card['suit'], rank: number): Card => ({ suit, rank });
const hand = (s: string): Card[] =>
  s.split(' ').map((t) => {
    const rank = 'TJQKA'.includes(t[0]) ? 10 + 'TJQKA'.indexOf(t[0]) : Number(t[0]);
    return c(t[1].toUpperCase() as Card['suit'], rank);
  });

/* ------------------------------ evaluator ------------------------------ */

test('hand categories rank in the right order', () => {
  const ladder = [
    '2S 4H 6D 8C TS', // high card
    '2S 2H 6D 8C TS', // pair
    '2S 2H 6D 6C TS', // two pair
    '2S 2H 2D 8C TS', // trips
    '5S 6H 7D 8C 9S', // straight
    '2S 5S 7S 8S KS', // flush
    '2S 2H 2D 8C 8S', // full house
    '2S 2H 2D 2C TS', // quads
    '5S 6S 7S 8S 9S', // straight flush
  ].map((h) => evaluate5(hand(h)));
  for (let i = 0; i < ladder.length; i++) assert.equal(categoryOf(ladder[i]), i);
  for (let i = 0; i < ladder.length - 1; i++) assert.ok(ladder[i] < ladder[i + 1]);
});

test('tiebreaks: kickers, wheel, and flush by high cards', () => {
  assert.ok(evaluate5(hand('AS AH KD 5C 3S')) > evaluate5(hand('AS AH QD JC TS')), 'pair of aces, K kicker beats Q kicker');
  assert.equal(evaluate5(hand('AS AH KD 5C 3S')), evaluate5(hand('AD AC KH 5S 3D')), 'suits never break ties');
  assert.ok(evaluate5(hand('6S 5H 4D 3C 2S')) > evaluate5(hand('AS 5H 4D 3C 2S')), 'six-high straight beats the wheel');
  assert.equal(categoryOf(evaluate5(hand('AS 5H 4D 3C 2S'))), 4, 'A-2-3-4-5 is a straight');
  assert.ok(evaluate5(hand('KS QS 9S 5S 3S')) > evaluate5(hand('KS QS 9S 5S 2S')), 'flush by lower cards');
  assert.ok(evaluate5(hand('KS KH KD 2C 2S')) > evaluate5(hand('QS QH QD AC AS')), 'trips rank first in a full house');
  assert.equal(categoryOf(evaluate5(hand('AS KS QS JS TS'))), 8, 'royal is a straight flush');
  assert.equal(categoryOf(evaluate5(hand('QS KS AS 2S 3S'))), 5, 'no wrap-around straights');
});

test('bestHand picks the best five of seven', () => {
  const seven = hand('AS AH 2D 7C 9S 9H AD');
  const best = bestHand(seven);
  assert.equal(best.category, 6, 'aces full of nines');
  assert.equal(best.score, evaluate5(hand('AS AH AD 9S 9H')));
  assert.equal(bestHand(hand('2S 3S 4S 5S 9H KD 6S')).category, 8);
  assert.equal(bestHand(hand('2S 3H 4D 5C 9H KD 6S')).category, 4);
});

test('chen score orders hands sensibly', () => {
  assert.ok(chenScore(hand('AS AH')) > chenScore(hand('KS KH')));
  assert.ok(chenScore(hand('AS KS')) > chenScore(hand('AS KH')));
  assert.ok(chenScore(hand('AS KH')) > chenScore(hand('7S 2H')));
  assert.ok(chenScore(hand('7S 2H')) < 0 + 1);
});

/* ------------------------------ setup & blinds ------------------------------ */

function newGame(seats: number, seed = 1, chips = 1000, taken: number[] = [...Array(seats).keys()]): PokerGame {
  const g = new PokerGame(seats, { startingChips: chips, rng: mulberry32(seed) });
  g.start(Array.from({ length: seats }, (_, i) => taken.includes(i)));
  return g;
}

/** Fix the community cards (and the burn cards) for the rest of the hand. */
function rig(g: PokerGame, board: Card[], holes?: Card[][]): void {
  const junk = c('C', 2);
  const order = [junk, board[0], board[1], board[2], junk, board[3], junk, board[4]];
  (g as unknown as { deck: Card[] }).deck = order.reverse();
  holes?.forEach((h, s) => {
    if (h) g.players[s].hole = h;
  });
}

const total = (g: PokerGame) => g.players.reduce((a, p) => a + p.chips, 0) + g.pot;

test('heads-up: the button posts the small blind and acts first before the flop', () => {
  const g = newGame(2, 3);
  assert.equal(g.sbSeat, g.button);
  assert.notEqual(g.bbSeat, g.button);
  assert.equal(g.turn, g.button);
  assert.equal(g.players[g.sbSeat].bet, 10);
  assert.equal(g.players[g.bbSeat].bet, 20);
  assert.equal(g.pot, 30);
  assert.ok(g.players.every((p) => p.hole.length === 2));
});

test('three-handed: blinds follow the button and UTG acts first (the button)', () => {
  const g = newGame(3, 4);
  assert.equal(g.sbSeat, (g.button + 1) % 3);
  assert.equal(g.bbSeat, (g.button + 2) % 3);
  assert.equal(g.turn, g.button);
});

test('blinds scale with the starting stack', () => {
  const g = newGame(2, 1, 5000);
  assert.equal(g.players[g.sbSeat].bet, 50);
  assert.equal(g.players[g.bbSeat].bet, 100);
});

test('empty seats are skipped', () => {
  const g = newGame(6, 5, 1000, [1, 4]);
  assert.ok(!g.players[0].inHand && !g.players[2].inHand && !g.players[3].inHand && !g.players[5].inHand);
  assert.deepEqual([g.sbSeat, g.bbSeat].sort(), [1, 4]);
});

/* ------------------------------ betting rules ------------------------------ */

test('illegal actions are refused and change nothing', () => {
  const g = newGame(3, 6);
  const before = JSON.stringify(g.players);
  const notMe = (g.turn + 1) % 3;
  assert.equal(g.act(notMe, { type: 'fold' }).ok, false, 'out of turn');
  assert.equal(g.act(g.turn, { type: 'check' }).ok, false, 'cannot check facing the big blind');
  assert.equal(g.act(g.turn, { type: 'raise', amount: 30 }).ok, false, 'below the minimum raise (to 40)');
  assert.equal(g.act(g.turn, { type: 'raise', amount: 5000 }).ok, false, 'more than the stack');
  assert.equal(g.act(g.turn, { type: 'raise', amount: 40.5 }).ok, false, 'not an integer');
  assert.equal(g.act(g.turn, { type: 'dance' as never }).ok, false);
  assert.equal(JSON.stringify(g.players), before);
});

test('big blind keeps the option; a raise reopens the action; min-raise follows the last raise', () => {
  const g = newGame(3, 7);
  const [utg, sb, bb] = [g.turn, g.sbSeat, g.bbSeat];
  assert.ok(g.act(utg, { type: 'call' }).ok);
  assert.ok(g.act(sb, { type: 'call' }).ok);
  assert.equal(g.turn, bb, 'the big blind still has to act');
  assert.equal(g.street, 'preflop');
  assert.ok(g.act(bb, { type: 'raise', amount: 60 }).ok); // raise of 40
  assert.equal(g.turn, utg);
  const l = g.legalActions(utg)!;
  assert.equal(l.minRaiseTo, 100, 'min re-raise = 60 + 40');
  assert.equal(l.callAmount, 40);
  assert.ok(g.act(utg, { type: 'call' }).ok);
  assert.ok(g.act(sb, { type: 'call' }).ok);
  assert.equal(g.street, 'flop');
  assert.equal(g.board.length, 3);
  assert.equal(g.turn, sb, 'first to act after the flop is left of the button');
  assert.equal(g.pot, 180);
});

test('everyone checks down to a showdown and the pot is paid once', () => {
  const g = newGame(2, 8);
  rig(g, hand('2C 7D 9H JS KD'), [hand('AS AH'), hand('3C 4D')]);
  const winner = g.players[0].hole[0].rank === 14 ? 0 : 1;
  assert.ok(g.act(g.turn, { type: 'call' }).ok);
  assert.ok(g.act(g.turn, { type: 'check' }).ok);
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(g.street, street);
    assert.ok(g.act(g.turn, { type: 'check' }).ok);
    assert.ok(g.act(g.turn, { type: 'check' }).ok);
  }
  assert.equal(g.phase, 'handEnd');
  assert.equal(g.lastResult!.showdown, true);
  assert.deepEqual(g.lastResult!.winners, [winner]);
  assert.equal(g.players[winner].chips, 1020);
  assert.equal(g.players[1 - winner].chips, 980);
  assert.equal(g.lastResult!.players.find((p) => p.seat === winner)!.handName, 'Pair');
});

test('a fold ends the hand without showing cards', () => {
  const g = newGame(3, 9);
  const [utg, sb, bb] = [g.turn, g.sbSeat, g.bbSeat];
  g.act(utg, { type: 'fold' });
  g.act(sb, { type: 'fold' });
  assert.equal(g.phase, 'handEnd');
  assert.equal(g.lastResult!.showdown, false);
  assert.deepEqual(g.lastResult!.winners, [bb]);
  assert.ok(g.lastResult!.players.every((p) => p.hole === null));
  assert.equal(g.players[bb].chips, 1010);
  assert.equal(g.players[sb].chips, 990);
  assert.equal(g.players[utg].chips, 1000);
});

/* ------------------------------ all-ins & side pots ------------------------------ */

test('side pots: short stack wins the main pot only, the next best wins the side pot', () => {
  const g = new PokerGame(3, { startingChips: 1000, rng: mulberry32(10) });
  g.start([true, true, true]);
  g.players[0].chips = 100;
  g.players[1].chips = 300;
  g.players[2].chips = 600;
  // Restart the hand with these stacks.
  (g as unknown as { phase: string }).phase = 'handEnd';
  g.players.forEach((p) => (p.startChips = p.chips));
  // Put the button where we want: seat 0 is the button, so seat 1 is SB, seat 2 is BB.
  g.button = 2; // startHand rotates to seat 0
  g.nextHand();
  rig(g, hand('2C 7D 9H JS 4D'), [hand('AS AH'), hand('KS KH'), hand('QS QH')]);
  // seat 0 = button/UTG shoves, others call.
  assert.equal(g.turn, 0);
  assert.ok(g.act(0, { type: 'allin' }).ok);
  assert.ok(g.act(1, { type: 'allin' }).ok);
  assert.ok(g.act(2, { type: 'call' }).ok);
  assert.equal(g.phase, 'handEnd', 'board runs out and the hand is settled');
  const r = g.lastResult!;
  assert.equal(r.board.length, 5);
  assert.equal(r.pots.length, 2);
  assert.deepEqual(r.pots.map((x) => x.amount), [300, 400]);
  assert.deepEqual(r.pots[0].winners, [0], 'aces win the main pot');
  assert.deepEqual(r.pots[1].winners, [1], 'kings win the side pot');
  assert.equal(g.players[2].chips, 300, 'the big stack only called 300 of its 600');
  assert.deepEqual(g.players.map((p) => p.chips), [300, 400, 300]);
  assert.equal(g.players[0].chips + g.players[1].chips + g.players[2].chips, 1000);
});

test('a split pot divides evenly and the odd chip goes to the first winner left of the button', () => {
  const g = newGame(3, 11, 500); // blinds 5/10
  const [utg, sb, bb] = [g.turn, g.sbSeat, g.bbSeat];
  rig(g, hand('AS KD QH JC TS'), [hand('2C 3D'), hand('4C 5D'), hand('6C 7D')]); // everyone plays the broadway board
  assert.ok(g.act(utg, { type: 'call' }).ok);
  assert.ok(g.act(sb, { type: 'fold' }).ok);
  assert.ok(g.act(bb, { type: 'check' }).ok);
  while (g.phase === 'betting') assert.ok(g.act(g.turn, { type: 'check' }).ok);
  assert.deepEqual(g.lastResult!.winners.slice().sort(), [utg, bb].sort());
  assert.equal(g.players[bb].chips, 503, 'odd chip to the winner first clockwise from the button');
  assert.equal(g.players[utg].chips, 502);
  assert.equal(g.players[sb].chips, 495);
  assert.equal(total(g), 1500);
});

test('uncalled raise is returned when everyone folds to it', () => {
  const g = newGame(2, 12);
  const first = g.turn;
  g.act(first, { type: 'raise', amount: 100 });
  g.act(g.turn, { type: 'fold' });
  assert.equal(g.phase, 'handEnd');
  assert.equal(g.players[first].chips, 1020, 'wins the big blind');
  assert.equal(total(g), 2000);
});

test('a short all-in raise does not reopen the betting for players who already acted', () => {
  const g = newGame(3, 13);
  g.players[0].chips = 1000;
  g.players[1].chips = 1000;
  g.players[2].chips = 1000;
  const [utg, sb, bb] = [g.turn, g.sbSeat, g.bbSeat];
  g.players[bb].chips = 30; // BB will only be able to raise by 10 more
  g.act(utg, { type: 'raise', amount: 60 });
  g.act(sb, { type: 'call' });
  assert.equal(g.turn, bb);
  assert.ok(g.act(bb, { type: 'allin' }).ok, 'short all-in is just a call here (30 behind + 20 posted = 50 < 60)');
  assert.equal(g.street, 'flop');
});

test('short all-in raise: those who acted may only call or fold', () => {
  const g = newGame(3, 14);
  g.players.forEach((p) => (p.chips = 1000));
  const [utg, sb, bb] = [g.turn, g.sbSeat, g.bbSeat];
  g.players[sb].chips = 55; // posted 10; can go to 65 total: a raise of 5 over the 60 bet... crafted below
  g.act(utg, { type: 'raise', amount: 60 }); // raise by 40
  assert.ok(g.act(sb, { type: 'allin' }).ok); // to 65: +5, below the minimum raise of 40
  assert.equal(g.currentBet, 65);
  assert.equal(g.minRaise, 40, 'min raise unchanged by a short all-in');
  g.act(bb, { type: 'call' });
  assert.equal(g.turn, utg);
  const l = g.legalActions(utg)!;
  assert.equal(l.canRaise, false, 'utg already acted and was only raised by 5');
  assert.equal(l.callAmount, 5);
  assert.equal(g.act(utg, { type: 'raise', amount: 500 }).ok, false);
  assert.ok(g.act(utg, { type: 'call' }).ok);
});

/* ------------------------------ whole games ------------------------------ */

function ctxFor(g: PokerGame, seat: number) {
  const p = g.players[seat];
  return {
    hole: p.hole,
    board: g.board,
    street: g.street,
    pot: g.pot,
    myBet: p.bet,
    currentBet: g.currentBet,
    chips: p.chips,
    bigBlind: g.bigBlind,
    opponents: g.players.filter((q) => q.inHand && !q.folded).length,
    legal: g.legalActions(seat)!,
  };
}

test('bots play whole freezeout games: chips are conserved and a winner takes all', () => {
  for (const seats of [2, 3, 4, 5, 6]) {
    for (let seed = 1; seed <= 6; seed++) {
      const g = new PokerGame(seats, { startingChips: 1000, rng: mulberry32(seed * 31 + seats), maxHands: 400 });
      g.start(Array(seats).fill(true));
      const rng = mulberry32(seed + 1000);
      let guard = 0;
      while (g.phase !== 'finished' && guard++ < 20000) {
        if (g.phase === 'betting') {
          const seat = g.turn;
          assert.ok(seat >= 0 && g.players[seat].inHand && !g.players[seat].folded && !g.players[seat].allIn);
          const action = chooseAction(ctxFor(g, seat), rng);
          const res = g.act(seat, action);
          assert.ok(res.ok, `seats ${seats} seed ${seed}: ${JSON.stringify(action)} -> ${res.ok ? '' : res.error}`);
        } else {
          assert.equal(g.phase, 'handEnd');
          assert.equal(total(g), seats * 1000, 'chips conserved at the end of every hand');
          const r = g.lastResult!;
          assert.equal(r.players.reduce((a, p) => a + p.delta, 0), 0, 'hand deltas sum to zero');
          g.nextHand();
        }
        if (g.phase === 'betting') assert.equal(total(g), seats * 1000);
      }
      assert.equal(g.phase, 'finished', `seats ${seats} seed ${seed} did not finish`);
      assert.ok(g.winners && g.winners.length >= 1);
      assert.equal(g.ranking!.length, seats);
      assert.equal(new Set(g.ranking).size, seats);
      assert.equal(g.players.reduce((a, p) => a + p.chips, 0), seats * 1000);
      if (g.handNo < 400) assert.equal(g.players[g.winners![0]].chips, seats * 1000, 'winner holds every chip');
    }
  }
});

test('timeout action: check when free, fold otherwise', () => {
  const g = newGame(3, 15);
  assert.equal(g.defaultAction(g.turn).type, 'fold');
  g.act(g.turn, { type: 'call' });
  g.act(g.turn, { type: 'call' });
  assert.equal(g.defaultAction(g.turn).type, 'check');
});

test('views hide other players cards until a showdown', () => {
  const g = newGame(3, 16);
  const v0 = g.viewFor(0);
  assert.equal(v0.myHole.length, 2);
  assert.ok(v0.players.every((p) => p.shown === null));
  assert.equal(JSON.stringify(v0).includes(JSON.stringify(g.players[1].hole)), false);
  assert.equal(g.viewFor(null).myHole.length, 0);
  assert.equal(g.viewFor(g.turn).actions !== null, true);
  assert.equal(g.viewFor((g.turn + 1) % 3).actions, null);
});

test('blind levels rise with the hand count', () => {
  const g = new PokerGame(2, { startingChips: 1000, handsPerLevel: 3 });
  assert.deepEqual([g.blindsForHand(1).bb, g.blindsForHand(3).bb, g.blindsForHand(4).bb], [20, 20, 30]);
  assert.equal(g.blindsForHand(9999).level, 11);
});
