/** Core shared types for the simplified battle engine. */

export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export const STAT_IDS: readonly StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export type StatsTable = { [S in StatID]: number };

/** Stats that can be boosted in battle (no HP; accuracy/evasion added). */
export type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';
export const BOOST_IDS: readonly BoostID[] = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
export type BoostsTable = { [B in BoostID]: number };

export type TypeName =
  | 'Normal' | 'Fighting' | 'Flying' | 'Poison' | 'Ground' | 'Rock'
  | 'Bug' | 'Ghost' | 'Steel' | 'Fire' | 'Water' | 'Grass'
  | 'Electric' | 'Psychic' | 'Ice' | 'Dragon' | 'Dark' | 'Fairy';

export type MoveCategory = 'Physical' | 'Special' | 'Status';

/** The six non-volatile status conditions. */
export type StatusID = 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';

/** Minimal species data the engine needs (sourced from @simple-showdown/data). */
export interface SpeciesData {
  id: string;
  name: string;
  num: number;
  types: TypeName[];
  baseStats: StatsTable;
  abilities: string[];
  gen: number;
  /** Previous evolution's species id, if any. */
  prevo?: string;
  /** Next evolutions' species ids. */
  evos?: string[];
  weightkg?: number;
  /** Base species name for formes (e.g. "Rotom" for Rotom-Wash). */
  baseSpecies?: string;
  /** Forme name (e.g. "Mega", "Wash"); undefined for base formes. */
  forme?: string;
}

/** A single secondary effect that may fire after a move hits. */
export interface SecondaryEffect {
  chance: number;
  status?: StatusID;
  volatileStatus?: string;
  boosts?: Partial<BoostsTable>;
  /** Boosts applied to the user of the move instead of the target. */
  self?: { boosts?: Partial<BoostsTable> };
}

/** Minimal move data the engine needs. */
export interface MoveData {
  id: string;
  name: string;
  type: TypeName;
  category: MoveCategory;
  basePower: number;
  /** true means "never misses"; otherwise a percentage. */
  accuracy: number | true;
  pp: number;
  priority: number;
  target: MoveTarget;
  flags: MoveFlags;
  /** Guaranteed primary status inflicted on the target. */
  status?: StatusID;
  /** Guaranteed volatile inflicted on the target. */
  volatileStatus?: string;
  /** Guaranteed stat changes to the target. */
  boosts?: Partial<BoostsTable>;
  /** Stat changes / effects applied to the user. */
  self?: { boosts?: Partial<BoostsTable> };
  secondaries?: SecondaryEffect[];
  /** e.g. drain [1,2] = heal 1/2 of damage dealt; recoil [33,100] = 33% of damage. */
  drain?: [number, number];
  recoil?: [number, number];
  /** Fixed number of hits, or a [min,max] range for multi-hit moves. */
  multihit?: number | [number, number];
  /** Fixed damage (e.g. Seismic Toss = level, Dragon Rage = 40). */
  damage?: number | 'level';
  /** Percentage of the user's max HP healed (e.g. Recover = 50). */
  heal?: number;
  /** true for OHKO moves (Fissure, etc.). */
  ohko?: boolean;
  /** How the engine should execute this move; defaults inferred from data. */
  effectType?: string;
  /** Weather this move sets: 'raindance' | 'sunnyday' | 'sandstorm' | 'snow'. */
  weather?: string;
  /** Side condition this move lays (only 'stealthrock' is implemented). */
  sideCondition?: string;
  /** User faints after using this move (Explosion, Self-Destruct...). */
  selfDestruct?: boolean;
  /** Attack stat override (Body Press attacks with Defense). */
  overrideOffensiveStat?: 'def';
}

export type WeatherID = '' | 'raindance' | 'sunnyday' | 'sandstorm' | 'snow';

export type MoveTarget =
  | 'normal'
  | 'self'
  | 'allAdjacentFoes'
  | 'allAdjacent'
  | 'all'
  | 'randomNormal';

export interface MoveFlags {
  contact?: 1;
  protect?: 1;
  sound?: 1;
  punch?: 1;
  [flag: string]: 1 | undefined;
}
