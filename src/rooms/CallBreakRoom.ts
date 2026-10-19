import { randomInt } from 'node:crypto';
import { Room, ServerError, type Client } from 'colyseus';
import { getTokenVerifier } from '../auth/verifyIdToken.js';
import { config } from '../config.js';
import { chooseBid, chooseCard } from '../engine/bot.js';
import { isValidCard } from '../engine/cards.js';
import { ActionResult, CallBreakGame, GameView, SEATS, TRICKS_PER_ROUND } from '../engine/game.js';
import { getMatchStore, type MatchResult } from '../services/matchStore.js';

/* ----------------------------------------------------------------------------
 * Types sent to clients
 * ------------------------------------------------------------------------- */

export type RoomStatus = 'lobby' | 'dealing' | 'bidding' | 'playing' | 'roundEnd' | 'finished';

export interface PublicSeat {
  seat: number;
  occupied: boolean;
  name: string;
  isBot: boolean;
  /** Human whose connection dropped (seat is held for them). */
  connected: boolean;
  /** Human who timed out repeatedly; a bot plays for them until they act again. */
  auto: boolean;
}

export interface RoomView {
  roomCode: string;
  roomName: string;
  isPrivate: boolean;
  status: RoomStatus;
  hostSeat: number;
  mySeat: number;
  targetScore: number;
  seats: PublicSeat[];
  /** Epoch ms when the current human turn times out (null if a bot / nobody is to act). */
  deadline: number | null;
  /** Epoch ms when the next round is dealt (round-end screen only). */
  nextRoundAt: number | null;
  /** Epoch ms when the cards were dealt (dealing phase only), with the animation and look-at-cards lengths. */
  dealAt: number | null;
  dealMs: number;
  viewMs: number;
  /** Server clock, so clients can correct for clock skew when showing countdowns. */
  serverTime: number;
  /** How long a human has to bid / play, so clients can size their countdown bars. */
  bidSeconds: number;
  playSeconds: number;
  game: GameView | null;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

interface Seat {
  occupied: boolean;
  isBot: boolean;
  /** True if a human originally sat here (even if a bot has since taken over). */
  wasHuman: boolean;
  name: string;
  uid: string | null;
  /** Small profile photo as a JPEG data URI (validated by cleanAvatar); null = show the initial. */
  avatar?: string | null;
  sessionId: string | null;
  connected: boolean;
  auto: boolean;
  timeouts: number;
}

const emptySeat = (): Seat => ({
  occupied: false,
  isBot: false,
  wasHuman: false,
  name: '',
  uid: null,
  sessionId: null,
  connected: false,
  auto: false,
  timeouts: 0,
});

const BOT_NAMES = ['Bot Rahim', 'Bot Karim', 'Bot Salma', 'Bot Jamal'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const activeCodes = new Set<string>();

function makeRoomCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  } while (activeCodes.has(code));
  activeCodes.add(code);
  return code;
}

function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, config.maxNameLength);
  return name.length > 0 ? name : fallback;
}

const AVATAR_PREFIX = 'data:image/jpeg;base64,';
const AVATAR_B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Accepts only a small JPEG data URI; anything else (too big, wrong type, junk) becomes null. */
export function cleanAvatar(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > config.maxAvatarChars) return null;
  if (!raw.startsWith(AVATAR_PREFIX)) return null;
  return AVATAR_B64.test(raw.slice(AVATAR_PREFIX.length)) ? raw : null;
}

function parseTarget(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  return n >= config.minTarget && n <= config.maxTarget ? n : null;
}

type Timer = { clear(): void };

/* ----------------------------------------------------------------------------
 * Room
 * ------------------------------------------------------------------------- */

export class CallBreakRoom extends Room {
  maxClients = SEATS;
  maxMessagesPerSecond = 20;

  private code = '';
  private title = 'Call Break';
  private isPrivateRoom = false;
  private targetScore = config.defaultTarget;

  private seats: Seat[] = [emptySeat(), emptySeat(), emptySeat(), emptySeat()];
  private hostSeat = -1;
  private game: CallBreakGame | null = null;
  private startedAt = 0;

  /** Per client: the avatar set it was last sent, so photos travel only when they change. */
  private avatarsSent = new WeakMap<Client, string>();

  private turnTimer: Timer | null = null;
  private roundTimer: Timer | null = null;
  private dealTimer: Timer | null = null;
  private dealAt: number | null = null;
  private deadline: number | null = null;
  private nextRoundAt: number | null = null;

  /* ------------------------------ lifecycle ------------------------------ */

  onCreate(options: any): void {
    this.code = makeRoomCode();
    this.roomId = this.code; // friends join with this 6-character code
    this.title = cleanName(options?.roomName, 'Call Break');
    this.isPrivateRoom = options?.isPrivate === true;
    this.targetScore = parseTarget(options?.targetScore) ?? config.defaultTarget;

    if (this.isPrivateRoom) void this.setPrivate(true);
    this.updateMetadata();

    this.onMessage('start', (client, msg) => this.handleStart(client, msg));
    this.onMessage('addBot', (client) => this.handleAddBot(client));
    this.onMessage('removeBot', (client, msg) => this.handleRemoveBot(client, msg));
    this.onMessage('setTarget', (client, msg) => this.handleSetTarget(client, msg));
    this.onMessage('bid', (client, msg) => this.handleBid(client, msg));
    this.onMessage('play', (client, msg) => this.handlePlay(client, msg));
    this.onMessage('rematch', (client) => this.handleRematch(client));
    this.onMessage('sync', (client) => {
      this.avatarsSent.delete(client); // a (re)syncing client gets the photos again
      this.sendView(client);
    });
    this.onMessage('setAvatar', (client, msg) => this.handleSetAvatar(client, msg));
  }

  async onAuth(_client: Client, options: any): Promise<any> {
    const verify = getTokenVerifier();
    if (!verify) {
      // Dev mode (FIREBASE_PROJECT_ID not set): identities are trusted as sent.
      return {
        name: cleanName(options?.name, 'Player'),
        uid: typeof options?.uid === 'string' ? options.uid.slice(0, 128) : null,
        avatar: cleanAvatar(options?.avatar),
      };
    }
    try {
      const user = await verify(options?.idToken);
      return { name: cleanName(options?.name, cleanName(user.name, 'Player')), uid: user.uid, avatar: cleanAvatar(options?.avatar) };
    } catch {
      throw new ServerError(401, 'invalid_token');
    }
  }

  onJoin(client: Client, _options: any, auth?: any): void {
    const info = (client as any).auth ?? auth ?? {};
    // Prefer an empty seat; otherwise replace a lobby bot.
    let idx = this.seats.findIndex((s) => !s.occupied);
    if (idx === -1) idx = this.seats.findIndex((s) => s.isBot);
    if (idx === -1) throw new Error('room is full');

    this.seats[idx] = {
      occupied: true,
      isBot: false,
      wasHuman: true,
      name: info.name ?? 'Player',
      uid: info.uid ?? null,
      avatar: info.avatar ?? null,
      sessionId: client.sessionId,
      connected: true,
      auto: false,
      timeouts: 0,
    };
    if (this.hostSeat === -1) this.hostSeat = idx;

    this.updateMetadata();
    this.broadcastState();
  }

  /** Connection lost without the player leaving: hold the seat. */
  onDrop(client: Client, _code?: number): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    this.seats[idx].connected = false;
    this.allowReconnection(client, config.reconnectSeconds);
    if (this.game && this.game.turn === idx) this.scheduleTurn(); // a bot covers their turn
    this.broadcastState();
  }

  onReconnect(client: Client): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    this.seats[idx].connected = true;
    if (this.game && this.game.turn === idx) this.scheduleTurn(); // give the human the clock back
    this.broadcastState();
  }

  /** The player is gone for good (left, or failed to reconnect in time). */
  onLeave(client: Client, _code?: number): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    const seat = this.seats[idx];

    if (this.game) {
      // Mid-game: a bot takes the seat over for the rest of the match.
      seat.isBot = true;
      seat.sessionId = null;
      seat.connected = true;
      seat.auto = false;
      if (this.game.turn === idx) this.scheduleTurn();
    } else {
      this.seats[idx] = emptySeat();
    }
    if (this.hostSeat === idx) this.hostSeat = this.seats.findIndex((s) => s.occupied && !s.isBot);

    this.updateMetadata();
    this.broadcastState();
  }

  onDispose(): void {
    this.clearTimers();
    activeCodes.delete(this.code);
  }

  /* ------------------------------ lobby actions ------------------------------ */

  private handleStart(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.game) return this.sendError(client, 'already_started', 'Game already started');

    const empty = this.seats.map((s, i) => (s.occupied ? -1 : i)).filter((i) => i >= 0);
    if (empty.length > 0) {
      if (msg?.fillBots !== true) return this.sendError(client, 'need_players', 'Need 4 players (or start with bots)');
      empty.forEach((i) => this.putBot(i));
    }

    this.game = new CallBreakGame({ targetScore: this.targetScore, noBidRounds: config.noBidRounds, dealPhase: true });
    this.game.start(randomInt(SEATS));
    this.startedAt = Date.now();
    void this.lock();
    this.afterChange();
  }

  private handleAddBot(client: Client): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.game) return this.sendError(client, 'already_started', 'Game already started');
    const free = this.seats.findIndex((s) => !s.occupied);
    if (free === -1) return this.sendError(client, 'room_full', 'No free seat');
    this.putBot(free);
    this.updateMetadata();
    this.broadcastState();
  }

  private handleRemoveBot(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.game) return this.sendError(client, 'already_started', 'Game already started');
    const target = msg?.seat;
    if (!Number.isInteger(target) || target < 0 || target >= SEATS || !this.seats[target].isBot) {
      return this.sendError(client, 'bad_seat', 'No bot in that seat');
    }
    this.seats[target] = emptySeat();
    this.updateMetadata();
    this.broadcastState();
  }

  private handleSetAvatar(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    this.seats[idx].avatar = cleanAvatar(msg?.avatar);
    this.broadcastState();
  }

  private handleSetTarget(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.game) return this.sendError(client, 'already_started', 'Game already started');
    const t = parseTarget(msg?.targetScore);
    if (t === null) {
      return this.sendError(client, 'bad_target', `Target must be ${config.minTarget}-${config.maxTarget}`);
    }
    this.targetScore = t;
    this.updateMetadata();
    this.broadcastState();
  }

  private handleRematch(client: Client): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (!this.game || this.game.phase !== 'finished') return this.sendError(client, 'not_finished', 'Game not finished');
    this.clearTimers();
    this.game = null;
    // Bots that replaced players who left are removed; real bots stay.
    this.seats = this.seats.map((s) => (s.isBot && s.wasHuman ? emptySeat() : s));
    this.seats.forEach((s) => {
      s.auto = false;
      s.timeouts = 0;
    });
    void this.unlock();
    this.updateMetadata();
    this.broadcastState();
  }

  /* ------------------------------ game actions ------------------------------ */

  private handleBid(client: Client, msg: any): void {
    const game = this.game;
    const idx = this.seatOf(client);
    if (!game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    this.humanActed(idx);
    const res = game.placeBid(idx, msg?.bid);
    this.finishAction(client, res);
  }

  private handlePlay(client: Client, msg: any): void {
    const game = this.game;
    const idx = this.seatOf(client);
    if (!game || idx === -1) return this.sendError(client, 'no_game', 'No game running');
    if (!isValidCard(msg)) return this.sendError(client, 'bad_card', 'Invalid card');
    this.humanActed(idx);
    const res = game.playCard(idx, { suit: msg.suit, rank: msg.rank });
    this.finishAction(client, res);
  }

  private humanActed(idx: number): void {
    const s = this.seats[idx];
    s.timeouts = 0;
    if (s.auto) s.auto = false;
  }

  private finishAction(client: Client, res: ActionResult): void {
    if (!res.ok) {
      this.sendError(client, 'illegal', res.error);
      this.sendView(client); // resync in case the client's picture is stale
      return;
    }
    this.afterChange(res);
  }

  /* ------------------------------ turn engine ------------------------------ */

  /** Runs after every successful game change: scheduling first, then one broadcast. */
  private afterChange(res?: ActionResult): void {
    const game = this.game;
    if (game && res?.ok) {
      for (const ev of res.events) {
        if (ev.type === 'gameEnded') this.onGameEnded();
      }
    }
    this.clearTimers();
    if (game) {
      if (game.phase === 'dealing') this.scheduleDeal();
      else if (game.phase === 'bidding' || game.phase === 'playing') this.scheduleTurn();
      else if (game.phase === 'roundEnd') this.scheduleNextRound();
    }
    this.updateMetadata();
    this.broadcastState();
  }

  private scheduleTurn(): void {
    this.turnTimer?.clear();
    this.turnTimer = null;
    const game = this.game;
    if (!game || (game.phase !== 'bidding' && game.phase !== 'playing')) {
      this.deadline = null;
      return;
    }
    const idx = game.turn;
    const seat = this.seats[idx];
    const botControlled = seat.isBot || seat.auto || !seat.connected;

    if (botControlled) {
      this.deadline = null;
      const delay = seat.isBot || seat.auto ? this.botDelay() : config.disconnectedPlayMs;
      this.turnTimer = this.clock.setTimeout(() => this.botAct(idx), delay);
    } else {
      const secs = game.phase === 'bidding' ? config.bidSeconds : config.playSeconds;
      this.deadline = Date.now() + secs * 1000;
      this.turnTimer = this.clock.setTimeout(() => this.onTurnTimeout(idx), secs * 1000);
    }
  }

  private onTurnTimeout(idx: number): void {
    const game = this.game;
    if (!game || game.turn !== idx) return;
    const seat = this.seats[idx];
    seat.timeouts++;
    if (seat.timeouts >= config.autoAfterTimeouts) seat.auto = true;
    this.botAct(idx);
  }

  /** Make the move a bot would make for this seat. */
  private botAct(idx: number): void {
    const game = this.game;
    if (!game || game.turn !== idx) return;
    let res: ActionResult;
    if (game.phase === 'bidding') {
      res = game.placeBid(idx, chooseBid(game.hands[idx], game.config.minBid, game.config.maxBid));
    } else if (game.phase === 'playing') {
      const card = chooseCard({
        hand: game.hands[idx],
        trick: game.trick,
        seat: idx,
        // No-bid round: every trick counts, so bots chase them all.
        bid: game.noBid ? TRICKS_PER_ROUND : (game.bids[idx] ?? game.config.minBid),
        tricksWon: game.tricksWon[idx],
      });
      res = game.playCard(idx, card);
    } else {
      return;
    }
    if (!res.ok) {
      console.error(`[room ${this.code}] bot move rejected: ${res.error}`);
      return;
    }
    this.afterChange(res);
  }

  /** Cards are dealt and shown for a while; then bidding (or play, in a no-bid round) begins. */
  private scheduleDeal(): void {
    this.deadline = null;
    this.dealAt = Date.now();
    this.dealTimer = this.clock.setTimeout(() => {
      this.dealAt = null;
      const game = this.game;
      if (!game || game.phase !== 'dealing') return;
      game.beginRound();
      this.afterChange();
    }, config.dealMs + config.viewMs);
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

  private botDelay(): number {
    const { botDelayMinMs: lo, botDelayMaxMs: hi } = config;
    return hi <= lo ? lo : lo + randomInt(hi - lo + 1);
  }

  private clearTimers(): void {
    this.turnTimer?.clear();
    this.roundTimer?.clear();
    this.dealTimer?.clear();
    this.turnTimer = null;
    this.roundTimer = null;
    this.dealTimer = null;
    this.deadline = null;
    if (!this.game || this.game.phase !== 'dealing') this.dealAt = null;
    if (!this.game || this.game.phase !== 'roundEnd') this.nextRoundAt = null;
  }

  private onGameEnded(): void {
    const game = this.game!;
    const order = game.ranking ?? [0, 1, 2, 3];
    const rankOf = (seat: number) => 1 + order.filter((o) => game.totals10[o] > game.totals10[seat]).length;
    const result: MatchResult = {
      roomCode: this.code,
      targetScore: this.targetScore,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      winners: game.winners ?? [],
      rounds: game.history,
      players: this.seats.map((s, i) => ({
        seat: i,
        uid: s.uid,
        name: s.name,
        isBot: !s.wasHuman,
        leftEarly: s.wasHuman && s.isBot,
        total: game.totals10[i] / 10,
        rank: rankOf(i),
      })),
    };
    getMatchStore()
      .saveMatch(result)
      .catch((err) => console.error(`[room ${this.code}] failed to save match`, err));
  }

  /* ------------------------------ views ------------------------------ */

  private seatOf(client: Client): number {
    return this.seats.findIndex((s) => s.sessionId === client.sessionId);
  }

  private putBot(idx: number): void {
    const used = new Set(this.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${idx + 1}`;
    this.seats[idx] = {
      occupied: true,
      isBot: true,
      wasHuman: false,
      name,
      uid: null,
      sessionId: null,
      connected: true,
      auto: false,
      timeouts: 0,
    };
  }

  private requireHost(client: Client, idx: number): boolean {
    if (idx === -1 || idx !== this.hostSeat) {
      this.sendError(client, 'not_host', 'Only the host can do that');
      return false;
    }
    return true;
  }

  private status(): RoomStatus {
    return this.game ? (this.game.phase as RoomStatus) : 'lobby';
  }

  private buildView(seat: number): RoomView {
    return {
      roomCode: this.code,
      roomName: this.title,
      isPrivate: this.isPrivateRoom,
      status: this.status(),
      hostSeat: this.hostSeat,
      mySeat: seat,
      targetScore: this.targetScore,
      seats: this.seats.map((s, i) => ({
        seat: i,
        occupied: s.occupied,
        name: s.name,
        isBot: s.isBot,
        connected: s.connected,
        auto: s.auto,
      })),
      deadline: this.deadline,
      nextRoundAt: this.nextRoundAt,
      dealAt: this.dealAt,
      dealMs: config.dealMs,
      viewMs: config.viewMs,
      serverTime: Date.now(),
      bidSeconds: config.bidSeconds,
      playSeconds: config.playSeconds,
      game: this.game ? this.game.viewFor(seat) : null,
    };
  }

  private sendView(client: Client): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    this.sendAvatars(client);
    client.send('state', this.buildView(idx));
  }

  /** Photos ride in their own message (not in every state update) and only when something changed. */
  private sendAvatars(client: Client): void {
    const list = this.seats.map((s) => (s.occupied && !s.isBot ? (s.avatar ?? null) : null));
    const sig = list.map((a) => (a ? `${a.length}:${a.slice(-12)}` : '-')).join('|');
    if (this.avatarsSent.get(client) === sig) return;
    this.avatarsSent.set(client, sig);
    client.send('avatars', { avatars: list });
  }

  private broadcastState(): void {
    for (const client of this.clients) this.sendView(client);
  }

  private sendError(client: Client, code: string, message: string): void {
    client.send('error', { code, message });
  }

  private updateMetadata(): void {
    const humans = this.seats.filter((s) => s.occupied && !s.isBot).length;
    const bots = this.seats.filter((s) => s.occupied && s.isBot).length;
    const host = this.hostSeat >= 0 ? this.seats[this.hostSeat].name : '';
    void this.setMetadata({
      name: this.title,
      targetScore: this.targetScore,
      humans,
      bots,
      status: this.status(),
      host,
    }).catch(() => undefined);
  }
}
