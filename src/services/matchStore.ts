export interface MatchPlayerResult {
  seat: number;
  uid: string | null;
  name: string;
  /** True if this seat was a bot for the whole match. */
  isBot: boolean;
  /** A human who left mid-match (a bot finished their seat). */
  leftEarly: boolean;
  /** Final total: points (Call Break), game points of the team (29) or chips (poker). */
  total: number;
  /** 1 = winner. Tied seats share a rank. */
  rank: number;
}

export interface MatchResult {
  /** Which game this was; absent on matches saved by older code (Call Break). */
  game?: 'callbreak' | 'twentynine' | 'poker';
  roomCode: string;
  /** Call Break: target score. 29: game points to win. Poker: starting chips. */
  targetScore: number;
  startedAt: number;
  endedAt: number;
  players: MatchPlayerResult[];
  winners: number[];
  /** Per-round results as the game's engine records them (Call Break / 29); empty for poker. */
  rounds: unknown[];
}

/**
 * Where finished matches go. Phase 5 adds a Firestore implementation
 * (match history, leaderboard, player stats). Until then results are logged.
 */
export interface MatchStore {
  saveMatch(result: MatchResult): Promise<void>;
}

export class ConsoleMatchStore implements MatchStore {
  async saveMatch(result: MatchResult): Promise<void> {
    const line = result.players.map((p) => `${p.name}${p.isBot ? ' (bot)' : ''}: ${p.total}`).join(', ');
    console.log(`[match] ${result.roomCode} target ${result.targetScore} finished in ${result.rounds.length} rounds -> ${line}`);
  }
}

let store: MatchStore = new ConsoleMatchStore();
export const setMatchStore = (s: MatchStore): void => {
  store = s;
};
export const getMatchStore = (): MatchStore => store;
