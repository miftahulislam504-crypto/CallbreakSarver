import { Card, TRUMP } from './cards.js';

export interface PlayedCard {
  seat: number;
  card: Card;
}

export interface RedealRules {
  /** Redeal when any hand has no spade. */
  noSpade: boolean;
  /** Redeal when any hand has only cards below this rank (null = off). */
  allBelow: number | null;
}

export function needsRedeal(hands: readonly (readonly Card[])[], rules: RedealRules): boolean {
  return hands.some(
    (h) =>
      (rules.noSpade && !h.some((c) => c.suit === TRUMP)) ||
      (rules.allBelow !== null && h.every((c) => c.rank < rules.allBelow!)),
  );
}

/** Seat currently winning a (possibly incomplete) trick. The trick must be non-empty. */
export function trickWinnerSeat(trick: readonly PlayedCard[]): number {
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const b = best.card;
    const c = p.card;
    if (c.suit === b.suit) {
      if (c.rank > b.rank) best = p;
    } else if (c.suit === TRUMP) {
      best = p; // b is not a spade here, otherwise suits would match
    }
  }
  return best.seat;
}

/**
 * Legal cards for a hand given the current trick.
 * - Lead: anything.
 * - Must follow the led suit, and beat the current winner if it is of the led suit and you can.
 * - Cannot follow: must play a spade, and over-trump a winning spade if possible.
 * - Otherwise: anything.
 */
export function legalPlays(hand: readonly Card[], trick: readonly PlayedCard[]): Card[] {
  if (trick.length === 0) return hand.slice();
  const led = trick[0].card.suit;
  const winnerSeat = trickWinnerSeat(trick);
  const winner = trick.find((p) => p.seat === winnerSeat)!.card;

  const ofLed = hand.filter((c) => c.suit === led);
  if (ofLed.length > 0) {
    if (winner.suit === led) {
      const higher = ofLed.filter((c) => c.rank > winner.rank);
      if (higher.length > 0) return higher;
    }
    return ofLed;
  }

  const spades = hand.filter((c) => c.suit === TRUMP);
  if (spades.length > 0) {
    if (winner.suit === TRUMP) {
      const higher = spades.filter((c) => c.rank > winner.rank);
      if (higher.length > 0) return higher;
    }
    return spades;
  }
  return hand.slice();
}

/** Score for one player's round in tenths of a point: bid met = bid + 0.1 per extra trick, else -bid. */
export function roundScore10(bid: number, tricks: number): number {
  return tricks >= bid ? bid * 10 + (tricks - bid) : -bid * 10;
}
