/**
 * Team generation for the server.
 * - `generateRandomTeam` — 6 random, fully-evolved, base-forme species.
 * - `generateTeamFromIds` — the player's saved team (species ids from the
 *   client teambuilder), padded with randoms if short; falls back gracefully
 *   on unknown ids.
 * Moves are picked randomly from each species' legal learnset (real move
 * choice UI arrives with the full teambuilder milestone).
 */
import { filterSpecies, getSpecies, getMove, canLearn, legalMoves } from '@simple-showdown/data';
import { PRNG, type ResolvedPokemonSet, type MoveData, type SpeciesData } from '@simple-showdown/sim';

/** A teambuilder slot as sent by the client: species id + chosen move ids. */
export interface TeamSpec {
  id: string;
  moves: string[];
}

/** Parse the wire format: `id~move1+move2,id2~...` (all ids alphanumeric). */
export function parseTeamSpecs(arg: string): TeamSpec[] {
  return arg.split(',').filter(Boolean).map((entry) => {
    const [id, moves] = entry.split('~');
    return { id: id ?? '', moves: (moves ?? '').split('+').filter(Boolean) };
  }).filter((s) => s.id);
}

/**
 * Balance lever: level scales inversely with base stat total, so a Rayquaza
 * (BST 680) fights at ~70 while a Wigglytuff (BST 435) gets high 80s. Same
 * idea as Showdown Random Battle's curated levels, computed from BST instead
 * of hand-tuning 1000+ species. Not a perfect meta — but every pick is usable.
 */
export function balancedLevel(species: SpeciesData): number {
  const s = species.baseStats;
  const bst = s.hp + s.atk + s.def + s.spa + s.spd + s.spe;
  // Linear: BST 300 -> 100, BST 600 -> 72; clamped to [70, 100].
  const level = Math.round(100 - ((bst - 300) * 28) / 300);
  return Math.max(70, Math.min(100, level));
}

/** Build one playable set for a species: up to 4 random legal moves. */
export async function generateRandomSet(
  prng: PRNG,
  species: SpeciesData,
): Promise<ResolvedPokemonSet | null> {
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
  if (moves.length === 0) return null;
  // Random ability from the species' real ability pool (Levitate, Intimidate...).
  const ability = species.abilities[prng.random(Math.max(1, species.abilities.length))];
  return { species, moves, level: balancedLevel(species), ability };
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
 * Build a team from teambuilder specs. Chosen moves are kept when they're
 * legal for the species; short or empty movesets are padded with random
 * legal moves. Unknown species are skipped; missing slots become randoms.
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
      const filler = await generateRandomSet(prng, species);
      for (const move of filler?.moves ?? []) {
        if (moves.length >= 4) break;
        if (!seen.has(move.id)) {
          seen.add(move.id);
          moves.push(move);
        }
      }
    }
    if (moves.length === 0) continue;
    usedNums.add(species.num);
    team.push({ species, moves, level: balancedLevel(species) });
  }
  if (team.length < size) {
    team.push(...await generateRandomTeam(prng, size - team.length, usedNums));
  }
  return team;
}
