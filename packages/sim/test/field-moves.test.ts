import { describe, it, expect } from 'vitest';
import { Battle } from '../src/battle.js';
import { getSpecies, getMove } from '@simple-showdown/data';
import type { ResolvedPokemonSet } from '../src/types.js';

/**
 * Hazards, screens, field effects and the large family of moves whose entire
 * effect lives in Showdown's imperative code. A data-driven engine sees
 * nothing for those, so before this they all resolved as "But it failed!".
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

function start(p1: ResolvedPokemonSet[], p2: ResolvedPokemonSet[], seed = 'field-seed'): Battle {
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

describe('entry hazards', () => {
  it('Spikes stack and hurt more each layer', () => {
    const battle = start(
      [mon('Skarmory', ['Spikes'], 'Sturdy')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    expect(battle.sides.p2.sideConditions.get('spikes')?.layers).toBe(1);
    turn(battle);
    expect(battle.sides.p2.sideConditions.get('spikes')?.layers).toBe(2);

    // Now bring something in and check it takes chip damage.
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'switch 2');
    const incoming = battle.sides.p2.active!;
    expect(incoming.species.name).toBe('Chansey');
    expect(incoming.hp).toBeLessThan(incoming.maxhp);
  });

  it('Toxic Spikes poison, and two layers badly poison', () => {
    const battle = start(
      [mon('Skarmory', ['Toxic Spikes'], 'Sturdy')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    turn(battle);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'switch 2');
    expect(battle.sides.p2.active!.status).toBe('tox');
  });

  it('a grounded Poison type absorbs Toxic Spikes', () => {
    const battle = start(
      [mon('Skarmory', ['Toxic Spikes', 'Splash'], 'Sturdy')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Muk', ['Splash'], 'Poison Touch')],
    );
    turn(battle);
    expect(battle.sides.p2.sideConditions.has('toxicspikes')).toBe(true);
    // Skarmory must NOT re-lay them on the turn Muk walks in.
    battle.choose('p1', 'move 2');
    battle.choose('p2', 'switch 2');
    expect(battle.sides.p2.sideConditions.has('toxicspikes')).toBe(false);
    expect(battle.sides.p2.active!.status).toBe('');
  });

  it('Sticky Web lowers the Speed of a grounded arrival', () => {
    const battle = start(
      [mon('Ribombee', ['Sticky Web'], 'Shield Dust')],
      [mon('Blissey', ['Splash'], 'Natural Cure'), mon('Chansey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'switch 2');
    expect(battle.sides.p2.active!.boosts.spe).toBe(-1);
  });

  it('Heavy-Duty Boots ignore every hazard', () => {
    const battle = start(
      [mon('Skarmory', ['Spikes'], 'Sturdy')],
      [
        mon('Blissey', ['Splash'], 'Natural Cure'),
        mon('Chansey', ['Splash'], 'Natural Cure', 'Heavy-Duty Boots'),
      ],
    );
    turn(battle);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'switch 2');
    const incoming = battle.sides.p2.active!;
    expect(incoming.hp).toBe(incoming.maxhp);
  });

  it('Rapid Spin clears the spinner’s own side', () => {
    const battle = start(
      [mon('Skarmory', ['Spikes', 'Splash'], 'Sturdy')],
      [mon('Donphan', ['Rapid Spin', 'Splash'], 'Sturdy')],
    );
    // Lay the hazard while the spinner does nothing.
    turn(battle, 'move 1', 'move 2');
    expect(battle.sides.p2.sideConditions.has('spikes')).toBe(true);
    // Now spin, while Skarmory does NOT re-lay.
    turn(battle, 'move 2', 'move 1');
    expect(battle.sides.p2.sideConditions.has('spikes')).toBe(false);
  });

  it('Defog strips hazards from both sides', () => {
    const battle = start(
      [mon('Skarmory', ['Stealth Rock', 'Defog'], 'Sturdy')],
      [mon('Blissey', ['Stealth Rock', 'Splash'], 'Natural Cure')],
    );
    turn(battle);
    expect(battle.sides.p1.sideConditions.has('stealthrock')).toBe(true);
    expect(battle.sides.p2.sideConditions.has('stealthrock')).toBe(true);
    turn(battle, 'move 2', 'move 2');
    expect(battle.sides.p1.sideConditions.has('stealthrock')).toBe(false);
    expect(battle.sides.p2.sideConditions.has('stealthrock')).toBe(false);
  });
});

describe('screens and field effects', () => {
  it('Reflect halves physical damage', () => {
    const plain = start(
      [mon('Blissey', ['Body Slam'], 'Natural Cure')],
      [mon('Miltank', ['Splash'], 'Thick Fat')],
    );
    const a = plain.sides.p2.active!;
    const beforeA = a.hp;
    turn(plain);
    const openDamage = beforeA - a.hp;

    const screened = start(
      [mon('Blissey', ['Body Slam'], 'Natural Cure')],
      [mon('Miltank', ['Reflect', 'Splash'], 'Thick Fat')],
    );
    turn(screened, 'move 1', 'move 1');       // Reflect goes up (and takes a hit)
    const b = screened.sides.p2.active!;
    const beforeB = b.hp;
    turn(screened, 'move 1', 'move 2');
    expect(beforeB - b.hp).toBeLessThan(openDamage);
  });

  it('Aurora Veil needs snow', () => {
    const battle = start(
      [mon('Abomasnow', ['Aurora Veil'], 'Overcoat')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    expect(battle.sides.p1.sideConditions.has('auroraveil')).toBe(false);
  });

  it('Tailwind doubles Speed while it lasts', () => {
    const battle = start(
      [mon('Whimsicott', ['Tailwind', 'Splash'], 'Prankster')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    turn(battle);
    expect(battle.sides.p1.sideConditions.has('tailwind')).toBe(true);
    for (let i = 0; i < 5; i++) turn(battle, 'move 2');
    expect(battle.sides.p1.sideConditions.has('tailwind')).toBe(false);
  });

  it('Trick Room reverses the speed order', () => {
    const battle = start(
      [mon('Bronzong', ['Trick Room', 'Body Slam'], 'Levitate')],
      [mon('Electrode', ['Splash'], 'Static')],
    );
    turn(battle);
    expect(battle.trickRoomTurns).toBeGreaterThan(0);
    // Bronzong is far slower than Electrode, so under Trick Room it moves first.
    turn(battle, 'move 2');
    const log = battle.log.join('\n');
    const bronzong = log.lastIndexOf('|move|p1a: Bronzong');
    const electrode = log.lastIndexOf('|move|p2a: Electrode');
    expect(bronzong).toBeLessThan(electrode);
  });
});

describe('coded status moves', () => {
  it('Rest fully heals and puts the user to sleep', () => {
    const battle = start(
      [mon('Snorlax', ['Rest'], 'Thick Fat')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const p = battle.sides.p1.active!;
    p.damage(Math.floor(p.maxhp / 2));
    turn(battle);
    expect(p.hp).toBe(p.maxhp);
    expect(p.status).toBe('slp');
  });

  it('Synthesis heals half, and more in sun', () => {
    const plain = start(
      [mon('Venusaur', ['Synthesis'], 'Overgrow')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const a = plain.sides.p1.active!;
    a.damage(a.maxhp - 1);
    turn(plain);
    const normalHeal = a.hp;

    const sunny = start(
      [mon('Venusaur', ['Synthesis'], 'Overgrow')],
      [mon('Torkoal', ['Splash'], 'Drought')],
    );
    const b = sunny.sides.p1.active!;
    b.damage(b.maxhp - 1);
    turn(sunny);
    expect(b.hp).toBeGreaterThan(normalHeal);
  });

  it('Pain Split averages both HP totals', () => {
    const battle = start(
      [mon('Rotom', ['Pain Split'], 'Levitate')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const me = battle.sides.p1.active!;
    const foe = battle.sides.p2.active!;
    me.damage(me.maxhp - 10);
    turn(battle);
    expect(me.hp).toBeGreaterThan(10);
    expect(foe.hp).toBeLessThan(foe.maxhp);
  });

  it('Haze wipes every stat change', () => {
    const battle = start(
      [mon('Blissey', ['Swords Dance', 'Haze'], 'Natural Cure')],
      [mon('Miltank', ['Splash'], 'Thick Fat')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.boosts.atk).toBe(2);
    turn(battle, 'move 2');
    expect(battle.sides.p1.active!.boosts.atk).toBe(0);
  });

  it('Belly Drum maxes Attack for half the user’s HP', () => {
    const battle = start(
      [mon('Azumarill', ['Belly Drum'], 'Huge Power')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const p = battle.sides.p1.active!;
    const before = p.hp;
    turn(battle);
    expect(p.boosts.atk).toBe(6);
    expect(p.hp).toBeLessThan(before);
  });

  it('Heal Bell cures the whole team', () => {
    const battle = start(
      [mon('Blissey', ['Heal Bell'], 'Serene Grace'), mon('Chansey', ['Splash'], 'Serene Grace')],
      [mon('Miltank', ['Splash'], 'Thick Fat')],
    );
    battle.sides.p1.team[1]!.setStatus('brn');
    battle.sides.p1.active!.setStatus('par');
    turn(battle);
    expect(battle.sides.p1.active!.status).toBe('');
    expect(battle.sides.p1.team[1]!.status).toBe('');
  });

  it('Wish heals the Pokémon out two turns later', () => {
    const battle = start(
      [mon('Alomomola', ['Wish', 'Splash'], 'Regenerator')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const p = battle.sides.p1.active!;
    p.damage(Math.floor(p.maxhp / 2));
    turn(battle);
    const afterWish = p.hp;
    turn(battle, 'move 2');
    expect(p.hp).toBeGreaterThan(afterWish);
  });

  it('Trick swaps items', () => {
    const battle = start(
      [mon('Rotom', ['Trick'], 'Levitate', 'Choice Scarf')],
      [mon('Blissey', ['Splash'], 'Natural Cure', 'Leftovers')],
    );
    turn(battle);
    expect(battle.sides.p1.active!.itemId).toBe('leftovers');
    expect(battle.sides.p2.active!.itemId).toBe('choicescarf');
  });
});

describe('other coded move behaviour', () => {
  it('Knock Off removes the item and hits harder for it', () => {
    // A physically bulky target, so it survives to be knocked.
    const battle = start(
      [mon('Weavile', ['Knock Off'], 'Pressure')],
      [mon('Corviknight', ['Splash'], 'Pressure', 'Leftovers')],
    );
    const foe = battle.sides.p2.active!;
    turn(battle);
    expect(foe.fainted, 'target must survive for the knock to matter').toBe(false);
    expect(foe.itemId).toBe('');
    expect(battle.log.join('\n')).toContain('Knock Off');
  });

  it('phazing drags in a random team-mate', () => {
    const battle = start(
      [mon('Skarmory', ['Whirlwind'], 'Sturdy')],
      [
        mon('Blissey', ['Splash'], 'Natural Cure'),
        mon('Chansey', ['Splash'], 'Natural Cure'),
        mon('Miltank', ['Splash'], 'Thick Fat'),
      ],
    );
    expect(battle.sides.p2.active!.species.name).toBe('Blissey');
    turn(battle);
    expect(battle.sides.p2.active!.species.name).not.toBe('Blissey');
  });

  it('Fake Out only works on the turn the user arrives', () => {
    const battle = start(
      [mon('Ambipom', ['Fake Out', 'Splash'], 'Technician')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(foe.hp, 'turn 1 should connect').toBeLessThan(before);
    const mid = foe.hp;
    turn(battle);
    expect(foe.hp, 'turn 2 should fail').toBe(mid);
  });

  it('Endeavor drags the target down to the user’s HP', () => {
    const battle = start(
      [mon('Swampert', ['Endeavor'], 'Torrent')],
      [mon('Blissey', ['Splash'], 'Natural Cure')],
    );
    const me = battle.sides.p1.active!;
    const foe = battle.sides.p2.active!;
    me.damage(me.maxhp - 20);
    turn(battle);
    expect(foe.hp).toBe(20);
  });
});

describe('conditional-power moves', () => {
  /** Damage one Pokémon deals to another with a single move, on turn 1. */
  function dmg(
    attacker: ResolvedPokemonSet, defender: ResolvedPokemonSet, setup?: (b: Battle) => void,
  ): number {
    const battle = start([attacker], [defender]);
    setup?.(battle);
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    return before - foe.hp;
  }

  it('Facade doubles when the user is statused (and ignores the burn penalty)', () => {
    const clean = dmg(mon('Ursaluna', ['Facade'], 'Pressure'), mon('Corviknight', ['Splash'], 'Pressure'));
    const burned = dmg(
      mon('Ursaluna', ['Facade'], 'Pressure'), mon('Corviknight', ['Splash'], 'Pressure'),
      (b) => { b.sides.p1.active!.setStatus('brn'); },
    );
    expect(burned).toBeGreaterThan(clean);
  });

  it('Hex doubles against a statused target', () => {
    const clean = dmg(mon('Dragapult', ['Hex'], 'Infiltrator'), mon('Corviknight', ['Splash'], 'Pressure'));
    const poisoned = dmg(
      mon('Dragapult', ['Hex'], 'Infiltrator'), mon('Corviknight', ['Splash'], 'Pressure'),
      (b) => { b.sides.p2.active!.setStatus('psn'); },
    );
    expect(poisoned).toBeGreaterThan(clean);
  });

  it('Acrobatics doubles with no held item', () => {
    const held = dmg(
      mon('Tornadus', ['Acrobatics'], 'Prankster', 'Leftovers'),
      mon('Corviknight', ['Splash'], 'Pressure'),
    );
    const empty = dmg(mon('Tornadus', ['Acrobatics'], 'Prankster'), mon('Corviknight', ['Splash'], 'Pressure'));
    expect(empty).toBeGreaterThan(held);
  });

  it('Stored Power grows with the user’s boosts', () => {
    const flat = dmg(mon('Espeon', ['Stored Power'], 'Synchronize'), mon('Corviknight', ['Splash'], 'Pressure'));
    const boosted = dmg(
      mon('Espeon', ['Stored Power'], 'Synchronize'), mon('Corviknight', ['Splash'], 'Pressure'),
      (b) => { b.sides.p1.active!.boosts.spa = 4; b.sides.p1.active!.boosts.spe = 2; },
    );
    expect(boosted).toBeGreaterThan(flat * 2);
  });

  it('Foul Play uses the target’s Attack', () => {
    // A physically weak user against a strong attacker still hits hard.
    const vsStrong = dmg(mon('Sableye', ['Foul Play'], 'Prankster'), mon('Rampardos', ['Splash'], 'Mold Breaker'));
    const vsWeak = dmg(mon('Sableye', ['Foul Play'], 'Prankster'), mon('Chansey', ['Splash'], 'Natural Cure'));
    expect(vsStrong).toBeGreaterThan(vsWeak);
  });

  it('Psyshock hits physical Defence', () => {
    // Chansey has huge Sp. Def and paper Defence, so Psyshock beats Psychic.
    const psychic = dmg(mon('Espeon', ['Psychic'], 'Synchronize'), mon('Chansey', ['Splash'], 'Natural Cure'));
    const psyshock = dmg(mon('Espeon', ['Psyshock'], 'Synchronize'), mon('Chansey', ['Splash'], 'Natural Cure'));
    expect(psyshock).toBeGreaterThan(psychic);
  });

  it('Weather Ball changes type with the weather', () => {
    const battle = start(
      [mon('Politoed', ['Weather Ball'], 'Drizzle')],
      [mon('Charizard', ['Splash'], 'Blaze')],
    );
    expect(battle.weather).toBe('raindance');
    turn(battle);
    // Water Weather Ball is super effective on Fire/Flying.
    expect(battle.log.join('\n')).toContain('-supereffective');
  });

  it('Brick Break shatters a screen', () => {
    const battle = start(
      [mon('Machamp', ['Brick Break', 'Splash'], 'No Guard')],
      [mon('Bronzong', ['Reflect', 'Splash'], 'Levitate')],
    );
    // Put the screen up first, then break it on the following turn.
    turn(battle, 'move 2', 'move 1');
    expect(battle.sides.p2.sideConditions.has('reflect')).toBe(true);
    turn(battle, 'move 1', 'move 2');
    expect(battle.sides.p2.sideConditions.has('reflect')).toBe(false);
  });

  it('Poltergeist fails against an empty-handed target', () => {
    const battle = start(
      [mon('Dragapult', ['Poltergeist'], 'Infiltrator')],
      [mon('Corviknight', ['Splash'], 'Pressure')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(foe.hp).toBe(before);
  });

  it('Clear Smog resets the target’s boosts', () => {
    // Poison cannot touch a Steel type, so use a target it can actually hit.
    const battle = start(
      [mon('Weezing', ['Clear Smog', 'Splash'], 'Levitate')],
      [mon('Machamp', ['Bulk Up', 'Splash'], 'No Guard')],
    );
    // Let the boost land first (Weezing outspeeds), then wipe it.
    turn(battle, 'move 2', 'move 1');
    expect(battle.sides.p2.active!.boosts.atk).toBe(1);
    turn(battle, 'move 1', 'move 2');
    expect(battle.sides.p2.active!.boosts.atk).toBe(0);
  });

  it('Counter returns double the physical damage taken', () => {
    const battle = start(
      [mon('Wobbuffet', ['Counter'], 'Shadow Tag')],
      [mon('Rampardos', ['Body Slam'], 'Mold Breaker')],
    );
    const foe = battle.sides.p2.active!;
    const before = foe.hp;
    turn(battle);
    expect(foe.hp).toBeLessThan(before);
  });

  it('Transform copies the opponent', () => {
    const battle = start(
      [mon('Ditto', ['Transform'], 'Limber')],
      [mon('Corviknight', ['Splash'], 'Pressure')],
    );
    turn(battle);
    const me = battle.sides.p1.active!;
    expect(me.types).toEqual(battle.sides.p2.active!.types);
    expect(me.ability).toBe('Pressure');
  });
});
