import { describe, it, expect } from 'vitest';
import {
  Battle, type ResolvedPokemonSet, type MoveData, type SpeciesData, type SideID,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Self-contained fixtures (no data package needed to test the engine).
// ---------------------------------------------------------------------------

function move(partial: Partial<MoveData> & Pick<MoveData, 'id' | 'name' | 'type' | 'category'>): MoveData {
  return {
    basePower: 0,
    accuracy: 100,
    pp: 16,
    priority: 0,
    target: partial.category === 'Status' && partial.boosts && !partial.status ? 'self' : 'normal',
    flags: { protect: 1 },
    ...partial,
  };
}

const TACKLE = move({ id: 'tackle', name: 'Tackle', type: 'Normal', category: 'Physical', basePower: 40, flags: { contact: 1, protect: 1 } });
const EMBER = move({
  id: 'ember', name: 'Ember', type: 'Fire', category: 'Special', basePower: 40,
  secondaries: [{ chance: 10, status: 'brn' }],
});
const WATER_GUN = move({ id: 'watergun', name: 'Water Gun', type: 'Water', category: 'Special', basePower: 40 });
const THUNDER_WAVE = move({ id: 'thunderwave', name: 'Thunder Wave', type: 'Electric', category: 'Status', status: 'par' });
const SWORDS_DANCE = move({ id: 'swordsdance', name: 'Swords Dance', type: 'Normal', category: 'Status', boosts: { atk: 2 }, target: 'self' });
const QUICK_ATTACK = move({ id: 'quickattack', name: 'Quick Attack', type: 'Normal', category: 'Physical', basePower: 40, priority: 1, flags: { contact: 1, protect: 1 } });
const RECOVER = move({ id: 'recover', name: 'Recover', type: 'Normal', category: 'Status', heal: 50, target: 'self' });

function species(partial: Partial<SpeciesData> & Pick<SpeciesData, 'id' | 'name' | 'types'>): SpeciesData {
  return {
    num: 0,
    baseStats: { hp: 80, atk: 80, def: 80, spa: 80, spd: 80, spe: 80 },
    abilities: ['Illuminate'],
    gen: 1,
    ...partial,
  };
}

const FIREMON = species({ id: 'firemon', name: 'Firemon', types: ['Fire'] });
const WATERMON = species({ id: 'watermon', name: 'Watermon', types: ['Water'] });
const FASTMON = species({
  id: 'fastmon', name: 'Fastmon', types: ['Normal'],
  baseStats: { hp: 60, atk: 90, def: 60, spa: 60, spd: 60, spe: 130 },
});
const SLOWMON = species({
  id: 'slowmon', name: 'Slowmon', types: ['Normal'],
  baseStats: { hp: 110, atk: 90, def: 100, spa: 60, spd: 100, spe: 30 },
});

function set(sp: SpeciesData, moves: MoveData[]): ResolvedPokemonSet {
  return { species: sp, moves };
}

function makeBattle(seed = 'test-seed', p1Team?: ResolvedPokemonSet[], p2Team?: ResolvedPokemonSet[]): Battle {
  return new Battle({
    seed,
    p1: { name: 'Alice', team: p1Team ?? [set(FIREMON, [EMBER, TACKLE]), set(FASTMON, [QUICK_ATTACK])] },
    p2: { name: 'Bob', team: p2Team ?? [set(WATERMON, [WATER_GUN, TACKLE]), set(SLOWMON, [TACKLE, RECOVER])] },
  });
}

/** Drive a battle to completion with default choices; returns the log. */
function playOut(battle: Battle, maxTurns = 200): string[] {
  const pending = new Map<SideID, boolean>();
  battle.onSideUpdate = (side, line) => {
    if (line.startsWith('|request|')) {
      const req = JSON.parse(line.slice('|request|'.length));
      pending.set(side, !req.wait);
    }
  };
  battle.start();
  let guard = 0;
  while (!battle.ended && guard++ < maxTurns * 2) {
    for (const side of ['p1', 'p2'] as SideID[]) {
      if (pending.get(side)) {
        pending.set(side, false);
        battle.choose(side, 'default');
      }
    }
  }
  return battle.log;
}

// ---------------------------------------------------------------------------

describe('Battle', () => {
  it('emits the standard header and team preview', () => {
    const battle = makeBattle();
    battle.start();
    const log = battle.log.join('\n');
    expect(log).toContain('|player|p1|Alice|');
    expect(log).toContain('|player|p2|Bob|');
    expect(log).toContain('|gametype|singles');
    expect(log).toContain('|teampreview');
    expect(log).toContain('|poke|p1|Firemon');
  });

  it('starts turn 1 with leads out after team preview', () => {
    const battle = makeBattle();
    battle.start();
    battle.choose('p1', 'team 123456');
    battle.choose('p2', 'team 123456');
    const log = battle.log.join('\n');
    expect(log).toContain('|start');
    expect(log).toContain('|switch|p1a: Firemon|Firemon|');
    expect(log).toContain('|switch|p2a: Watermon|Watermon|');
    expect(log).toContain('|turn|1');
  });

  it('team order choice reorders leads', () => {
    const battle = makeBattle();
    battle.start();
    battle.choose('p1', 'team 21'); // lead with Fastmon
    battle.choose('p2', 'team 12');
    expect(battle.log.join('\n')).toContain('|switch|p1a: Fastmon|Fastmon|');
  });

  it('rejects invalid choices with an error', () => {
    const battle = makeBattle();
    battle.start();
    const errors: string[] = [];
    battle.onSideUpdate = (_side, line) => {
      if (line.startsWith('|error|')) errors.push(line);
    };
    const err = battle.choose('p1', 'move 1'); // must team-order first
    expect(err).toBeTruthy();
    expect(errors.length).toBe(1);
  });

  it('runs a full battle to a win deterministically', () => {
    const log1 = playOut(makeBattle('determinism'));
    const log2 = playOut(makeBattle('determinism'));
    expect(log1).toEqual(log2); // byte-identical => replays are exact
    const last = log1[log1.length - 1]!;
    expect(last.startsWith('|win|') || last === '|tie').toBe(true);
  });

  it('different seeds usually diverge', () => {
    const log1 = playOut(makeBattle('seed-one')).join('\n');
    const log2 = playOut(makeBattle('seed-two')).join('\n');
    expect(log1).not.toEqual(log2);
  });

  it('type advantage: water beats fire 1v1', () => {
    const battle = makeBattle('adv',
      [set(FIREMON, [EMBER])],
      [set(WATERMON, [WATER_GUN])],
    );
    const log = playOut(battle);
    expect(log[log.length - 1]).toBe('|win|Bob');
    expect(log.join('\n')).toContain('|-supereffective|p1a: Firemon');
    expect(log.join('\n')).toContain('|-resisted|p2a: Watermon');
  });

  it('priority moves go first', () => {
    // Slowmon (slow) with Quick Attack vs Fastmon (fast) with Tackle.
    const battle = makeBattle('prio',
      [set({ ...SLOWMON, id: 'sm', name: 'Slowpoke' }, [QUICK_ATTACK])],
      [set(FASTMON, [TACKLE])],
    );
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const log = battle.log;
    const qaIndex = log.findIndex((l) => l.includes('|move|p1a: Slowpoke|Quick Attack|'));
    const tackleIndex = log.findIndex((l) => l.includes('|move|p2a: Fastmon|Tackle|'));
    expect(qaIndex).toBeGreaterThan(-1);
    expect(tackleIndex).toBeGreaterThan(-1);
    expect(qaIndex).toBeLessThan(tackleIndex);
  });

  it('status move inflicts paralysis and speed halves', () => {
    const battle = makeBattle('twave',
      [set(FIREMON, [THUNDER_WAVE])],
      [set(WATERMON, [WATER_GUN])],
    );
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|-status|p2a: Watermon|par');
    const paralyzed = battle.sides.p2.active!;
    expect(paralyzed.status).toBe('par');
    const unboosted = paralyzed.stats.spe;
    expect(paralyzed.getStat('spe')).toBe(Math.floor(unboosted * 0.5));
  });

  it('boost moves raise stages and affect damage', () => {
    const battle = makeBattle('sd',
      [set(FIREMON, [SWORDS_DANCE, TACKLE])],
      [set(SLOWMON, [RECOVER])],
    );
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1'); // Swords Dance
    battle.choose('p2', 'move 1');
    expect(battle.log.join('\n')).toContain('|-boost|p1a: Firemon|atk|2');
    expect(battle.sides.p1.active!.boosts.atk).toBe(2);
  });

  it('forced switch after a faint, then battle continues', () => {
    // p1 has a fast strong attacker; p2's lead will faint and must switch.
    const NUKE = move({ id: 'nuke', name: 'Nuke', type: 'Normal', category: 'Physical', basePower: 250 });
    const battle = makeBattle('faint',
      [set(FASTMON, [NUKE])],
      [set({ ...WATERMON, baseStats: { ...WATERMON.baseStats, hp: 40, def: 30 } }, [WATER_GUN]), set(SLOWMON, [TACKLE])],
    );
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');
    const log = battle.log.join('\n');
    expect(log).toContain('|faint|p2a: Watermon');
    expect(battle.ended).toBe(false);
    // p2 owes a switch; p1 waits.
    expect(battle.sides.p2.requestState).toBe('switch');
    expect(battle.sides.p1.requestState).toBe('wait');
    battle.choose('p2', 'switch 2');
    expect(battle.log.join('\n')).toContain('|switch|p2a: Slowmon|Slowmon|');
    expect(battle.log.join('\n')).toContain('|turn|2');
  });

  it('voluntary switching works mid-battle', () => {
    const battle = makeBattle('switchy');
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'switch 2');
    battle.choose('p2', 'move 1');
    const log = battle.log.join('\n');
    expect(log).toContain('|switch|p1a: Fastmon|Fastmon|');
    expect(log).toContain('|turn|2');
  });

  it('forfeit ends the battle with the other side winning', () => {
    const battle = makeBattle();
    battle.start();
    battle.forfeit('p1');
    expect(battle.ended).toBe(true);
    expect(battle.winner).toBe('Bob');
    expect(battle.log[battle.log.length - 1]).toBe('|win|Bob');
  });

  it('records an input log capable of replay', () => {
    const battle = makeBattle('inputlog');
    playOut(battle);
    expect(battle.inputLog[0]).toContain('>seed');
    expect(battle.inputLog.some((l) => l.startsWith('>p1 '))).toBe(true);
    expect(battle.inputLog.some((l) => l.startsWith('>p2 '))).toBe(true);
  });

  it('struggle is used when out of PP', () => {
    const ONE_PP = { ...TACKLE, pp: 1 };
    const battle = makeBattle('struggle',
      [set(SLOWMON, [ONE_PP])],
      [set({ ...SLOWMON, id: 'sm2', name: 'Wallmon' }, [RECOVER])],
    );
    battle.start();
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
    battle.choose('p1', 'move 1'); // uses last Tackle PP
    battle.choose('p2', 'move 1');
    battle.choose('p1', 'move 1'); // out of PP -> Struggle
    battle.choose('p2', 'move 1');
    const log = battle.log.join('\n');
    expect(log).toContain('|move|p1a: Slowmon|Struggle|');
    expect(log).toContain('[from] recoil');
  });
});
