/**
 * Elo rating + ladder, modeled on Pokémon Showdown's local ladder
 * (dynamic K-factor, rating floor 1000), backed by libSQL (Turso in
 * production, local SQLite file in dev — see db.ts).
 *
 * Reads (matchmaking, ladder tab) come from an in-memory cache loaded at
 * boot; writes go through to the database asynchronously. Legacy
 * ladder.json files are imported once, then renamed.
 */
import * as fs from 'node:fs';
import type { Client } from './db.js';

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
  private db: Client;
  private legacyFile: string | undefined;

  constructor(db: Client, legacyFile?: string) {
    this.db = db;
    this.legacyFile = legacyFile;
  }

  /** Create the table and warm the cache. Call once at boot. */
  async init(): Promise<void> {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS ladder (
      userid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      elo INTEGER NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      ties INTEGER NOT NULL DEFAULT 0,
      avatar TEXT
    )`);
    const rows = await this.db.execute('SELECT * FROM ladder');
    for (const row of rows.rows) {
      const entry: LadderEntry = {
        userid: String(row['userid']),
        name: String(row['name']),
        elo: Number(row['elo']),
        wins: Number(row['wins']),
        losses: Number(row['losses']),
        ties: Number(row['ties']),
        avatar: row['avatar'] ? String(row['avatar']) : undefined,
      };
      this.entries.set(entry.userid, entry);
    }
    await this.importLegacyFile();
  }

  private async importLegacyFile(): Promise<void> {
    if (!this.legacyFile || this.entries.size > 0) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      if (Array.isArray(raw)) {
        for (const e of raw) {
          if (!e || typeof e.userid !== 'string') continue;
          const entry: LadderEntry = {
            userid: e.userid,
            name: String(e.name ?? e.userid),
            elo: Number(e.elo) || STARTING_ELO,
            wins: Number(e.wins) || 0,
            losses: Number(e.losses) || 0,
            ties: Number(e.ties) || 0,
            avatar: e.avatar ? String(e.avatar) : undefined,
          };
          this.entries.set(entry.userid, entry);
          await this.persistNow(entry);
        }
        fs.renameSync(this.legacyFile, `${this.legacyFile}.migrated`);
        console.log(`ladder: imported ${this.entries.size} from legacy JSON`);
      }
    } catch { /* no legacy file */ }
  }

  private async persistNow(entry: LadderEntry): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO ladder (userid, name, elo, wins, losses, ties, avatar)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [entry.userid, entry.name, entry.elo, entry.wins, entry.losses, entry.ties, entry.avatar ?? null],
    });
  }

  private persist(entry: LadderEntry): void {
    this.persistNow(entry).catch((err) => console.error('ladder persist failed:', err));
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
   * Returns both players' before/after ratings; persisted write-through.
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
    this.persist(e1);
    this.persist(e2);
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
