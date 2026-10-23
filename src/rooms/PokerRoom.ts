import type { Client } from 'colyseus';
import { config } from '../config.js';
import { MAX_SEATS, PokerAction, PokerEvent, PokerGame, PokerPhase, PokerResult, PokerView } from '../engine/poker.js';
import { chooseAction } from '../engine/poker-bot.js';
import { getMatchStore, type MatchResult } from '../services/matchStore.js';
import { BaseView, TableRoom } from './TableRoom.js';

export type PokerRoomStatus = 'lobby' | PokerPhase;

export interface PokerRoomView extends BaseView {
  gameId: 'poker';
  status: PokerRoomStatus;
  /** Starting stack of every player (play-money chips). */
  startingChips: number;
  /** How long a human has to act, so clients can size their countdown bar. */
  actionSeconds: number;
  game: PokerView | null;
}

function parseChips(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && config.pokerChipOptions.includes(n) ? n : null;
}

/** Texas Hold'em (no limit) with play-money chips, 2-6 seats. The rules live in engine/poker.ts. */
export class PokerRoom extends TableRoom {
  maxClients = MAX_SEATS;

  protected readonly gameId = 'poker' as const;
  protected readonly defaultTitle = 'Poker';

  private startingChips = config.pokerDefaultChips;
  private game: PokerGame | null = null;

  /* ------------------------------ what the base asks for ------------------------------ */

  protected readOptions(options: any): void {
    this.startingChips = parseChips(options?.startingChips) ?? config.pokerDefaultChips;
  }

  protected setupMessages(): void {
    this.onMessage('setChips', (client, msg) => this.handleSetChips(client, msg));
    this.onMessage('act', (client, msg) => this.handleAct(client, msg));
  }

  protected gameRunning(): boolean {
    return this.game !== null;
  }

  protected gameFinished(): boolean {
    return this.game?.phase === 'finished';
  }

  protected status(): PokerRoomStatus {
    return this.game ? this.game.phase : 'lobby';
  }

  protected discardGame(): void {
    this.game = null;
  }

  protected metadataExtra(): Record<string, unknown> {
    return { startingChips: this.startingChips };
  }

  protected isTurnOf(idx: number): boolean {
    return this.game !== null && this.game.phase === 'betting' && this.game.turn === idx;
  }

  protected rescheduleIfTurn(_idx: number): void {
    this.scheduleTurn();
  }

  protected buildView(seat: number): PokerRoomView {
    return {
      ...this.baseView(seat),
      gameId: 'poker',
      status: this.status(),
      startingChips: this.startingChips,
      actionSeconds: config.pokerActionSeconds,
      game: this.game ? this.game.viewFor(seat) : null,
    };
  }

  /* ------------------------------ lobby actions ------------------------------ */

  protected handleStart(client: Client, msg: any): void {
    if (this.seats.filter((s) => s.occupied).length < 2) {
      if (msg?.fillBots !== true) return this.sendError(client, 'need_players', 'Need at least 2 players (or start with bots)');
      this.fillBots(4); // a lone player gets a 4-handed table
    }
    this.game = new PokerGame(this.seats.length, {
      startingChips: this.startingChips,
      handsPerLevel: config.pokerHandsPerLevel,
      maxHands: config.pokerMaxHands,
    });
    const events = this.game.start(this.seats.map((s) => s.occupied));
    this.startedAt = Date.now();
    void this.lock();
    this.afterChange(events);
  }

  private handleSetChips(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.game) return this.sendError(client, 'already_started', 'Game already started');
    const chips = parseChips(msg?.startingChips);
    if (chips === null) {
      return this.sendError(client, 'bad_chips', `Starting chips must be one of ${config.pokerChipOptions.join(', ')}`);
    }
    this.startingChips = chips;
    this.updateMetadata();
    this.broadcastState();
  }

  /* ------------------------------ game actions ------------------------------ */

  private handleAct(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    this.humanActed(idx);
    const action: PokerAction = { type: msg?.type, amount: msg?.amount };
    const res = this.game.act(idx, action);
    if (!res.ok) {
      this.sendError(client, 'illegal', res.error);
      this.sendView(client); // resync in case the client's picture is stale
      return;
    }
    this.afterChange(res.events);
  }

  /* ------------------------------ turn engine ------------------------------ */

  /** Runs after every successful game change: scheduling first, then one broadcast. */
  private afterChange(events: PokerEvent[] = []): void {
    const game = this.game;
    if (game && events.some((e) => e.type === 'gameEnded')) this.onGameEnded();
    this.clearTimers();
    this.dealAt = null;
    if (!game || game.phase !== 'handEnd') this.nextRoundAt = null;
    if (game) {
      if (game.phase === 'betting') this.scheduleTurn();
      else if (game.phase === 'handEnd') this.scheduleNextHand();
    }
    this.updateMetadata();
    this.broadcastState();
  }

  private scheduleTurn(): void {
    const game = this.game;
    if (!game || game.phase !== 'betting') {
      this.turnTimer?.clear();
      this.turnTimer = null;
      this.deadline = null;
      return;
    }
    const idx = game.turn;
    this.armTurn(idx, config.pokerActionSeconds, () => this.botAct(idx), () => this.onTurnTimeout(idx));
  }

  /** A human ran out of time: check if that is free, otherwise fold. */
  private onTurnTimeout(idx: number): void {
    const game = this.game;
    if (!game || game.phase !== 'betting' || game.turn !== idx) return;
    this.noteTimeout(idx);
    const res = game.act(idx, game.defaultAction(idx));
    this.afterBotMove(idx, res);
  }

  /** Make the move a bot would make for this seat. */
  private botAct(idx: number): void {
    const game = this.game;
    if (!game || game.phase !== 'betting' || game.turn !== idx) return;
    const legal = game.legalActions(idx);
    if (!legal) return;
    const p = game.players[idx];
    const action = chooseAction({
      hole: p.hole,
      board: game.board,
      street: game.street,
      pot: game.pot,
      myBet: p.bet,
      currentBet: game.currentBet,
      chips: p.chips,
      bigBlind: game.bigBlind,
      opponents: game.players.filter((q) => q.inHand && !q.folded).length,
      legal,
    });
    let res = game.act(idx, action);
    if (!res.ok) res = game.act(idx, game.defaultAction(idx)); // never leave the table stuck
    this.afterBotMove(idx, res);
  }

  private afterBotMove(idx: number, res: PokerResult): void {
    if (!res.ok) {
      console.error(`[room ${this.code}] bot move rejected for seat ${idx}: ${res.error}`);
      return;
    }
    this.afterChange(res.events);
  }

  private scheduleNextHand(): void {
    this.deadline = null;
    this.nextRoundAt = Date.now() + config.pokerHandEndMs;
    this.roundTimer = this.clock.setTimeout(() => {
      this.nextRoundAt = null;
      const game = this.game;
      if (!game || game.phase !== 'handEnd') return;
      this.afterChange(game.nextHand());
    }, config.pokerHandEndMs);
  }

  private onGameEnded(): void {
    const game = this.game!;
    const winners = game.winners ?? [];
    const ranking = game.ranking ?? [];
    const result: MatchResult = {
      game: 'poker',
      roomCode: this.code,
      targetScore: this.startingChips,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      winners,
      rounds: [],
      players: this.seats
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.occupied)
        .map(({ s, i }) => ({
          seat: i,
          uid: s.uid,
          name: s.name,
          isBot: !s.wasHuman,
          leftEarly: s.wasHuman && s.isBot,
          total: game.players[i].chips,
          rank: winners.includes(i) ? 1 : Math.max(1, ranking.indexOf(i) + 1),
        })),
    };
    getMatchStore()
      .saveMatch(result)
      .catch((err) => console.error(`[room ${this.code}] failed to save match`, err));
  }
}
