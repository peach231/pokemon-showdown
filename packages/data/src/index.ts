/**
 * Thin wrapper over @pkmn/dex: exposes all species/moves with the filter
 * helpers the teambuilder and randomizer need (type / generation / evolution
 * stage), converting into the minimal shapes the sim engine consumes.
 */
import { Dex } from '@pkmn/dex';
import { Generations, type Specie, type Move as PkmnMove, type Data } from '@pkmn/data';
import type {
  SpeciesData, MoveData, TypeName, StatsTable, MoveTarget, StatusID, SecondaryEffect,
} from '@simple-showdown/sim';

/** The dex generation the whole game runs on. */
export const GEN_NUM = 9;

/**
 * Custom existence filter: unlike the default (which drops anything not
 * obtainable in the current generation's games), we keep species/moves marked
 * `Past` — the game deliberately offers ALL species. CAP/custom content is
 * still excluded.
 */
function existsInGame(d: Data): boolean {
  if (!('exists' in d) || !d.exists) return false;
  if (d.kind === 'Learnset') return true;
  if ('isNonstandard' in d && d.isNonstandard && d.isNonstandard !== 'Past') return false;
  if (d.kind === 'Species' && d.num <= 0) return false;
  return true;
}

const gens = new Generations(Dex, existsInGame);
export const gen = gens.get(GEN_NUM);

/** Evolution stage of a species: 1 = unevolved/base, 2 = middle, 3 = final-of-3. */
export type EvoStage = 1 | 2 | 3;

export interface SpeciesFilter {
  types?: TypeName[];
  /** Generation the species was introduced in (1..9). */
  gens?: number[];
  /** Evolution stage(s): 1 base, 2 middle, 3 fully-evolved-of-three. */
  stages?: EvoStage[];
  /** Only species that are fully evolved (no further evos). */
  fullyEvolvedOnly?: boolean;
  /** Only base formes (no Mega/regional/cosmetic formes). */
  baseFormesOnly?: boolean;
}

function toStatsTable(s: Specie['baseStats']): StatsTable {
  return { hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe };
}

/** Compute how deep in its evolution chain a species is (1-indexed). */
export function evoStage(specie: Specie): EvoStage {
  let stage = 1;
  let cur: Specie | undefined = specie;
  while (cur?.prevo) {
    stage++;
    cur = gen.species.get(cur.prevo);
  }
  return Math.min(stage, 3) as EvoStage;
}

function abilitiesOf(specie: Specie): string[] {
  const abilities = specie.abilities as unknown as Record<string, string | undefined>;
  return [abilities['0'], abilities['1'], abilities['H']].filter(
    (a): a is string => !!a,
  );
}

export function toSpeciesData(specie: Specie): SpeciesData {
  return {
    id: specie.id,
    name: specie.name,
    num: specie.num,
    types: specie.types as TypeName[],
    baseStats: toStatsTable(specie.baseStats),
    abilities: abilitiesOf(specie),
    gen: specie.gen,
    prevo: specie.prevo ? (gen.species.get(specie.prevo)?.id ?? undefined) : undefined,
    evos: specie.evos
      ?.map((e) => gen.species.get(e)?.id as string | undefined)
      .filter((e): e is string => !!e),
    weightkg: specie.weightkg,
    baseSpecies: specie.baseSpecies !== specie.name ? specie.baseSpecies : undefined,
    forme: specie.forme || undefined,
  };
}

/** All real, usable species in the target generation (no CAP, no illegal formes). */
export function allSpecies(): SpeciesData[] {
  const out: SpeciesData[] = [];
  for (const specie of gen.species) {
    out.push(toSpeciesData(specie));
  }
  return out;
}

export function getSpecies(idOrName: string): SpeciesData | undefined {
  const specie = gen.species.get(idOrName);
  return specie ? toSpeciesData(specie) : undefined;
}

/** Filter species by type / introduction generation / evolution stage. */
export function filterSpecies(filter: SpeciesFilter): SpeciesData[] {
  const out: SpeciesData[] = [];
  for (const specie of gen.species) {
    if (filter.baseFormesOnly && specie.forme) continue;
    if (filter.types?.length) {
      const types = specie.types as TypeName[];
      if (!filter.types.some((t) => types.includes(t))) continue;
    }
    if (filter.gens?.length && !filter.gens.includes(specie.gen)) continue;
    if (filter.fullyEvolvedOnly && specie.evos?.length) continue;
    if (filter.stages?.length && !filter.stages.includes(evoStage(specie))) continue;
    out.push(toSpeciesData(specie));
  }
  return out;
}

function toMoveTarget(target: PkmnMove['target']): MoveTarget {
  switch (target) {
    case 'self': return 'self';
    case 'allAdjacentFoes': return 'allAdjacentFoes';
    case 'allAdjacent': return 'allAdjacent';
    case 'all': return 'all';
    case 'randomNormal': return 'randomNormal';
    default: return 'normal';
  }
}

const STATUS_IDS: ReadonlySet<string> = new Set(['brn', 'par', 'psn', 'tox', 'slp', 'frz']);

function toStatus(status: string | undefined): StatusID | undefined {
  return status && STATUS_IDS.has(status) ? (status as StatusID) : undefined;
}

export function toMoveData(move: PkmnMove): MoveData {
  const secondaries: SecondaryEffect[] = [];
  for (const sec of move.secondaries ?? []) {
    if (!sec || sec.chance === undefined) continue;
    secondaries.push({
      chance: sec.chance,
      status: toStatus(sec.status),
      volatileStatus: sec.volatileStatus,
      boosts: sec.boosts as SecondaryEffect['boosts'],
      self: sec.self?.boosts ? { boosts: sec.self.boosts as SecondaryEffect['boosts'] } : undefined,
    });
  }

  return {
    id: move.id,
    name: move.name,
    type: move.type as TypeName,
    category: move.category,
    basePower: move.basePower,
    accuracy: move.accuracy === true ? true : move.accuracy,
    pp: move.pp,
    priority: move.priority,
    target: toMoveTarget(move.target),
    flags: { ...(move.flags as Record<string, 1 | undefined>) },
    status: toStatus(move.status),
    volatileStatus: typeof move.volatileStatus === 'string' ? move.volatileStatus : undefined,
    boosts: (move.boosts ?? undefined) as MoveData['boosts'],
    self: move.self?.boosts ? { boosts: move.self.boosts as NonNullable<MoveData['self']>['boosts'] } : undefined,
    secondaries: secondaries.length ? secondaries : undefined,
    drain: move.drain ? [move.drain[0]!, move.drain[1]!] : undefined,
    recoil: move.recoil ? [move.recoil[0]!, move.recoil[1]!] : undefined,
    multihit: (move.multihit ?? undefined) as MoveData['multihit'],
    damage: move.damage === 'level' ? 'level' : typeof move.damage === 'number' ? move.damage : undefined,
    heal: move.heal ? Math.floor((move.heal[0]! / move.heal[1]!) * 100) : undefined,
    ohko: move.ohko ? true : undefined,
    weather: move.weather
      ? (['hail', 'snowscape', 'snow'].includes(move.weather.toLowerCase().replace(/[^a-z]/g, ''))
        ? 'snow'
        : move.weather.toLowerCase().replace(/[^a-z]/g, ''))
      : undefined,
    sideCondition: typeof move.sideCondition === 'string'
      ? move.sideCondition.toLowerCase().replace(/[^a-z]/g, '')
      : undefined,
    selfDestruct: move.selfdestruct === 'always' ? true : undefined,
    overrideOffensiveStat: move.overrideOffensiveStat === 'def' ? 'def' : undefined,
  };
}

export function getMove(idOrName: string): MoveData | undefined {
  const move = gen.moves.get(idOrName);
  return move ? toMoveData(move) : undefined;
}

/** All moves a species can legally learn (any legal source), as engine MoveData. */
export async function legalMoves(speciesIdOrName: string): Promise<MoveData[]> {
  const specie = gen.species.get(speciesIdOrName);
  if (!specie) return [];
  const learnset = await gen.learnsets.learnable(specie.id);
  if (!learnset) return [];
  const out: MoveData[] = [];
  for (const moveId of Object.keys(learnset)) {
    const move = gen.moves.get(moveId);
    if (move) out.push(toMoveData(move));
  }
  return out;
}

/** Whether `speciesIdOrName` can legally learn `moveIdOrName`. */
export async function canLearn(speciesIdOrName: string, moveIdOrName: string): Promise<boolean> {
  const specie = gen.species.get(speciesIdOrName);
  const move = gen.moves.get(moveIdOrName);
  if (!specie || !move) return false;
  // Smeargle Sketches literally anything.
  if (specie.id === 'smeargle') return true;
  const learnset = await gen.learnsets.learnable(specie.id);
  if (learnset && move.id in learnset) return true;
  // Trust PS's own Random Battle data over learnset edge cases.
  return isInShowdownPool(specie.name, move.id);
}

export function allItems(): { id: string; name: string; desc: string }[] {
  const out: { id: string; name: string; desc: string }[] = [];
  for (const item of gen.items) {
    out.push({ id: item.id, name: item.name, desc: item.shortDesc ?? item.desc ?? '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Battle items the engine actually implements (teambuilder picker + validation)
// ---------------------------------------------------------------------------

export const BATTLE_ITEMS: { id: string; name: string }[] = [
  { id: 'leftovers', name: 'Leftovers' },
  { id: 'blacksludge', name: 'Black Sludge' },
  { id: 'lifeorb', name: 'Life Orb' },
  { id: 'choiceband', name: 'Choice Band' },
  { id: 'choicespecs', name: 'Choice Specs' },
  { id: 'choicescarf', name: 'Choice Scarf' },
  { id: 'focussash', name: 'Focus Sash' },
  { id: 'assaultvest', name: 'Assault Vest' },
  { id: 'rockyhelmet', name: 'Rocky Helmet' },
  { id: 'heavydutyboots', name: 'Heavy-Duty Boots' },
  { id: 'sitrusberry', name: 'Sitrus Berry' },
  { id: 'lumberry', name: 'Lum Berry' },
  { id: 'flameorb', name: 'Flame Orb' },
  { id: 'toxicorb', name: 'Toxic Orb' },
  { id: 'expertbelt', name: 'Expert Belt' },
  { id: 'muscleband', name: 'Muscle Band' },
  { id: 'wiseglasses', name: 'Wise Glasses' },
  { id: 'eviolite', name: 'Eviolite' },
  { id: 'lightball', name: 'Light Ball' },
  { id: 'airballoon', name: 'Air Balloon' },
  { id: 'weaknesspolicy', name: 'Weakness Policy' },
  { id: 'powerherb', name: 'Power Herb' },
  { id: 'charcoal', name: 'Charcoal' },
  { id: 'mysticwater', name: 'Mystic Water' },
  { id: 'magnet', name: 'Magnet' },
  { id: 'miracleseed', name: 'Miracle Seed' },
  { id: 'nevermeltice', name: 'Never-Melt Ice' },
  { id: 'blackbelt', name: 'Black Belt' },
  { id: 'poisonbarb', name: 'Poison Barb' },
  { id: 'softsand', name: 'Soft Sand' },
  { id: 'sharpbeak', name: 'Sharp Beak' },
  { id: 'twistedspoon', name: 'Twisted Spoon' },
  { id: 'silverpowder', name: 'Silver Powder' },
  { id: 'hardstone', name: 'Hard Stone' },
  { id: 'spelltag', name: 'Spell Tag' },
  { id: 'dragonfang', name: 'Dragon Fang' },
  { id: 'blackglasses', name: 'Black Glasses' },
  { id: 'metalcoat', name: 'Metal Coat' },
  { id: 'fairyfeather', name: 'Fairy Feather' },
  { id: 'silkscarf', name: 'Silk Scarf' },
];

export function battleItemName(id: string): string | undefined {
  return BATTLE_ITEMS.find((i) => i.id === id)?.name;
}

// ---------------------------------------------------------------------------
// Real Pokémon Showdown Random Battle sets (nightly data from pkmn/randbats)
// ---------------------------------------------------------------------------
import randbats from './gen9randombattle.json';

interface RandbatsRole {
  abilities?: string[];
  items?: string[];
  moves?: string[];
}
interface RandbatsEntry {
  level?: number;
  abilities?: string[];
  items?: string[];
  roles?: Record<string, RandbatsRole>;
}

export interface ShowdownSet {
  /** Move ids (normalized), up to 4, sampled from a real PS role. */
  moves: string[];
  ability?: string;
  item?: string;
  role?: string;
}

const toMoveID = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The actual Pokémon Showdown Random Battle set for a species, or null if PS
 * doesn't include it in its random pool. `rng` in [0,1) picks the role.
 *
 * Move selection mirrors PS's generator behavior: pools of ≤4 are taken
 * whole; larger pools are sampled 4 at a time with damaging STAB moves
 * guaranteed first (PS's own constraint), so core moves like Garchomp's
 * Earthquake never get randomed away.
 */
export function getShowdownSet(speciesName: string, rng: () => number = Math.random): ShowdownSet | null {
  const species = gen.species.get(speciesName);
  const entry = (randbats as Record<string, RandbatsEntry>)[species?.name ?? speciesName];
  if (!entry) return null;
  const roleNames = Object.keys(entry.roles ?? {});
  const roleName = roleNames.length ? roleNames[Math.floor(rng() * roleNames.length)]! : undefined;
  const role = roleName ? entry.roles![roleName]! : undefined;
  const pool = (role?.moves ?? []).map(toMoveID);
  if (pool.length === 0) return null;

  let moves: string[];
  if (pool.length <= 4) {
    moves = [...pool];
  } else {
    const speciesTypes = (species?.types ?? []) as string[];
    const isStabAttack = (id: string) => {
      const move = gen.moves.get(id);
      return !!move && move.category !== 'Status' && move.basePower > 0
        && speciesTypes.includes(move.type);
    };
    // Damaging STAB first (all of them, as PS's generator enforces)...
    const stab = pool.filter(isStabAttack);
    const rest = pool.filter((id) => !isStabAttack(id));
    moves = [...stab].slice(0, 4);
    // ...then random picks from the remainder.
    while (moves.length < 4 && rest.length > 0) {
      moves.push(rest.splice(Math.floor(rng() * rest.length), 1)[0]!);
    }
  }

  return {
    moves,
    ability: role?.abilities?.[0] ?? entry.abilities?.[0],
    item: role?.items?.[0] ?? entry.items?.[0],
    role: roleName,
  };
}

/** True if PS's Random Battle data includes this move for this species. */
export function isInShowdownPool(speciesName: string, moveId: string): boolean {
  const species = gen.species.get(speciesName);
  const entry = (randbats as Record<string, RandbatsEntry>)[species?.name ?? speciesName];
  if (!entry) return false;
  for (const role of Object.values(entry.roles ?? {})) {
    if (role.moves?.some((m) => toMoveID(m) === moveId)) return true;
  }
  return false;
}
