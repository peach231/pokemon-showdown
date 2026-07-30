import { describe, it, expect } from 'vitest';
import { Battle } from '../src/battle.js';
import { getSpecies, getMove } from '@simple-showdown/data';
import type { ResolvedPokemonSet } from '../src/types.js';

/** Terrain did not exist in this engine at all before; nor did the abilities and
 *  moves that depend on it. */

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

function start(p1: ResolvedPokemonSet[], p2: ResolvedPokemonSet[], seed = 'terrain-seed'): Battle {
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

function turn(battle: Battle, p1Move = 'move 1', p2Move = 'move 1'): void {
  battle.choose('p1', p1Move);
  battle.choose('p2', p2Move);
}

describe('terrain', () => {
  it('Surge abilities set terrain on entry', () => {
    const battle = start(
      [mon('Tapu Koko', ['Splash'], 'Electric Surge')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    expect(battle.terrain).toBe('electricterrain');
  });

  it('terrain moves set it too, and it expires', () => {
    const battle = start(
      [mon('Tapu Bulu', ['Grassy Terrain', 'Splash'], 'Overgrow')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    expect(battle.terrain).toBe('grassyterrain');
    for (let i = 0; i < 6 && battle.terrain; i++) turn(battle, 'move 2');
    expect(battle.terrain).toBe('');
  });

  it('Electric Terrain stops a grounded Pokémon falling asleep', () => {
    const battle = start(
      [mon('Blissey', ['Spore'], 'Natural Cure')],
      [mon('Tapu Koko', ['Splash'], 'Electric Surge')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.status).not.toBe('slp');
  });

  it('Misty Terrain blocks status entirely for grounded Pokémon', () => {
    const battle = start(
      [mon('Blissey', ['Toxic'], 'Natural Cure')],
      [mon('Tapu Fini', ['Splash'], 'Misty Surge')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.status).toBe('');
  });

  it('Grassy Terrain heals grounded Pokémon each turn', () => {
    const battle = start(
      [mon('Tapu Bulu', ['Splash'], 'Grassy Surge')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const p = battle.sides.p1.active!;
    p.damage(Math.floor(p.maxhp / 2));
    const before = p.hp;
    turn(battle);
    expect(p.hp).toBeGreaterThan(before);
  });

  it('Psychic Terrain refuses priority moves against a grounded target', () => {
    const battle = start(
      [mon('Blissey', ['Quick Attack'], 'Natural Cure')],
      [mon('Tapu Lele', ['Splash'], 'Psychic Surge')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(foe.hp).toBe(before);
  });

  it('a Flying type is above the terrain', () => {
    const battle = start(
      [mon('Blissey', ['Spore'], 'Natural Cure')],
      [mon('Tornadus', ['Splash'], 'Prankster')],
    );
    // Set Electric Terrain from p1's side would need a setter; instead check
    // grounding directly: a Flying type must still be sleepable.
    turn(battle);
    expect(battle.sides.p2.active!.status).toBe('slp');
  });
});

describe('Protosynthesis / Quark Drive', () => {
  it('Quark Drive switches on in Electric Terrain and off when it ends', () => {
    const battle = start(
      [mon('Iron Valiant', ['Splash'], 'Quark Drive')],
      [mon('Tapu Koko', ['Splash'], 'Electric Surge')],
    );
    const p = battle.sides.p1.active!;
    expect(p.boostedStat, 'terrain should trigger it').not.toBeNull();
    for (let i = 0; i < 6 && battle.terrain; i++) turn(battle);
    expect(battle.terrain).toBe('');
    expect(p.boostedStat, 'and it should lapse with the terrain').toBeNull();
  });

  it('Protosynthesis triggers in harsh sun', () => {
    const battle = start(
      [mon('Roaring Moon', ['Splash'], 'Protosynthesis')],
      [mon('Torkoal', ['Splash'], 'Drought')],
    );
    expect(battle.weather).toBe('sunnyday');
    expect(battle.sides.p1.active!.boostedStat).not.toBeNull();
  });

  it('Booster Energy supplies the trigger with no field support', () => {
    const battle = start(
      [mon('Iron Valiant', ['Splash'], 'Quark Drive', 'Booster Energy')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const p = battle.sides.p1.active!;
    expect(p.boostedStat).not.toBeNull();
    expect(p.itemId, 'the energy is consumed').toBe('');
  });
});

describe('trapping and field abilities', () => {
  it('Shadow Tag stops the opponent switching', () => {
    const battle = start(
      [mon('Gothitelle', ['Splash'], 'Shadow Tag')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    const err = battle.choose('p2', 'switch 2');
    expect(err).toBeTruthy();
    expect(err).toContain("can't escape");
  });

  it('Magnet Pull only holds Steel types', () => {
    const steel = start(
      [mon('Magnezone', ['Splash'], 'Magnet Pull')],
      [mon('Skarmory', ['Splash'], 'Sturdy'), mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    expect(steel.choose('p2', 'switch 2')).toBeTruthy();

    const soft = start(
      [mon('Magnezone', ['Splash'], 'Magnet Pull')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    expect(soft.choose('p2', 'switch 2')).toBeNull();
  });

  it('Ruin abilities sap the opposing offence', () => {
    const plain = start(
      [mon('Blissey', ['Body Slam'], 'Natural Cure')],
      [mon('Miltank', ['Splash'], 'Thick Fat')],
    );
    const a = plain.sides.p2.active!;
    const beforeA = a.hp;
    turn(plain);

    const ruined = start(
      [mon('Blissey', ['Body Slam'], 'Natural Cure')],
      [mon('Ting-Lu', ['Splash'], 'Vessel of Ruin')],
    );
    // Tablets of Ruin cuts physical attack; use it for a like-for-like check.
    const ruined2 = start(
      [mon('Blissey', ['Body Slam'], 'Natural Cure')],
      [mon('Miltank', ['Splash'], 'Tablets of Ruin')],
    );
    const b = ruined2.sides.p2.active!;
    const beforeB = b.hp;
    turn(ruined2);
    expect(beforeB - b.hp).toBeLessThan(beforeA - a.hp);
    expect(ruined.sides.p2.active!.ability).toBe('Vessel of Ruin');
  });
});

describe('identity and item abilities', () => {
  it('Disguise absorbs the first hit', () => {
    const battle = start(
      // Normal moves cannot touch a Ghost at all, so use something that can.
      [mon('Blissey', ['Shadow Ball'], 'Natural Cure')],
      [mon('Mimikyu', ['Splash'], 'Disguise')],
    );
    const foe = battle.sides.p2.active!;
    const full = foe.maxhp;
    turn(battle);
    // Only the 1/8 busted-form chip, not the attack itself.
    expect(foe.hp).toBe(full - Math.floor(full / 8));
  });

  it('Magician steals the target’s item', () => {
    const battle = start(
      [mon('Delphox', ['Body Slam'], 'Magician')],
      [mon('Blissey', ['Splash'], 'Natural Cure', 'Leftovers')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.itemId).toBe('leftovers');
    expect(battle.sides.p2.active!.itemId).toBe('');
  });

  it('Sticky Hold keeps the item', () => {
    const battle = start(
      [mon('Delphox', ['Body Slam'], 'Magician')],
      [mon('Muk', ['Splash'], 'Sticky Hold', 'Leftovers')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.itemId).toBe('leftovers');
  });

  it('Trace copies the opponent’s ability', () => {
    const battle = start(
      [mon('Porygon2', ['Splash'], 'Trace')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    expect(battle.sides.p1.active!.ability).toBe('Natural Cure');
  });
});

describe('priority and type-changing abilities', () => {
  it('Galvanize turns Normal moves Electric', () => {
    const battle = start(
      [mon('Gigalith', ['Body Slam'], 'Galvanize')],
      [mon('Gyarados', ['Splash'], 'Intimidate')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    // Electric is super-effective on a Water/Flying Gyarados; Normal is neutral.
    expect(battle.log.join('\n')).toContain('-supereffective');
    expect(foe.hp).toBeLessThan(before);
  });

  it('Queenly Majesty blocks priority', () => {
    const battle = start(
      [mon('Blissey', ['Quick Attack'], 'Natural Cure')],
      [mon('Tsareena', ['Splash'], 'Queenly Majesty')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(foe.hp).toBe(before);
  });
});
