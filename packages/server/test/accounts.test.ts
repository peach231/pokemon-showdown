import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { createClient } from '@libsql/client';
import { AccountStore } from '../src/accounts.js';

const tmpDb = () => createClient({
  url: `file:${path.join(os.tmpdir(), `accounts-test-${Math.random().toString(36).slice(2)}.db`).replace(/\\/g, '/')}`,
});

async function makeStore(db = tmpDb()): Promise<AccountStore> {
  const store = new AccountStore(db);
  await store.init();
  return store;
}

describe('AccountStore (libsql)', () => {
  it('registers and logs in with the password', async () => {
    const store = await makeStore();
    const reg = store.register('redd', 'Redd', 'hunter22');
    expect('token' in reg).toBe(true);
    const login = store.login('redd', 'hunter22');
    expect('token' in login && login.name).toBe('Redd');
  });

  it('rejects wrong passwords and unknown accounts', async () => {
    const store = await makeStore();
    store.register('redd', 'Redd', 'hunter22');
    expect(store.login('redd', 'wrong')).toEqual({ error: 'Wrong password.' });
    expect('error' in store.login('nobody', 'x')).toBe(true);
  });

  it('session tokens log in without the password, and revoke works', async () => {
    const store = await makeStore();
    const reg = store.register('redd', 'Redd', 'hunter22');
    const token = (reg as { token: string }).token;
    expect('token' in store.login('redd', token)).toBe(true);
    store.revokeToken('redd', token);
    expect('error' in store.login('redd', token)).toBe(true);
    expect('token' in store.login('redd', 'hunter22')).toBe(true);
  });

  it('rejects duplicate registration and short passwords', async () => {
    const store = await makeStore();
    store.register('redd', 'Redd', 'hunter22');
    expect('error' in store.register('redd', 'Redd', 'other')).toBe(true);
    expect('error' in store.register('blue', 'Blue', 'abc')).toBe(true);
  });

  it('persists to the database and reloads across instances', async () => {
    const db = tmpDb();
    const store = new AccountStore(db);
    await store.init();
    store.register('redd', 'Redd', 'hunter22');
    // Write-through is async; give it a beat.
    await new Promise((r) => setTimeout(r, 150));

    const reloaded = new AccountStore(db);
    await reloaded.init();
    expect(reloaded.isRegistered('redd')).toBe(true);
    expect('token' in reloaded.login('redd', 'hunter22')).toBe(true);
  });
});
