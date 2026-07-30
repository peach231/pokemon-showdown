import { describe, it, expect } from 'vitest';
import { Battle } from '../src/battle.js';
import { getSpecies, getMove } from '@simple-showdown/data';
import type { ResolvedPokemonSet } from '../src/types.js';

/**
 * Moves and abilities that never appear in the random-battle sets but ARE
 * selectable in the teambuilder. They were unreachable by the previous audit
 * and every one of them did nothing.
 */

function mon(species: string, moves: string[], ability?: string, item = '', level = 80): ResolvedPokemonSet {
  const sp = getSpecies(species)!;
  return {
    species: sp,
    level,
    moves: moves.map((m) => getMove(m)!),
    ability: ability ?? sp.abilities[0] ?? '',
    item,
  } as ResolvedPokemonSet;
}

function start(p1: ResolvedPokemonSet[], p2: ResolvedPokemonSet[], seed = 'tb-seed'): Battle {
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
function turn(b: Battle, p1 = 'move 1', p2 = 'move 1'): void {
  b.choose('p1', p1);
  b.choose('p2', p2);
}

describe('typing and ability manipulation', () => {
  it('Soak turns the target into a Water type', () => {
    const battle = start(
      [mon('Politoed', ['Soak'], 'Drizzle')],
      [mon('Machamp', ['Splash'], 'No Guard')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.types).toEqual(['Water']);
  });

  it('Reflect Type copies the target’s typing', () => {
    const battle = start(
      [mon('Ditto', ['Reflect Type'], 'Limber')],
      [mon('Skarmory', ['Splash'], 'Sturdy')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.types).toEqual(battle.sides.p2.active!.types);
  });

  it('Skill Swap exchanges abilities', () => {
    const battle = start(
      [mon('Alakazam', ['Skill Swap'], 'Magic Guard')],
      [mon('Skarmory', ['Splash'], 'Sturdy')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.ability).toBe('Sturdy');
    expect(battle.sides.p2.active!.ability).toBe('Magic Guard');
  });

  it('Worry Seed replaces the target’s ability', () => {
    const battle = start(
      [mon('Amoonguss', ['Worry Seed'], 'Regenerator')],
      [mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.ability).toBe('Insomnia');
  });
});

describe('boost manipulation', () => {
  it('Psych Up copies the opponent’s boosts', () => {
    const battle = start(
      [mon('Alakazam', ['Psych Up', 'Splash'], 'Magic Guard')],
      [mon('Snorlax', ['Swords Dance', 'Splash'], 'Thick Fat')],
    );
    turn(battle, 'move 2', 'move 1');
    expect(battle.sides.p2.active!.boosts.atk).toBe(2);
    turn(battle, 'move 1', 'move 2');
    expect(battle.sides.p1.active!.boosts.atk).toBe(2);
  });

  it('Topsy-Turvy inverts them', () => {
    const battle = start(
      [mon('Alakazam', ['Topsy-Turvy', 'Splash'], 'Magic Guard')],
      [mon('Snorlax', ['Swords Dance', 'Splash'], 'Thick Fat')],
    );
    turn(battle, 'move 2', 'move 1');
    turn(battle, 'move 1', 'move 2');
    expect(battle.sides.p2.active!.boosts.atk).toBe(-2);
  });

  it('Simple doubles every stage change', () => {
    const battle = start(
      [mon('Bibarel', ['Swords Dance'], 'Simple')],
      [mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.boosts.atk).toBe(4);
  });
});

describe('field rooms', () => {
  it('Gravity grounds a Flying type', () => {
    const battle = start(
      [mon('Machamp', ['Gravity', 'Earthquake'], 'No Guard')],
      [mon('Skarmory', ['Splash'], 'Sturdy')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle, 'move 2');            // Earthquake misses a Flying type
    expect(foe.hp).toBe(before);
    turn(battle, 'move 1');            // Gravity goes up
    expect(battle.gravityTurns).toBeGreaterThan(0);
    turn(battle, 'move 2');
    expect(foe.hp).toBeLessThan(before);
  });

  it('Wonder Room swaps the defensive stats', () => {
    const plain = start(
      [mon('Alakazam', ['Psychic'], 'Magic Guard')],
      [mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    const a = plain.sides.p2.active!;
    const beforeA = a.hp;
    turn(plain);
    const normal = beforeA - a.hp;

    const swapped = start(
      [mon('Alakazam', ['Psychic', 'Wonder Room'], 'Magic Guard')],
      [mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    turn(swapped, 'move 2');
    const b = swapped.sides.p2.active!;
    const beforeB = b.hp;
    turn(swapped, 'move 1');
    // Chansey's Defence is far worse than its Sp. Def, so the swap hurts more.
    expect(beforeB - b.hp).toBeGreaterThan(normal);
  });

  it('Perish Song counts both Pokémon down', () => {
    const battle = start(
      [mon('Politoed', ['Perish Song', 'Splash'], 'Drizzle')],
      [mon('Snorlax', ['Splash'], 'Thick Fat'), mon('Miltank', ['Splash'], 'Thick Fat')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.perishTurns).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) turn(battle, 'move 2');
    // Both should have fainted to the song.
    expect(battle.log.join('\n')).toContain('perish0');
  });
});

describe('trapping and utility', () => {
  it('Mean Look stops the target escaping', () => {
    const battle = start(
      [mon('Umbreon', ['Mean Look'], 'Synchronize')],
      [mon('Snorlax', ['Splash'], 'Thick Fat'), mon('Miltank', ['Splash'], 'Thick Fat')],
    );
    turn(battle);
    const err = battle.choose('p2', 'switch 2');
    expect(err).toBeTruthy();
  });

  it('Heal Pulse heals the target', () => {
    const battle = start(
      [mon('Alakazam', ['Heal Pulse'], 'Magic Guard')],
      [mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    const foe = battle.sides.p2.active!;
    foe.damage(Math.floor(foe.maxhp / 2));
    const before = foe.hp;
    turn(battle);
    expect(foe.hp).toBeGreaterThan(before);
  });

  it('Recycle brings a used item back', () => {
    const battle = start(
      [mon('Snorlax', ['Recycle'], 'Thick Fat', 'Sitrus Berry')],
      [mon('Machamp', ['Splash'], 'No Guard')],
    );
    const me = battle.sides.p1.active!;
    me.consumeItem();
    expect(me.itemId).toBe('');
    turn(battle);
    expect(me.itemId).toBe('sitrusberry');
  });

  it('Flail hits harder the lower the user’s HP', () => {
    const healthy = start(
      [mon('Corviknight', ['Flail'], 'Pressure')],
      [mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    const a = healthy.sides.p2.active!;
    const beforeA = a.hp;
    turn(healthy);
    const strong = beforeA - a.hp;

    const hurt = start(
      [mon('Corviknight', ['Flail'], 'Pressure')],
      [mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    hurt.sides.p1.active!.damage(hurt.sides.p1.active!.maxhp - 5);
    const b = hurt.sides.p2.active!;
    const beforeB = b.hp;
    turn(hurt);
    expect(beforeB - b.hp).toBeGreaterThan(strong);
  });

  it('Final Gambit trades the user’s HP for damage', () => {
    const battle = start(
      [mon('Corviknight', ['Final Gambit'], 'Pressure')],
      [mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    const me = battle.sides.p1.active!;
    const hp = me.hp;
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(me.fainted).toBe(true);
    expect(before - foe.hp).toBe(hp);
  });
});

describe('teambuilder abilities', () => {
  it('Beast Boost raises the best stat on a KO', () => {
    const battle = start(
      [mon('Kartana', ['Sacred Sword'], 'Beast Boost')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.fainted).toBe(true);
    expect(battle.sides.p1.active!.boosts.atk).toBe(1);
  });

  it('Anger Point maxes Attack on a critical hit', () => {
    const battle = start(
      [mon('Primeape', ['Splash'], 'Anger Point')],
      [mon('Machamp', ['Storm Throw'], 'No Guard')],   // always crits
    );
    turn(battle);
    expect(battle.sides.p1.active!.boosts.atk).toBe(6);
  });

  it('Long Reach avoids contact abilities', () => {
    const battle = start(
      [mon('Decidueye', ['Body Slam'], 'Long Reach')],
      [mon('Ferrothorn', ['Splash'], 'Iron Barbs')],
    );
    const me = battle.sides.p1.active!;
    const before = me.hp;
    turn(battle);
    expect(me.hp, 'Iron Barbs must not fire').toBe(before);
  });

  it('Wimp Out bails out at half HP', () => {
    const battle = start(
      [mon('Machamp', ['Body Slam'], 'No Guard')],
      [mon('Wimpod', ['Splash'], 'Wimp Out'), mon('Snorlax', ['Splash'], 'Thick Fat')],
    );
    turn(battle);
    // Either it fled (a switch request is pending) or it fainted outright.
    const fled = battle.sides.p2.requestState === 'switch'
      || battle.sides.p2.active!.species.name !== 'Wimpod';
    expect(fled || battle.sides.p2.active!.fainted).toBe(true);
  });

  it('Steadfast turns a flinch into Speed', () => {
    const battle = start(
      [mon('Lucario', ['Splash'], 'Steadfast')],
      [mon('Machamp', ['Fake Out'], 'No Guard')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.boosts.spe).toBe(1);
  });
});
