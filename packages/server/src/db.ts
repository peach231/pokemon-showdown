/**
 * Database handle: Turso (libSQL) in production, a local SQLite file in dev.
 *
 * - Set TURSO_DATABASE_URL (libsql://...turso.io) + TURSO_AUTH_TOKEN on the
 *   host (e.g. Render env vars) and all persistent data lives off-box —
 *   the server becomes stateless and survives ephemeral-disk hosts.
 * - With no env vars, it transparently uses file:packages/server/data/game.db
 *   so local dev needs zero setup.
 *
 * Stores keep an in-memory cache (loaded once at boot) and write through
 * asynchronously, so game-loop reads stay synchronous and fast.
 */
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type { Client };

export function createDb(): Client {
  const url = process.env['TURSO_DATABASE_URL'];
  if (url) {
    console.log('database: Turso (remote)');
    return createClient({ url, authToken: process.env['TURSO_AUTH_TOKEN'] });
  }
  const dir = path.join(process.cwd(), 'packages', 'server', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = `file:${path.join(dir, 'game.db').replace(/\\/g, '/')}`;
  console.log('database: local file (set TURSO_DATABASE_URL for remote)');
  return createClient({ url: file });
}
