import { describe, it, expect } from 'vitest';
import { Battle } from '../src/battle.js';
import { getSpecies, getMove } from '@simple-showdown/data';
import type { ResolvedPokemonSet } from '../src/types.js';

/**
 * Abilities that were previously absent from the engine entirely: the name
 * appeared on the Pokémon, and nothing in the battle loop ever looked at it.
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

function start(p1: ResolvedPokemonSet[], p2: ResolvedPokemonSet[], seed = 'ability-seed'): Battle {
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

/** Play one turn with both sides using their first move. */
function turn(battle: Battle, p1Move = 'move 1', p2Move = 'move 1'): void {
  battle.choose('p1', p1Move);
  battle.choose('p2', p2Move);
}

describe('absorb-and-boost abilities', () => {
  const cases: { ability: string; move: string; stat: 'atk' | 'spa' | 'spe' | 'def' }[] = [
    { ability: 'Sap Sipper', move: 'Energy Ball', stat: 'atk' },
    { ability: 'Lightning Rod', move: 'Thunderbolt', stat: 'spa' },
    { ability: 'Storm Drain', move: 'Surf', stat: 'spa' },
    { ability: 'Motor Drive', move: 'Thunderbolt', stat: 'spe' },
    { ability: 'Well-Baked Body', move: 'Flamethrower', stat: 'def' },
  ];
  for (const { ability, move, stat } of cases) {
    it(`${ability} blocks ${move} and raises ${stat}`, () => {
      const battle = start(
        [mon('Blissey', [move], 'Natural Cure')],
        [mon('Miltank', ['Splash'], ability)],
      );
      const target = battle.sides.p2.active!;
      const hpBefore = target.hp;
      turn(battle);
      expect(target.hp, 'should take no damage').toBe(hpBefore);
      expect(target.boosts[stat], `${stat} should rise`).toBeGreaterThan(0);
    });
  }

  it('Earth Eater heals instead of taking Ground damage', () => {
    const battle = start(
      [mon('Blissey', ['Earthquake'], 'Natural Cure')],
      [mon('Miltank', ['Splash'], 'Earth Eater')],
    );
    const target = battle.sides.p2.active!;
    target.damage(Math.floor(target.maxhp / 2));
    const before = target.hp;
    turn(battle);
    expect(target.hp).toBeGreaterThan(before);
  });
});

describe('stat-drop protection and retaliation', () => {
  it('Clear Body refuses a foe-inflicted drop', () => {
    const battle = start(
      [mon('Blissey', ['Growl'], 'Natural Cure')],
      [mon('Metagross', ['Splash'], 'Clear Body')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.boosts.atk).toBe(0);
  });

  it('Defiant answers a drop with +2 Attack', () => {
    const battle = start(
      [mon('Blissey', ['Growl'], 'Natural Cure')],
      [mon('Bisharp', ['Splash'], 'Defiant')],
    );
    turn(battle);
    // -1 from Growl, then +2 from Defiant.
    expect(battle.sides.p2.active!.boosts.atk).toBe(1);
  });

  it('Competitive answers a drop with +2 Sp. Atk', () => {
    const battle = start(
      [mon('Blissey', ['Growl'], 'Natural Cure')],
      [mon('Milotic', ['Splash'], 'Competitive')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.boosts.spa).toBe(2);
  });

  it('Contrary turns a drop into a boost', () => {
    const battle = start(
      [mon('Blissey', ['Growl'], 'Natural Cure')],
      [mon('Serperior', ['Splash'], 'Contrary')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.boosts.atk).toBe(1);
  });

  it('a self-inflicted drop does NOT trigger Defiant', () => {
    const battle = start(
      [mon('Bisharp', ['Close Combat'], 'Defiant')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    const user = battle.sides.p1.active!;
    // Close Combat drops its own Def/SpD; Defiant must stay silent.
    expect(user.boosts.def).toBeLessThan(0);
    expect(user.boosts.atk).toBe(0);
  });
});

describe('damage-modifying abilities', () => {
  function damageWith(ability: string, attackerSpecies: string, move: string, defender: string): number {
    const battle = start(
      [mon(attackerSpecies, [move], ability)],
      [mon(defender, ['Splash'], 'Natural Cure')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    return before - foe.hp;
  }

  it('Tinted Lens doubles resisted damage', () => {
    // Bug vs Steel is resisted.
    const withIt = damageWith('Tinted Lens', 'Yanmega', 'Bug Buzz', 'Skarmory');
    const without = damageWith('Speed Boost', 'Yanmega', 'Bug Buzz', 'Skarmory');
    expect(withIt).toBeGreaterThan(without);
  });

  it('Heatproof halves Fire damage taken', () => {
    const normal = start([mon('Blissey', ['Flamethrower'], 'Natural Cure')], [mon('Bronzong', ['Splash'], 'Levitate')]);
    const foeA = normal.sides.p2.active!;
    const beforeA = foeA.hp;
    turn(normal);
    const dmgNormal = beforeA - foeA.hp;

    const proofed = start([mon('Blissey', ['Flamethrower'], 'Natural Cure')], [mon('Bronzong', ['Splash'], 'Heatproof')]);
    const foeB = proofed.sides.p2.active!;
    const beforeB = foeB.hp;
    turn(proofed);
    const dmgProof = beforeB - foeB.hp;

    expect(dmgProof).toBeLessThan(dmgNormal);
  });

  it('Unaware ignores the foe’s boosts', () => {
    const battle = start(
      [mon('Blissey', ['Swords Dance', 'Body Slam'], 'Natural Cure')],
      [mon('Clefable', ['Splash'], 'Unaware')],
    );
    turn(battle);                       // p1 sets up +2 Atk
    expect(battle.sides.p1.active!.boosts.atk).toBe(2);
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle, 'move 2');             // attack into Unaware
    const boostedDamage = before - foe.hp;

    const plain = start(
      [mon('Blissey', ['Swords Dance', 'Body Slam'], 'Natural Cure')],
      [mon('Clefable', ['Splash'], 'Cute Charm')],
    );
    turn(plain);
    const foe2 = plain.sides.p2.active!;
    const before2 = foe2.hp;
    turn(plain, 'move 2');
    expect(boostedDamage).toBeLessThan(before2 - foe2.hp);
  });
});

describe('status abilities', () => {
  it('Purifying Salt cannot be statused', () => {
    const battle = start(
      [mon('Blissey', ['Toxic'], 'Natural Cure')],
      [mon('Garganacl', ['Splash'], 'Purifying Salt')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.status).toBe('');
  });

  it('Synchronize passes the status back', () => {
    const battle = start(
      [mon('Blissey', ['Toxic'], 'Natural Cure')],
      [mon('Umbreon', ['Splash'], 'Synchronize')],
    );
    turn(battle);
    expect(battle.sides.p2.active!.status).toBe('tox');
    expect(battle.sides.p1.active!.status).toBe('tox');
  });

  it('Shell Armor prevents critical hits', () => {
    // 200 turns of attacks: with Shell Armor none may crit.
    const battle = start(
      [mon('Blissey', ['Body Slam'], 'Natural Cure')],
      [mon('Cloyster', ['Recover'], 'Shell Armor')],
    );
    for (let i = 0; i < 60 && !battle.ended; i++) turn(battle);
    expect(battle.log.join('\n')).not.toContain('-crit');
  });
});

describe('accuracy abilities', () => {
  it('No Guard makes an inaccurate move always land', () => {
    const battle = start(
      [mon('Machamp', ['Dynamic Punch'], 'No Guard')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    for (let i = 0; i < 20 && !battle.ended; i++) turn(battle);
    expect(battle.log.join('\n')).not.toContain('-miss');
  });
});

describe('mould-breaking and bypass abilities', () => {
  it('Mold Breaker ignores a defensive ability', () => {
    // Levitate normally makes Ground moves miss entirely.
    const blocked = start(
      [mon('Blissey', ['Earthquake'], 'Natural Cure')],
      [mon('Bronzong', ['Splash'], 'Levitate')],
    );
    const a = blocked.sides.p2.active!;
    const beforeA = a.hp;
    turn(blocked);
    expect(a.hp, 'Levitate should block it').toBe(beforeA);

    const broken = start(
      [mon('Pangoro', ['Earthquake'], 'Mold Breaker')],
      [mon('Bronzong', ['Splash'], 'Levitate')],
    );
    const b = broken.sides.p2.active!;
    const beforeB = b.hp;
    turn(broken);
    expect(b.hp, 'Mold Breaker should punch through').toBeLessThan(beforeB);
  });

  it('Scrappy lets a Normal move hit a Ghost, and does not stick', () => {
    const battle = start(
      [mon('Decidueye-Hisui', ['Body Slam'], 'Scrappy')],
      [mon('Gengar', ['Splash'], 'Cursed Body')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(foe.hp).toBeLessThan(before);
    // The Ghost typing must be back afterwards.
    expect(foe.types).toContain('Ghost');
  });

  it('Infiltrator ignores a Substitute', () => {
    const battle = start(
      [mon('Blissey', ['Substitute'], 'Natural Cure')],
      [mon('Chandelure', ['Flamethrower'], 'Infiltrator')],
    );
    turn(battle);
    const sub = battle.sides.p1.active!;
    expect(sub.hasVolatile('substitute')).toBe(true);
    const before = sub.hp;
    turn(battle, 'move 1');
    // Damage must reach the Pokémon itself, not just the Substitute.
    expect(sub.hp).toBeLessThan(before);
  });

  it('Liquid Ooze punishes a drain move', () => {
    const battle = start(
      [mon('Venusaur', ['Giga Drain'], 'Overgrow')],
      [mon('Tentacruel', ['Splash'], 'Liquid Ooze')],
    );
    const user = battle.sides.p1.active!;
    user.damage(Math.floor(user.maxhp / 2));
    const before = user.hp;
    turn(battle);
    expect(user.hp, 'draining into Liquid Ooze should hurt').toBeLessThan(before);
  });
});
