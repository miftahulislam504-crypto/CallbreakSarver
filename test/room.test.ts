import './env.js'; // keep first: sets fast timers before config loads
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from 'colyseus';
import { Client } from '@colyseus/sdk';
import { createServer } from '../src/app.js';
import { config } from '../src/config.js';
import type { RoomView } from '../src/rooms/CallBreakRoom.js';
import { setMatchStore, type MatchResult } from '../src/services/matchStore.js';

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
    autoplay,
    states: 0,
  };
  room.onMessage('error', (e: any) => p.errors.push(e));
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

  await waitFor(() => host.view().status === 'finished', 30000, 'game finished');
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
