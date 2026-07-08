import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { AccountStore } from '../src/accounts.js';

const tmpFile = () => path.join(os.tmpdir(), `accounts-test-${Math.random().toString(36).slice(2)}.json`);

describe('AccountStore', () => {
  it('registers and logs in with the password', () => {
    const store = new AccountStore(tmpFile());
    const reg = store.register('redd', 'Redd', 'hunter22');
    expect('token' in reg).toBe(true);
    const login = store.login('redd', 'hunter22');
    expect('token' in login && login.name).toBe('Redd');
  });

  it('rejects wrong passwords and unknown accounts', () => {
    const store = new AccountStore(tmpFile());
    store.register('redd', 'Redd', 'hunter22');
    expect(store.login('redd', 'wrong')).toEqual({ error: 'Wrong password.' });
    expect('error' in store.login('nobody', 'x')).toBe(true);
  });

  it('session tokens log in without the password, and revoke works', () => {
    const store = new AccountStore(tmpFile());
    const reg = store.register('redd', 'Redd', 'hunter22');
    const token = (reg as { token: string }).token;
    const byToken = store.login('redd', token);
    expect('token' in byToken).toBe(true);
    store.revokeToken('redd', token);
    expect('error' in store.login('redd', token)).toBe(true);
    // Password still works after revoking a device token.
    expect('token' in store.login('redd', 'hunter22')).toBe(true);
  });

  it('rejects duplicate registration and short passwords', () => {
    const store = new AccountStore(tmpFile());
    store.register('redd', 'Redd', 'hunter22');
    expect('error' in store.register('redd', 'Redd', 'other')).toBe(true);
    expect('error' in store.register('blue', 'Blue', 'abc')).toBe(true);
  });

  it('persists across reloads', () => {
    const file = tmpFile();
    new AccountStore(file).register('redd', 'Redd', 'hunter22');
    const reloaded = new AccountStore(file);
    expect(reloaded.isRegistered('redd')).toBe(true);
    expect('token' in reloaded.login('redd', 'hunter22')).toBe(true);
  });
});
