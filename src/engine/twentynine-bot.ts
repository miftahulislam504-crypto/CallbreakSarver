import { Card, Rng, SUITS, Suit } from './cards.js';
import { TNPlayed, cardPoints, legalPlays, strength, teamOf, trickWinnerSeat } from './twentynine.js';

/** Hand value on the first four cards: card points, a long suit and jacks all help. */
function estimate(hand: readonly Card[]): number {
  const pts = hand.reduce((a, c) => a + cardPoints(c), 0);
  const counts = SUITS.map((s) => hand.filter((c) => c.suit === s).length);
  const longest = Math.max(...counts);
  const jacks = hand.filter((c) => c.rank === 11).length;
  return 15 + pts * 0.9 + Math.max(0, longest - 2) * 2 + (jacks > 0 ? 1 : 0);
}

/**
 * A bid, or 0 to pass. `highBid` 0 means nobody has bid yet. When `forced`, passing is not allowed.
 */
export function chooseBid(
  hand: readonly Card[],
  minBid: number,
  maxBid: number,
  highBid: number,
  forced: boolean,
  rng: Rng = Math.random,
): number {
  const cap = Math.min(maxBid, Math.floor(estimate(hand) + (rng() * 2 - 1)));
  const lowest = highBid === 0 ? minBid : highBid + 1;
  if (lowest > maxBid) return forced ? minBid : 0;
  if (lowest <= cap) {
    const jump = highBid === 0 ? 1 : rng() < 0.35 ? 2 : 1;
    return Math.min(cap, lowest + jump - 1);
  }
  return forced ? lowest : 0;
}

/** The suit with the most strength and length among the first four cards. */
export function chooseTrump(hand: readonly Card[]): Suit {
  let best: Suit = SUITS[0];
  let bestScore = -1;
  for (const s of SUITS) {
    const cs = hand.filter((c) => c.suit === s);
    const score = cs.reduce((a, c) => a + strength(c.rank) * 2 + cardPoints(c) * 3, 0) + cs.length * 6;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

export interface TNBotContext {
  hand: readonly Card[];
  trick: readonly TNPlayed[];
  seat: number;
  declarer: number;
  /** The trump suit as far as this seat knows it (own choice, or revealed); otherwise null. */
  trumpSuit: Suit | null;
  trumpRevealed: boolean;
}

export type TNBotAction = { type: 'reveal' } | { type: 'play'; card: Card };

/** Cheapest card to give away: fewest points, then weakest. */
const cheapest = (cs: readonly Card[]): Card =>
  cs.slice().sort((a, b) => cardPoints(a) - cardPoints(b) || strength(a.rank) - strength(b.rank))[0];

const richest = (cs: readonly Card[]): Card =>
  cs.slice().sort((a, b) => cardPoints(b) - cardPoints(a) || strength(b.rank) - strength(a.rank))[0];

/** Always returns a legal action. */
export function chooseAction(ctx: TNBotContext): TNBotAction {
  const { hand, trick, seat, declarer, trumpSuit, trumpRevealed } = ctx;
  const legal = legalPlays(hand, trick, trumpSuit, trumpRevealed);
  if (legal.length === 1) return { type: 'play', card: legal[0] };

  const myTeamBid = declarer >= 0 && teamOf(declarer) === teamOf(seat);

  if (trick.length === 0) {
    const nonTrump = legal.filter((c) => c.suit !== trumpSuit);
    const pool = nonTrump.length > 0 ? nonTrump : legal;
    if (myTeamBid) {
      // Strong cards first.
      return { type: 'play', card: pool.slice().sort((a, b) => strength(b.rank) - strength(a.rank))[0] };
    }
    return { type: 'play', card: cheapest(pool) };
  }

  const asTrump = (c: Card) => trumpRevealed && c.suit === trumpSuit;
  const winnerNow = trickWinnerSeat(trick, trumpSuit);
  const partnerWinning = teamOf(winnerNow) === teamOf(seat);
  const trickPts = trick.reduce((a, p) => a + cardPoints(p.card), 0);
  const wins = legal.filter((c) => trickWinnerSeat([...trick, { seat, card: c, asTrump: asTrump(c) }], trumpSuit) === seat);

  const led = trick[0].card.suit;
  const cannotFollow = !hand.some((c) => c.suit === led);

  if (cannotFollow && !trumpRevealed) {
    const holdsTrump = trumpSuit !== null && hand.some((c) => c.suit === trumpSuit);
    // The bidder knows the trump suit; others ask only when the trick is worth it.
    if (!partnerWinning && ((holdsTrump && trickPts >= 1) || trickPts >= 3)) return { type: 'reveal' };
    const keep = legal.filter((c) => c.suit !== trumpSuit);
    return { type: 'play', card: cheapest(keep.length > 0 ? keep : legal) };
  }

  if (partnerWinning) return { type: 'play', card: richest(legal) };
  if (wins.length > 0 && (trickPts > 0 || trick.length === 3)) {
    return { type: 'play', card: wins.slice().sort((a, b) => strength(a.rank) - strength(b.rank))[0] };
  }
  return { type: 'play', card: cheapest(legal) };
}
