import { Card, Rng, SUITS, Suit, sameCard, shuffle } from './cards.js';

/**
 * 29 (টোয়েন্টি-নাইন): 4 players in 2 teams (seats 0+2 vs 1+3), 32 cards (7..A).
 * Card order J > 9 > A > 10 > K > Q > 8 > 7. Points J=3, 9=2, A=1, 10=1 (28 in the deck) + 1 for the last trick = 29.
 * Flow: 4 cards each -> bidding -> the winner secretly picks trump -> 4 more cards each -> 8 tricks.
 * Trump stays hidden until a player who cannot follow suit asks for it to be revealed.
 * Pure logic: no I/O, no timers (the room owns those).
 */

export const SEATS = 4;
export const FIRST_DEAL = 4;
export const CARDS_PER_HAND = 8;
export const LAST_TRICK_BONUS = 1;

export type TNPhase = 'lobby' | 'dealing' | 'bidding' | 'trump' | 'playing' | 'roundEnd' | 'finished';

const STRENGTH: Record<number, number> = { 11: 7, 9: 6, 14: 5, 10: 4, 13: 3, 12: 2, 8: 1, 7: 0 };
const POINTS: Record<number, number> = { 11: 3, 9: 2, 14: 1, 10: 1 };
const RANKS = [7, 8, 9, 10, 11, 12, 13, 14];

export const strength = (rank: number): number => STRENGTH[rank] ?? -1;
export const cardPoints = (c: Card): number => POINTS[c.rank] ?? 0;
export const teamOf = (seat: number): number => seat % 2;

export function createDeck32(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
  return deck;
}

/** Suits S,H,D,C; strongest first inside each suit. */
export function sortHand29(hand: readonly Card[]): Card[] {
  const order = (s: Suit) => SUITS.indexOf(s);
  return hand.slice().sort((a, b) => order(a.suit) - order(b.suit) || strength(b.rank) - strength(a.rank));
}

export interface TNPlayed {
  seat: number;
  card: Card;
  /** True when the card was played as trump (trump already revealed and the card is of that suit). */
  asTrump: boolean;
}

/** Seat currently winning a (possibly incomplete) trick. `trumpSuit` may be null when it is not known to the caller. */
export function trickWinnerSeat(trick: readonly TNPlayed[], trumpSuit: Suit | null): number {
  const led = trick[0].card.suit;
  // A trump-suit card that was led is simply the led suit, so asTrump flags only matter when another suit was led.
  const useTrump = led !== trumpSuit && trick.some((p) => p.asTrump);
  const pool = useTrump ? trick.filter((p) => p.asTrump) : trick.filter((p) => p.card.suit === led);
  let best = pool[0];
  for (const p of pool.slice(1)) if (strength(p.card.rank) > strength(best.card.rank)) best = p;
  return best.seat;
}

/**
 * Cards a hand may play:
 * - Lead: anything. Must follow the led suit if able (no duty to beat).
 * - Cannot follow: once trump is revealed, a trump card must be played if held; before that, anything.
 */
export function legalPlays(
  hand: readonly Card[],
  trick: readonly TNPlayed[],
  trumpSuit: Suit | null,
  trumpRevealed: boolean,
): Card[] {
  if (trick.length === 0) return hand.slice();
  const led = trick[0].card.suit;
  const follow = hand.filter((c) => c.suit === led);
  if (follow.length > 0) return follow;
  if (trumpRevealed && trumpSuit) {
    const trumps = hand.filter((c) => c.suit === trumpSuit);
    if (trumps.length > 0) return trumps;
  }
  return hand.slice();
}

/** A player who cannot follow suit may ask for the hidden trump to be shown. */
export function canAskTrump(hand: readonly Card[], trick: readonly TNPlayed[], trumpRevealed: boolean): boolean {
  if (trumpRevealed || trick.length === 0) return false;
  const led = trick[0].card.suit;
  return !hand.some((c) => c.suit === led);
}

/* ----------------------------------------------------------------------------
 * Game
 * ------------------------------------------------------------------------- */

export interface TNConfig {
  /** Game points a team needs (or, going the other way, the lead at which the other team has lost). */
  targetScore: number;
  minBid: number;
  maxBid: number;
  maxRounds: number;
  /** K+Q of trump declared after the reveal: bidder's team need -N, other team +N. */
  pairAdjust: number;
  /** A deal first enters 'dealing' (cards shown); the caller then calls beginRound(). */
  dealPhase: boolean;
}

export interface TNOptions extends Partial<Omit<TNConfig, 'targetScore'>> {
  targetScore: number;
  rng?: Rng;
}

export interface TNRoundResult {
  round: number;
  dealer: number;
  declarer: number;
  contract: number;
  /** Points the bidder's team had to reach (contract adjusted by a pair). */
  need: number;
  trumpSuit: Suit;
  pairTeam: number | null;
  /** Card points won per team this round (includes the last-trick bonus). */
  teamPoints: number[];
  success: boolean;
  /** Game points gained per team this round. */
  delta: number[];
  totals: number[];
}

export type TNEvent =
  | { type: 'bid'; seat: number; bid: number }
  | { type: 'bidWon'; seat: number; bid: number }
  | { type: 'trumpChosen'; seat: number }
  | { type: 'trumpRevealed'; seat: number }
  | { type: 'pairDeclared'; seat: number }
  | { type: 'played'; seat: number; card: Card }
  | { type: 'trickWon'; seat: number; points: number }
  | { type: 'roundEnded'; round: number }
  | { type: 'gameEnded'; winners: number[] };

export type TNResult = { ok: true; events: TNEvent[] } | { ok: false; error: string };
const fail = (error: string): TNResult => ({ ok: false, error });

export interface TNLastTrick {
  cards: TNPlayed[];
  winner: number;
  points: number;
}

/** Everything one seat may know. `seat = null` is a spectator. */
export interface TNView {
  phase: TNPhase;
  round: number;
  dealer: number;
  turn: number;
  targetScore: number;
  minBid: number;
  maxBid: number;
  maxRounds: number;
  myHand: Card[];
  legal: Card[];
  /** I may ask for trump to be shown right now. */
  canReveal: boolean;
  handCounts: number[];
  /** Last bid per seat: a number, 0 for pass, null when that seat has not acted yet. */
  bids: (number | null)[];
  highBid: number;
  highBidder: number;
  /** Everyone else passed and it is my turn: I cannot pass. */
  forcedBid: boolean;
  declarer: number;
  contract: number;
  /** Contract adjusted by a declared pair (0 before bidding ends). */
  need: number;
  /** The trump suit if I may know it (I am the bidder, it was revealed, or the round is over); otherwise null. */
  trumpSuit: Suit | null;
  trumpRevealed: boolean;
  /** Trump has been picked but is still hidden from me. */
  trumpHidden: boolean;
  revealedBy: number;
  pair: { seat: number; team: number } | null;
  tricksWon: number[];
  /** Card points per team so far this round. */
  teamPoints: number[];
  trick: TNPlayed[];
  lastTrick: TNLastTrick | null;
  /** Game points per team. */
  totals: number[];
  history: TNRoundResult[];
  /** Winning seats (both partners), set when the game is finished. */
  winners: number[] | null;
  ranking: number[] | null;
}

export class TwentyNineGame {
  readonly config: TNConfig;
  phase: TNPhase = 'lobby';
  round = 0;
  dealer = 0;
  turn = 0;
  hands: Card[][] = [[], [], [], []];
  private rest: Card[][] = [[], [], [], []];
  bids: (number | null)[] = [null, null, null, null];
  passed: boolean[] = [false, false, false, false];
  highBid = 0;
  highBidder = -1;
  forcedBid = false;
  declarer = -1;
  contract = 0;
  trumpSuit: Suit | null = null;
  trumpRevealed = false;
  revealedBy = -1;
  pair: { seat: number; team: number } | null = null;
  tricksWon = [0, 0, 0, 0];
  teamPoints = [0, 0];
  trick: TNPlayed[] = [];
  lastTrick: TNLastTrick | null = null;
  totals = [0, 0];
  history: TNRoundResult[] = [];
  winners: number[] | null = null;
  ranking: number[] | null = null;
  private readonly rng: Rng;

  constructor(opts: TNOptions) {
    if (!Number.isFinite(opts.targetScore) || opts.targetScore <= 0) {
      throw new Error('targetScore must be a positive number');
    }
    this.rng = opts.rng ?? Math.random;
    this.config = {
      targetScore: opts.targetScore,
      minBid: opts.minBid ?? 16,
      maxBid: opts.maxBid ?? 28,
      maxRounds: opts.maxRounds ?? Math.max(20, opts.targetScore * 6),
      pairAdjust: opts.pairAdjust ?? 4,
      dealPhase: opts.dealPhase ?? false,
    };
  }

  /* ------------------------------ lifecycle ------------------------------ */

  start(dealer = 0): void {
    if (this.phase !== 'lobby') throw new Error('game already started');
    this.dealer = ((dealer % SEATS) + SEATS) % SEATS;
    this.round = 1;
    this.deal();
  }

  /** Dealing -> bidding (after the players have looked at their first four cards). */
  beginRound(): void {
    if (this.phase === 'dealing') this.phase = 'bidding';
  }

  /** After the round-end summary: next dealer, new deal. */
  nextRound(): void {
    if (this.phase !== 'roundEnd') return;
    this.dealer = (this.dealer + 1) % SEATS;
    this.round++;
    this.deal();
  }

  private deal(): void {
    const deck = shuffle(createDeck32(), this.rng);
    for (let s = 0; s < SEATS; s++) {
      this.hands[s] = sortHand29(deck.slice(s * FIRST_DEAL, (s + 1) * FIRST_DEAL));
      this.rest[s] = deck.slice(SEATS * FIRST_DEAL + s * FIRST_DEAL, SEATS * FIRST_DEAL + (s + 1) * FIRST_DEAL);
    }
    this.bids = [null, null, null, null];
    this.passed = [false, false, false, false];
    this.highBid = 0;
    this.highBidder = -1;
    this.forcedBid = false;
    this.declarer = -1;
    this.contract = 0;
    this.trumpSuit = null;
    this.trumpRevealed = false;
    this.revealedBy = -1;
    this.pair = null;
    this.tricksWon = [0, 0, 0, 0];
    this.teamPoints = [0, 0];
    this.trick = [];
    this.lastTrick = null;
    this.turn = (this.dealer + 1) % SEATS;
    this.phase = this.config.dealPhase ? 'dealing' : 'bidding';
  }

  /* ------------------------------ bidding ------------------------------ */

  /** `bid` 0 = pass. */
  placeBid(seat: number, bid: unknown): TNResult {
    if (this.phase !== 'bidding') return fail('Not bidding now');
    if (seat !== this.turn) return fail('Not your turn');
    if (typeof bid !== 'number' || !Number.isInteger(bid)) return fail('Invalid bid');

    if (bid === 0) {
      if (this.forcedBid) return fail(`Everyone passed: you must bid at least ${this.config.minBid}`);
      this.bids[seat] = 0;
      this.passed[seat] = true;
    } else {
      if (bid < this.config.minBid || bid > this.config.maxBid) {
        return fail(`Bid must be ${this.config.minBid}-${this.config.maxBid}`);
      }
      if (bid <= this.highBid) return fail('Bid must be higher than the current bid');
      this.bids[seat] = bid;
      this.highBid = bid;
      this.highBidder = seat;
      this.forcedBid = false;
    }

    const events: TNEvent[] = [{ type: 'bid', seat, bid }];
    this.advanceBidding(events);
    return { ok: true, events };
  }

  /** The lowest legal bid, used for a forced / timed-out human. */
  minimumBid(): number {
    return this.highBid === 0 ? this.config.minBid : Math.min(this.config.maxBid, this.highBid + 1);
  }

  private advanceBidding(events: TNEvent[]): void {
    const active: number[] = [];
    for (let s = 0; s < SEATS; s++) if (!this.passed[s]) active.push(s);

    if (this.highBidder !== -1 && (active.length === 1 || this.highBid >= this.config.maxBid)) {
      this.declarer = this.highBidder;
      this.contract = this.highBid;
      this.forcedBid = false;
      this.phase = 'trump';
      this.turn = this.declarer;
      events.push({ type: 'bidWon', seat: this.declarer, bid: this.contract });
      return;
    }
    if (this.highBidder === -1 && active.length === 1) {
      // Everyone else passed without a bid: the last seat is stuck with the minimum bid.
      this.turn = active[0];
      this.forcedBid = true;
      return;
    }
    let n = this.turn;
    do n = (n + 1) % SEATS;
    while (this.passed[n]);
    this.turn = n;
  }

  /* ------------------------------ trump ------------------------------ */

  chooseTrump(seat: number, suit: unknown): TNResult {
    if (this.phase !== 'trump') return fail('Not choosing trump now');
    if (seat !== this.declarer) return fail('Only the bidder picks trump');
    if (typeof suit !== 'string' || !(SUITS as readonly string[]).includes(suit)) return fail('Invalid suit');

    this.trumpSuit = suit as Suit;
    for (let s = 0; s < SEATS; s++) {
      this.hands[s] = sortHand29([...this.hands[s], ...this.rest[s]]);
      this.rest[s] = [];
    }
    this.phase = 'playing';
    this.turn = (this.dealer + 1) % SEATS;
    return { ok: true, events: [{ type: 'trumpChosen', seat }] };
  }

  /** Ask for trump to be shown (allowed only to a player who cannot follow suit). */
  revealTrump(seat: number): TNResult {
    if (this.phase !== 'playing') return fail('Not playing now');
    if (seat !== this.turn) return fail('Not your turn');
    if (this.trumpRevealed) return fail('Trump is already shown');
    if (!canAskTrump(this.hands[seat], this.trick, this.trumpRevealed)) return fail('You can only ask when you cannot follow suit');
    this.trumpRevealed = true;
    this.revealedBy = seat;
    return { ok: true, events: [{ type: 'trumpRevealed', seat }] };
  }

  /* ------------------------------ play ------------------------------ */

  playCard(seat: number, card: Card): TNResult {
    if (this.phase !== 'playing') return fail('Not playing now');
    if (seat !== this.turn) return fail('Not your turn');
    const hand = this.hands[seat];
    const idx = hand.findIndex((c) => sameCard(c, card));
    if (idx === -1) return fail('You do not hold that card');
    const legal = legalPlays(hand, this.trick, this.trumpSuit, this.trumpRevealed);
    if (!legal.some((c) => sameCard(c, card))) {
      return fail(this.trumpRevealed && legal.every((c) => c.suit === this.trumpSuit) ? 'You must play trump' : 'You must follow suit');
    }

    const played = hand[idx];
    const asTrump = this.trumpRevealed && played.suit === this.trumpSuit;
    hand.splice(idx, 1);
    this.trick.push({ seat, card: played, asTrump });
    const events: TNEvent[] = [{ type: 'played', seat, card: played }];

    // A pair: K or Q of trump played after the reveal while the other one is still in hand.
    if (!this.pair && asTrump && (played.rank === 12 || played.rank === 13)) {
      const other = played.rank === 13 ? 12 : 13;
      if (hand.some((c) => c.suit === this.trumpSuit && c.rank === other)) {
        this.pair = { seat, team: teamOf(seat) };
        events.push({ type: 'pairDeclared', seat });
      }
    }

    if (this.trick.length < SEATS) {
      this.turn = (seat + 1) % SEATS;
      return { ok: true, events };
    }

    const winner = trickWinnerSeat(this.trick, this.trumpSuit);
    const points = this.trick.reduce((a, p) => a + cardPoints(p.card), 0);
    this.teamPoints[teamOf(winner)] += points;
    this.tricksWon[winner]++;
    this.lastTrick = { cards: this.trick.slice(), winner, points };
    this.trick = [];
    events.push({ type: 'trickWon', seat: winner, points });

    if (this.hands.every((h) => h.length === 0)) {
      this.teamPoints[teamOf(winner)] += LAST_TRICK_BONUS;
      this.finishRound(events);
    } else {
      this.turn = winner;
    }
    return { ok: true, events };
  }

  /* ------------------------------ scoring ------------------------------ */

  /** The bidder's team target for this round (contract adjusted by a pair). */
  get need(): number {
    if (this.declarer === -1) return 0;
    if (!this.pair) return this.contract;
    const same = this.pair.team === teamOf(this.declarer);
    return this.contract + (same ? -this.config.pairAdjust : this.config.pairAdjust);
  }

  private finishRound(events: TNEvent[]): void {
    const dTeam = teamOf(this.declarer);
    const need = this.need;
    const success = this.teamPoints[dTeam] >= need;
    const delta = [0, 0];
    delta[dTeam] = success ? 1 : -1;
    this.totals = [this.totals[0] + delta[0], this.totals[1] + delta[1]];
    this.history.push({
      round: this.round,
      dealer: this.dealer,
      declarer: this.declarer,
      contract: this.contract,
      need,
      trumpSuit: this.trumpSuit!,
      pairTeam: this.pair ? this.pair.team : null,
      teamPoints: this.teamPoints.slice(),
      success,
      delta,
      totals: this.totals.slice(),
    });
    this.phase = 'roundEnd';
    events.push({ type: 'roundEnded', round: this.round });

    const { targetScore, maxRounds } = this.config;
    let winnerTeam = -1;
    for (let t = 0; t < 2; t++) {
      if (this.totals[t] >= targetScore) winnerTeam = t;
      else if (this.totals[t] <= -targetScore) winnerTeam = 1 - t;
    }
    let tie = false;
    if (winnerTeam === -1 && this.round >= maxRounds) {
      if (this.totals[0] === this.totals[1]) tie = true;
      else winnerTeam = this.totals[0] > this.totals[1] ? 0 : 1;
    }
    if (winnerTeam === -1 && !tie) return;

    this.phase = 'finished';
    const all = [0, 1, 2, 3];
    this.winners = tie ? all : all.filter((s) => teamOf(s) === winnerTeam);
    this.ranking = tie ? all : [...this.winners, ...all.filter((s) => !this.winners!.includes(s))];
    events.push({ type: 'gameEnded', winners: this.winners });
  }

  /* ------------------------------ view ------------------------------ */

  viewFor(seat: number | null): TNView {
    const me = seat !== null && seat >= 0 && seat < SEATS ? seat : null;
    const myHand = me === null ? [] : this.hands[me].slice();
    const myTurn = me !== null && this.turn === me;
    const playing = this.phase === 'playing';
    const over = this.phase === 'roundEnd' || this.phase === 'finished';
    const knowsTrump = this.trumpSuit !== null && (this.trumpRevealed || over || (me !== null && me === this.declarer));
    return {
      phase: this.phase,
      round: this.round,
      dealer: this.dealer,
      turn: this.turn,
      targetScore: this.config.targetScore,
      minBid: this.config.minBid,
      maxBid: this.config.maxBid,
      maxRounds: this.config.maxRounds,
      myHand,
      legal: playing && myTurn ? legalPlays(this.hands[me!], this.trick, this.trumpSuit, this.trumpRevealed) : [],
      canReveal: playing && myTurn && canAskTrump(this.hands[me!], this.trick, this.trumpRevealed),
      handCounts: this.hands.map((h) => h.length),
      bids: this.bids.slice(),
      highBid: this.highBid,
      highBidder: this.highBidder,
      forcedBid: this.phase === 'bidding' && this.forcedBid && myTurn,
      declarer: this.declarer,
      contract: this.contract,
      need: this.need,
      trumpSuit: knowsTrump ? this.trumpSuit : null,
      trumpRevealed: this.trumpRevealed,
      trumpHidden: this.trumpSuit !== null && !knowsTrump,
      revealedBy: this.revealedBy,
      pair: this.pair,
      tricksWon: this.tricksWon.slice(),
      teamPoints: this.teamPoints.slice(),
      trick: this.trick.slice(),
      lastTrick: this.lastTrick,
      totals: this.totals.slice(),
      history: this.history,
      winners: this.winners,
      ranking: this.ranking,
    };
  }
}
