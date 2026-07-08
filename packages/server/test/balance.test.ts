import { describe, it, expect } from 'vitest';
import { getSpecies } from '@simple-showdown/data';
import { PRNG } from '@simple-showdown/sim';
import { balancedLevel, generateRandomTeam, generateTeamFromSpecs } from '../src/random-team.js';

describe('balancedLevel', () => {
  it('gives strong Pokémon lower levels than weak ones', () => {
    const rayquaza = balancedLevel(getSpecies('Rayquaza')!); // BST 680
    const arcanine = balancedLevel(getSpecies('Arcanine')!); // BST 555
    const wigglytuff = balancedLevel(getSpecies('Wigglytuff')!); // BST 435
    const sunkern = balancedLevel(getSpecies('Sunkern')!); // BST 180
    expect(rayquaza).toBeLessThan(arcanine);
    expect(arcanine).toBeLessThan(wigglytuff);
    expect(wigglytuff).toBeLessThan(sunkern);
    expect(sunkern).toBe(100);
  });

  it('clamps to [70, 100]', () => {
    for (const name of ['Rayquaza', 'Arceus', 'Magikarp', 'Blissey', 'Shuckle']) {
      const level = balancedLevel(getSpecies(name)!);
      expect(level).toBeGreaterThanOrEqual(70);
      expect(level).toBeLessThanOrEqual(100);
    }
  });
});

describe('team generation applies balanced levels', () => {
  it('random teams carry per-species levels', async () => {
    const team = await generateRandomTeam(new PRNG('balance-test'), 6);
    expect(team).toHaveLength(6);
    for (const set of team) {
      expect(set.level).toBe(balancedLevel(set.species));
    }
  });

  it('custom teams get balanced levels too', async () => {
    const team = await generateTeamFromSpecs(new PRNG('balance-test-2'), [
      { id: 'rayquaza', moves: [] },
      { id: 'wigglytuff', moves: [] },
    ], 2);
    expect(team[0]!.level).toBeLessThan(team[1]!.level!);
  });
});
