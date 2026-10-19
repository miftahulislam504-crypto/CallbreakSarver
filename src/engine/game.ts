import { Card, Rng, createDeck, isValidCard, sameCard, shuffle, sortHand } from './cards.js';
import {
  PlayedCard, RedealRules, legalPlays, needsRedeal, roundScore10, trickWinnerSeat,
} from './rules.js';

export const SEATS = 4;
export const TRICKS_PER_ROUND = 13;

export type Phase = 'lobby' | 'dealing' | 'bidding' | 'playing' | 'roundEnd' | 'finished';

export interface GameConfig {
  /** Whole points; the game ends when a single leader has reached it. */
  targetScore: number;
  minBid: number;
  maxBid: number;
  /** Safety cap so a game can never run forever; at the cap the top score(s) win. */
  maxRounds: number;
  redeal: RedealRules;
  /**
   * The first N rounds are dealt straight into play, with no bidding. Nobody can lose points for
   * missing a bid there: each player is scored as if they had bid exactly the tricks they won.
   */
  noBidRounds: number;
  /**
   * When true, a deal first enters the 'dealing' phase (cards are dealt out and players look at
   * them); the caller then calls beginRound() to start bidding / play. When false, a deal goes
   * straight into bidding / play.
   */
  dealPhase: boolean;
}

export interface GameOptions extends Partial<Omit<GameConfig, 'targetScore'>> {
  targetScore: number;
  rng?: Rng;
}

export interface RoundResult {
  round: number;
  dealer: number;
  bids: number[];
  tricks: number[];
  scores10: number[];
  totals10: number[];
}

export type GameEvent =
  | { type: 'roundStarted'; round: number }
  | { type: 'bid'; seat: number; bid: number }
  | { type: 'played'; seat: number; card: Card }
  | { type: 'trickWon'; seat: number }
  | { type: 'roundEnded'; round: number }
  | { type: 'gameEnded'; winners: number[] };

export type ActionResult = { ok: true; events: GameEvent[] } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });

export interface LastTrick {
  cards: PlayedCard[];
  winner: number;
}

/** Everything one seat may know. `seat = null` is a spectator (no hand). */
export interface GameView {
  phase: Phase;
  round: number;
  dealer: number;
  turn: number;
  targetScore: number;
  minBid: number;
  maxBid: number;
  maxRounds: number;
  myHand: Card[];
  /** Cards you may play right now (empty unless it is your turn to play). */
  legal: Card[];
  handCounts: number[];
  bids: (number | null)[];
  tricksWon: number[];
  trick: PlayedCard[];
  lastTrick: LastTrick | null;
  /** Totals in points (one decimal). */
  totals: number[];
  history: RoundResult[];
  winners: number[] | null;
  /** Seats best to worst; set when the game is finished. */
  ranking: number[] | null;
}

/** Pure, server-authoritative Call Break engine. No I/O and no timers. */
export class CallBreakGame {
  readonly config: GameConfig;
  phase: Phase = 'lobby';
  round = 0;
  dealer = 0;
  turn = 0;
  hands: Card[][] = [[], [], [], []];
  bids: (number | null)[] = [null, null, null, null];
  tricksWon: number[] = [0, 0, 0, 0];
  trick: PlayedCard[] = [];
  lastTrick: LastTrick | null = null;
  totals10: number[] = [0, 0, 0, 0];
  history: RoundResult[] = [];
  winners: number[] | null = null;
  ranking: number[] | null = null;
  private readonly rng: Rng;

  constructor(opts: GameOptions) {
    if (!Number.isFinite(opts.targetScore) || opts.targetScore <= 0) {
      throw new Error('targetScore must be a positive number');
    }
    this.rng = opts.rng ?? Math.random;
    this.config = {
      targetScore: opts.targetScore,
      minBid: opts.minBid ?? 1,
      maxBid: opts.maxBid ?? 8,
      maxRounds: opts.maxRounds ?? Math.max(30, Math.ceil(opts.targetScore * 1.5)),
      redeal: opts.redeal ?? { noSpade: true, allBelow: 10 },
      noBidRounds: opts.noBidRounds ?? 0,
      dealPhase: opts.dealPhase ?? false,
    };
  }

  /** Deals round 1. `dealer` is the seat that deals; the seat after it bids (or just leads, in a no-bid round) first. */
  start(dealer: number): ActionResult {
    if (this.phase !== 'lobby') return fail('Game already started');
    if (!Number.isInteger(dealer) || dealer < 0 || dealer >= SEATS) return fail('Bad dealer seat');
    this.dealer = dealer;
    this.round = 1;
    this.deal();
    return { ok: true, events: [{ type: 'roundStarted', round: 1 }] };
  }

  /** Call after a 'roundEnd': rotates the dealer and deals the next round. */
  nextRound(): ActionResult {
    if (this.phase !== 'roundEnd') return fail('Round is not over');
    this.dealer = (this.dealer + 1) % SEATS;
    this.round += 1;
    this.deal();
    return { ok: true, events: [{ type: 'roundStarted', round: this.round }] };
  }

  private deal(): void {
    let hands: Card[][];
    do {
      const deck = shuffle(createDeck(), this.rng);
      hands = [[], [], [], []];
      deck.forEach((c, i) => hands[i % SEATS].push(c));
    } while (needsRedeal(hands, this.config.redeal));
    this.hands = hands.map(sortHand);
    this.bids = [null, null, null, null];
    this.tricksWon = [0, 0, 0, 0];
    this.trick = [];
    this.lastTrick = null;
    this.turn = (this.dealer + 1) % SEATS;
    this.phase = this.config.dealPhase ? 'dealing' : this.firstPhase();
  }

  private firstPhase(): Phase {
    return this.round <= this.config.noBidRounds ? 'playing' : 'bidding';
  }

  /** Call after a 'dealing' phase: the hands are out and seen, so bidding (or play) starts. */
  beginRound(): ActionResult {
    if (this.phase !== 'dealing') return fail('Not dealing');
    this.phase = this.firstPhase();
    this.turn = (this.dealer + 1) % SEATS;
    return { ok: true, events: [] };
  }

  /** True while the current round is played without bidding. */
  get noBid(): boolean {
    return this.round >= 1 && this.round <= this.config.noBidRounds;
  }

  placeBid(seat: number, bid: unknown): ActionResult {
    if (this.phase !== 'bidding') return fail('Not in bidding');
    if (seat !== this.turn) return fail('Not your turn');
    const { minBid, maxBid } = this.config;
    if (typeof bid !== 'number' || !Number.isInteger(bid) || bid < minBid || bid > maxBid) {
      return fail(`Bid must be a whole number from ${minBid} to ${maxBid}`);
    }
    this.bids[seat] = bid;
    const events: GameEvent[] = [{ type: 'bid', seat, bid }];
    if (this.bids.every((b) => b !== null)) {
      this.phase = 'playing';
      this.turn = (this.dealer + 1) % SEATS;
    } else {
      this.turn = (this.turn + 1) % SEATS;
    }
    return { ok: true, events };
  }

  legalMoves(seat: number): Card[] {
    if (this.phase !== 'playing' || seat !== this.turn) return [];
    return legalPlays(this.hands[seat], this.trick);
  }

  playCard(seat: number, card: unknown): ActionResult {
    if (this.phase !== 'playing') return fail('Not in play');
    if (seat !== this.turn) return fail('Not your turn');
    if (!isValidCard(card)) return fail('Invalid card');
    const hand = this.hands[seat];
    const idx = hand.findIndex((c) => sameCard(c, card));
    if (idx < 0) return fail('You do not hold that card');
    if (!legalPlays(hand, this.trick).some((c) => sameCard(c, card))) {
      return fail('Illegal card: follow suit, beat the trick, or play a spade');
    }
    const played: Card = hand.splice(idx, 1)[0];
    this.trick.push({ seat, card: played });
    const events: GameEvent[] = [{ type: 'played', seat, card: played }];

    if (this.trick.length < SEATS) {
      this.turn = (this.turn + 1) % SEATS;
      return { ok: true, events };
    }

    const winner = trickWinnerSeat(this.trick);
    this.tricksWon[winner] += 1;
    this.lastTrick = { cards: this.trick, winner };
    this.trick = [];
    this.turn = winner;
    events.push({ type: 'trickWon', seat: winner });
    if (this.tricksWon.reduce((a, b) => a + b, 0) === TRICKS_PER_ROUND) this.endRound(events);
    return { ok: true, events };
  }

  private endRound(events: GameEvent[]): void {
    // No-bid round: the bid is whatever the player took, so the score is simply tricks x 1.0.
    const bids = this.noBid ? this.tricksWon.slice() : (this.bids as number[]);
    const scores10 = bids.map((b, s) => roundScore10(b, this.tricksWon[s]));
    scores10.forEach((sc, s) => (this.totals10[s] += sc));
    this.history.push({
      round: this.round,
      dealer: this.dealer,
      bids: bids.slice(),
      tricks: this.tricksWon.slice(),
      scores10,
      totals10: this.totals10.slice(),
    });
    events.push({ type: 'roundEnded', round: this.round });

    const top = Math.max(...this.totals10);
    const leaders = this.totals10.flatMap((t, s) => (t === top ? [s] : []));
    const reached = top >= this.config.targetScore * 10 && leaders.length === 1; // a tie at the top plays on
    const capped = this.history.length >= this.config.maxRounds;
    if (reached || capped) {
      this.phase = 'finished';
      this.winners = leaders;
      this.ranking = [0, 1, 2, 3].sort((a, b) => this.totals10[b] - this.totals10[a] || a - b);
      events.push({ type: 'gameEnded', winners: leaders });
    } else {
      this.phase = 'roundEnd';
    }
  }

  viewFor(seat: number | null): GameView {
    const mine = seat !== null && seat >= 0 && seat < SEATS;
    const copy = (c: Card): Card => ({ suit: c.suit, rank: c.rank });
    const copyPlayed = (p: PlayedCard): PlayedCard => ({ seat: p.seat, card: copy(p.card) });
    return {
      phase: this.phase,
      round: this.round,
      dealer: this.dealer,
      turn: this.turn,
      targetScore: this.config.targetScore,
      minBid: this.config.minBid,
      maxBid: this.config.maxBid,
      maxRounds: this.config.maxRounds,
      myHand: mine ? this.hands[seat!].map(copy) : [],
      legal: mine ? this.legalMoves(seat!).map(copy) : [],
      handCounts: this.hands.map((h) => h.length),
      bids: this.bids.slice(),
      tricksWon: this.tricksWon.slice(),
      trick: this.trick.map(copyPlayed),
      lastTrick: this.lastTrick
        ? { cards: this.lastTrick.cards.map(copyPlayed), winner: this.lastTrick.winner }
        : null,
      totals: this.totals10.map((t) => t / 10),
      history: this.history,
      winners: this.winners,
      ranking: this.ranking,
    };
  }
}
