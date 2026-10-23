import { randomInt } from 'node:crypto';
import type { Client } from 'colyseus';
import { config } from '../config.js';
import { isValidCard } from '../engine/cards.js';
import { SEATS, TNPhase, TNResult, TNView, TwentyNineGame, legalPlays, teamOf } from '../engine/twentynine.js';
import { chooseAction, chooseBid, chooseTrump } from '../engine/twentynine-bot.js';
import { getMatchStore, type MatchResult } from '../services/matchStore.js';
import { BaseView, TableRoom } from './TableRoom.js';

export type TNRoomStatus = 'lobby' | TNPhase;

export interface TNRoomView extends BaseView {
  gameId: 'twentynine';
  status: TNRoomStatus;
  /** Game points a team needs to win. */
  targetScore: number;
  dealMs: number;
  viewMs: number;
  /** How long a human has to bid / pick trump / play, so clients can size their countdown bars. */
  bidSeconds: number;
  playSeconds: number;
  game: TNView | null;
}

function parseTarget(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  return n >= config.tnMinTarget && n <= config.tnMaxTarget ? n : null;
}

/** 29 (টোয়েন্টি-নাইন): 4 players in 2 teams. The rules live in engine/twentynine.ts; this class is the table around them. */
export class TwentyNineRoom extends TableRoom {
  maxClients = SEATS;

  protected readonly gameId = 'twentynine' as const;
  protected readonly defaultTitle = '29';

  private targetScore = config.tnDefaultTarget;
  private game: TwentyNineGame | null = null;

  /* ------------------------------ what the base asks for ------------------------------ */

  protected readOptions(options: any): void {
    this.targetScore = parseTarget(options?.targetScore) ?? config.tnDefaultTarget;
  }

  protected setupMessages(): void {
    this.onMessage('setTarget', (client, msg) => this.handleSetTarget(client, msg));
    this.onMessage('ready', (client) => this.handleReady(client));
    this.onMessage('bid', (client, msg) => this.handleBid(client, msg));
    this.onMessage('trump', (client, msg) => this.handleTrump(client, msg));
    this.onMessage('play', (client, msg) => this.handlePlay(client, msg));
    this.onMessage('reveal', (client) => this.handleReveal(client));
  }

  protected gameRunning(): boolean {
    return this.game !== null;
  }

  protected gameFinished(): boolean {
    return this.game?.phase === 'finished';
  }

  protected status(): TNRoomStatus {
    return this.game ? this.game.phase : 'lobby';
  }

  protected discardGame(): void {
    this.game = null;
  }

  protected metadataExtra(): Record<string, unknown> {
    return { targetScore: this.targetScore };
  }

  protected isTurnOf(idx: number): boolean {
    return this.game !== null && this.game.turn === idx;
  }

  protected rescheduleIfTurn(_idx: number): void {
    this.scheduleTurn();
  }

  protected buildView(seat: number): TNRoomView {
    return {
      ...this.baseView(seat),
      gameId: 'twentynine',
      status: this.status(),
      targetScore: this.targetScore,
      dealMs: config.dealMs,
      viewMs: config.viewMs,
      bidSeconds: config.bidSeconds,
      playSeconds: config.playSeconds,
      game: this.game ? this.game.viewFor(seat) : null,
    };
  }

  /* ------------------------------ lobby actions ------------------------------ */

  protected handleStart(client: Client, msg: any): void {
    const empty = this.seats.map((s, i) => (s.occupied ? -1 : i)).filter((i) => i >= 0);
    if (empty.length > 0) {
      if (msg?.fillBots !== true) return this.sendError(client, 'need_players', 'Need 4 players (or start with bots)');
      this.fillBots();
    }
    this.game = new TwentyNineGame({ targetScore: this.targetScore }); // no look-at-cards phase: bidding starts at once
    this.game.start(randomInt(SEATS));
    this.startedAt = Date.now();
    void this.lock();
    this.afterChange();
  }

  private handleSetTarget(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.game) return this.sendError(client, 'already_started', 'Game already started');
    const t = parseTarget(msg?.targetScore);
    if (t === null) {
      return this.sendError(client, 'bad_target', `Target must be ${config.tnMinTarget}-${config.tnMaxTarget}`);
    }
    this.targetScore = t;
    this.updateMetadata();
    this.broadcastState();
  }

  /* ------------------------------ game actions ------------------------------ */

  private handleBid(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    this.humanActed(idx);
    this.finishAction(client, this.game.placeBid(idx, msg?.bid));
  }

  private handleTrump(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    this.humanActed(idx);
    this.finishAction(client, this.game.chooseTrump(idx, msg?.suit));
  }

  private handlePlay(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    if (!isValidCard(msg)) return this.sendError(client, 'bad_card', 'Invalid card');
    this.humanActed(idx);
    this.finishAction(client, this.game.playCard(idx, { suit: msg.suit, rank: msg.rank }));
  }

  /** "Ask for trump": a player who cannot follow suit asks the bidder to show it. */
  private handleReveal(client: Client): void {
    const idx = this.seatOf(client);
    if (!this.game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    this.humanActed(idx);
    this.finishAction(client, this.game.revealTrump(idx));
  }

  /** A player is done looking at their cards. Only counts once the dealing animation has finished. */
  private handleReady(client: Client): void {
    const game = this.game;
    const idx = this.seatOf(client);
    if (!game || idx === -1 || game.phase !== 'dealing') return;
    if (this.dealAt === null || Date.now() - this.dealAt < config.dealMs) return;
    if (this.seats[idx].ready) return;
    this.seats[idx].ready = true;
    if (this.checkAllReady()) return;
    this.broadcastState();
  }

  /** If every connected human is ready, end the look-at-cards wait now. Returns true if it did. */
  protected override checkAllReady(): boolean {
    const game = this.game;
    if (!game || game.phase !== 'dealing' || this.dealAt === null) return false;
    if (Date.now() - this.dealAt < config.dealMs) return false;
    const waiting = this.seats.some((s) => s.occupied && !s.isBot && s.connected && !s.ready);
    if (waiting) return false;
    this.startRound();
    return true;
  }

  private startRound(): void {
    const game = this.game;
    if (!game || game.phase !== 'dealing') return;
    this.dealAt = null;
    game.beginRound();
    this.afterChange();
  }

  private finishAction(client: Client, res: TNResult): void {
    if (!res.ok) {
      this.sendError(client, 'illegal', res.error);
      this.sendView(client); // resync in case the client's picture is stale
      return;
    }
    this.afterChange(res);
  }

  /* ------------------------------ turn engine ------------------------------ */

  /** Runs after every successful game change: scheduling first, then one broadcast. */
  private afterChange(res?: TNResult): void {
    const game = this.game;
    if (game && res?.ok) {
      for (const ev of res.events) {
        if (ev.type === 'gameEnded') this.onGameEnded();
      }
    }
    this.clearTimers();
    if (!game || game.phase !== 'dealing') this.dealAt = null;
    if (!game || game.phase !== 'roundEnd') this.nextRoundAt = null;
    if (game) {
      if (game.phase === 'dealing') this.scheduleDeal();
      else if (game.phase === 'bidding' || game.phase === 'trump' || game.phase === 'playing') this.scheduleTurn();
      else if (game.phase === 'roundEnd') this.scheduleNextRound();
    }
    this.updateMetadata();
    this.broadcastState();
  }

  private scheduleTurn(): void {
    const game = this.game;
    if (!game || (game.phase !== 'bidding' && game.phase !== 'trump' && game.phase !== 'playing')) {
      this.turnTimer?.clear();
      this.turnTimer = null;
      this.deadline = null;
      return;
    }
    const idx = game.turn;
    const secs = game.phase === 'playing' ? config.playSeconds : config.bidSeconds;
    this.armTurn(idx, secs, () => this.botAct(idx), () => this.onTurnTimeout(idx));
  }

  private onTurnTimeout(idx: number): void {
    const game = this.game;
    if (!game || game.turn !== idx) return;
    this.noteTimeout(idx);
    this.botAct(idx);
  }

  /** Make the move a bot would make for this seat (a human who ran out of time gets a gentler one when bidding). */
  private botAct(idx: number): void {
    const game = this.game;
    if (!game || game.turn !== idx) return;
    const seat = this.seats[idx];
    const hand = game.hands[idx];
    let res: TNResult;

    if (game.phase === 'bidding') {
      const { minBid, maxBid } = game.config;
      const forced = game.forcedBid;
      const bid = seat.isBot || seat.auto ? chooseBid(hand, minBid, maxBid, game.highBid, forced) : forced ? minBid : 0;
      res = game.placeBid(idx, bid);
      if (!res.ok) res = game.placeBid(idx, forced ? game.minimumBid() : 0);
    } else if (game.phase === 'trump') {
      res = game.chooseTrump(idx, chooseTrump(hand));
    } else if (game.phase === 'playing') {
      const knowsTrump = idx === game.declarer || game.trumpRevealed;
      const act = chooseAction({
        hand,
        trick: game.trick,
        seat: idx,
        declarer: game.declarer,
        trumpSuit: knowsTrump ? game.trumpSuit : null,
        trumpRevealed: game.trumpRevealed,
      });
      res = act.type === 'reveal' ? game.revealTrump(idx) : game.playCard(idx, act.card);
      if (!res.ok) {
        // Never leave the table stuck: fall back to the first legal card.
        const legal = legalPlays(hand, game.trick, game.trumpSuit, game.trumpRevealed);
        res = game.playCard(idx, legal[0]);
      }
    } else {
      return;
    }
    if (!res.ok) {
      console.error(`[room ${this.code}] bot move rejected: ${res.error}`);
      return;
    }
    this.afterChange(res);
  }

  /** The first four cards are dealt and shown for a while; then bidding begins. */
  private scheduleDeal(): void {
    this.deadline = null;
    this.dealAt = Date.now();
    this.seats.forEach((s) => (s.ready = false));
    this.dealTimer = this.clock.setTimeout(() => this.startRound(), config.dealMs + config.viewMs);
  }

  private scheduleNextRound(): void {
    this.deadline = null;
    this.nextRoundAt = Date.now() + config.roundEndMs;
    this.roundTimer = this.clock.setTimeout(() => {
      this.nextRoundAt = null;
      const game = this.game;
      if (!game || game.phase !== 'roundEnd') return;
      game.nextRound();
      this.afterChange();
    }, config.roundEndMs);
  }

  private onGameEnded(): void {
    const game = this.game!;
    const winners = game.winners ?? [];
    const result: MatchResult = {
      game: 'twentynine',
      roomCode: this.code,
      targetScore: this.targetScore,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      winners,
      rounds: game.history,
      players: this.seats.map((s, i) => ({
        seat: i,
        uid: s.uid,
        name: s.name,
        isBot: !s.wasHuman,
        leftEarly: s.wasHuman && s.isBot,
        total: game.totals[teamOf(i)],
        rank: winners.includes(i) ? 1 : 2,
      })),
    };
    getMatchStore()
      .saveMatch(result)
      .catch((err) => console.error(`[room ${this.code}] failed to save match`, err));
  }
}
