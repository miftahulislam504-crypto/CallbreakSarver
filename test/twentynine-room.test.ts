import './env.js'; // keep first: sets fast timers before config loads
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from 'colyseus';
import { Client } from '@colyseus/sdk';
import { createServer } from '../src/app.js';
import type { TNRoomView } from '../src/rooms/TwentyNineRoom.js';
import { setMatchStore, type MatchResult } from '../src/services/matchStore.js';

const PORT = 2900 + (process.pid % 300);
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

interface TestPlayer {
  room: any;
  view: () => TNRoomView;
  errors: { code: string; message: string }[];
}

/** A human who plays simply but legally: passes (or takes the forced minimum), picks spades, plays the first legal card. */
async function attach(room: any, autoplay: boolean): Promise<TestPlayer> {
  openRooms.push(room);
  let latest: TNRoomView | null = null;
  const p: TestPlayer = { room, view: () => latest as TNRoomView, errors: [] };
  room.onMessage('error', (e: any) => p.errors.push(e));
  room.onMessage('state', (s: TNRoomView) => {
    latest = s;
    const g = s.game;
    if (!autoplay || !g || g.turn !== s.mySeat) return;
    if (g.phase === 'bidding') room.send('bid', { bid: g.forcedBid ? g.minBid : 0 });
    else if (g.phase === 'trump') room.send('trump', { suit: 'S' });
    else if (g.phase === 'playing') {
      if (g.canReveal) room.send('reveal');
      else if (g.legal.length > 0) room.send('play', g.legal[0]);
    }
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
  attach(await connect().create('twentynine', { name: 'Host', ...opts }), autoplay);
const join = async (code: string, name: string, autoplay = true) =>
  attach(await connect().joinById(code, { name }), autoplay);

test('29: create room -> code, settings in the view; a bad target falls back to the default', async () => {
  const host = await hostCreate({ isPrivate: true, targetScore: 5 });
  const v = host.view();
  assert.equal(v.gameId, 'twentynine');
  assert.match(v.roomCode, /^[A-Z2-9]{6}$/);
  assert.equal(v.status, 'lobby');
  assert.equal(v.targetScore, 5);
  assert.equal(v.seats.length, 4);
  assert.equal(v.game, null);

  const other = await hostCreate({ targetScore: 9999 });
  assert.equal(other.view().targetScore, 3);
});

test('29: public rooms are listed under ?game=twentynine and not in the default (Call Break) list', async () => {
  const host = await hostCreate({ roomName: 'Tonight 29' });
  const code = host.view().roomCode;
  const list = (await (await fetch(`${HTTP}/rooms?game=twentynine`)).json()) as any[];
  assert.ok(list.some((r) => r.roomCode === code && r.name === 'Tonight 29' && r.game === 'twentynine'));
  const callbreak = (await (await fetch(`${HTTP}/rooms`)).json()) as any[];
  assert.ok(!callbreak.some((r) => r.roomCode === code));
});

test('29: only the host starts; start needs 4 players or fillBots; target changes are host-only', async () => {
  const host = await hostCreate({}, false);
  const guest = await join(host.view().roomCode, 'Guest', false);
  guest.room.send('start', { fillBots: true });
  guest.room.send('setTarget', { targetScore: 7 });
  await waitFor(() => guest.errors.length >= 2, 3000, 'two not_host errors');
  assert.ok(guest.errors.every((e) => e.code === 'not_host'));

  host.room.send('start', {});
  await waitFor(() => host.errors.some((e) => e.code === 'need_players'), 3000, 'need_players');
  host.room.send('setTarget', { targetScore: 7 });
  await waitFor(() => host.view().targetScore === 7, 3000, 'target 7');
});

test('29: a human plus three bots play a whole game; hands stay private; the match is saved', async () => {
  const host = await hostCreate({ targetScore: 2 });
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().status !== 'lobby', 3000, 'game started');
  await waitFor(() => host.view().status === 'finished', 60000, 'game finished');

  const v = host.view();
  assert.ok(v.game);
  assert.ok(v.game!.winners && v.game!.winners.length >= 2);
  assert.equal(v.game!.ranking!.length, 4);
  assert.equal(v.game!.myHand.length, 0);
  const saved = savedMatches.find((m) => m.roomCode === v.roomCode);
  assert.ok(saved, 'match saved');
  assert.equal(saved!.game, 'twentynine');
  assert.equal(saved!.players.length, 4);
  assert.equal(saved!.rounds.length, v.game!.history.length);
});

test('29: a move out of turn is rejected and the state stays valid', async () => {
  const host = await hostCreate({ targetScore: 2 }, false);
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().game?.phase === 'dealing' || host.view().game?.phase === 'bidding', 3000, 'dealt');
  host.room.send('play', { suit: 'S', rank: 14 });
  host.room.send('trump', { suit: 'H' });
  await waitFor(() => host.errors.length >= 2, 3000, 'errors');
  assert.ok(host.errors.every((e) => e.code === 'illegal'));
  assert.equal(host.view().game!.myHand.length, 4);
});
