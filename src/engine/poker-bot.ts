import { Card, Rng } from './cards.js';
import { LegalActions, PokerAction, Street, bestHand } from './poker.js';

export interface PokerBotContext {
  hole: readonly Card[];
  board: readonly Card[];
  street: Street;
  /** Everything in the middle, bets included. */
  pot: number;
  /** Chips already put in on this street by this bot. */
  myBet: number;
  currentBet: number;
  chips: number;
  bigBlind: number;
  /** Players still in the hand (this bot included). */
  opponents: number;
  legal: LegalActions;
}

/** Chen formula: a quick pre-flop hand value (AA = 20, 72o is negative). */
export function chenScore(hole: readonly Card[]): number {
  const [a, b] = hole.slice().sort((x, y) => y.rank - x.rank);
  const pts = (r: number) => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let s = pts(a.rank);
  if (a.rank === b.rank) return Math.ceil(Math.max(5, s * 2));
  if (a.suit === b.suit) s += 2;
  const gap = a.rank - b.rank - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && a.rank < 12) s += 1;
  return Math.ceil(s);
}

/** 0..1 post-flop strength: made hand category plus a little for draws. */
export function postflopStrength(hole: readonly Card[], board: readonly Card[]): { strength: number; draw: boolean } {
  const all = [...hole, ...board];
  const { category } = bestHand(all);

  const suits = new Map<string, number>();
  for (const c of all) suits.set(c.suit, (suits.get(c.suit) ?? 0) + 1);
  const flushDraw = board.length < 5 && [...suits.values()].some((n) => n === 4);
  const ranks = [...new Set(all.map((c) => c.rank))].sort((x, y) => x - y);
  if (ranks.includes(14)) ranks.unshift(1);
  let open = false;
  for (let i = 0; i + 3 < ranks.length; i++) if (ranks[i + 3] - ranks[i] === 3) open = true;
  const draw = category < 4 && (flushDraw || (board.length < 5 && open));

  let strength: number;
  if (category >= 6) strength = 0.97;
  else if (category === 5) strength = 0.92;
  else if (category === 4) strength = 0.88;
  else if (category === 3) strength = 0.8;
  else if (category === 2) strength = 0.7;
  else if (category === 1) {
    // A pair that uses a hole card is worth more when it is the top pair.
    const top = Math.max(...board.map((c) => c.rank));
    const pairRank = hole.find((h) => all.filter((c) => c.rank === h.rank).length >= 2)?.rank ?? 0;
    strength = pairRank === 0 ? 0.3 : pairRank >= top ? 0.58 : 0.45;
  } else {
    strength = 0.15 + Math.max(...hole.map((c) => c.rank)) / 100;
  }
  if (draw) strength = Math.max(strength, 0.42);
  return { strength, draw };
}

function raiseTo(ctx: PokerBotContext, target: number): PokerAction {
  const { legal } = ctx;
  if (!legal.canRaise) return legal.canCall ? { type: 'call' } : { type: 'check' };
  const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(target)));
  return to >= legal.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount: to };
}

const checkOrFold = (ctx: PokerBotContext): PokerAction => ({ type: ctx.legal.canCheck ? 'check' : 'fold' });
const callOrCheck = (ctx: PokerBotContext): PokerAction => ({ type: ctx.legal.canCall ? 'call' : 'check' });

/** Always returns an action that is legal for `ctx.legal`. */
export function chooseAction(ctx: PokerBotContext, rng: Rng = Math.random): PokerAction {
  const { legal, bigBlind: bb, pot, chips } = ctx;
  const toCall = legal.callAmount;

  if (ctx.board.length === 0) {
    const chen = chenScore(ctx.hole);
    const facingRaise = ctx.currentBet > bb;
    if (chen >= 12) return raiseTo(ctx, ctx.currentBet * 3 + bb);
    if (chen >= 9) {
      if (!facingRaise) return raiseTo(ctx, bb * 3);
      return toCall <= chips * 0.25 ? { type: 'call' } : checkOrFold(ctx);
    }
    if (chen >= 6) {
      if (!legal.canCall) return rng() < 0.3 ? raiseTo(ctx, bb * 3) : { type: 'check' };
      return toCall <= bb * 3 ? { type: 'call' } : { type: 'fold' };
    }
    if (!legal.canCall) return { type: 'check' };
    return toCall <= bb && rng() < 0.4 ? { type: 'call' } : { type: 'fold' };
  }

  const { strength, draw } = postflopStrength(ctx.hole, ctx.board);
  // Fewer chips in a bigger field: be a little more careful.
  const adj = strength - Math.max(0, ctx.opponents - 2) * 0.03;

  if (!legal.canCall) {
    // Free to check.
    if (adj >= 0.75) return raiseTo(ctx, ctx.currentBet + pot * (0.5 + rng() * 0.4));
    if (adj >= 0.55 && rng() < 0.6) return raiseTo(ctx, ctx.currentBet + pot * 0.5);
    if (draw && rng() < 0.3) return raiseTo(ctx, ctx.currentBet + pot * 0.4);
    if (adj < 0.35 && rng() < 0.07) return raiseTo(ctx, ctx.currentBet + pot * 0.5);
    return { type: 'check' };
  }

  const needed = toCall / (pot + toCall); // pot odds: the share of the final pot I must pay
  if (adj >= 0.85) return rng() < 0.6 ? raiseTo(ctx, ctx.currentBet + pot * 0.75) : { type: 'call' };
  if (adj >= needed + 0.15) return { type: 'call' };
  if (draw && needed < 0.3) return { type: 'call' };
  if (toCall <= bb && adj >= 0.3) return callOrCheck(ctx);
  return { type: 'fold' };
}
