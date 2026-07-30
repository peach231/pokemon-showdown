import { describe, it, expect } from 'vitest';
import { Battle } from '../src/battle.js';
import { getSpecies, getMove } from '@simple-showdown/data';
import type { ResolvedPokemonSet } from '../src/types.js';

/**
 * Volatile statuses that the engine used to *announce* and then ignore: the
 * volatile went into the map, |-start| went out, and nothing ever ticked it.
 * Infestation was the reported example — it trapped nothing and chipped nothing.
 */

function mon(species: string, moves: string[], ability?: string, level = 80): ResolvedPokemonSet {
  const sp = getSpecies(species)!;
  return {
    species: sp,
    level,
    moves: moves.map((m) => getMove(m)!),
    ability: ability ?? sp.abilities[0] ?? '',
    item: '',
  } as ResolvedPokemonSet;
}

function start(p1: ResolvedPokemonSet[], p2: ResolvedPokemonSet[], seed = 'volatile-seed'): Battle {
  const battle = new Battle({
    seed,
    p1: { name: 'P1', team: p1, avatar: 'red' },
    p2: { name: 'P2', team: p2, avatar: 'blue' },
  });
  battle.start();
  battle.choose('p1', `team ${p1.map((_, i) => i + 1).join('')}`);
  battle.choose('p2', `team ${p2.map((_, i) => i + 1).join('')}`);
  return battle;
}

describe('binding moves', () => {
  it('Infestation chips the target every turn', () => {
    const battle = start(
      [mon('Genesect', ['Infestation'], 'Download')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const foe = battle.sides.p2.active!;
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(foe.hasVolatile('partiallytrapped')).toBe(true);
    const afterHit = foe.hp;

    // A second turn where nothing else touches it: only the bind can chip.
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(foe.hp).toBeLessThan(afterHit);
    expect(battle.log.join('\n')).toContain('[from] partiallytrapped');
  });

  it('Infestation stops the target switching out', () => {
    const battle = start(
      [mon('Genesect', ['Infestation'], 'Download')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p2.active!.hasVolatile('partiallytrapped')).toBe(true);

    const err = battle.choose('p2', 'switch 2');
    expect(err).toBeTruthy();
    expect(err).toContain("can't escape");
  });

  it('the bind eventually wears off', () => {
    const battle = start(
      [mon('Genesect', ['Infestation', 'Splash'], 'Download')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const foe = battle.sides.p2.active!;
    for (let i = 0; i < 8 && foe.hasVolatile('partiallytrapped'); i++) {
      battle.choose('p1', 'move 2');   // filler; move 1 would re-bind
      battle.choose('p2', 'move 1');
    }
    expect(foe.hasVolatile('partiallytrapped')).toBe(false);
  });
});

describe('Taunt', () => {
  it('blocks status moves while it lasts', () => {
    const battle = start(
      [mon('Whimsicott', ['Taunt'], 'Prankster')],
      [mon('Blissey', ['Soft-Boiled', 'Seismic Toss'], 'Natural Cure')],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 2');
    const foe = battle.sides.p2.active!;
    expect(foe.hasVolatile('taunt')).toBe(true);

    // The status move is no longer selectable at all, as in the real client.
    const err = battle.choose('p2', 'move 1');
    expect(err).toBeTruthy();
    // The attacking move still works.
    expect(battle.choose('p2', 'move 2')).toBeNull();
  });
});

describe('Salt Cure', () => {
  it('chips every turn, harder on Steel types', () => {
    const battle = start(
      [mon('Garganacl', ['Salt Cure'], 'Purifying Salt')],
      [mon('Skarmory', ['Splash'], 'Sturdy')],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const foe = battle.sides.p2.active!;
    expect(foe.hasVolatile('saltcure')).toBe(true);
    const before = foe.hp;
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(foe.hp).toBeLessThan(before);
    expect(battle.log.join('\n')).toContain('[from] Salt Cure');
  });
});

describe('Yawn', () => {
  it('puts the target to sleep at the end of the next turn', () => {
    const battle = start(
      [mon('Slowbro', ['Yawn'], 'Oblivious')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const foe = battle.sides.p2.active!;
    expect(foe.hasVolatile('yawn')).toBe(true);
    expect(foe.status).toBe('');

    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(foe.status).toBe('slp');
  });
});
