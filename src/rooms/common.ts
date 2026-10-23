import { randomInt } from 'node:crypto';
import { config } from '../config.js';

/** Helpers shared by every game room (Call Break, 29, Poker). No Colyseus import: safe to use anywhere. */

// Animal names: the app draws a matching animal avatar for a bot from its name (see app src/lib/botAvatars.ts).
export const BOT_NAMES = ['Cat', 'Dog', 'Snake', 'Fox', 'Panda', 'Lion'];

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const activeCodes = new Set<string>();

/** A 6-character room code, unique across ALL game rooms on this server (the code is the Colyseus room id). */
export function makeRoomCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  } while (activeCodes.has(code));
  activeCodes.add(code);
  return code;
}

export function releaseRoomCode(code: string): void {
  activeCodes.delete(code);
}

export function cleanName(raw: unknown, fallback: string): string {
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
