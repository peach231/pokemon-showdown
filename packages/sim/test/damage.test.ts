import { describe, it, expect } from 'vitest';
import { calculateDamage, PRNG, type DamageInput } from '../src/index.js';

/** A neutral baseline: lvl 100, BP 80, atk 200, def 100, no STAB, neutral type. */
function baseInput(overrides: Partial<DamageInput> = {}): DamageInput {
  return {
    level: 100,
    basePower: 80,
    category: 'Physical',
    moveType: 'Normal',
    attackStat: 200,
    defenseStat: 100,
    attackerTypes: ['Electric'], // not Normal => no STAB by default
    defenderTypes: ['Grass'], // Normal vs Grass is neutral
    isCrit: false,
    isBurned: false,
    randomRoll: 0, // max roll for a stable expected value
    ...overrides,
  };
}

describe('damage formula', () => {
  it('computes the neutral baseline (max roll)', () => {
    // base = floor(floor(floor(2*100/5+2)*80*200/100)/50)+2 = 136
    expect(calculateDamage(baseInput()).damage).toBe(136);
  });

  it('applies the min roll (85%)', () => {
    expect(calculateDamage(baseInput({ randomRoll: 15 })).damage).toBe(115); // floor(136*0.85)
  });

  it('applies STAB', () => {
    const r = calculateDamage(baseInput({ attackerTypes: ['Normal'] }));
    expect(r.damage).toBe(204); // floor(136 * 1.5)
  });

  it('applies super effective and resisted multipliers', () => {
    expect(calculateDamage(baseInput({ moveType: 'Fire', defenderTypes: ['Grass'] })).damage).toBe(272);
    expect(calculateDamage(baseInput({ moveType: 'Water', defenderTypes: ['Grass'] })).damage).toBe(68);
    expect(calculateDamage(baseInput({ moveType: 'Ice', defenderTypes: ['Grass', 'Dragon'] })).damage).toBe(544);
  });

  it('returns 0 damage and eff 0 vs an immune type', () => {
    const r = calculateDamage(baseInput({ moveType: 'Normal', defenderTypes: ['Ghost'] }));
    expect(r.damage).toBe(0);
    expect(r.effectiveness).toBe(0);
  });

  it('applies critical hits before the random roll', () => {
    const r = calculateDamage(baseInput({ isCrit: true }));
    expect(r.damage).toBe(204); // floor(136 * 1.5)
    expect(r.crit).toBe(true);
  });

  it('halves physical damage when burned, but not special', () => {
    expect(calculateDamage(baseInput({ isBurned: true })).damage).toBe(68);
    expect(calculateDamage(baseInput({ isBurned: true, category: 'Special' })).damage).toBe(136);
  });

  it('floors at 1 damage for a non-immune hit', () => {
    // Base damage bottoms out at 2 (the formula's +2); resist + burn halve it
    // twice (2 -> 1 -> 0), and the final clamp brings it back to 1.
    const r = calculateDamage(baseInput({
      basePower: 1, attackStat: 1, defenseStat: 255,
      moveType: 'Water', defenderTypes: ['Grass'], // resisted
      isBurned: true, // physical halved
    }));
    expect(r.damage).toBe(1);
  });

  it('draws a roll from the PRNG when randomRoll is omitted', () => {
    const prng = new PRNG('dmg');
    const input = baseInput();
    delete (input as Partial<DamageInput>).randomRoll;
    const r = calculateDamage({ ...input, prng });
    expect(r.damage).toBeGreaterThanOrEqual(115);
    expect(r.damage).toBeLessThanOrEqual(136);
  });
});
