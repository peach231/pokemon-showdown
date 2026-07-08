/**
 * Password accounts + session tokens, backed by libSQL (Turso in production,
 * local SQLite file in dev — see db.ts).
 *
 * - Passwords are scrypt-hashed (Node built-in) with a per-account salt;
 *   comparison is constant-time.
 * - Logging in issues a session token the client stores in localStorage —
 *   closing the tab and re-entering resumes the identity. 90-day expiry.
 * - Reads are served from an in-memory cache loaded at boot; writes go
 *   through to the database asynchronously.
 * - Legacy accounts.json files are imported once, then renamed.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { Client } from './db.js';

const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TOKENS_PER_ACCOUNT = 10; // one per device/browser, pruned oldest

interface Account {
  userid: string;
  name: string;
  salt: string;
  passHash: string;
  tokens: { token: string; expires: number }[];
  createdAt: number;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export class AccountStore {
  private accounts = new Map<string, Account>();
  private db: Client;
  /** Optional legacy JSON file to import on first run. */
  private legacyFile: string | undefined;

  constructor(db: Client, legacyFile?: string) {
    this.db = db;
    this.legacyFile = legacyFile;
  }

  /** Create the table and warm the cache. Call once at boot. */
  async init(): Promise<void> {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS accounts (
      userid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      salt TEXT NOT NULL,
      passhash TEXT NOT NULL,
      tokens TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`);
    const rows = await this.db.execute('SELECT * FROM accounts');
    for (const row of rows.rows) {
      const account: Account = {
        userid: String(row['userid']),
        name: String(row['name']),
        salt: String(row['salt']),
        passHash: String(row['passhash']),
        tokens: JSON.parse(String(row['tokens'] ?? '[]')),
        createdAt: Number(row['created_at']),
      };
      this.accounts.set(account.userid, account);
    }
    await this.importLegacyFile();
  }

  /** One-time import of the old accounts.json (pre-Turso format). */
  private async importLegacyFile(): Promise<void> {
    if (!this.legacyFile || this.accounts.size > 0) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      if (Array.isArray(raw)) {
        for (const acc of raw) {
          if (!acc || typeof acc.userid !== 'string' || typeof acc.passHash !== 'string') continue;
          const account: Account = {
            userid: acc.userid,
            name: String(acc.name ?? acc.userid),
            salt: String(acc.salt),
            passHash: String(acc.passHash),
            tokens: Array.isArray(acc.tokens) ? acc.tokens : [],
            createdAt: Number(acc.createdAt) || Date.now(),
          };
          this.accounts.set(account.userid, account);
          await this.persistNow(account);
        }
        fs.renameSync(this.legacyFile, `${this.legacyFile}.migrated`);
        console.log(`accounts: imported ${this.accounts.size} from legacy JSON`);
      }
    } catch { /* no legacy file */ }
  }

  private async persistNow(account: Account): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO accounts (userid, name, salt, passhash, tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [account.userid, account.name, account.salt, account.passHash,
        JSON.stringify(account.tokens), account.createdAt],
    });
  }

  private persist(account: Account): void {
    this.persistNow(account).catch((err) => console.error('accounts persist failed:', err));
  }

  isRegistered(userid: string): boolean {
    return this.accounts.has(userid);
  }

  /** Create an account; returns a session token or an error string. */
  register(userid: string, name: string, password: string): { token: string } | { error: string } {
    if (this.accounts.has(userid)) return { error: 'That name is already registered.' };
    if (password.length < 4) return { error: 'Password must be at least 4 characters.' };
    if (password.length > 128) return { error: 'Password is too long.' };
    const salt = crypto.randomBytes(16).toString('hex');
    const account: Account = {
      userid,
      name,
      salt,
      passHash: hashPassword(password, salt),
      tokens: [],
      createdAt: Date.now(),
    };
    this.accounts.set(userid, account);
    const token = this.issueToken(account);
    this.persist(account);
    return { token };
  }

  /**
   * Verify a secret (session token OR password) and issue a fresh token.
   */
  login(userid: string, secret: string): { token: string; name: string } | { error: string } {
    const account = this.accounts.get(userid);
    if (!account) return { error: 'That name is not registered.' };
    const now = Date.now();
    account.tokens = account.tokens.filter((t) => t.expires > now);
    const byToken = account.tokens.some((t) => safeEqual(t.token, secret));
    const byPassword = !byToken && safeEqual(account.passHash, hashPassword(secret, account.salt));
    if (!byToken && !byPassword) return { error: 'Wrong password.' };
    const token = this.issueToken(account);
    this.persist(account);
    return { token, name: account.name };
  }

  /** Invalidate one session token (logout on this device). */
  revokeToken(userid: string, token: string): void {
    const account = this.accounts.get(userid);
    if (!account) return;
    account.tokens = account.tokens.filter((t) => !safeEqual(t.token, token));
    this.persist(account);
  }

  private issueToken(account: Account): string {
    const token = crypto.randomBytes(24).toString('hex');
    account.tokens.push({ token, expires: Date.now() + TOKEN_LIFETIME_MS });
    if (account.tokens.length > MAX_TOKENS_PER_ACCOUNT) {
      account.tokens = account.tokens.slice(-MAX_TOKENS_PER_ACCOUNT);
    }
    return token;
  }
}
