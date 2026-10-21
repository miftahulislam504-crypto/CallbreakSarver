import './env.js'; // keep first: sets fast timers before config loads
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { listen, matchMaker } from 'colyseus';
import { Client } from '@colyseus/sdk';
import { createServer } from '../src/app.js';
import { config } from '../src/config.js';
import type { RoomView } from '../src/rooms/CallBreakRoom.js';
import { setMatchStore, type MatchResult } from '../src/services/matchStore.js';
import { setVoiceTokenBuilder, type VoiceMessage, type VoiceTokenRequest } from '../src/services/voiceToken.js';

const PORT = 2600 + (process.pid % 300);
const URL = `ws://localhost:${PORT}`;
const HTTP = `http://localhost:${PORT}`;

const savedMatches: MatchResult[] = [];
let server: Awaited<ReturnType<typeof listen>>;
const openRooms: any[] = [];

before(async () => {
  setMatchStore({
    async saveMatch(r) {
      savedMatches.push(r);
    },
  });
  server = await listen(createServer(), PORT);
});

after(async () => {
  // Arm the force-exit first: leave()/gracefullyShutdown can hang on rooms with reconnection timers.
  setTimeout(() => process.exit(0), 3000).unref();
  for (const r of openRooms) {
    try {
      await r.leave(true);
    } catch {
      /* already closed */
    }
  }
  await server.gracefullyShutdown(false).catch(() => undefined);
});

/* ------------------------------ test client helper ------------------------------ */

interface TestPlayer {
  room: any;
  view: () => RoomView;
  errors: { code: string; message: string }[];
  voices: VoiceMessage[];
  autoplay: boolean;
  states: number;
}

async function attach(room: any, autoplay: boolean): Promise<TestPlayer> {
  openRooms.push(room);
  let latest: RoomView | null = null;
  const p: TestPlayer = {
    room,
    view: () => latest as RoomView,
    errors: [],
    voices: [],
    autoplay,
    states: 0,
  };
  room.onMessage('error', (e: any) => p.errors.push(e));
  room.onMessage('voice', (m: VoiceMessage) => p.voices.push(m));
  room.onMessage('state', (s: RoomView) => {
    latest = s;
    p.states++;
    const g = s.game;
    if (!p.autoplay || !g || g.turn !== s.mySeat) return;
    if (g.phase === 'bidding' && g.bids[s.mySeat] === null) room.send('bid', { bid: 2 });
    else if (g.phase === 'playing' && g.legal.length > 0) room.send('play', g.legal[0]);
  });
  room.send('sync');
  await waitFor(() => latest !== null, 3000, 'first state');
  return p;
}

async function waitFor(cond: () => boolean, ms = 10000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const connect = () => new Client(URL);
const hostCreate = async (opts: any = {}, autoplay = true) =>
  attach(await connect().create('callbreak', { name: 'Host', ...opts }), autoplay);
const join = async (code: string, name: string, autoplay = true) =>
  attach(await connect().joinById(code, { name }), autoplay);

/* ------------------------------ tests ------------------------------ */

test('health endpoint answers', async () => {
  const res = await fetch(`${HTTP}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('create room -> 6-char code; friends join by code; 5th player is refused', async () => {
  const host = await hostCreate({ isPrivate: true, targetScore: 29 });
  const code = host.view().roomCode;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(host.view().status, 'lobby');
  // The view carries the configured turn lengths (test/env.ts sets both to 1s).
  assert.equal(host.view().bidSeconds, Number(process.env.CB_BID_SECONDS));
  assert.equal(host.view().playSeconds, Number(process.env.CB_PLAY_SECONDS));
  assert.equal(host.view().mySeat, 0);
  assert.equal(host.view().hostSeat, 0);
  assert.equal(host.view().targetScore, 29);

  const b = await join(code, 'Bela');
  const c = await join(code, 'Chandra');
  const d = await join(code, 'Dipu');
  const seats = new Set([host, b, c, d].map((p) => p.view().mySeat));
  assert.equal(seats.size, 4);
  await waitFor(() => host.view().seats.every((s) => s.occupied), 3000, 'all seats occupied');
  assert.deepEqual(host.view().seats.map((s) => s.name).sort(), ['Bela', 'Chandra', 'Dipu', 'Host']);

  await assert.rejects(() => connect().joinById(code, { name: 'Late' }));
});

test('public rooms are listed, private rooms are not', async () => {
  const pub = await hostCreate({ isPrivate: false, roomName: 'Open table', targetScore: 49 });
  const priv = await hostCreate({ isPrivate: true, roomName: 'Secret table' });
  await new Promise((r) => setTimeout(r, 200));
  const res = await fetch(`${HTTP}/rooms`);
  const rooms: any[] = await res.json();
  const codes = rooms.map((r) => r.roomCode);
  assert.ok(codes.includes(pub.view().roomCode), 'public room should be listed');
  assert.ok(!codes.includes(priv.view().roomCode), 'private room must not be listed');
  const listed = rooms.find((r) => r.roomCode === pub.view().roomCode);
  assert.equal(listed.name, 'Open table');
  assert.equal(listed.targetScore, 49);
  assert.equal(listed.humans, 1);
  assert.equal(listed.status, 'lobby');
});

test('quick match pairs by target score', async () => {
  const mk = async (target: number, name: string) =>
    attach(await connect().joinOrCreate('callbreak', { name, targetScore: target }), false);
  const a = await mk(99, 'A');
  const b = await mk(99, 'B');
  const c = await mk(29, 'C');
  assert.equal(a.view().roomCode, b.view().roomCode);
  assert.notEqual(a.view().roomCode, c.view().roomCode);
  assert.equal(c.view().targetScore, 29);
});

test('only the host can start / configure; start needs 4 players or fillBots', async () => {
  const host = await hostCreate({ isPrivate: true }, false);
  const guest = await join(host.view().roomCode, 'Guest', false);

  guest.room.send('start', { fillBots: true });
  await waitFor(() => guest.errors.length > 0, 3000, 'not_host error');
  assert.equal(guest.errors[0].code, 'not_host');

  host.room.send('start', {});
  await waitFor(() => host.errors.length > 0, 3000, 'need_players error');
  assert.equal(host.errors[0].code, 'need_players');

  host.room.send('setTarget', { targetScore: 5 });
  await waitFor(() => host.errors.length > 1, 3000, 'bad_target error');
  assert.equal(host.errors[1].code, 'bad_target');

  host.room.send('setTarget', { targetScore: 59 });
  await waitFor(() => host.view().targetScore === 59, 3000, 'target change');
});

test('lobby: add/remove bots, host leaves -> host passes to next human', async () => {
  const host = await hostCreate({ isPrivate: true }, false);
  const guest = await join(host.view().roomCode, 'Guest', false);

  host.room.send('addBot');
  host.room.send('addBot');
  await waitFor(() => host.view().seats.filter((s) => s.isBot).length === 2, 3000, 'two bots');
  const botSeat = host.view().seats.find((s) => s.isBot)!.seat;
  host.room.send('removeBot', { seat: botSeat });
  await waitFor(() => host.view().seats.filter((s) => s.isBot).length === 1, 3000, 'one bot');

  await host.room.leave(true);
  await waitFor(() => guest.view().hostSeat === guest.view().mySeat, 3000, 'host transfer');
});

test('full game: 2 humans + 2 bots play to the end; scores consistent; hands private', async () => {
  const before = savedMatches.length;
  const host = await hostCreate({ isPrivate: true, targetScore: 29 });
  const guest = await join(host.view().roomCode, 'Guest');

  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().status !== 'lobby', 3000, 'game start');
  assert.equal(host.view().seats.filter((s) => s.isBot).length, 2);
  const early = host.view().game!;
  assert.equal(early.myHand.length, 13);
  assert.deepEqual(early.handCounts, [13, 13, 13, 13]);

  // A random game to 29 points takes ~17-25 rounds (~1.5 s each here), so 30 s was sometimes too tight.
  await waitFor(() => host.view().status === 'finished', 120000, 'game finished');
  const g = host.view().game!;
  assert.ok(g.winners && g.winners.length === 1);
  assert.ok(Math.max(...g.totals) >= 29);
  assert.equal(g.ranking!.length, 4);
  assert.deepEqual(g.totals, guest.view().game!.totals);

  await waitFor(() => savedMatches.length === before + 1, 3000, 'match saved');
  const saved = savedMatches[savedMatches.length - 1];
  assert.equal(saved.targetScore, 29);
  assert.equal(saved.players.filter((p) => p.isBot).length, 2);
  assert.equal(saved.players.filter((p) => !p.isBot).length, 2);
  assert.deepEqual(saved.winners, g.winners);

  // Rematch goes back to the lobby; only the host may ask for it.
  guest.room.send('rematch');
  await waitFor(() => guest.errors.some((e) => e.code === 'not_host'), 3000, 'guest rematch refused');
  host.room.send('rematch');
  await waitFor(() => host.view().status === 'lobby', 3000, 'back to lobby');
});

test('illegal moves are rejected with an error and the state stays valid', async () => {
  const host = await hostCreate({ isPrivate: true }, false);
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().status === 'bidding', 3000, 'bidding');
  // wait until it's the host's turn (bots bid instantly in fast mode)
  await waitFor(() => host.view().game!.turn === host.view().mySeat, 3000, 'host turn');
  host.room.send('bid', { bid: 99 });
  await waitFor(() => host.errors.length > 0, 3000, 'bid error');
  host.room.send('play', { suit: 'S', rank: 2 }); // not in playing phase
  await waitFor(() => host.errors.length > 1, 3000, 'play error');
  host.room.send('bid', { bid: 3 });
  await waitFor(() => host.view().game!.phase === 'playing' || host.view().game!.bids[host.view().mySeat] === 3, 3000, 'valid bid accepted');
});

test('idle human: timeout -> bot plays for them -> auto flag; game still finishes', async () => {
  const host = await hostCreate({ isPrivate: true, targetScore: 29 }, false); // never acts
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().seats[host.view().mySeat].auto, 15000, 'auto-play flag');
  await waitFor(() => host.view().status === 'finished', 60000, 'game finished without the human');
});

test('disconnect: seat is held, bot covers, player reconnects and keeps seat + hand', async () => {
  const host = await hostCreate({ isPrivate: true, targetScore: 99 });
  const guest = await join(host.view().roomCode, 'Guest');
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().status === 'playing', 5000, 'playing');

  const guestSeat = guest.view().mySeat;
  const handBefore = guest.view().game!.myHand.length;
  const beforeStates = guest.states;

  // Kill the socket without a clean leave.
  guest.room.connection.transport.ws.close(4001);

  await waitFor(() => host.view().seats[guestSeat].connected === false || guest.states > beforeStates + 3, 5000, 'drop noticed')
    .catch(() => undefined); // in fast mode the SDK may reconnect before we observe it

  // SDK auto-reconnects; the seat must come back as connected with the same private hand size or smaller.
  await waitFor(() => host.view().seats[guestSeat].connected === true, 10000, 'reconnected');
  guest.room.send('sync');
  await waitFor(() => guest.view().mySeat === guestSeat, 5000, 'same seat after reconnect');
  assert.ok(guest.view().game!.myHand.length <= handBefore);
  assert.equal(host.view().seats[guestSeat].name, 'Guest');
});

test('no-bid first round (production default): play starts at once with no bids, round 2 has bidding', async () => {
  config.noBidRounds = 1;
  try {
    const host = await hostCreate({ isPrivate: true, targetScore: 29 }, true);
    host.room.send('start', { fillBots: true });
    await waitFor(() => host.view().status === 'playing', 3000, 'round 1 goes straight to playing');
    assert.ok(host.view().game!.bids.every((b) => b === null));
    assert.equal(host.view().game!.round, 1);
    await waitFor(() => host.view().game!.round >= 2, 30000, 'round 2 reached');
    const r1 = host.view().game!.history[0];
    assert.deepEqual(r1.bids, r1.tricks);
    await waitFor(() => host.view().game!.phase === 'bidding' || host.view().game!.round > 2 || host.view().status === 'finished', 5000, 'round 2 bidding');
  } finally {
    config.noBidRounds = 0;
  }
});

test('dealing phase: cards are dealt, everyone looks at them, then bidding starts', async () => {
  config.dealMs = 150;
  config.viewMs = 250;
  try {
    const host = await hostCreate({ isPrivate: true, targetScore: 29 }, false);
    host.room.send('start', { fillBots: true });
    await waitFor(() => host.view().status === 'dealing', 3000, 'dealing phase');
    const v = host.view();
    assert.equal(v.game!.myHand.length, 13); // the hand is already there, the client animates it
    assert.equal(v.dealMs, 150);
    assert.equal(v.viewMs, 250);
    assert.ok(v.dealAt !== null && v.dealAt <= v.serverTime);
    host.room.send('bid', { bid: 2 }); // too early
    await waitFor(() => host.errors.length > 0, 2000, 'early bid rejected');
    assert.equal(host.view().status, 'dealing');
    await waitFor(() => host.view().status === 'bidding', 3000, 'bidding after the look time');
    assert.equal(host.view().dealAt, null);
  } finally {
    config.dealMs = 0;
    config.viewMs = 0;
  }
});

test('ready button: all humans ready ends the look-at-cards wait early; too-early ready is ignored', async () => {
  config.dealMs = 200;
  config.viewMs = 20000; // would take 20s without the ready button
  try {
    const host = await hostCreate({ isPrivate: true, targetScore: 29 }, false);
    host.room.send('start', { fillBots: true });
    await waitFor(() => host.view().status === 'dealing', 3000, 'dealing phase');
    host.room.send('ready'); // still dealing the cards: ignored
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(host.view().seats[host.view().mySeat].ready, false);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(host.view().status, 'dealing');
    host.room.send('ready');
    await waitFor(() => host.view().status === 'bidding', 3000, 'bidding right after ready');
  } finally {
    config.dealMs = 0;
    config.viewMs = 0;
  }
});

test('minimum call is 2: a human who does not bid in time gets exactly 2', async () => {
  const host = await hostCreate({ isPrivate: true, targetScore: 29 }, false); // never bids
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().status === 'bidding', 3000, 'bidding');
  assert.equal(host.view().game!.minBid, 2);
  const me = host.view().mySeat;
  await waitFor(() => host.view().game!.bids[me] !== null || host.view().game!.phase === 'playing', 5000, 'timeout bid');
  const g = host.view().game!;
  const mine = g.phase === 'playing' ? undefined : g.bids[me];
  if (mine !== undefined) assert.equal(mine, 2);
  await waitFor(() => host.view().game!.history.length > 0, 30000, 'a round finished');
  assert.equal(host.view().game!.history[0].bids[me], 2);
  assert.ok(host.view().game!.history[0].bids.every((b) => b >= 2));
});

test('avatars: valid JPEG data URIs reach every player, junk is dropped, changes propagate', async () => {
  const good = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof';
  const host = await hostCreate({ isPrivate: true }, false);
  const got: Record<string, (string | null)[]> = {};
  host.room.onMessage('avatars', (m: any) => (got.host = m.avatars));
  const code = host.view().roomCode;

  const bela = await attach(await connect().joinById(code, { name: 'Bela', avatar: good }), false);
  const evil = await attach(await connect().joinById(code, { name: 'Evil', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }), false);
  bela.room.onMessage('avatars', (m: any) => (got.bela = m.avatars));
  bela.room.send('sync');

  await waitFor(() => got.host?.[bela.view().mySeat] === good, 3000, 'host sees Bela photo');
  await waitFor(() => got.bela?.[bela.view().mySeat] === good, 3000, 'Bela sees own photo');
  assert.equal(got.host[evil.view().mySeat], null, 'non-JPEG avatar is dropped');
  assert.equal(got.host[host.view().mySeat], null, 'no avatar -> null');

  // Changing and removing a photo mid-room is broadcast.
  host.room.send('setAvatar', { avatar: good });
  await waitFor(() => got.bela?.[host.view().mySeat] === good, 3000, 'photo change propagates');
  host.room.send('setAvatar', { avatar: 'x'.repeat(config.maxAvatarChars + 5) });
  await waitFor(() => got.bela?.[host.view().mySeat] === null, 3000, 'oversized photo is removed');
});

/* ------------------------------ voice chat (Agora tokens) ------------------------------ */

const FAKE_APP_ID = '0123456789abcdef0123456789abcdef'; // Agora wants 32 hex characters
const FAKE_CERT = 'fedcba9876543210fedcba9876543210';

/** Sends `voiceToken` and returns the next `voice` message that arrives. */
async function askVoice(p: TestPlayer): Promise<VoiceMessage> {
  const n = p.voices.length;
  p.room.send('voiceToken');
  await waitFor(() => p.voices.length > n, 3000, 'voice message');
  return p.voices[n];
}

/** Runs `fn` with voice configured (fake keys, no rate limit unless overridden), then restores everything. */
async function withVoice(overrides: Partial<typeof config>, fn: () => Promise<void>): Promise<void> {
  const saved = {
    agoraAppId: config.agoraAppId,
    agoraAppCertificate: config.agoraAppCertificate,
    voiceEnabled: config.voiceEnabled,
    voiceTokenSeconds: config.voiceTokenSeconds,
    voiceTokenMinGapMs: config.voiceTokenMinGapMs,
  };
  Object.assign(config, {
    agoraAppId: FAKE_APP_ID,
    agoraAppCertificate: FAKE_CERT,
    voiceEnabled: true,
    voiceTokenSeconds: 3600,
    voiceTokenMinGapMs: 0,
    ...overrides,
  });
  try {
    await fn();
  } finally {
    Object.assign(config, saved);
    setVoiceTokenBuilder(undefined);
  }
}

test('voice: seated humans get a token for channel cb-<room> with uid = seat + 1; the certificate never leaves the server', async () => {
  await withVoice({ voiceTokenSeconds: 120 }, async () => {
    const calls: VoiceTokenRequest[] = [];
    setVoiceTokenBuilder((req) => {
      calls.push(req);
      return `fake.${req.channel}.${req.uid}`;
    });
    const host = await hostCreate({ isPrivate: true }, false);
    const code = host.view().roomCode;
    const guest = await join(code, 'Guest', false);

    const t0 = Date.now();
    const a = await askVoice(host);
    const b = await askVoice(guest);
    assert.ok(a.enabled && b.enabled);
    assert.equal(a.channel, `cb-${code}`);
    assert.equal(b.channel, `cb-${code}`);
    assert.equal(a.uid, host.view().mySeat + 1);
    assert.equal(b.uid, guest.view().mySeat + 1);
    assert.notEqual(a.uid, b.uid);
    assert.ok(a.uid >= 1 && a.uid <= 4 && b.uid >= 1 && b.uid <= 4);
    assert.equal(a.appId, FAKE_APP_ID);
    assert.equal(a.token, `fake.cb-${code}.${a.uid}`);
    assert.ok(a.expiresAt >= t0 + 120_000 && a.expiresAt <= Date.now() + 120_000, 'expiry is now + the configured lifetime');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].appCertificate, FAKE_CERT);
    assert.equal(calls[0].ttlSeconds, 120);
    assert.ok(!JSON.stringify([a, b]).includes(FAKE_CERT), 'the App Certificate must never be sent to a client');

    // Voice keeps working once the game is running (same seat, same uid).
    host.room.send('start', { fillBots: true });
    await waitFor(() => host.view().status !== 'lobby', 3000, 'game start');
    const c = await askVoice(host);
    assert.ok(c.enabled);
    assert.equal(c.uid, a.uid);
  });
});

test('voice: off without keys, without the certificate, or with VOICE_ENABLED=0; the game is unaffected', async () => {
  const off = { enabled: false, reason: 'disabled' };
  const host = await hostCreate({ isPrivate: true }, false);

  await withVoice({ agoraAppId: null, agoraAppCertificate: null }, async () => {
    assert.deepEqual(await askVoice(host), off);
  });
  await withVoice({ agoraAppCertificate: null }, async () => {
    assert.deepEqual(await askVoice(host), off);
  });
  await withVoice({ agoraAppId: null }, async () => {
    assert.deepEqual(await askVoice(host), off);
  });
  await withVoice({ voiceEnabled: false }, async () => {
    const calls: VoiceTokenRequest[] = [];
    setVoiceTokenBuilder((req) => (calls.push(req), 'fake'));
    assert.deepEqual(await askVoice(host), off);
    assert.equal(calls.length, 0, 'no token is built while the kill switch is on');
  });

  const states = host.states;
  host.room.send('sync');
  await waitFor(() => host.states > states, 3000, 'state still flows');
  assert.equal(host.errors.length, 0);
});

test('voice: a client asking too often is rate-limited (per client); it is allowed again later', async () => {
  await withVoice({ voiceTokenMinGapMs: 300 }, async () => {
    setVoiceTokenBuilder(() => 'fake');
    const host = await hostCreate({ isPrivate: true }, false);
    const guest = await join(host.view().roomCode, 'Guest', false);

    assert.equal((await askVoice(host)).enabled, true);
    assert.deepEqual(await askVoice(host), { enabled: false, reason: 'rate_limited' });
    assert.equal((await askVoice(guest)).enabled, true, 'the limit is per client');

    await new Promise((r) => setTimeout(r, 350));
    assert.equal((await askVoice(host)).enabled, true, 'allowed again after the gap');
  });
});

test('voice: a client with no human seat (released, or taken over by a bot) gets no token', async () => {
  await withVoice({}, async () => {
    const calls: VoiceTokenRequest[] = [];
    setVoiceTokenBuilder((req) => (calls.push(req), 'fake'));
    const host = await hostCreate({ isPrivate: true }, false);
    const room: any = matchMaker.getLocalRoomById(host.view().roomCode);
    const seat = room.seats[host.view().mySeat];
    const sessionId = seat.sessionId;

    seat.sessionId = null; // the room no longer knows this connection
    assert.deepEqual(await askVoice(host), { enabled: false, reason: 'not_seated' });

    seat.sessionId = sessionId;
    seat.isBot = true; // a bot sits here now
    assert.deepEqual(await askVoice(host), { enabled: false, reason: 'not_seated' });
    assert.equal(calls.length, 0, 'no token was built for either request');

    seat.isBot = false;
    assert.equal((await askVoice(host)).enabled, true, 'back to a normal human seat');
  });
});

test('voice: the real Agora builder issues a token; malformed keys fail soft and the room keeps working', async () => {
  await withVoice({}, async () => {
    const host = await hostCreate({ isPrivate: true }, false); // no fake builder: the real one runs
    const m = await askVoice(host);
    assert.ok(m.enabled);
    assert.match(m.token, /^007[A-Za-z0-9+/=]+$/, 'Agora token v007');
    assert.equal(m.channel, `cb-${host.view().roomCode}`);
  });

  await withVoice({ agoraAppId: 'not-a-real-app-id' }, async () => {
    const host = await hostCreate({ isPrivate: true }, false);
    assert.deepEqual(await askVoice(host), { enabled: false, reason: 'disabled' }); // Agora's builder returns '' for bad keys
    const states = host.states;
    host.room.send('sync');
    await waitFor(() => host.states > states, 3000, 'state still flows');
  });
});
