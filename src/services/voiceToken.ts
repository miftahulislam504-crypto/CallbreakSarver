// `agora-token` is a CommonJS package: under Node ESM only the default import carries its exports
// (`import { RtcTokenBuilder } from 'agora-token'` compiles but is undefined at runtime in dist/).
import agora from 'agora-token';
import { config } from '../config.js';

const { RtcRole, RtcTokenBuilder } = agora;

/* ----------------------------------------------------------------------------
 * Messages sent to clients (the `voice` message)
 * ------------------------------------------------------------------------- */

export type VoiceDeniedReason = 'disabled' | 'not_seated' | 'rate_limited';

export interface VoiceDenied {
  enabled: false;
  reason: VoiceDeniedReason;
}

export interface VoiceGrant {
  enabled: true;
  appId: string;
  /** Agora channel: `cb-<room code>`. */
  channel: string;
  /** Agora uid: seat + 1 (1..4), so "who is speaking" maps straight to a seat. */
  uid: number;
  token: string;
  /** Epoch ms when the token stops working. */
  expiresAt: number;
}

export type VoiceMessage = VoiceGrant | VoiceDenied;

/* ----------------------------------------------------------------------------
 * Token builder (injectable, like the Firebase TokenVerifier)
 * ------------------------------------------------------------------------- */

export interface VoiceTokenRequest {
  appId: string;
  appCertificate: string;
  channel: string;
  uid: number;
  /** Token lifetime in seconds from now. */
  ttlSeconds: number;
}

/** Returns an Agora RTC token. Tests replace it with a fake so no real keys are needed. */
export type VoiceTokenBuilder = (req: VoiceTokenRequest) => string;

export function createVoiceTokenBuilder(): VoiceTokenBuilder {
  return (req) =>
    RtcTokenBuilder.buildTokenWithUid(
      req.appId,
      req.appCertificate,
      req.channel,
      req.uid,
      RtcRole.PUBLISHER, // voice call: everyone may speak
      req.ttlSeconds, // whole-token lifetime (seconds from now)
      req.ttlSeconds, // join/publish privilege lifetime (must not exceed the token's)
    );
}

let override: VoiceTokenBuilder | undefined;

/** Tests (or a custom setup) can replace the builder; `undefined` restores the real one. */
export function setVoiceTokenBuilder(b: VoiceTokenBuilder | undefined): void {
  override = b;
}

let real: VoiceTokenBuilder | undefined;

export function getVoiceTokenBuilder(): VoiceTokenBuilder {
  if (override) return override;
  real ??= createVoiceTokenBuilder();
  return real;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60; // Agora's own ceiling

export const voiceChannel = (roomCode: string): string => `cb-${roomCode}`;
export const voiceUid = (seat: number): number => seat + 1;

/** Why voice is off right now, or null when it is on. Never contains a secret value. */
export function voiceOffReason(): string | null {
  if (!config.voiceEnabled) return 'VOICE_ENABLED=0';
  if (!config.agoraAppId) return 'AGORA_APP_ID is not set';
  if (!config.agoraAppCertificate) return 'AGORA_APP_CERTIFICATE is not set';
  return null;
}

export const isVoiceOn = (): boolean => voiceOffReason() === null;

/**
 * Builds a token for one seat of one room. Throws if voice is not configured or Agora's builder
 * refuses the keys (it silently returns '' when the App ID / Certificate are not 32 hex characters).
 */
export function issueVoiceToken(roomCode: string, seat: number, now: number = Date.now()): VoiceGrant {
  const appId = config.agoraAppId;
  const appCertificate = config.agoraAppCertificate;
  if (!appId || !appCertificate) throw new Error('voice_not_configured');

  const ttlSeconds = Math.min(Math.max(Math.floor(config.voiceTokenSeconds), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
  const channel = voiceChannel(roomCode);
  const uid = voiceUid(seat);

  const token = getVoiceTokenBuilder()({ appId, appCertificate, channel, uid, ttlSeconds });
  if (typeof token !== 'string' || token.length === 0) throw new Error('empty_token');

  return { enabled: true, appId, channel, uid, token, expiresAt: now + ttlSeconds * 1000 };
}
