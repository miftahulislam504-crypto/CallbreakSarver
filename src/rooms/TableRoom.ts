import { randomInt } from 'node:crypto';
import { Room, ServerError, type Client } from 'colyseus';
import { getTokenVerifier } from '../auth/verifyIdToken.js';
import { config } from '../config.js';
import { isVoiceOn, issueVoiceToken, type VoiceDeniedReason } from '../services/voiceToken.js';
import { BOT_NAMES, cleanAvatar, cleanName, makeRoomCode, releaseRoomCode } from './common.js';

/**
 * Everything a seated table game shares: seats, host, bots, reconnection, avatars, voice chat, metadata and views.
 * A game room extends this and supplies its rules (see TwentyNineRoom and PokerRoom).
 * Call Break keeps its own room class; it behaves the same way but predates this base.
 */

export type GameId = 'twentynine' | 'poker';

export interface PublicSeat {
  seat: number;
  occupied: boolean;
  name: string;
  isBot: boolean;
  /** Human whose connection dropped (seat is held for them). */
  connected: boolean;
  /** Human who timed out repeatedly; a bot plays for them until they act again. */
  auto: boolean;
  /** Done looking at the cards (always true for bots). */
  ready: boolean;
  /** The human's account id (null for bots / empty seats), so clients can offer "add friend". */
  uid: string | null;
}

/** The part of the view every table game sends. */
export interface BaseView {
  gameId: GameId;
  roomCode: string;
  roomName: string;
  isPrivate: boolean;
  status: string;
  hostSeat: number;
  mySeat: number;
  seats: PublicSeat[];
  /** Epoch ms when the current human turn times out (null if a bot / nobody is to act). */
  deadline: number | null;
  /** Epoch ms when the next round / hand is dealt (round-end screen only). */
  nextRoundAt: number | null;
  /** Epoch ms when the cards were dealt (dealing phase only). */
  dealAt: number | null;
  /** Server clock, so clients can correct for clock skew when showing countdowns. */
  serverTime: number;
}

export interface Seat {
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
  /** Pressed "ready" during the look-at-cards phase. */
  ready: boolean;
}

export const emptySeat = (): Seat => ({
  occupied: false,
  isBot: false,
  wasHuman: false,
  name: '',
  uid: null,
  sessionId: null,
  connected: false,
  auto: false,
  timeouts: 0,
  ready: false,
});

export type Timer = { clear(): void };

export abstract class TableRoom extends Room {
  maxMessagesPerSecond = 20;

  /** Which game this room runs (used in metadata and views). */
  protected abstract readonly gameId: GameId;
  protected abstract readonly defaultTitle: string;

  protected code = '';
  protected title = '';
  protected isPrivateRoom = false;
  protected seats: Seat[] = [];
  protected hostSeat = -1;
  protected startedAt = 0;

  protected turnTimer: Timer | null = null;
  protected roundTimer: Timer | null = null;
  protected dealTimer: Timer | null = null;
  protected deadline: number | null = null;
  protected nextRoundAt: number | null = null;
  protected dealAt: number | null = null;

  /** Per client: the avatar set it was last sent, so photos travel only when they change. */
  private avatarsSent = new WeakMap<Client, string>();
  /** Per client: when it last got a voice token (epoch ms), to rate-limit requests. */
  private voiceTokenAt = new WeakMap<Client, number>();

  /* ------------------------------ what a game provides ------------------------------ */

  /** Read the game's create options (target score, starting chips, ...). */
  protected abstract readOptions(options: any): void;
  /** Register the game's own messages (bid, play, ...). */
  protected abstract setupMessages(): void;
  protected abstract gameRunning(): boolean;
  protected abstract gameFinished(): boolean;
  /** 'lobby' when no game is running, otherwise the game's phase name. */
  protected abstract status(): string;
  /** Host pressed start (checks already done by the base: host, no game running). */
  protected abstract handleStart(client: Client, msg: any): void;
  /** Rematch: throw the finished game away. */
  protected abstract discardGame(): void;
  protected abstract metadataExtra(): Record<string, unknown>;
  /** The game's part of the view for this seat. */
  protected abstract buildView(seat: number): unknown;
  /** The seat's turn may have changed hands (bot took over, player dropped / came back): re-arm the timer. */
  protected abstract rescheduleIfTurn(idx: number): void;
  /** True if it is `idx`'s turn right now. */
  protected abstract isTurnOf(idx: number): boolean;
  /** Called after every lobby change that the room must react to (e.g. all ready). Returns true if it moved the game on. */
  protected checkAllReady(): boolean {
    return false;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  onCreate(options: any): void {
    this.seats = Array.from({ length: this.maxClients }, emptySeat);
    this.code = makeRoomCode();
    this.roomId = this.code; // friends join with this 6-character code
    this.title = cleanName(options?.roomName, this.defaultTitle);
    this.isPrivateRoom = options?.isPrivate === true;
    this.readOptions(options);

    if (this.isPrivateRoom) void this.setPrivate(true);
    this.updateMetadata();

    this.onMessage('start', (client, msg) => {
      const idx = this.seatOf(client);
      if (!this.requireHost(client, idx)) return;
      if (this.gameRunning()) return this.sendError(client, 'already_started', 'Game already started');
      this.handleStart(client, msg);
    });
    this.onMessage('addBot', (client) => this.handleAddBot(client));
    this.onMessage('removeBot', (client, msg) => this.handleRemoveBot(client, msg));
    this.onMessage('rematch', (client) => this.handleRematch(client));
    this.onMessage('sync', (client) => {
      this.avatarsSent.delete(client); // a (re)syncing client gets the photos again
      this.sendView(client);
    });
    this.onMessage('setAvatar', (client, msg) => this.handleSetAvatar(client, msg));
    this.onMessage('voiceToken', (client) => this.handleVoiceToken(client));
    this.setupMessages();
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
      ready: false,
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
    if (this.isTurnOf(idx)) this.rescheduleIfTurn(idx); // a bot covers their turn
    if (this.checkAllReady()) return;
    this.broadcastState();
  }

  onReconnect(client: Client): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    this.seats[idx].connected = true;
    if (this.isTurnOf(idx)) this.rescheduleIfTurn(idx); // give the human the clock back
    this.broadcastState();
  }

  /** The player is gone for good (left, or failed to reconnect in time). */
  onLeave(client: Client, _code?: number): void {
    const idx = this.seatOf(client);
    if (idx === -1) return;
    const seat = this.seats[idx];

    if (this.gameRunning()) {
      // Mid-game: a bot takes the seat over for the rest of the match.
      seat.isBot = true;
      seat.sessionId = null;
      seat.connected = true;
      seat.auto = false;
      if (this.isTurnOf(idx)) this.rescheduleIfTurn(idx);
    } else {
      this.seats[idx] = emptySeat();
    }
    if (this.hostSeat === idx) this.hostSeat = this.seats.findIndex((s) => s.occupied && !s.isBot);

    if (this.checkAllReady()) return;
    this.updateMetadata();
    this.broadcastState();
  }

  onDispose(): void {
    this.clearTimers();
    releaseRoomCode(this.code);
  }

  /* ------------------------------ lobby actions ------------------------------ */

  private handleAddBot(client: Client): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.gameRunning()) return this.sendError(client, 'already_started', 'Game already started');
    const free = this.seats.findIndex((s) => !s.occupied);
    if (free === -1) return this.sendError(client, 'room_full', 'No free seat');
    this.putBot(free);
    this.updateMetadata();
    this.broadcastState();
  }

  private handleRemoveBot(client: Client, msg: any): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (this.gameRunning()) return this.sendError(client, 'already_started', 'Game already started');
    const target = msg?.seat;
    if (!Number.isInteger(target) || target < 0 || target >= this.seats.length || !this.seats[target].isBot) {
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

  private handleRematch(client: Client): void {
    const idx = this.seatOf(client);
    if (!this.requireHost(client, idx)) return;
    if (!this.gameRunning() || !this.gameFinished()) return this.sendError(client, 'not_finished', 'Game not finished');
    this.clearTimers();
    this.dealAt = null;
    this.nextRoundAt = null;
    this.discardGame();
    // Bots that replaced players who left are removed; real bots stay.
    this.seats = this.seats.map((s) => (s.isBot && s.wasHuman ? emptySeat() : s));
    this.seats.forEach((s) => {
      s.auto = false;
      s.timeouts = 0;
      s.ready = false;
    });
    void this.unlock();
    this.updateMetadata();
    this.broadcastState();
  }

  /** Fills every empty seat with a bot (used by "start with bots"). `upTo` limits how many seats end up occupied. */
  protected fillBots(upTo: number = this.seats.length): void {
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats.filter((s) => s.occupied).length >= upTo) break;
      if (!this.seats[i].occupied) this.putBot(i);
    }
  }

  /* ------------------------------ voice chat ------------------------------ */

  /**
   * A player asks for a voice token. The answer is always one `voice` message:
   * a grant (channel, uid, token, ...) or `{ enabled: false, reason }`. Voice problems never touch the game.
   * Only a human sitting in this room gets a token, so nobody can join the voice channel without a seat.
   */
  private handleVoiceToken(client: Client): void {
    const deny = (reason: VoiceDeniedReason) => client.send('voice', { enabled: false, reason });

    const idx = this.seatOf(client);
    if (idx === -1 || this.seats[idx].isBot) return deny('not_seated');
    if (!isVoiceOn()) return deny('disabled');

    const now = Date.now();
    const last = this.voiceTokenAt.get(client);
    if (last !== undefined && now - last < config.voiceTokenMinGapMs) return deny('rate_limited');
    this.voiceTokenAt.set(client, now);

    try {
      client.send('voice', issueVoiceToken(this.code, idx, now));
    } catch (err) {
      // e.g. a malformed App ID / Certificate. Log the cause (never the keys) and keep the game running.
      console.error(`[room ${this.code}] voice token failed: ${err instanceof Error ? err.message : String(err)}`);
      deny('disabled');
    }
  }

  /* ------------------------------ timers ------------------------------ */

  protected botDelay(): number {
    const { botDelayMinMs: lo, botDelayMaxMs: hi } = config;
    return hi <= lo ? lo : lo + randomInt(hi - lo + 1);
  }

  protected clearTimers(): void {
    this.turnTimer?.clear();
    this.roundTimer?.clear();
    this.dealTimer?.clear();
    this.turnTimer = null;
    this.roundTimer = null;
    this.dealTimer = null;
    this.deadline = null;
  }

  /** Arms the turn timer for seat `idx`: a bot (or absent / auto player) moves after a short delay, a human gets `secs`. */
  protected armTurn(idx: number, secs: number, botMove: () => void, onTimeout: () => void): void {
    this.turnTimer?.clear();
    this.turnTimer = null;
    const seat = this.seats[idx];
    const botControlled = seat.isBot || seat.auto || !seat.connected;
    if (botControlled) {
      this.deadline = null;
      const delay = seat.isBot || seat.auto ? this.botDelay() : config.disconnectedPlayMs;
      this.turnTimer = this.clock.setTimeout(botMove, delay);
    } else {
      this.deadline = Date.now() + secs * 1000;
      this.turnTimer = this.clock.setTimeout(onTimeout, secs * 1000);
    }
  }

  /** A human missed their clock: count it, and put them on auto-play after a few misses. */
  protected noteTimeout(idx: number): void {
    const seat = this.seats[idx];
    seat.timeouts++;
    if (seat.timeouts >= config.autoAfterTimeouts) seat.auto = true;
  }

  /** The human acted themselves: they are back in control. */
  protected humanActed(idx: number): void {
    const s = this.seats[idx];
    s.timeouts = 0;
    if (s.auto) s.auto = false;
  }

  /* ------------------------------ seats & views ------------------------------ */

  protected seatOf(client: Client): number {
    return this.seats.findIndex((s) => s.sessionId === client.sessionId);
  }

  protected putBot(idx: number): void {
    const used = new Set(this.seats.map((s) => s.name));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    const name = free.length > 0 ? free[Math.floor(Math.random() * free.length)] : `Bot ${idx + 1}`;
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
      ready: false,
    };
  }

  protected requireHost(client: Client, idx: number): boolean {
    if (idx === -1 || idx !== this.hostSeat) {
      this.sendError(client, 'not_host', 'Only the host can do that');
      return false;
    }
    return true;
  }

  protected publicSeats(): PublicSeat[] {
    return this.seats.map((s, i) => ({
      seat: i,
      occupied: s.occupied,
      name: s.name,
      isBot: s.isBot,
      connected: s.connected,
      auto: s.auto,
      ready: s.isBot || s.ready,
      uid: s.occupied && !s.isBot ? s.uid : null,
    }));
  }

  protected baseView(seat: number): BaseView {
    return {
      gameId: this.gameId,
      roomCode: this.code,
      roomName: this.title,
      isPrivate: this.isPrivateRoom,
      status: this.status(),
      hostSeat: this.hostSeat,
      mySeat: seat,
      seats: this.publicSeats(),
      deadline: this.deadline,
      nextRoundAt: this.nextRoundAt,
      dealAt: this.dealAt,
      serverTime: Date.now(),
    };
  }

  protected sendView(client: Client): void {
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

  protected broadcastState(): void {
    for (const client of this.clients) this.sendView(client);
  }

  protected sendError(client: Client, code: string, message: string): void {
    client.send('error', { code, message });
  }

  protected updateMetadata(): void {
    const humans = this.seats.filter((s) => s.occupied && !s.isBot).length;
    const bots = this.seats.filter((s) => s.occupied && s.isBot).length;
    const host = this.hostSeat >= 0 ? this.seats[this.hostSeat].name : '';
    void this.setMetadata({
      name: this.title,
      game: this.gameId,
      humans,
      bots,
      status: this.status(),
      host,
      ...this.metadataExtra(),
    }).catch(() => undefined);
  }
}
