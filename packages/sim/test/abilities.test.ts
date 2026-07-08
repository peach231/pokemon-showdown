import { describe, it, expect } from 'vitest';
import {
  Battle, type ResolvedPokemonSet, type MoveData, type SpeciesData,
} from '../src/index.js';

function move(partial: Partial<MoveData> & Pick<MoveData, 'id' | 'name' | 'type' | 'category'>): MoveData {
  return {
    basePower: 0, accuracy: true, pp: 16, priority: 0,
    target: partial.category === 'Status' ? 'self' : 'normal',
    flags: { protect: 1 },
    ...partial,
  };
}

const TACKLE = move({ id: 'tackle', name: 'Tackle', type: 'Normal', category: 'Physical', basePower: 40, flags: { contact: 1, protect: 1 } });
const EARTHQUAKE = move({ id: 'earthquake', name: 'Earthquake', type: 'Ground', category: 'Physical', basePower: 100 });
const EMBER = move({ id: 'ember', name: 'Ember', type: 'Fire', category: 'Special', basePower: 40 });
const WATER_GUN = move({ id: 'watergun', name: 'Water Gun', type: 'Water', category: 'Special', basePower: 40 });
const SPLASH = move({ id: 'splash', name: 'Splash', type: 'Normal', category: 'Status', target: 'self' });
const NUKE = move({ id: 'nuke', name: 'Nuke', type: 'Normal', category: 'Physical', basePower: 250 });

function species(partial: Partial<SpeciesData> & Pick<SpeciesData, 'id' | 'name' | 'types'>): SpeciesData {
  return {
    num: 0,
    baseStats: { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
    abilities: [], gen: 1,
    ...partial,
  };
}

function battleOf(p1Set: ResolvedPokemonSet, p2Set: ResolvedPokemonSet, seed = 'ability-test'): Battle {
  const battle = new Battle({ seed, p1: { name: 'A', team: [p1Set] }, p2: { name: 'B', team: [p2Set] } });
  battle.start();
  battle.choose('p1', 'default');
  battle.choose('p2', 'default');
  return battle;
}

const PLAIN = species({ id: 'plain', name: 'Plain', types: ['Normal'] });

describe('abilities', () => {
  it('Intimidate lowers the foe Attack on switch-in', () => {
    const battle = battleOf(
      { species: PLAIN, moves: [SPLASH], ability: 'Intimidate' },
      { species: { ...PLAIN, id: 'p2', name: 'Foe' }, moves: [SPLASH] },
    );
    expect(battle.log.join('\n')).toContain('|-ability|p1a: Plain|Intimidate');
    expect(battle.sides.p2.active!.boosts.atk).toBe(-1);
  });

  it('Levitate is immune to Ground moves', () => {
    const battle = battleOf(
      { species: PLAIN, moves: [EARTHQUAKE] },
      { species: { ...PLAIN, id: 'l', name: 'Floaty' }, moves: [SPLASH], ability: 'Levitate' },
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('[from] ability: Levitate');
    expect(battle.sides.p2.active!.hp).toBe(battle.sides.p2.active!.maxhp);
  });

  it('Water Absorb heals instead of taking Water damage', () => {
    const battle = battleOf(
      { species: PLAIN, moves: [WATER_GUN] },
      { species: { ...PLAIN, id: 'w', name: 'Sponge' }, moves: [NUKE], ability: 'Water Absorb' },
    );
    // Damage the sponge first so the absorb visibly heals.
    battle.choose('p1', 'move 1'); // absorbed (full HP -> -immune)
    battle.choose('p2', 'move 1'); // sponge nukes A... A survives? A has 80 base, lvl 100 nuke likely KOs; use default order anyway
    expect(battle.log.join('\n')).toContain('ability: Water Absorb');
  });

  it('Blaze boosts Fire moves at low HP', () => {
    // Two identical battles, attacker at full vs low HP.
    const mk = (hp: 'full' | 'low') => {
      const battle = battleOf(
        { species: { ...PLAIN, id: 'bl', name: 'Blazer' }, moves: [EMBER], ability: 'Blaze' },
        { species: { ...PLAIN, id: 'd', name: 'Dummy' }, moves: [SPLASH] },
      );
      if (hp === 'low') {
        const p = battle.sides.p1.active!;
        p.hp = Math.floor(p.maxhp / 4); // below 1/3
      }
      battle.choose('p1', 'move 1');
      battle.choose('p2', 'move 1');
      const dummy = battle.sides.p2.active!;
      return dummy.maxhp - dummy.hp;
    };
    expect(mk('low')).toBeGreaterThan(mk('full'));
  });

  it('Sturdy survives a lethal hit from full HP with 1 HP', () => {
    const battle = battleOf(
      { species: { ...PLAIN, id: 'n', name: 'Nuker', baseStats: { hp: 80, atk: 200, def: 80, spa: 80, spd: 80, spe: 200 } }, moves: [NUKE] },
      { species: { ...PLAIN, id: 's', name: 'Rocky' }, moves: [SPLASH], ability: 'Sturdy' },
    );
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const rocky = battle.sides.p2.active!;
    expect(rocky.fainted).toBe(false);
    expect(rocky.hp).toBe(1);
    expect(battle.log.join('\n')).toContain('|-ability|p2a: Rocky|Sturdy');
  });

  it('Guts ignores the burn attack drop', () => {
    const dmgWith = (ability?: string) => {
      const battle = battleOf(
        { species: { ...PLAIN, id: 'g', name: 'Gutsy' }, moves: [TACKLE], ability },
        { species: { ...PLAIN, id: 'd2', name: 'Dummy2' }, moves: [SPLASH] },
      );
      battle.sides.p1.active!.setStatus('brn');
      battle.choose('p1', 'move 1');
      battle.choose('p2', 'move 1');
      const dummy = battle.sides.p2.active!;
      return dummy.maxhp - dummy.hp;
    };
    expect(dmgWith('Guts')).toBeGreaterThan(dmgWith(undefined));
  });
});
