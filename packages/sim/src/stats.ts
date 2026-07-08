import type { StatID, StatsTable, BoostsTable, BoostID } from './types.js';

/**
 * Simplified stat calculation: no EVs, IVs, or natures.
 * Reduces the main-series Gen 3+ formula (with EV=IV=0, neutral nature) to:
 *   HP    = floor(2 * base * level / 100) + level + 10
 *   other = floor(2 * base * level / 100) + 5
 */
export function calcStat(stat: StatID, base: number, level: number): number {
  const core = Math.floor((2 * base * level) / 100);
  if (stat === 'hp') {
    // Shedinja-style 1-HP species keep 1 HP.
    if (base === 1) return 1;
    return core + level + 10;
  }
  return core + 5;
}

export function calcStats(baseStats: StatsTable, level: number): StatsTable {
  return {
    hp: calcStat('hp', baseStats.hp, level),
    atk: calcStat('atk', baseStats.atk, level),
    def: calcStat('def', baseStats.def, level),
    spa: calcStat('spa', baseStats.spa, level),
    spd: calcStat('spd', baseStats.spd, level),
    spe: calcStat('spe', baseStats.spe, level),
  };
}

/** Stage multipliers for main stats (atk/def/spa/spd/spe), indexed by |stage|. */
const STAT_BOOST_TABLE = [1, 1.5, 2, 2.5, 3, 3.5, 4] as const;
/** Stage multipliers for accuracy/evasion, indexed by |stage|. */
const ACC_BOOST_TABLE = [1, 4 / 3, 5 / 3, 2, 7 / 3, 8 / 3, 3] as const;

/** Apply a boost stage (-6..+6) to a main stat value. */
export function applyBoost(value: number, stage: number): number {
  stage = clampStage(stage);
  if (stage >= 0) return Math.floor(value * STAT_BOOST_TABLE[stage]!);
  return Math.floor(value / STAT_BOOST_TABLE[-stage]!);
}

/** Accuracy/evasion use a different (x3 max) stage table and return a raw multiplier. */
export function accuracyBoostMultiplier(stage: number): number {
  stage = clampStage(stage);
  if (stage >= 0) return ACC_BOOST_TABLE[stage]!;
  return 1 / ACC_BOOST_TABLE[-stage]!;
}

export function clampStage(stage: number): number {
  return Math.max(-6, Math.min(6, stage));
}

export function emptyBoosts(): BoostsTable {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

/** Add `delta` stages to `boosts[id]`, clamped to [-6, 6]. Returns the actual change applied. */
export function addBoost(boosts: BoostsTable, id: BoostID, delta: number): number {
  const before = boosts[id];
  boosts[id] = clampStage(before + delta);
  return boosts[id] - before;
}
