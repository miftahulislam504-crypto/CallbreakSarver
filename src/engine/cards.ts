export type Suit = 'S' | 'H' | 'D' | 'C';
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];
export const TRUMP: Suit = 'S';

/** rank 2..14 (J=11, Q=12, K=13, A=14) */
export interface Card {
  suit: Suit;
  rank: number;
}

export type Rng = () => number;

export function isValidCard(x: unknown): x is Card {
  if (typeof x !== 'object' || x === null) return false;
  const { suit, rank } = x as Record<string, unknown>;
  return (
    typeof suit === 'string' &&
    (SUITS as readonly string[]).includes(suit) &&
    typeof rank === 'number' &&
    Number.isInteger(rank) &&
    rank >= 2 &&
    rank <= 14
  );
}

export const sameCard = (a: Card, b: Card): boolean => a.suit === b.suit && a.rank === b.rank;

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ suit, rank });
  return deck;
}

/** Fisher-Yates; returns a new array. */
export function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Small deterministic RNG (tests, replays). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spades, hearts, diamonds, clubs; high to low inside each suit. */
export function sortHand(hand: readonly Card[]): Card[] {
  const order = (s: Suit) => SUITS.indexOf(s);
  return hand.slice().sort((a, b) => order(a.suit) - order(b.suit) || b.rank - a.rank);
}
