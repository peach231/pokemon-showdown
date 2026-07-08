import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { calculateElo, LadderStore, STARTING_ELO } from '../src/ladder.js';

describe('calculateElo', () => {
  it('winner gains, loser drops, floored at 1000', () => {
    const winner = calculateElo(1000, 1, 1000);
    const loser = calculateElo(1000, 0, 1000);
    expect(winner).toBeGreaterThan(1000);
    expect(loser).toBe(1000); // floor
  });

  it('new players climb fast and fall slow (asymmetric K under 1200)', () => {
    const gain = calculateElo(1050, 1, 1050) - 1050;
    const loss = 1050 - calculateElo(1050, 0, 1050);
    expect(gain).toBeGreaterThan(loss);
  });

  it('beating a stronger foe pays more than beating a weaker one', () => {
    const vsStrong = calculateElo(1300, 1, 1500) - 1300;
    const vsWeak = calculateElo(1300, 1, 1100) - 1300;
    expect(vsStrong).toBeGreaterThan(vsWeak);
  });

  it('high ratings use a smaller K', () => {
    const midGain = calculateElo(1300, 1, 1300) - 1300;   // K=50
    const highGain = calculateElo(1700, 1, 1700) - 1700;  // K=32
    expect(highGain).toBeLessThan(midGain);
  });
});

describe('LadderStore', () => {
  const tmpFile = () => path.join(os.tmpdir(), `ladder-test-${Math.random().toString(36).slice(2)}.json`);

  it('reports results, tracks W/L, persists, and reloads', () => {
    const file = tmpFile();
    const store = new LadderStore(file);
    const result = store.reportResult(
      { userid: 'alice', name: 'Alice' },
      { userid: 'bob', name: 'Bob' },
      1,
    );
    expect(result.p1.after).toBeGreaterThan(result.p1.before);
    expect(result.p2.after).toBe(1000);
    expect(store.get('alice')!.wins).toBe(1);
    expect(store.get('bob')!.losses).toBe(1);

    const reloaded = new LadderStore(file);
    expect(reloaded.getElo('alice')).toBe(result.p1.after);
    expect(reloaded.top(10)[0]!.userid).toBe('alice');
    fs.unlinkSync(file);
  });

  it('unknown players default to the starting rating', () => {
    const store = new LadderStore(tmpFile());
    expect(store.getElo('nobody')).toBe(STARTING_ELO);
  });
});
