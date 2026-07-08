import { describe, it, expect } from 'vitest';
import {
  Battle, calculateDamage, type ResolvedPokemonSet, type MoveData, type SpeciesData,
} from '../src/index.js';

function move(partial: Partial<MoveData> & Pick<MoveData, 'id' | 'name' | 'type' | 'category'>): MoveData {
  return {
    basePower: 0, accuracy: 100, pp: 16, priority: 0,
    target: partial.category === 'Status' ? 'self' : 'normal',
    flags: { protect: 1 },
    ...partial,
  };
}

const WATER_GUN = move({ id: 'watergun', name: 'Water Gun', type: 'Water', category: 'Special', basePower: 40 });
const RAIN_DANCE = move({ id: 'raindance', name: 'Rain Dance', type: 'Water', category: 'Status', weather: 'raindance' });
const SANDSTORM = move({ id: 'sandstorm', name: 'Sandstorm', type: 'Rock', category: 'Status', weather: 'sandstorm' });
const STEALTH_ROCK = move({ id: 'stealthrock', name: 'Stealth Rock', type: 'Rock', category: 'Status', sideCondition: 'stealthrock', target: 'normal' });
const SPLASH = move({ id: 'splash', name: 'Splash', type: 'Normal', category: 'Status', target: 'self' });

function species(partial: Partial<SpeciesData> & Pick<SpeciesData, 'id' | 'name' | 'types'>): SpeciesData {
  return {
    num: 0,
    baseStats: { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
    abilities: [], gen: 1,
    ...partial,
  };
}

const NORMALMON = species({ id: 'normalmon', name: 'Normalmon', types: ['Normal'] });
const ROCKMON = species({ id: 'rockmon', name: 'Rockmon', types: ['Rock'] });
const BIRDFIRE = species({ id: 'birdfire', name: 'Birdfire', types: ['Fire', 'Flying'] });

const set = (sp: SpeciesData, moves: MoveData[]): ResolvedPokemonSet => ({ species: sp, moves });

describe('weather damage modifiers', () => {
  const base = {
    level: 100, basePower: 40, category: 'Special' as const, moveType: 'Water' as const,
    attackStat: 200, defenseStat: 200,
    attackerTypes: [] as const, defenderTypes: ['Normal'] as const,
    isCrit: false, isBurned: false, randomRoll: 0,
  };

  it('rain boosts Water 1.5x and halves Fire', () => {
    const dry = calculateDamage({ ...base }).damage;
    const wet = calculateDamage({ ...base, weather: 'raindance' }).damage;
    expect(wet).toBe(Math.floor(dry * 1.5) + (Math.floor(dry * 1.5) === wet ? 0 : 0));
    expect(wet).toBeGreaterThan(dry);
    const fireDry = calculateDamage({ ...base, moveType: 'Fire' }).damage;
    const fireWet = calculateDamage({ ...base, moveType: 'Fire', weather: 'raindance' }).damage;
    expect(fireWet).toBeLessThan(fireDry);
  });

  it('sun boosts Fire and halves Water', () => {
    const fire = calculateDamage({ ...base, moveType: 'Fire' }).damage;
    const fireSun = calculateDamage({ ...base, moveType: 'Fire', weather: 'sunnyday' }).damage;
    expect(fireSun).toBeGreaterThan(fire);
    const waterSun = calculateDamage({ ...base, weather: 'sunnyday' }).damage;
    expect(waterSun).toBeLessThan(calculateDamage({ ...base }).damage);
  });
});

function startBattle(p1Sets: ResolvedPokemonSet[], p2Sets: ResolvedPokemonSet[], seed = 'field-test'): Battle {
  const battle = new Battle({ seed, p1: { name: 'A', team: p1Sets }, p2: { name: 'B', team: p2Sets } });
  battle.start();
  battle.choose('p1', 'default');
  battle.choose('p2', 'default');
  return battle;
}

describe('weather in battle', () => {
  it('starts, announces upkeep, and expires after 5 turns', () => {
    const battle = startBattle([set(NORMALMON, [RAIN_DANCE, SPLASH])], [set(ROCKMON, [SPLASH])]);
    battle.choose('p1', 'move 1'); // Rain Dance
    battle.choose('p2', 'move 1');
    expect(battle.log).toContain('|-weather|RainDance');
    expect(battle.weather).toBe('raindance');
    for (let i = 0; i < 5; i++) {
      battle.choose('p1', 'move 2');
      battle.choose('p2', 'move 1');
    }
    expect(battle.log).toContain('|-weather|none');
    expect(battle.weather).toBe('');
  });

  it('sandstorm chips non-immune Pokémon 1/16 and spares Rock types', () => {
    const battle = startBattle([set(NORMALMON, [SANDSTORM])], [set(ROCKMON, [SPLASH])]);
    const normal = battle.sides.p1.active!;
    const rock = battle.sides.p2.active!;
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(normal.hp).toBe(normal.maxhp - Math.floor(normal.maxhp / 16));
    expect(rock.hp).toBe(rock.maxhp);
    expect(battle.log.join('\n')).toContain('[from] Sandstorm');
  });

  it('setting the same weather twice fails', () => {
    const battle = startBattle([set(NORMALMON, [RAIN_DANCE])], [set(ROCKMON, [RAIN_DANCE])]);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.filter((l) => l === '|-weather|RainDance')).toHaveLength(1);
    expect(battle.log.join('\n')).toContain('|-fail|');
  });
});

describe('stealth rock', () => {
  it('lays on the foe side and damages switch-ins by Rock effectiveness', () => {
    const battle = startBattle(
      [set(NORMALMON, [STEALTH_ROCK, SPLASH])],
      [set(ROCKMON, [SPLASH]), set(NORMALMON, [SPLASH]), set(BIRDFIRE, [SPLASH])],
    );
    battle.choose('p1', 'move 1'); // rocks onto p2's side
    battle.choose('p2', 'move 1');
    expect(battle.log).toContain('|-sidestart|p2: B|move: Stealth Rock');
    expect(battle.sides.p2.sideConditions.has('stealthrock')).toBe(true);

    // Neutral switch-in: 1/8 max HP.
    battle.choose('p1', 'move 2');
    battle.choose('p2', 'switch 2');
    const normal = battle.sides.p2.active!;
    expect(normal.species.id).toBe('normalmon');
    expect(normal.hp).toBe(normal.maxhp - Math.floor(normal.maxhp / 8));

    // 4x weak (Fire/Flying): half max HP.
    battle.choose('p1', 'move 2');
    battle.choose('p2', 'switch 3');
    const bird = battle.sides.p2.active!;
    expect(bird.species.id).toBe('birdfire');
    expect(bird.hp).toBe(bird.maxhp - Math.floor(bird.maxhp / 2));
    expect(battle.log.join('\n')).toContain('[from] Stealth Rock');
  });

  it('laying rocks twice fails', () => {
    const battle = startBattle([set(NORMALMON, [STEALTH_ROCK])], [set(ROCKMON, [STEALTH_ROCK])]);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.filter((l) => l.startsWith('|-sidestart|p2:'))).toHaveLength(1);
    expect(battle.log.join('\n')).toContain('|-fail|');
  });
});
