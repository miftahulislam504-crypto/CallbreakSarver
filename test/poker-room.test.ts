import './env.js'; // keep first: sets fast timers before config loads
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from 'colyseus';
import { Client } from '@colyseus/sdk';
import { createServer } from '../src/app.js';
import type { PokerRoomView } from '../src/rooms/PokerRoom.js';
import { setMatchStore, type MatchResult } from '../src/services/matchStore.js';

const PORT = 3250 + (process.pid % 300);
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
  view: () => PokerRoomView;
  errors: { code: string; message: string }[];
}

/** A calling station: checks when free, otherwise calls. */
async function attach(room: any, autoplay: boolean): Promise<TestPlayer> {
  openRooms.push(room);
  let latest: PokerRoomView | null = null;
  const p: TestPlayer = { room, view: () => latest as PokerRoomView, errors: [] };
  room.onMessage('error', (e: any) => p.errors.push(e));
  room.onMessage('state', (s: PokerRoomView) => {
    latest = s;
    const g = s.game;
    if (!autoplay || !g || g.turn !== s.mySeat || !g.actions) return;
    room.send('act', { type: g.actions.canCheck ? 'check' : 'call' });
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
  attach(await connect().create('poker', { name: 'Host', ...opts }), autoplay);

test('poker: create room -> 6 seats, starting chips in the view; a bad value falls back to 1000', async () => {
  const host = await hostCreate({ startingChips: 2000 });
  const v = host.view();
  assert.equal(v.gameId, 'poker');
  assert.equal(v.status, 'lobby');
  assert.equal(v.seats.length, 6);
  assert.equal(v.startingChips, 2000);
  assert.equal(v.actionSeconds, Number(process.env.CB_POKER_ACTION_SECONDS));

  const other = await hostCreate({ startingChips: 123 });
  assert.equal(other.view().startingChips, 1000);
});

test('poker: public rooms are listed under ?game=poker', async () => {
  const host = await hostCreate({ roomName: 'High stakes' });
  const list = (await (await fetch(`${HTTP}/rooms?game=poker`)).json()) as any[];
  assert.ok(list.some((r) => r.roomCode === host.view().roomCode && r.game === 'poker' && r.maxClients === 6));
});

test('poker: start needs 2 players or fillBots; chips are host-only and validated', async () => {
  const host = await hostCreate({}, false);
  host.room.send('start', {});
  await waitFor(() => host.errors.some((e) => e.code === 'need_players'), 3000, 'need_players');
  host.room.send('setChips', { startingChips: 777 });
  await waitFor(() => host.errors.some((e) => e.code === 'bad_chips'), 3000, 'bad_chips');
  host.room.send('setChips', { startingChips: 5000 });
  await waitFor(() => host.view().startingChips === 5000, 3000, 'chips 5000');
  host.room.send('addBot');
  await waitFor(() => host.view().seats.filter((s) => s.occupied).length === 2, 3000, 'a bot sat down');
});

test('poker: a human plus bots play to a winner; chips are conserved; the match is saved', async () => {
  const host = await hostCreate({ startingChips: 500 });
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().status !== 'lobby', 3000, 'game started');
  assert.equal(host.view().seats.filter((s) => s.occupied).length, 4);
  await waitFor(() => host.view().status === 'finished', 60000, 'game finished');

  const g = host.view().game!;
  assert.ok(g.winners && g.winners.length >= 1);
  assert.equal(g.players.reduce((a, p) => a + p.chips, 0), 4 * 500);
  const saved = savedMatches.find((m) => m.roomCode === host.view().roomCode);
  assert.ok(saved, 'match saved');
  assert.equal(saved!.game, 'poker');
  assert.equal(saved!.players.length, 4);
});

test('poker: other players hole cards never reach my view; an out-of-turn action is rejected', async () => {
  const host = await hostCreate({}, false);
  host.room.send('start', { fillBots: true });
  await waitFor(() => host.view().game?.phase === 'betting', 3000, 'a hand is being played');
  const g = host.view().game!;
  assert.equal(g.myHole.length, 2);
  assert.ok(g.players.every((p) => p.shown === null));
  if (g.turn !== host.view().mySeat) {
    host.room.send('act', { type: 'check' });
    await waitFor(() => host.errors.some((e) => e.code === 'illegal'), 3000, 'illegal');
  }
});
