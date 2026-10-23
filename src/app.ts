import { defineServer, defineRoom, matchMaker, WebSocketTransport } from 'colyseus';
import { CallBreakRoom } from './rooms/CallBreakRoom.js';
import { PokerRoom } from './rooms/PokerRoom.js';
import { TwentyNineRoom } from './rooms/TwentyNineRoom.js';

const GAMES = ['callbreak', 'twentynine', 'poker'] as const;

/** The Colyseus server definition (separate from `listen` so tests can start it on any port). */
export const createServer = () =>
  defineServer({
    // Colyseus caps a client message at 4 KB by default; a profile photo (setAvatar) is bigger than that.
    transport: new WebSocketTransport({ maxPayload: 32 * 1024 }),
    rooms: {
      // Quick match only pairs players who picked the same target score.
      callbreak: defineRoom(CallBreakRoom).filterBy(['targetScore']),
      // 29: quick match pairs players who picked the same game-points target.
      twentynine: defineRoom(TwentyNineRoom).filterBy(['targetScore']),
      // Poker: quick match pairs players who picked the same starting stack.
      poker: defineRoom(PokerRoom).filterBy(['startingChips']),
    },
    express: (app) => {
      // Free hosts ping this to check the server is alive.
      app.get('/health', (_req, res) => {
        res.json({ ok: true, uptime: Math.round(process.uptime()) });
      });

      // Public lobby: rooms that are not private, not locked (game not started) and have a free seat.
      // `?game=twentynine|poker` picks the game; without it the list is Call Break only (what older apps expect).
      app.get('/rooms', async (req, res) => {
        try {
          const asked = typeof req.query.game === 'string' ? req.query.game : 'callbreak';
          const name = (GAMES as readonly string[]).includes(asked) ? asked : 'callbreak';
          const rooms = await matchMaker.query({ name, private: false, locked: false });
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
