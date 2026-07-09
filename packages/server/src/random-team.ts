/**
 * Team generation for the server.
 * - Random teams use REAL Pokémon Showdown Random Battle sets (nightly
 *   pkmn/randbats data) whenever the species is in PS's random pool —
 *   moves, ability, and item included; a scored-move heuristic covers
 *   species PS doesn't run.
 * - `generateTeamFromSpecs` builds the player's saved team (species, chosen
 *   moves, ability slot, item id), server-validated, padded with randoms.
 */
import {
  filterSpecies, getSpecies, getMove, canLearn, legalMoves,
  getShowdownSet, battleItemName,
} from '@simple-showdown/data';
import { PRNG, type ResolvedPokemonSet, type MoveData, type SpeciesData } from '@simple-showdown/sim';

/** A teambuilder slot as sent by the client. */
export interface TeamSpec {
  id: string;
  moves: string[];
  /** Index into species.abilities. */
  ability?: number;
  /** Implemented battle-item id. */
  item?: string;
}

/** Parse the wire format: `id~move1+move2~abilityIdx~itemid,...` */
export function parseTeamSpecs(arg: string): TeamSpec[] {
  return arg.split(',').filter(Boolean).map((entry) => {
    const [id, moves, ability, item] = entry.split('~');
    const abilityIdx = parseInt(ability ?? '', 10);
    return {
      id: id ?? '',
      moves: (moves ?? '').split('+').filter(Boolean),
      ability: Number.isNaN(abilityIdx) ? undefined : abilityIdx,
      item: (item ?? '').replace(/[^a-z0-9]/g, '') || undefined,
    };
  }).filter((s) => s.id);
}

/**
 * Balance lever: level scales inversely with base stat total (clamped 70-100),
 * like Showdown Random Battle's level balancing.
 */
export function balancedLevel(species: SpeciesData): number {
  const s = species.baseStats;
  const bst = s.hp + s.atk + s.def + s.spa + s.spd + s.spe;
  const level = Math.round(100 - ((bst - 300) * 28) / 300);
  return Math.max(70, Math.min(100, level));
}

/** Fallback move picker for species outside PS's random pool. */
async function heuristicMoves(prng: PRNG, species: SpeciesData): Promise<MoveData[]> {
  const learnable = await legalMoves(species.id);
  const damaging = learnable.filter((m) => m.basePower >= 40);
  const status = learnable.filter((m) => m.category === 'Status');
  const moves: MoveData[] = [];
  const seen = new Set<string>();
  const take = (from: MoveData[]) => {
    let tries = 0;
    while (moves.length < 4 && from.length > 0 && tries++ < 40) {
      const m = from[prng.random(from.length)]!;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      moves.push(m);
    }
  };
  take(damaging);
  take(status);
  return moves;
}

/** Build one playable set: real PS randbats set when available. */
export async function generateRandomSet(
  prng: PRNG,
  species: SpeciesData,
): Promise<ResolvedPokemonSet | null> {
  const rng = () => prng.random(1_000_000) / 1_000_000;
  const showdown = getShowdownSet(species.name, rng);

  let moves: MoveData[] = [];
  let ability: string | undefined;
  let item: string | undefined;

  if (showdown) {
    moves = showdown.moves
      .map((id) => getMove(id))
      .filter((m): m is MoveData => !!m);
    if (showdown.ability && species.abilities.includes(showdown.ability)) {
      ability = showdown.ability;
    }
    if (showdown.item) {
      item = battleItemName(showdown.item.toLowerCase().replace(/[^a-z0-9]/g, ''));
    }
  }
  if (moves.length < 4) {
    const filler = await heuristicMoves(prng, species);
    for (const m of filler) {
      if (moves.length >= 4) break;
      if (!moves.some((x) => x.id === m.id)) moves.push(m);
    }
  }
  if (moves.length === 0) return null;
  ability ??= species.abilities[prng.random(Math.max(1, species.abilities.length))];
  return { species, moves, level: balancedLevel(species), ability, item };
}

export async function generateRandomTeam(
  prng: PRNG,
  size = 6,
  excludeNums: Set<number> = new Set(),
): Promise<ResolvedPokemonSet[]> {
  const pool = filterSpecies({ fullyEvolvedOnly: true, baseFormesOnly: true });
  const team: ResolvedPokemonSet[] = [];

  let guard = 0;
  while (team.length < size && guard++ < 300) {
    const species = pool[prng.random(pool.length)]!;
    if (excludeNums.has(species.num)) continue; // species clause
    const set = await generateRandomSet(prng, species);
    if (!set) continue;
    excludeNums.add(species.num);
    team.push(set);
  }
  return team;
}

/**
 * Build a team from teambuilder specs. Chosen moves/ability/item are kept
 * when legal; gaps are filled sensibly; missing slots become randoms.
 */
export async function generateTeamFromSpecs(
  prng: PRNG,
  specs: TeamSpec[],
  size = 6,
): Promise<ResolvedPokemonSet[]> {
  const team: ResolvedPokemonSet[] = [];
  const usedNums = new Set<number>();
  for (const spec of specs.slice(0, size)) {
    const species = getSpecies(spec.id);
    if (!species || usedNums.has(species.num)) continue;

    const moves: MoveData[] = [];
    const seen = new Set<string>();
    for (const moveId of spec.moves.slice(0, 4)) {
      const move = getMove(moveId);
      if (!move || seen.has(move.id)) continue;
      if (!await canLearn(species.id, move.id)) continue; // server-side legality
      seen.add(move.id);
      moves.push(move);
    }
    if (moves.length < 4) {
      const filler = await heuristicMoves(prng, species);
      for (const move of filler) {
        if (moves.length >= 4) break;
        if (!seen.has(move.id)) {
          seen.add(move.id);
          moves.push(move);
        }
      }
    }
    if (moves.length === 0) continue;

    const ability = spec.ability !== undefined
      ? species.abilities[spec.ability] ?? species.abilities[0]
      : species.abilities[0];
    const item = spec.item ? battleItemName(spec.item) : undefined;

    usedNums.add(species.num);
    team.push({ species, moves, level: balancedLevel(species), ability, item });
  }
  if (team.length < size) {
    team.push(...await generateRandomTeam(prng, size - team.length, usedNums));
  }
  return team;
}