/**
 * Elo rating + ladder persistence, modeled on Pokémon Showdown's local
 * ladder (server/ladders-local.ts): dynamic K-factor, rating floor 1000,
 * stored in a simple JSON file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LadderEntry {
  userid: string;
  name: string;
  elo: number;
  wins: number;
  losses: number;
  ties: number;
  /** Trainer avatar sprite name (cosmetic). */
  avatar?: string;
}

export const STARTING_ELO = 1000;

/**
 * Showdown's Elo update. `score` is 1 (win), 0 (loss), or 0.5 (tie).
 * Below 1200 the K-factor is asymmetric (climb fast, fall slow) so new
 * players converge quickly; it tightens as ratings rise. Floor 1000.
 */
export function calculateElo(oldElo: number, score: number, foeElo: number): number {
  let K = 50;
  if (oldElo < 1200) {
    if (score < 0.5) {
      K = 10 + ((oldElo - 1000) * 40) / 200;
    } else if (score > 0.5) {
      K = 90 - ((oldElo - 1000) * 40) / 200;
    }
  } else if (oldElo > 1350 && oldElo <= 1600) {
    K = 40;
  } else if (oldElo > 1600) {
    K = 32;
  }
  const expected = 1 / (1 + 10 ** ((foeElo - oldElo) / 400));
  return Math.max(oldElo + K * (score - expected), 1000);
}

export class LadderStore {
  private entries = new Map<string, LadderEntry>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (entry && typeof entry.userid === 'string') {
            this.entries.set(entry.userid, {
              userid: entry.userid,
              name: String(entry.name ?? entry.userid),
              elo: Number(entry.elo) || STARTING_ELO,
              wins: Number(entry.wins) || 0,
              losses: Number(entry.losses) || 0,
              ties: Number(entry.ties) || 0,
            });
          }
        }
      }
    } catch { /* first run: empty ladder */ }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.entries.values()], null, 1));
  }

  /** Current rating (STARTING_ELO for unrated players). */
  getElo(userid: string): number {
    return this.entries.get(userid)?.elo ?? STARTING_ELO;
  }

  get(userid: string): LadderEntry | undefined {
    return this.entries.get(userid);
  }

  private ensure(userid: string, name: string): LadderEntry {
    let entry = this.entries.get(userid);
    if (!entry) {
      entry = { userid, name, elo: STARTING_ELO, wins: 0, losses: 0, ties: 0 };
      this.entries.set(userid, entry);
    }
    entry.name = name; // keep display casing fresh
    return entry;
  }

  /**
   * Apply a rated result. `score` is p1's result (1/0/0.5).
   * Returns both players' before/after ratings, already persisted.
   */
  reportResult(
    p1: { userid: string; name: string; avatar?: string },
    p2: { userid: string; name: string; avatar?: string },
    score: number,
  ): { p1: { before: number; after: number }; p2: { before: number; after: number } } {
    const e1 = this.ensure(p1.userid, p1.name);
    const e2 = this.ensure(p2.userid, p2.name);
    if (p1.avatar) e1.avatar = p1.avatar;
    if (p2.avatar) e2.avatar = p2.avatar;
    const before1 = e1.elo;
    const before2 = e2.elo;
    e1.elo = Math.round(calculateElo(before1, score, before2));
    e2.elo = Math.round(calculateElo(before2, 1 - score, before1));
    if (score === 0.5) {
      e1.ties++;
      e2.ties++;
    } else if (score > 0.5) {
      e1.wins++;
      e2.losses++;
    } else {
      e1.losses++;
      e2.wins++;
    }
    this.save();
    return {
      p1: { before: before1, after: e1.elo },
      p2: { before: before2, after: e2.elo },
    };
  }

  top(n = 25): LadderEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.elo - a.elo || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, n);
  }
}
