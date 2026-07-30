import { describe, it, expect } from 'vitest';
import { Battle } from '../src/battle.js';
import { getSpecies, getMove } from '@simple-showdown/data';
import type { ResolvedPokemonSet } from '../src/types.js';

/**
 * Pivot moves (U-turn, Volt Switch, Flip Turn, Parting Shot, Teleport,
 * Chilly Reception). The whole family used to behave like ordinary moves
 * because the data wrapper never forwarded `selfSwitch` to the engine.
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

/** Drive a battle to the first move-request, returning the battle. */
function startBattle(p1Team: ResolvedPokemonSet[], p2Team: ResolvedPokemonSet[]): Battle {
  const battle = new Battle({
    seed: 'pivot-test-seed',
    p1: { name: 'P1', team: p1Team, avatar: 'red' },
    p2: { name: 'P2', team: p2Team, avatar: 'blue' },
  });
  battle.start();
  battle.choose('p1', 'team 123');
  battle.choose('p2', 'team 123');
  return battle;
}

function activeOf(battle: Battle, side: 'p1' | 'p2'): string {
  return battle.sides[side].active?.species.name ?? '';
}

describe('pivot moves', () => {
  it('forwards selfSwitch from the data layer', () => {
    for (const name of ['U-turn', 'Volt Switch', 'Flip Turn', 'Parting Shot', 'Teleport', 'Chilly Reception']) {
      expect(getMove(name)?.selfSwitch, name).toBeTruthy();
    }
    // Sanity: an ordinary attack must NOT be flagged.
    expect(getMove('Tackle')?.selfSwitch).toBeUndefined();
  });

  it('U-turn asks its user for a replacement and brings it in', () => {
    const battle = startBattle(
      [mon('Ambipom', ['U-turn']), mon('Pikachu', ['Tackle']), mon('Snorlax', ['Tackle'])],
      [mon('Blissey', ['Tackle']), mon('Chansey', ['Tackle']), mon('Miltank', ['Tackle'])],
    );
    expect(activeOf(battle, 'p1')).toBe('Ambipom');

    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');

    // The turn pauses on a switch request for p1 only.
    expect(battle.sides.p1.requestState).toBe('switch');
    expect(battle.sides.p2.requestState).toBe('wait');

    battle.choose('p1', 'switch 2');
    expect(activeOf(battle, 'p1')).toBe('Pikachu');
  });

  it('Teleport switches out instead of failing', () => {
    const battle = startBattle(
      [mon('Abra', ['Teleport']), mon('Pikachu', ['Tackle']), mon('Snorlax', ['Tackle'])],
      [mon('Blissey', ['Tackle']), mon('Chansey', ['Tackle']), mon('Miltank', ['Tackle'])],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.requestState).toBe('switch');
    battle.choose('p1', 'switch 3');
    expect(activeOf(battle, 'p1')).toBe('Snorlax');
    expect(battle.log.join('\n')).not.toContain('-fail');
  });

  it('Parting Shot lowers the foe AND switches', () => {
    const battle = startBattle(
      [mon('Pangoro', ['Parting Shot']), mon('Pikachu', ['Tackle']), mon('Snorlax', ['Tackle'])],
      [mon('Blissey', ['Tackle']), mon('Chansey', ['Tackle']), mon('Miltank', ['Tackle'])],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const foe = battle.sides.p2.active!;
    expect(foe.boosts.atk).toBeLessThan(0);
    expect(foe.boosts.spa).toBeLessThan(0);
    expect(battle.sides.p1.requestState).toBe('switch');
  });

  it('does not switch when the user has nobody left to bring in', () => {
    const battle = startBattle(
      [mon('Ambipom', ['U-turn'])],
      [mon('Blissey', ['Tackle'])],
    );
    battle.choose('p1', 'team 1');
    battle.choose('p2', 'team 1');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    // No replacement exists, so the turn must continue normally.
    expect(battle.sides.p1.requestState).not.toBe('switch');
    expect(activeOf(battle, 'p1')).toBe('Ambipom');
  });

  it('the opponent still moves after the pivot completes', () => {
    const battle = startBattle(
      [mon('Ambipom', ['U-turn']), mon('Snorlax', ['Tackle']), mon('Pikachu', ['Tackle'])],
      [mon('Blissey', ['Tackle']), mon('Chansey', ['Tackle']), mon('Miltank', ['Tackle'])],
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    battle.choose('p1', 'switch 2');
    const log = battle.log.join('\n');
    // Blissey's Tackle must appear, and the incoming Snorlax must have taken it.
    expect(log).toContain('|move|p2a: Blissey|Tackle');
    const snorlax = battle.sides.p1.active!;
    expect(snorlax.species.name).toBe('Snorlax');
    expect(snorlax.hp).toBeLessThan(snorlax.maxhp);
  });
});

describe('switch-out abilities announce themselves', () => {
  it('Regenerator heals on the way out and says so', () => {
    const battle = startBattle(
      [mon('Alomomola', ['Tackle'], 'Regenerator'), mon('Pikachu', ['Tackle']), mon('Snorlax', ['Tackle'])],
      [mon('Blissey', ['Tackle']), mon('Chansey', ['Tackle']), mon('Miltank', ['Tackle'])],
    );
    const alomomola = battle.sides.p1.active!;
    expect(alomomola.ability).toBe('Regenerator');
    alomomola.damage(Math.floor(alomomola.maxhp / 2));
    const before = alomomola.hp;

    battle.choose('p1', 'switch 2');
    battle.choose('p2', 'move 1');

    expect(alomomola.hp).toBeGreaterThan(before);
    expect(battle.log.join('\n')).toContain('ability: Regenerator');
  });
});
