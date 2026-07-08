import { describe, it, expect } from 'vitest';
import { PRNG } from '../src/index.js';

describe('PRNG', () => {
  it('is deterministic for the same seed', () => {
    const a = new PRNG('battle-seed-1');
    const b = new PRNG('battle-seed-1');
    const seqA = Array.from({ length: 20 }, () => a.random(1000));
    const seqB = Array.from({ length: 20 }, () => b.random(1000));
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = new PRNG('seed-a');
    const b = new PRNG('seed-b');
    const seqA = Array.from({ length: 20 }, () => a.random(1_000_000));
    const seqB = Array.from({ length: 20 }, () => b.random(1_000_000));
    expect(seqA).not.toEqual(seqB);
  });

  it('can snapshot and restore state exactly', () => {
    const p = new PRNG('resume-me');
    for (let i = 0; i < 7; i++) p.random(100);
    const state = p.getState();
    const expected = Array.from({ length: 10 }, () => p.random(100));

    const resumed = new PRNG(state);
    const actual = Array.from({ length: 10 }, () => resumed.random(100));
    expect(actual).toEqual(expected);
  });

  it('random(from, to) stays in range', () => {
    const p = new PRNG('range');
    for (let i = 0; i < 500; i++) {
      const v = p.random(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(9);
    }
  });

  it('randomChance(1, 1) is always true and (0, 5) always false', () => {
    const p = new PRNG('chance');
    for (let i = 0; i < 50; i++) {
      expect(p.randomChance(1, 1)).toBe(true);
      expect(p.randomChance(0, 5)).toBe(false);
    }
  });

  it('shuffle is a permutation and deterministic per seed', () => {
    const p1 = new PRNG('shuf');
    const p2 = new PRNG('shuf');
    const arr1 = [0, 1, 2, 3, 4, 5, 6, 7];
    const arr2 = [0, 1, 2, 3, 4, 5, 6, 7];
    p1.shuffle(arr1);
    p2.shuffle(arr2);
    expect(arr1).toEqual(arr2);
    expect([...arr1].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
