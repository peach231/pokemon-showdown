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

const GIGA_IMPACT = move({ id: 'gigaimpact', name: 'Giga Impact', type: 'Normal', category: 'Physical', basePower: 150, flags: { contact: 1, protect: 1, recharge: 1 } });
const EXPLOSION = move({ id: 'explosion', name: 'Explosion', type: 'Normal', category: 'Physical', basePower: 250, selfDestruct: true });
const SKY_ATTACK = move({ id: 'skyattack', name: 'Sky Attack', type: 'Flying', category: 'Physical', basePower: 140, flags: { charge: 1, protect: 1 } });
const SOLAR_BEAM = move({ id: 'solarbeam', name: 'Solar Beam', type: 'Grass', category: 'Special', basePower: 120, flags: { charge: 1, protect: 1 } });
const FOCUS_PUNCH = move({ id: 'focuspunch', name: 'Focus Punch', type: 'Fighting', category: 'Physical', basePower: 150, priority: -3, flags: { contact: 1, protect: 1 } });
const SUCKER_PUNCH = move({ id: 'suckerpunch', name: 'Sucker Punch', type: 'Dark', category: 'Physical', basePower: 70, priority: 1, flags: { contact: 1, protect: 1 } });
const WATER_SPOUT = move({ id: 'waterspout', name: 'Water Spout', type: 'Water', category: 'Special', basePower: 150 });
const GYRO_BALL = move({ id: 'gyroball', name: 'Gyro Ball', type: 'Steel', category: 'Physical', basePower: 0, flags: { contact: 1, protect: 1 } });
const GRASS_KNOT = move({ id: 'grassknot', name: 'Grass Knot', type: 'Grass', category: 'Special', basePower: 0 });
const SUPER_FANG = move({ id: 'superfang', name: 'Super Fang', type: 'Normal', category: 'Physical', basePower: 1, accuracy: 90, flags: { contact: 1, protect: 1 } });
const BODY_PRESS = move({ id: 'bodypress', name: 'Body Press', type: 'Fighting', category: 'Physical', basePower: 80, overrideOffensiveStat: 'def', flags: { contact: 1, protect: 1 } });
const TACKLE = move({ id: 'tackle', name: 'Tackle', type: 'Normal', category: 'Physical', basePower: 40, flags: { contact: 1, protect: 1 } });
const SPLASH = move({ id: 'splash', name: 'Splash', type: 'Normal', category: 'Status', target: 'self' });
const RAIN_DANCE = move({ id: 'raindance', name: 'Rain Dance', type: 'Water', category: 'Status', weather: 'raindance' });
const SUNNY_DAY = move({ id: 'sunnyday', name: 'Sunny Day', type: 'Fire', category: 'Status', weather: 'sunnyday' });

function species(partial: Partial<SpeciesData> & Pick<SpeciesData, 'id' | 'name' | 'types'>): SpeciesData {
  return {
    num: 0,
    baseStats: { hp: 100, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
    abilities: [], gen: 1, weightkg: 50,
    ...partial,
  };
}

const A = species({ id: 'amon', name: 'Amon', types: ['Normal'] });
const B = species({ id: 'bmon', name: 'Bmon', types: ['Normal'], baseStats: { hp: 200, atk: 80, def: 120, spa: 80, spd: 120, spe: 60 } });

function startBattle(p1: ResolvedPokemonSet, p2: ResolvedPokemonSet, seed = 'mech'): Battle {
  const battle = new Battle({ seed, p1: { name: 'P1', team: [p1] }, p2: { name: 'P2', team: [p2] } });
  battle.start();
  battle.choose('p1', 'default');
  battle.choose('p2', 'default');
  return battle;
}

const set = (sp: SpeciesData, moves: MoveData[]): ResolvedPokemonSet => ({ species: sp, moves });

describe('recharge moves', () => {
  it('forces a recharge turn after a hit', () => {
    const battle = startBattle(set(A, [GIGA_IMPACT]), set(B, [SPLASH]));
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|-mustrecharge|p1a: Amon');
    battle.choose('p1', 'move 1'); // spent recharging
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|cant|p1a: Amon|recharge');
    // Exactly one hit landed across both turns.
    expect(battle.log.filter((l) => l.startsWith('|-damage|p2a:')).length).toBe(1);
  });
});

describe('self-destructing moves', () => {
  it('the user faints after Explosion', () => {
    const battle = startBattle(set(A, [EXPLOSION]), set(B, [SPLASH]));
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.active!.fainted).toBe(true);
    expect(battle.log.join('\n')).toContain('|faint|p1a: Amon');
  });

  it('no boom against a Ghost (immune target)', () => {
    const ghost = species({ id: 'ghosty', name: 'Ghosty', types: ['Ghost'] });
    const battle = startBattle(set(A, [EXPLOSION]), set(ghost, [SPLASH]));
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.active!.fainted).toBe(false);
  });
});

describe('two-turn charge moves', () => {
  it('charges turn 1, strikes turn 2', () => {
    const battle = startBattle(set(A, [SKY_ATTACK]), set(B, [SPLASH]));
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|-prepare|p1a: Amon|Sky Attack');
    expect(battle.sides.p2.active!.hp).toBe(battle.sides.p2.active!.maxhp);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p2.active!.hp).toBeLessThan(battle.sides.p2.active!.maxhp);
  });

  it('Solar Beam skips the charge in sun', () => {
    const battle = startBattle(set(A, [SOLAR_BEAM, SUNNY_DAY]), set(B, [SPLASH]));
    battle.choose('p1', 'move 2'); // set sun
    battle.choose('p2', 'move 1');
    battle.choose('p1', 'move 1'); // fires immediately
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).not.toContain('|-prepare|');
    expect(battle.sides.p2.active!.hp).toBeLessThan(battle.sides.p2.active!.maxhp);
  });
});

describe('Focus Punch', () => {
  it('fails when hit first, works when not', () => {
    // Foe is faster (priority 0 vs our -3) and attacks: focus broken.
    const battle = startBattle(set(A, [FOCUS_PUNCH]), set(B, [TACKLE, SPLASH]));
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1'); // Tackle hits first
    expect(battle.log.join('\n')).toContain('|cant|p1a: Amon|Focus Punch');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 2'); // Splash: no damage -> punch lands
    expect(battle.log.join('\n')).toContain('|move|p1a: Amon|Focus Punch|');
  });
});

describe('Sucker Punch', () => {
  it('hits an attacking target, fails vs status', () => {
    const battle = startBattle(set(A, [SUCKER_PUNCH]), set(B, [TACKLE, SPLASH]));
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1'); // foe attacks: sucker punch connects first
    const log1 = battle.log.join('\n');
    expect(log1).toContain('|move|p1a: Amon|Sucker Punch|');
    expect(log1).not.toContain('|-fail|p1a: Amon');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 2'); // foe uses status: fails
    expect(battle.log.join('\n')).toContain('|-fail|p1a: Amon');
  });
});

describe('computed base powers', () => {
  it('Water Spout weakens with missing HP', () => {
    const atFull = startBattle(set(A, [WATER_SPOUT]), set(B, [SPLASH]), 'ws1');
    atFull.choose('p1', 'move 1');
    atFull.choose('p2', 'move 1');
    const fullDmg = atFull.sides.p2.active!.maxhp - atFull.sides.p2.active!.hp;

    const atLow = startBattle(set(A, [WATER_SPOUT]), set(B, [SPLASH]), 'ws1');
    atLow.sides.p1.active!.hp = Math.floor(atLow.sides.p1.active!.maxhp / 4);
    atLow.choose('p1', 'move 1');
    atLow.choose('p2', 'move 1');
    const lowDmg = atLow.sides.p2.active!.maxhp - atLow.sides.p2.active!.hp;
    expect(lowDmg).toBeLessThan(fullDmg);
    expect(lowDmg).toBeGreaterThan(0);
  });

  it('Gyro Ball hits harder the slower the user', () => {
    const slow = species({ ...A, id: 'slowy', name: 'Slowy', baseStats: { ...A.baseStats, spe: 20 } });
    const fast = species({ ...A, id: 'fasty', name: 'Fasty', baseStats: { ...A.baseStats, spe: 160 } });
    const asSlow = startBattle(set(slow, [GYRO_BALL]), set(fast, [SPLASH]), 'gb');
    asSlow.choose('p1', 'move 1');
    asSlow.choose('p2', 'move 1');
    const slowDmg = asSlow.sides.p2.active!.maxhp - asSlow.sides.p2.active!.hp;

    const asFast = startBattle(set(fast, [GYRO_BALL]), set(slow, [SPLASH]), 'gb');
    asFast.choose('p1', 'move 1');
    asFast.choose('p2', 'move 1');
    const fastDmg = asFast.sides.p2.active!.maxhp - asFast.sides.p2.active!.hp;
    expect(slowDmg).toBeGreaterThan(fastDmg);
  });

  it('Grass Knot scales with target weight', () => {
    const heavy = species({ ...B, id: 'heavy', name: 'Heavy', weightkg: 400 });
    const light = species({ ...B, id: 'light', name: 'Light', weightkg: 5 });
    const vsHeavy = startBattle(set(A, [GRASS_KNOT]), set(heavy, [SPLASH]), 'gk');
    vsHeavy.choose('p1', 'move 1');
    vsHeavy.choose('p2', 'move 1');
    const heavyDmg = vsHeavy.sides.p2.active!.maxhp - vsHeavy.sides.p2.active!.hp;

    const vsLight = startBattle(set(A, [GRASS_KNOT]), set(light, [SPLASH]), 'gk');
    vsLight.choose('p1', 'move 1');
    vsLight.choose('p2', 'move 1');
    const lightDmg = vsLight.sides.p2.active!.maxhp - vsLight.sides.p2.active!.hp;
    expect(heavyDmg).toBeGreaterThan(lightDmg);
  });

  it('Super Fang halves current HP', () => {
    const battle = startBattle(set(A, [SUPER_FANG, SPLASH]), set(B, [SPLASH]));
    const target = battle.sides.p2.active!;
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(target.hp).toBe(target.maxhp - Math.floor(target.maxhp / 2));
  });

  it('Body Press attacks with Defense', () => {
    const tank = species({ ...A, id: 'tank', name: 'Tank', baseStats: { hp: 100, atk: 10, def: 150, spa: 10, spd: 80, spe: 80 } });
    const battle = startBattle(set(tank, [BODY_PRESS, TACKLE]), set(B, [SPLASH]));
    battle.choose('p1', 'move 1'); // Body Press off 150 Def
    battle.choose('p2', 'move 1');
    const pressDmg = battle.sides.p2.active!.maxhp - battle.sides.p2.active!.hp;
    // 80 BP off 150 Def must beat 40 BP off 10 Atk by a mile.
    expect(pressDmg).toBeGreaterThan(20);
  });
});
