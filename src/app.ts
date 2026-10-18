import { defineServer, defineRoom, matchMaker } from 'colyseus';
import { CallBreakRoom } from './rooms/CallBreakRoom.js';

/** The Colyseus server definition (separate from `listen` so tests can start it on any port). */
export const createServer = () =>
  defineServer({
    rooms: {
      // Quick match only pairs players who picked the same target score.
      callbreak: defineRoom(CallBreakRoom).filterBy(['targetScore']),
    },
    express: (app) => {
      // Free hosts ping this to check the server is alive.
      app.get('/health', (_req, res) => {
        res.json({ ok: true, uptime: Math.round(process.uptime()) });
      });

      // Public lobby: rooms that are not private, not locked (game not started) and have a free seat.
      app.get('/rooms', async (_req, res) => {
        try {
          const rooms = await matchMaker.query({ name: 'callbreak', private: false, locked: false });
          res.json(
            rooms
              .filter((r) => r.clients < r.maxClients)
              .map((r) => ({
                roomCode: r.roomId,
                clients: r.clients,
                maxClients: r.maxClients,
                ...(r.metadata as object),
              })),
          );
        } catch (err) {
          console.error('[rooms] listing failed', err);
          res.status(500).json({ error: 'listing_failed' });
        }
      });
    },
  });
