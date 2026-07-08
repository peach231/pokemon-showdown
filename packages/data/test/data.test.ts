import { describe, it, expect } from 'vitest';
import {
  allSpecies, getSpecies, filterSpecies, getMove, canLearn, legalMoves,
} from '../src/index.js';

describe('species data', () => {
  it('loads all species (roughly the full national dex)', () => {
    const species = allSpecies();
    expect(species.length).toBeGreaterThan(1000);
  });

  it('gets a species by name with base stats and types', () => {
    const garchomp = getSpecies('Garchomp');
    expect(garchomp).toBeDefined();
    expect(garchomp!.types).toEqual(['Dragon', 'Ground']);
    expect(garchomp!.baseStats.atk).toBe(130);
    expect(garchomp!.gen).toBe(4);
  });

  it('resolves evolution links', () => {
    const gible = getSpecies('Gible');
    expect(gible!.evos).toContain('gabite');
    const gabite = getSpecies('Gabite');
    expect(gabite!.prevo).toBe('gible');
  });
});

describe('species filters', () => {
  it('filters by type', () => {
    const fire = filterSpecies({ types: ['Fire'] });
    expect(fire.length).toBeGreaterThan(30);
    expect(fire.every((s) => s.types.includes('Fire'))).toBe(true);
  });

  it('filters by generation introduced', () => {
    const gen1 = filterSpecies({ gens: [1] });
    expect(gen1.some((s) => s.id === 'pikachu')).toBe(true);
    expect(gen1.every((s) => s.gen === 1)).toBe(true);
  });

  it('filters fully evolved only', () => {
    const fe = filterSpecies({ fullyEvolvedOnly: true });
    expect(fe.some((s) => s.id === 'garchomp')).toBe(true);
    expect(fe.some((s) => s.id === 'gible')).toBe(false);
  });

  it('filters by evolution stage', () => {
    const base = filterSpecies({ stages: [1] });
    expect(base.some((s) => s.id === 'gible')).toBe(true);
    expect(base.some((s) => s.id === 'garchomp')).toBe(false);
  });
});

describe('moves and learnsets', () => {
  it('gets a move with engine-shaped data', () => {
    const tbolt = getMove('Thunderbolt');
    expect(tbolt).toBeDefined();
    expect(tbolt!.basePower).toBe(90);
    expect(tbolt!.type).toBe('Electric');
    expect(tbolt!.secondaries?.[0]).toMatchObject({ chance: 10, status: 'par' });
  });

  it('checks learnset legality', async () => {
    await expect(canLearn('Pikachu', 'Thunderbolt')).resolves.toBe(true);
    // (Fly is a bad negative case: event "Flying Pikachu" really learns it.)
    await expect(canLearn('Pikachu', 'Spore')).resolves.toBe(false);
  });

  it('lists legal moves for a species', async () => {
    const moves = await legalMoves('Pikachu');
    expect(moves.length).toBeGreaterThan(20);
    expect(moves.some((m) => m.id === 'thunderbolt')).toBe(true);
  });
});
