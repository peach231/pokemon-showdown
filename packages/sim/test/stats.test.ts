import { describe, it, expect } from 'vitest';
import { calcStat, calcStats, applyBoost, addBoost, emptyBoosts } from '../src/index.js';

describe('stat calculation (no EV/IV/nature)', () => {
  it('matches hand-computed Garchomp stats at level 100', () => {
    // Garchomp base: HP 108, Atk 130, Def 95, SpA 80, SpD 85, Spe 102.
    expect(calcStat('hp', 108, 100)).toBe(326); // 216 + 100 + 10
    expect(calcStat('atk', 130, 100)).toBe(265); // 260 + 5
    expect(calcStat('spe', 102, 100)).toBe(209); // 204 + 5
  });

  it('scales with level', () => {
    expect(calcStat('atk', 100, 50)).toBe(105); // floor(2*100*50/100)+5 = 100+5
    expect(calcStat('hp', 100, 50)).toBe(160); // 100 + 50 + 10
  });

  it('keeps 1-HP species at 1 HP', () => {
    expect(calcStat('hp', 1, 100)).toBe(1);
  });

  it('computes a full stat table', () => {
    const stats = calcStats(
      { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 },
      100,
    );
    expect(stats).toEqual({ hp: 326, atk: 265, def: 195, spa: 165, spd: 175, spe: 209 });
  });
});

describe('boost application', () => {
  it('applies positive and negative stages', () => {
    expect(applyBoost(200, 0)).toBe(200);
    expect(applyBoost(200, 1)).toBe(300); // x1.5
    expect(applyBoost(200, 2)).toBe(400); // x2
    expect(applyBoost(200, 6)).toBe(800); // x4
    expect(applyBoost(200, -1)).toBe(133); // floor(200/1.5)
    expect(applyBoost(200, -2)).toBe(100); // /2
    expect(applyBoost(200, -6)).toBe(50); // /4
  });

  it('clamps stages beyond +/-6', () => {
    expect(applyBoost(200, 99)).toBe(applyBoost(200, 6));
    expect(applyBoost(200, -99)).toBe(applyBoost(200, -6));
  });

  it('addBoost clamps and reports the applied delta', () => {
    const boosts = emptyBoosts();
    expect(addBoost(boosts, 'atk', 2)).toBe(2);
    expect(boosts.atk).toBe(2);
    expect(addBoost(boosts, 'atk', 6)).toBe(4); // clamped at +6
    expect(boosts.atk).toBe(6);
  });
});
