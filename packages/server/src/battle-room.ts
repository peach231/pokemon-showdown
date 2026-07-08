import { serializeServerFrame } from '@simple-showdown/protocol';
import type { Battle, SideID } from '@simple-showdown/sim';
import type { TeamSpec } from './random-team.js';
import type { User } from './user.js';

/** One battle + its players/spectators; bridges the sim to the sockets. */
export class BattleRoom {
  readonly id: string;
  readonly battle: Battle;
  readonly players: { p1: User; p2: User };
  readonly spectators = new Set<User>();
  ended = false;
  /** Rated (ranked-search) battles update the ladder when they end. */
  rated = false;
  ratingReported = false;
  /** Which side the practice bot plays, if any. */
  botSide: SideID | null = null;
  /** Bot difficulty (hard = picks the strongest effective move). */
  botHard = true;
  /** Original team specs, kept for rematches and restart persistence. */
  teams: { p1: TeamSpec[]; p2: TeamSpec[] } = { p1: [], p2: [] };
  /** Players who clicked Rematch after the battle ended. */
  rematchVotes = new Set<SideID>();
  /** Seed string the teams were generated from (for restart restore). */
  teamSeed = '';
  /** ALL inputs (human, bot, timer) recorded for restart replay. */
  persistedInputs: string[] = [];
  /** Set by the server: persists this room to disk after each input. */
  onPersist: (() => void) | null = null;

  /**
   * The single entry point for battle choices — human, bot, or timer.
   * Records successful inputs so a restarted server can replay them exactly.
   */
  submitChoice(side: SideID, input: string): string | null {
    const err = this.battle.choose(side, input);
    if (err === null) {
      this.persistedInputs.push(`>${side} ${input}`);
      this.onPersist?.();
    }
    return err;
  }

  constructor(id: string, battle: Battle, p1: User, p2: User) {
    this.id = id;
    this.battle = battle;
    this.players = { p1, p2 };
  }

  sideOf(user: User): SideID | null {
    if (this.players.p1 === user) return 'p1';
    if (this.players.p2 === user) return 'p2';
    return null;
  }

  broadcast(lines: string[]): void {
    for (const user of [this.players.p1, this.players.p2, ...this.spectators]) {
      user.send(serializeServerFrame(this.id, lines));
    }
  }
}
