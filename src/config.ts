const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** CB_FAST=1 removes all artificial delays (used by automated tests). */
const FAST = process.env.CB_FAST === '1';

export const config = {
  port: num('PORT', 2567),

  /** Set FIREBASE_PROJECT_ID in production: joins then require a valid Firebase ID token. */
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID?.trim() || null,

  /** The first N rounds are played without bidding; a player's score there is their tricks won. */
  noBidRounds: num('CB_NO_BID_ROUNDS', 1),

  /** Seconds a human has to bid / play before the server plays for them. */
  bidSeconds: num('CB_BID_SECONDS', 20),
  playSeconds: num('CB_PLAY_SECONDS', 30),

  /** Bots "think" for a random time in [min, max] ms so the table feels natural. */
  botDelayMinMs: FAST ? 0 : num('CB_BOT_MIN_MS', 700),
  botDelayMaxMs: FAST ? 0 : num('CB_BOT_MAX_MS', 1500),

  /** Pause on the round-result screen before the next deal. */
  roundEndMs: FAST ? 50 : num('CB_ROUND_END_MS', 6000),

  /** A disconnected player keeps their seat this long. */
  reconnectSeconds: num('CB_RECONNECT_SECONDS', 60),
  /** While disconnected, a bot plays their turns after this delay. */
  disconnectedPlayMs: FAST ? 0 : num('CB_DISCONNECTED_PLAY_MS', 2500),

  /** After this many consecutive timeouts the seat is put on auto-play. */
  autoAfterTimeouts: 2,

  minTarget: 10,
  maxTarget: 500,
  defaultTarget: 49,
  maxNameLength: 20,
};

export type Config = typeof config;
