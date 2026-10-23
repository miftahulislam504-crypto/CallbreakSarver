const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** True when the env var is explicitly switched off ("0", "false", "off", "no"); unset = not off. */
const isOff = (name: string): boolean => /^(0|false|off|no)$/i.test(process.env[name]?.trim() ?? '');

/** CB_FAST=1 removes all artificial delays (used by automated tests). */
const FAST = process.env.CB_FAST === '1';

export const config = {
  port: num('PORT', 2567),

  /** Set FIREBASE_PROJECT_ID in production: joins then require a valid Firebase ID token. */
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID?.trim() || null,

  /**
   * Voice chat (Agora). Voice is on only when both the App ID and the App Certificate are set.
   * The certificate is a secret: it lives in this env var only, never in the app or in git.
   */
  agoraAppId: process.env.AGORA_APP_ID?.trim() || null,
  agoraAppCertificate: process.env.AGORA_APP_CERTIFICATE?.trim() || null,
  /** Emergency kill switch: VOICE_ENABLED=0 turns voice off without touching the keys. */
  voiceEnabled: !isOff('VOICE_ENABLED'),
  /** How long a voice token lives (clamped to 60 s .. 24 h when issued). */
  voiceTokenSeconds: num('CB_VOICE_TOKEN_SECONDS', 3600),
  /** Minimum gap between two token requests from the same client. */
  voiceTokenMinGapMs: num('CB_VOICE_TOKEN_MIN_GAP_MS', 5000),

  /** The first N rounds are played without bidding; a player's score there is their tricks won. */
  noBidRounds: num('CB_NO_BID_ROUNDS', 1),

  /** Seconds a human has to bid / play before the server plays for them. */
  bidSeconds: num('CB_BID_SECONDS', 20),
  playSeconds: num('CB_PLAY_SECONDS', 30),

  /** Bots "think" for a random time in [min, max] ms so the table feels natural. */
  botDelayMinMs: FAST ? 0 : num('CB_BOT_MIN_MS', 700),
  botDelayMaxMs: FAST ? 0 : num('CB_BOT_MAX_MS', 1500),

  /** Card-dealing animation, then time to look at the cards before bidding starts (players can press "ready" to skip the wait). */
  dealMs: FAST ? 0 : num('CB_DEAL_MS', 3000),
  viewMs: FAST ? 0 : num('CB_VIEW_MS', 60000),

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

  /** 29: game points a team needs to win (or, going the other way, the deficit that loses). */
  tnMinTarget: 2,
  tnMaxTarget: 30,
  tnDefaultTarget: 3,

  /** Poker: allowed starting stacks (play-money chips), the default, seconds to act and blind pace. */
  pokerChipOptions: [500, 1000, 2000, 5000] as number[],
  pokerDefaultChips: 1000,
  pokerActionSeconds: num('CB_POKER_ACTION_SECONDS', 25),
  pokerHandsPerLevel: num('CB_POKER_HANDS_PER_LEVEL', 8),
  pokerMaxHands: num('CB_POKER_MAX_HANDS', 120),
  /** Pause after a poker hand before the next one is dealt. */
  pokerHandEndMs: FAST ? 50 : num('CB_POKER_HAND_END_MS', 5000),
  maxNameLength: 20,
  /** Longest accepted avatar data URI (a ~96x120 JPEG is about 5-8k characters). */
  maxAvatarChars: 16000,
};

export type Config = typeof config;
