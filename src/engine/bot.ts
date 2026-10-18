import { Card, TRUMP } from './cards.js';
import { PlayedCard, legalPlays, trickWinnerSeat } from './rules.js';

/** Estimate tricks from hand strength, clamped to the allowed bid range. */
export function chooseBid(hand: readonly Card[], minBid: number, maxBid: number): number {
  let est = 0;
  for (const suit of ['H', 'D', 'C'] as const) {
    const cards = hand.filter((c) => c.suit === suit);
    if (cards.some((c) => c.rank === 14)) est += 1;
    if (cards.some((c) => c.rank === 13)) est += cards.length >= 2 ? 0.8 : 0.3;
    if (cards.length === 0) est += 0.7;
    else if (cards.length <= 2) est += 0.3; // short suit can be trumped
  }
  const spades = hand.filter((c) => c.suit === TRUMP);
  est += spades.filter((c) => c.rank >= 12).length * 0.9;
  est += Math.max(0, spades.length - 3) * 0.6;
  return Math.max(minBid, Math.min(maxBid, Math.round(est)));
}

/** Lowest card, preferring to keep spades. */
const lowest = (cs: Card[]): Card =>
  cs.slice().sort((a, b) => (a.suit === TRUMP ? 1 : 0) - (b.suit === TRUMP ? 1 : 0) || a.rank - b.rank)[0];

export interface BotContext {
  hand: readonly Card[];
  trick: readonly PlayedCard[];
  seat: number;
  bid: number;
  tricksWon: number;
}

/** Always returns a legal card. Chases tricks while under bid, ducks once the bid is met. */
export function chooseCard(ctx: BotContext): Card {
  const { hand, trick, seat, bid, tricksWon } = ctx;
  const legal = legalPlays(hand, trick);
  if (legal.length === 1) return legal[0];
  const needMore = tricksWon < bid;

  if (trick.length === 0) {
    if (needMore) {
      const nonTrump = legal.filter((c) => c.suit !== TRUMP);
      const pool = nonTrump.length ? nonTrump : legal;
      return pool.slice().sort((a, b) => b.rank - a.rank)[0];
    }
    return lowest(legal);
  }

  const wins = legal.filter((c) => trickWinnerSeat([...trick, { seat, card: c }]) === seat);
  if (needMore) return wins.length ? lowest(wins) : lowest(legal);
  const loses = legal.filter((c) => !wins.includes(c));
  return loses.length ? lowest(loses) : lowest(legal);
}
