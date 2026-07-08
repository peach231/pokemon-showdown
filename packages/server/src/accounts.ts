/**
 * Password accounts + session tokens, file-persisted like the ladder.
 *
 * - Passwords are scrypt-hashed (Node built-in, no dependencies) with a
 *   per-account random salt; comparison is constant-time.
 * - Logging in issues a random session token the client stores in
 *   localStorage — closing the tab and re-entering resumes the identity
 *   without retyping the password. Tokens expire after 90 days.
 * - Registered names can only be taken via password/token (no squatting).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(raw)) {
        for (const acc of raw) {
          if (acc && typeof acc.userid === 'string' && typeof acc.passHash === 'string') {
            this.accounts.set(acc.userid, {
              userid: acc.userid,
              name: String(acc.name ?? acc.userid),
              salt: String(acc.salt),
              passHash: String(acc.passHash),
              tokens: Array.isArray(acc.tokens) ? acc.tokens : [],
              createdAt: Number(acc.createdAt) || Date.now(),
            });
          }
        }
      }
    } catch { /* first run */ }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify([...this.accounts.values()], null, 1));
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
    this.save();
    return { token };
  }

  /**
   * Verify a secret (session token OR password) and issue a fresh token.
   * Returns the token or an error string.
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
    this.save();
    return { token, name: account.name };
  }

  /** Invalidate one session token (logout on this device). */
  revokeToken(userid: string, token: string): void {
    const account = this.accounts.get(userid);
    if (!account) return;
    account.tokens = account.tokens.filter((t) => !safeEqual(t.token, token));
    this.save();
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
