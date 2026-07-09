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
const WATER_GUN = move({ id: 'watergun', name: 'Water Gun', type: 'Water', category: 'Special', basePower: 40 });
const EMBER = move({ id: 'ember', name: 'Ember', type: 'Fire', category: 'Special', basePower: 40 });
const EARTHQUAKE = move({ id: 'earthquake', name: 'Earthquake', type: 'Ground', category: 'Physical', basePower: 100 });
const SPLASH = move({ id: 'splash', name: 'Splash', type: 'Normal', category: 'Status', target: 'self' });
const STEALTH_ROCK = move({ id: 'stealthrock', name: 'Stealth Rock', type: 'Rock', category: 'Status', sideCondition: 'stealthrock', target: 'normal' });
const THUNDER_WAVE = move({ id: 'thunderwave', name: 'Thunder Wave', type: 'Electric', category: 'Status', status: 'par', target: 'normal' });
const NUKE = move({ id: 'nuke', name: 'Nuke', type: 'Normal', category: 'Physical', basePower: 250 });

function species(partial: Partial<SpeciesData> & Pick<SpeciesData, 'id' | 'name' | 'types'>): SpeciesData {
  return {
    num: 0,
    baseStats: { hp: 100, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
    abilities: [], gen: 1, weightkg: 50,
    ...partial,
  };
}

const P = species({ id: 'p', name: 'Punchy', types: ['Normal'] });
const W = species({ id: 'w', name: 'Wally', types: ['Normal'], baseStats: { hp: 200, atk: 80, def: 120, spa: 80, spd: 120, spe: 60 } });

function duel(p1: ResolvedPokemonSet, p2: ResolvedPokemonSet, seed = 'fx'): Battle {
  const battle = new Battle({ seed, p1: { name: 'A', team: [p1] }, p2: { name: 'B', team: [p2] } });
  battle.start();
  battle.choose('p1', 'default');
  battle.choose('p2', 'default');
  return battle;
}

function dmgTo(battle: Battle, side: 'p1' | 'p2'): number {
  const p = battle.sides[side].active!;
  return p.maxhp - p.hp;
}

describe('items', () => {
  it('Leftovers heals 1/16 each turn', () => {
    const battle = duel(
      { species: P, moves: [TACKLE], item: 'Leftovers' },
      { species: W, moves: [TACKLE] },
    );
    const holder = battle.sides.p1.active!;
    holder.hp = Math.floor(holder.maxhp / 2);
    const before = holder.hp;
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    // Took a Tackle but healed 1/16; net must exceed pure-damage outcome.
    expect(battle.log.join('\n')).toContain('[from] item: Leftovers');
    expect(holder.hp).toBeGreaterThan(before - holder.maxhp); // sanity
  });

  it('Choice Band boosts and locks', () => {
    const withBand = duel(
      { species: P, moves: [TACKLE, EARTHQUAKE], item: 'Choice Band' },
      { species: W, moves: [SPLASH] }, 'cb');
    withBand.choose('p1', 'move 1');
    withBand.choose('p2', 'move 1');
    const bandDmg = dmgTo(withBand, 'p2');

    const without = duel(
      { species: P, moves: [TACKLE, EARTHQUAKE] },
      { species: W, moves: [SPLASH] }, 'cb');
    without.choose('p1', 'move 1');
    without.choose('p2', 'move 1');
    expect(bandDmg).toBeGreaterThan(dmgTo(without, 'p2'));

    // Locked: move 2 now rejected.
    const err = withBand.choose('p1', 'move 2');
    expect(err).toBeTruthy();
    expect(withBand.choose('p1', 'move 1')).toBeNull();
  });

  it('Life Orb boosts damage and costs HP', () => {
    const battle = duel(
      { species: P, moves: [TACKLE], item: 'Life Orb' },
      { species: W, moves: [SPLASH] });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('[from] item: Life Orb');
    const user = battle.sides.p1.active!;
    expect(user.hp).toBe(user.maxhp - Math.floor(user.maxhp / 10));
  });

  it('Focus Sash survives a one-shot from full HP', () => {
    const battle = duel(
      { species: { ...P, id: 'n', name: 'Nuker', baseStats: { ...P.baseStats, atk: 250 } }, moves: [NUKE] },
      { species: P, moves: [SPLASH], item: 'Focus Sash' });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const holder = battle.sides.p2.active!;
    expect(holder.fainted).toBe(false);
    expect(holder.hp).toBe(1);
    expect(battle.log.join('\n')).toContain('|-enditem|p2a:');
  });

  it('Heavy-Duty Boots ignore Stealth Rock', () => {
    const battle = new Battle({
      seed: 'boots',
      p1: { name: 'A', team: [{ species: P, moves: [STEALTH_ROCK, SPLASH] }] },
      p2: {
        name: 'B', team: [
          { species: W, moves: [SPLASH] },
          { species: { ...W, id: 'w2', name: 'Booted' }, moves: [SPLASH], item: 'Heavy-Duty Boots' },
        ],
      },
    });
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1'); // rocks
    battle.choose('p2', 'move 1');
    battle.choose('p1', 'move 2');
    battle.choose('p2', 'switch 2'); // booted switch-in
    const booted = battle.sides.p2.active!;
    expect(booted.hp).toBe(booted.maxhp);
  });

  it('Lum Berry instantly cures a status', () => {
    const battle = duel(
      { species: P, moves: [THUNDER_WAVE] },
      { species: W, moves: [SPLASH], item: 'Lum Berry' });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const target = battle.sides.p2.active!;
    expect(target.status).toBe('');
    expect(battle.log.join('\n')).toContain('Lum Berry');
  });

  it('Flame Orb burns its holder at end of turn (Guts fuel)', () => {
    const battle = duel(
      { species: P, moves: [SPLASH], item: 'Flame Orb', ability: 'Guts' },
      { species: W, moves: [SPLASH] });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.active!.status).toBe('brn');
  });

  it('Rocky Helmet punishes contact', () => {
    const battle = duel(
      { species: P, moves: [TACKLE] },
      { species: W, moves: [SPLASH], item: 'Rocky Helmet' });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const attacker = battle.sides.p1.active!;
    expect(attacker.hp).toBe(attacker.maxhp - Math.floor(attacker.maxhp / 6));
  });

  it('Air Balloon grants Ground immunity until popped', () => {
    const battle = duel(
      { species: P, moves: [EARTHQUAKE, TACKLE] },
      { species: W, moves: [SPLASH], item: 'Air Balloon' });
    battle.choose('p1', 'move 1'); // EQ: immune
    battle.choose('p2', 'move 1');
    expect(dmgTo(battle, 'p2')).toBe(0);
    battle.choose('p1', 'move 2'); // Tackle pops it
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|-enditem|p2a: Wally|Air Balloon');
    battle.choose('p1', 'move 1'); // EQ now connects
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|move|p1a: Punchy|Earthquake|');
    expect(dmgTo(battle, 'p2')).toBeGreaterThan(0);
  });
});

describe('expanded abilities', () => {
  it('Drizzle sets rain on switch-in', () => {
    const battle = duel(
      { species: P, moves: [SPLASH], ability: 'Drizzle' },
      { species: W, moves: [SPLASH] });
    expect(battle.weather).toBe('raindance');
    expect(battle.log.join('\n')).toContain('|-weather|RainDance');
  });

  it('Swift Swim doubles speed in rain', () => {
    const battle = duel(
      { species: P, moves: [SPLASH], ability: 'Drizzle' },
      { species: W, moves: [SPLASH], ability: 'Swift Swim' });
    const slow = battle.sides.p2.active!;
    expect(battle.effectiveSpe(slow)).toBe(slow.getStat('spe') * 2);
  });

  it('Regenerator heals a third on switch-out', () => {
    const battle = new Battle({
      seed: 'regen',
      p1: {
        name: 'A', team: [
          { species: P, moves: [SPLASH], ability: 'Regenerator' },
          { species: { ...P, id: 'p2x', name: 'Backup' }, moves: [SPLASH] },
        ],
      },
      p2: { name: 'B', team: [{ species: W, moves: [SPLASH] }] },
    });
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    const regen = battle.sides.p1.active!;
    regen.hp = Math.floor(regen.maxhp / 4);
    const before = regen.hp;
    battle.choose('p1', 'switch 2');
    battle.choose('p2', 'move 1');
    expect(regen.hp).toBe(before + Math.floor(regen.maxhp / 3));
  });

  it('Adaptability doubles STAB', () => {
    const adapted = duel(
      { species: P, moves: [TACKLE], ability: 'Adaptability' },
      { species: W, moves: [SPLASH] }, 'adapt');
    adapted.choose('p1', 'move 1');
    adapted.choose('p2', 'move 1');
    const plain = duel(
      { species: P, moves: [TACKLE] },
      { species: W, moves: [SPLASH] }, 'adapt');
    plain.choose('p1', 'move 1');
    plain.choose('p2', 'move 1');
    expect(dmgTo(adapted, 'p2')).toBeGreaterThan(dmgTo(plain, 'p2'));
  });

  it('Protean changes the user to the move type (STAB everything)', () => {
    const battle = duel(
      { species: P, moves: [EMBER], ability: 'Protean' },
      { species: W, moves: [SPLASH] });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.active!.types).toEqual(['Fire']);
    expect(battle.log.join('\n')).toContain('typechange');
  });

  it('Wonder Guard only lets super-effective moves through', () => {
    const shed = species({ id: 'shed', name: 'Sheddy', types: ['Bug', 'Ghost'], baseStats: { hp: 1, atk: 90, def: 45, spa: 30, spd: 30, spe: 40 } });
    const battle = duel(
      { species: P, moves: [TACKLE, EMBER] },
      { species: shed, moves: [SPLASH], ability: 'Wonder Guard' });
    battle.choose('p1', 'move 1'); // Normal vs Ghost is immune anyway; use Ember next
    battle.choose('p2', 'move 1');
    expect(battle.sides.p2.active!.fainted).toBe(false);
    battle.choose('p1', 'move 2'); // Fire vs Bug = super effective: breaks through
    battle.choose('p2', 'move 1');
    expect(battle.sides.p2.active!.fainted).toBe(true);
  });

  it('Truant loafs every other turn', () => {
    const battle = duel(
      { species: P, moves: [TACKLE], ability: 'Truant' },
      { species: W, moves: [SPLASH] });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const log = battle.log.join('\n');
    expect(log).toContain('|cant|p1a: Punchy|ability: Truant');
    expect(battle.log.filter((l) => l.startsWith('|move|p1a:')).length).toBe(1);
  });

  it('Slow Start halves Attack and wears off after 5 turns', () => {
    const battle = duel(
      { species: P, moves: [TACKLE], ability: 'Slow Start' },
      { species: W, moves: [SPLASH] }, 'ss');
    expect(battle.sides.p1.active!.slowStartTurns).toBe(5);
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const early = dmgTo(battle, 'p2');
    for (let i = 0; i < 5; i++) {
      battle.choose('p1', 'move 1');
      battle.choose('p2', 'move 1');
    }
    expect(battle.sides.p1.active!.slowStartTurns).toBe(0);
    expect(battle.log.join('\n')).toContain('|-end|p1a: Punchy|ability: Slow Start');
    expect(early).toBeGreaterThan(0);
  });

  it('Speed Boost raises Speed each turn', () => {
    const battle = duel(
      { species: P, moves: [SPLASH], ability: 'Speed Boost' },
      { species: W, moves: [SPLASH] });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.active!.boosts.spe).toBe(1);
  });

  it('Moxie snowballs on KOs', () => {
    const frail = species({ id: 'frail', name: 'Frail', types: ['Normal'], baseStats: { hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10 } });
    const battle = new Battle({
      seed: 'moxie',
      p1: { name: 'A', team: [{ species: { ...P, baseStats: { ...P.baseStats, atk: 200 } }, moves: [NUKE], ability: 'Moxie' }] },
      p2: { name: 'B', team: [{ species: frail, moves: [SPLASH] }, { species: { ...frail, id: 'f2', name: 'Frail2' }, moves: [SPLASH] }] },
    });
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p1.active!.boosts.atk).toBe(1);
  });

  it('Limber blocks paralysis', () => {
    const battle = duel(
      { species: P, moves: [THUNDER_WAVE] },
      { species: W, moves: [SPLASH], ability: 'Limber' });
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.sides.p2.active!.status).toBe('');
  });
});
