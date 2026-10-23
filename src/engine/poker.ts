import { Card, Rng, createDeck, shuffle } from './cards.js';

/**
 * Texas Hold'em (no limit), play-money chips, 2..6 seats, freezeout: the game ends when one player has all
 * the chips (or after `maxHands`, then the biggest stack wins). Pure logic: no I/O and no timers.
 */

export const MAX_SEATS = 6;

/* ----------------------------------------------------------------------------
 * Hand evaluation
 * ------------------------------------------------------------------------- */

export const HAND_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush',
] as const;

const BASE = 15;
const POW = [1, BASE, BASE ** 2, BASE ** 3, BASE ** 4, BASE ** 5];

/** Score of exactly five cards: category * 15^5 + tiebreak ranks in base 15. Higher is better. */
export function evaluate5(cards: readonly Card[]): number {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Group by (count desc, rank desc): the order that decides ties.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ordered = groups.flatMap(([r, n]) => Array<number>(n).fill(r));

  let straightHigh = 0;
  if (counts.size === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5; // A-2-3-4-5
  }

  const pack = (category: number, tie: number[]): number =>
    category * POW[5] + tie.reduce((acc, r, i) => acc + r * POW[4 - i], 0);

  if (straightHigh && flush) return pack(8, [straightHigh]);
  if (groups[0][1] === 4) return pack(7, ordered);
  if (groups[0][1] === 3 && groups[1][1] === 2) return pack(6, ordered);
  if (flush) return pack(5, ordered);
  if (straightHigh) return pack(4, [straightHigh]);
  if (groups[0][1] === 3) return pack(3, ordered);
  if (groups[0][1] === 2 && groups[1][1] === 2) return pack(2, ordered);
  if (groups[0][1] === 2) return pack(1, ordered);
  return pack(0, ordered);
}

export const categoryOf = (score: number): number => Math.floor(score / POW[5]);

/** Best five of five to seven cards. */
export function bestHand(cards: readonly Card[]): { score: number; category: number } {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  let best = -1;
  const n = cards.length;
  const pick: Card[] = [];
  const rec = (start: number): void => {
    if (pick.length === 5) {
      const s = evaluate5(pick);
      if (s > best) best = s;
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(cards[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return { score: best, category: categoryOf(best) };
}

/* ----------------------------------------------------------------------------
 * Game
 * ------------------------------------------------------------------------- */

export type PokerPhase = 'lobby' | 'betting' | 'handEnd' | 'finished';
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type PokerActionType = 'fold' | 'check' | 'call' | 'raise' | 'allin';
export interface PokerAction {
  type: PokerActionType;
  /** For `raise`: the total bet for this street ("raise to"). */
  amount?: number;
}

export interface PokerConfig {
  startingChips: number;
  /** Blinds go up one level after this many hands. */
  handsPerLevel: number;
  /** Safety cap: after this many hands the biggest stack wins. */
  maxHands: number;
}

export interface PokerOptions extends Partial<PokerConfig> {
  startingChips: number;
  rng?: Rng;
}

/** Blind levels for a 1000-chip stack; scaled by startingChips / 1000. */
export const BLIND_LEVELS: ReadonlyArray<readonly [number, number]> = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [600, 1200], [1000, 2000],
];

export interface PokerPlayer {
  chips: number;
  /** Chips put in on this street. */
  bet: number;
  /** Chips put in this hand. */
  totalBet: number;
  /** Still in the tournament. */
  inGame: boolean;
  /** Dealt into the current hand. */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  hasActed: boolean;
  canRaise: boolean;
  hole: Card[];
  lastAction: string | null;
  startChips: number;
}

export interface PotResult {
  amount: number;
  winners: number[];
  eligible: number[];
}

export interface HandPlayerResult {
  seat: number;
  /** Shown only at a showdown, for players who did not fold. */
  hole: Card[] | null;
  handName: string | null;
  folded: boolean;
  /** Net chips won or lost this hand. */
  delta: number;
  chips: number;
}

export interface HandResult {
  handNo: number;
  board: Card[];
  showdown: boolean;
  pots: PotResult[];
  players: HandPlayerResult[];
  winners: number[];
}

export type PokerEvent =
  | { type: 'handStarted'; handNo: number }
  | { type: 'action'; seat: number; action: PokerActionType; amount: number }
  | { type: 'street'; street: Street }
  | { type: 'handEnded'; handNo: number }
  | { type: 'gameEnded'; winners: number[] };

export type PokerResult = { ok: true; events: PokerEvent[] } | { ok: false; error: string };
const fail = (error: string): PokerResult => ({ ok: false, error });

export interface LegalActions {
  canCheck: boolean;
  canCall: boolean;
  /** Chips to put in to call (capped by the stack). */
  callAmount: number;
  canRaise: boolean;
  /** "Raise to" bounds for this street's total bet. */
  minRaiseTo: number;
  maxRaiseTo: number;
}

export interface PokerPlayerView {
  seat: number;
  inGame: boolean;
  inHand: boolean;
  chips: number;
  bet: number;
  folded: boolean;
  allIn: boolean;
  lastAction: string | null;
  /** Cards other players may see (showdown only). */
  shown: Card[] | null;
}

export interface PokerView {
  phase: PokerPhase;
  handNo: number;
  maxHands: number;
  startingChips: number;
  smallBlind: number;
  bigBlind: number;
  /** Hands left at these blinds, including the current one. */
  handsToNextLevel: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  street: Street;
  board: Card[];
  /** Everything in the middle, current bets included. */
  pot: number;
  turn: number;
  currentBet: number;
  players: PokerPlayerView[];
  myHole: Card[];
  /** What I can do right now (null unless it is my turn). */
  actions: LegalActions | null;
  lastResult: HandResult | null;
  winners: number[] | null;
  ranking: number[] | null;
}

const emptyPlayer = (): PokerPlayer => ({
  chips: 0, bet: 0, totalBet: 0, inGame: false, inHand: false, folded: false, allIn: false,
  hasActed: false, canRaise: true, hole: [], lastAction: null, startChips: 0,
});

export class PokerGame {
  readonly config: PokerConfig;
  readonly seats: number;
  phase: PokerPhase = 'lobby';
  players: PokerPlayer[];
  handNo = 0;
  button = 0;
  sbSeat = -1;
  bbSeat = -1;
  street: Street = 'preflop';
  board: Card[] = [];
  currentBet = 0;
  minRaise = 0;
  turn = -1;
  lastResult: HandResult | null = null;
  winners: number[] | null = null;
  ranking: number[] | null = null;
  /** Seats in the order they went out, worst first. */
  private bustOrder: number[] = [];
  private deck: Card[] = [];
  private readonly rng: Rng;

  constructor(seats: number, opts: PokerOptions) {
    if (!Number.isInteger(seats) || seats < 2 || seats > MAX_SEATS) throw new Error(`seats must be 2-${MAX_SEATS}`);
    if (!Number.isFinite(opts.startingChips) || opts.startingChips < 100) throw new Error('startingChips must be at least 100');
    this.seats = seats;
    this.rng = opts.rng ?? Math.random;
    this.config = {
      startingChips: opts.startingChips,
      handsPerLevel: opts.handsPerLevel ?? 8,
      maxHands: opts.maxHands ?? 120,
    };
    this.players = Array.from({ length: seats }, emptyPlayer);
  }

  /* ------------------------------ blinds ------------------------------ */

  blindsForHand(handNo: number): { sb: number; bb: number; level: number } {
    const level = Math.min(BLIND_LEVELS.length - 1, Math.floor(Math.max(0, handNo - 1) / this.config.handsPerLevel));
    const scale = this.config.startingChips / 1000;
    const [sb, bb] = BLIND_LEVELS[level];
    return { sb: Math.max(1, Math.round(sb * scale)), bb: Math.max(2, Math.round(bb * scale)), level };
  }

  get bigBlind(): number {
    return this.blindsForHand(Math.max(1, this.handNo)).bb;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** `participants[i]` is true for every seat that plays. */
  start(participants: readonly boolean[]): PokerEvent[] {
    if (this.phase !== 'lobby') throw new Error('game already started');
    const seated: number[] = [];
    for (let s = 0; s < this.seats; s++) {
      if (participants[s]) {
        this.players[s] = { ...emptyPlayer(), inGame: true, chips: this.config.startingChips };
        seated.push(s);
      }
    }
    if (seated.length < 2) throw new Error('need at least 2 players');
    this.button = seated[Math.floor(this.rng() * seated.length)];
    this.handNo = 0;
    return this.startHand(false);
  }

  /** After the hand-end summary: remove busted players, then deal the next hand or finish. */
  nextHand(): PokerEvent[] {
    if (this.phase !== 'handEnd') return [];
    const busted = this.players
      .map((p, seat) => ({ p, seat }))
      .filter(({ p }) => p.inGame && p.chips === 0)
      .sort((a, b) => a.p.startChips - b.p.startChips);
    for (const { p, seat } of busted) {
      p.inGame = false;
      this.bustOrder.push(seat);
    }
    const alive = this.alive();
    if (alive.length <= 1 || this.handNo >= this.config.maxHands) return this.finish(alive);
    return this.startHand(true);
  }

  private alive(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.seats; s++) if (this.players[s].inGame) out.push(s);
    return out;
  }

  private finish(alive: number[]): PokerEvent[] {
    const byChips = alive.slice().sort((a, b) => this.players[b].chips - this.players[a].chips);
    const top = byChips.length > 0 ? this.players[byChips[0]].chips : 0;
    this.winners = byChips.filter((s) => this.players[s].chips === top);
    this.ranking = [...byChips, ...this.bustOrder.slice().reverse()];
    this.phase = 'finished';
    this.turn = -1;
    return [{ type: 'gameEnded', winners: this.winners }];
  }

  /** Next seat clockwise from `from` that satisfies `ok` (never `from` itself), or -1. */
  private seatAfter(from: number, ok: (p: PokerPlayer, seat: number) => boolean): number {
    for (let i = 1; i <= this.seats; i++) {
      const s = (from + i) % this.seats;
      if (ok(this.players[s], s)) return s;
    }
    return -1;
  }

  private startHand(rotate: boolean): PokerEvent[] {
    this.handNo++;
    const hasChips = (p: PokerPlayer) => p.inGame && p.chips > 0;
    if (rotate) this.button = this.seatAfter(this.button, hasChips);

    this.deck = shuffle(createDeck(), this.rng);
    this.board = [];
    this.lastResult = null;
    for (const p of this.players) {
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.hasActed = false;
      p.canRaise = true;
      p.hole = [];
      p.lastAction = null;
      p.inHand = false;
    }
    const seated: number[] = [];
    for (let s = 0; s < this.seats; s++) if (hasChips(this.players[s])) seated.push(s);
    for (const s of seated) {
      const p = this.players[s];
      p.inHand = true;
      p.startChips = p.chips;
      p.hole = [this.deck.pop()!, this.deck.pop()!];
    }

    const { sb, bb } = this.blindsForHand(this.handNo);
    if (seated.length === 2) {
      // Heads-up: the button is the small blind.
      this.sbSeat = this.button;
      this.bbSeat = this.seatAfter(this.button, (p) => p.inHand);
    } else {
      this.sbSeat = this.seatAfter(this.button, (p) => p.inHand);
      this.bbSeat = this.seatAfter(this.sbSeat, (p) => p.inHand);
    }
    this.post(this.sbSeat, sb, 'sb');
    this.post(this.bbSeat, bb, 'bb');
    this.currentBet = bb;
    this.minRaise = bb;
    this.street = 'preflop';
    this.phase = 'betting';

    const events: PokerEvent[] = [{ type: 'handStarted', handNo: this.handNo }];
    if (this.bettingClosed()) this.closeStreet(events);
    else this.turn = this.seatAfter(this.bbSeat, (p) => this.canAct(p));
    return events;
  }

  private post(seat: number, amount: number, label: string): void {
    const p = this.players[seat];
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.totalBet += pay;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = p.allIn ? 'allin' : label;
  }

  private canAct = (p: PokerPlayer): boolean => p.inHand && !p.folded && !p.allIn;
  private live(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.seats; s++) if (this.players[s].inHand && !this.players[s].folded) out.push(s);
    return out;
  }
  private ables(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.seats; s++) if (this.canAct(this.players[s])) out.push(s);
    return out;
  }

  /* ------------------------------ actions ------------------------------ */

  legalActions(seat: number): LegalActions | null {
    if (this.phase !== 'betting' || seat !== this.turn) return null;
    const p = this.players[seat];
    if (!this.canAct(p)) return null;
    const toCall = this.currentBet - p.bet;
    const maxTo = p.bet + p.chips;
    const canRaise = p.canRaise && p.chips > toCall;
    return {
      canCheck: toCall <= 0,
      canCall: toCall > 0,
      callAmount: Math.min(Math.max(0, toCall), p.chips),
      canRaise,
      minRaiseTo: canRaise ? Math.min(this.currentBet + this.minRaise, maxTo) : 0,
      maxRaiseTo: canRaise ? maxTo : 0,
    };
  }

  /** What a timed-out human does: check if free, otherwise fold. */
  defaultAction(seat: number): PokerAction {
    const l = this.legalActions(seat);
    return { type: l && l.canCheck ? 'check' : 'fold' };
  }

  act(seat: number, action: PokerAction): PokerResult {
    if (this.phase !== 'betting') return fail('No hand in progress');
    if (seat !== this.turn) return fail('Not your turn');
    const p = this.players[seat];
    if (!this.canAct(p)) return fail('You cannot act');
    const legal = this.legalActions(seat)!;
    const toCall = this.currentBet - p.bet;
    const events: PokerEvent[] = [];
    let type: PokerActionType = action?.type;
    let paid = 0;

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'fold';
        break;
      case 'check':
        if (!legal.canCheck) return fail('You cannot check: there is a bet to call');
        p.lastAction = 'check';
        break;
      case 'call':
        if (!legal.canCall) return fail('Nothing to call');
        paid = this.pay(p, legal.callAmount);
        p.lastAction = p.allIn ? 'allin' : 'call';
        if (p.allIn) type = 'allin';
        break;
      case 'raise':
      case 'allin': {
        let to: number;
        if (type === 'allin') {
          if (p.chips <= toCall) {
            // Cannot cover the bet: this is a call for everything.
            paid = this.pay(p, p.chips);
            p.lastAction = 'allin';
            break;
          }
          to = p.bet + p.chips;
        } else {
          if (typeof action.amount !== 'number' || !Number.isInteger(action.amount)) return fail('Invalid raise amount');
          to = action.amount;
        }
        if (!legal.canRaise) return fail('You cannot raise now');
        if (to > p.bet + p.chips) return fail('You do not have that many chips');
        if (to >= p.bet + p.chips) to = p.bet + p.chips; // a raise for everything is an all-in
        else if (to < this.currentBet + this.minRaise) return fail(`Minimum raise is to ${this.currentBet + this.minRaise}`);
        if (to <= this.currentBet) return fail('A raise must be higher than the current bet');

        paid = this.pay(p, to - p.bet);
        const size = to - this.currentBet;
        const full = size >= this.minRaise;
        this.currentBet = to;
        if (full) this.minRaise = size;
        for (const q of this.players) {
          if (q !== p && this.canAct(q)) {
            q.hasActed = false;
            if (full) q.canRaise = true;
          }
        }
        p.lastAction = p.allIn ? 'allin' : 'raise';
        type = p.allIn ? 'allin' : 'raise';
        break;
      }
      default:
        return fail('Unknown action');
    }

    p.hasActed = true;
    p.canRaise = false;
    events.push({ type: 'action', seat, action: type, amount: paid });
    this.advance(events);
    return { ok: true, events };
  }

  private pay(p: PokerPlayer, amount: number): number {
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    p.totalBet += pay;
    if (p.chips === 0) p.allIn = true;
    return pay;
  }

  /* ------------------------------ flow ------------------------------ */

  private bettingClosed(): boolean {
    const ables = this.ables();
    if (ables.length === 0) return true;
    if (ables.length === 1) return this.players[ables[0]].bet >= this.currentBet;
    return ables.every((s) => this.players[s].hasActed && this.players[s].bet === this.currentBet);
  }

  private advance(events: PokerEvent[]): void {
    const live = this.live();
    if (live.length === 1) {
      this.award(false, events);
      return;
    }
    if (this.bettingClosed()) {
      this.closeStreet(events);
      return;
    }
    this.turn = this.seatAfter(this.turn, (p) => this.canAct(p));
  }

  /** Betting on this street is over: deal on (running the board out if nobody can bet) or go to showdown. */
  private closeStreet(events: PokerEvent[]): void {
    for (;;) {
      for (const p of this.players) {
        p.bet = 0;
        p.hasActed = false;
        p.canRaise = true;
        if (p.lastAction !== 'allin') p.lastAction = null;
      }
      this.currentBet = 0;
      this.minRaise = this.bigBlind;

      if (this.street === 'river') {
        this.award(true, events);
        return;
      }
      this.deck.pop(); // burn
      if (this.street === 'preflop') {
        this.board.push(this.deck.pop()!, this.deck.pop()!, this.deck.pop()!);
        this.street = 'flop';
      } else {
        this.board.push(this.deck.pop()!);
        this.street = this.street === 'flop' ? 'turn' : 'river';
      }
      events.push({ type: 'street', street: this.street });
      if (this.ables().length >= 2) {
        this.turn = this.seatAfter(this.button, (p) => this.canAct(p));
        return;
      }
    }
  }

  /* ------------------------------ pots ------------------------------ */

  /** Seats ordered clockwise starting left of the button (for odd chips). */
  private fromButton(seats: number[]): number[] {
    const dist = (s: number) => (s - this.button - 1 + this.seats * 2) % this.seats;
    return seats.slice().sort((a, b) => dist(a) - dist(b));
  }

  private award(showdown: boolean, events: PokerEvent[]): void {
    const live = this.live();
    const scores = new Map<number, { score: number; category: number }>();
    if (showdown) for (const s of live) scores.set(s, bestHand([...this.players[s].hole, ...this.board]));

    // Layer the pot by contribution so side pots and uncalled bets come out right.
    const contributors = this.players.map((p, seat) => ({ p, seat })).filter(({ p }) => p.totalBet > 0);
    const levels = [...new Set(contributors.map(({ p }) => p.totalBet))].sort((a, b) => a - b);
    const pots: PotResult[] = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const { p } of contributors) amount += Math.min(p.totalBet, level) - Math.min(p.totalBet, prev);
      const eligible = live.filter((s) => this.players[s].totalBet >= level);
      if (eligible.length === 0) {
        // Only folded players reached this level: it is an uncalled bet and goes back to them.
        for (const { p } of contributors) p.chips += Math.min(p.totalBet, level) - Math.min(p.totalBet, prev);
        prev = level;
        continue;
      }
      prev = level;
      let winners = eligible;
      if (showdown && eligible.length > 1) {
        const best = Math.max(...eligible.map((s) => scores.get(s)!.score));
        winners = eligible.filter((s) => scores.get(s)!.score === best);
      }
      const ordered = this.fromButton(winners);
      const share = Math.floor(amount / ordered.length);
      let rem = amount - share * ordered.length;
      for (const s of ordered) {
        this.players[s].chips += share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
      }
      pots.push({ amount, winners: ordered, eligible });
    }

    const winnerSeats = [...new Set(pots.flatMap((x) => x.winners))];
    this.lastResult = {
      handNo: this.handNo,
      board: this.board.slice(),
      showdown,
      pots,
      players: this.players
        .map((p, seat) => ({ p, seat }))
        .filter(({ p }) => p.inHand)
        .map(({ p, seat }) => ({
          seat,
          hole: showdown && !p.folded ? p.hole.slice() : null,
          handName: showdown && !p.folded ? HAND_NAMES[scores.get(seat)!.category] : null,
          folded: p.folded,
          delta: p.chips - p.startChips,
          chips: p.chips,
        })),
      winners: winnerSeats,
    };
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;
    this.turn = -1;
    this.phase = 'handEnd';
    events.push({ type: 'handEnded', handNo: this.handNo });
  }

  /* ------------------------------ view ------------------------------ */

  /** Total in the middle while a hand is being played: every chip put in this hand (0 once it is paid out). */
  get pot(): number {
    return this.phase === 'betting' ? this.players.reduce((a, p) => a + p.totalBet, 0) : 0;
  }

  viewFor(seat: number | null): PokerView {
    const me = seat !== null && seat >= 0 && seat < this.seats ? seat : null;
    const { sb, bb } = this.blindsForHand(Math.max(1, this.handNo));
    const shownAt = (s: number): Card[] | null => {
      if (this.phase !== 'handEnd' && this.phase !== 'finished') return null;
      return this.lastResult?.players.find((x) => x.seat === s)?.hole ?? null;
    };
    const handsIntoLevel = (Math.max(1, this.handNo) - 1) % this.config.handsPerLevel;
    return {
      phase: this.phase,
      handNo: this.handNo,
      maxHands: this.config.maxHands,
      startingChips: this.config.startingChips,
      smallBlind: sb,
      bigBlind: bb,
      handsToNextLevel: this.config.handsPerLevel - handsIntoLevel,
      button: this.button,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      street: this.street,
      board: this.board.slice(),
      pot: this.pot,
      turn: this.turn,
      currentBet: this.currentBet,
      players: this.players.map((p, s) => ({
        seat: s,
        inGame: p.inGame,
        inHand: p.inHand,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        lastAction: p.lastAction,
        shown: shownAt(s),
      })),
      myHole: me !== null ? this.players[me].hole.slice() : [],
      actions: me !== null ? this.legalActions(me) : null,
      lastResult: this.phase === 'handEnd' || this.phase === 'finished' ? this.lastResult : null,
      winners: this.winners,
      ranking: this.ranking,
    };
  }
}
