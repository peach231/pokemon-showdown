/**
 * Full sweep: for EVERY species in the real PS randbats data, verify that
 * our auto-fill produces moves strictly from the real movepool. Reports:
 *  1. randbats moves our learnset-checker wrongly rejects (corruption source)
 *  2. species whose generated set contains non-randbats moves
 */
import randbats from '../../data/src/gen9randombattle.json';
import { getSpecies, getMove, legalMoves } from '@simple-showdown/data';
import { autofillSet } from '../../client/src/team.js';

const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

let speciesChecked = 0;
let missingSpecies = 0;
let missingMoves = 0;
const legalityDrops = new Map<string, string[]>(); // species -> rejected moves
let contaminated = 0;
const contaminatedExamples: string[] = [];

for (const [name, entry] of Object.entries(randbats as Record<string, {
  roles?: Record<string, { moves?: string[] }>;
}>)) {
  const species = getSpecies(name);
  if (!species) {
    missingSpecies++;
    continue;
  }
  speciesChecked++;

  // Union of all role movepools = the full legitimate pool.
  const pool = new Set<string>();
  for (const role of Object.values(entry.roles ?? {})) {
    for (const move of role.moves ?? []) pool.add(toID(move));
  }

  // 1. Which real randbats moves does our legality checker reject?
  const legal = new Set((await legalMoves(species.id)).map((m) => m.id));
  const rejected = [...pool].filter((id) => !legal.has(id));
  const unknown = [...pool].filter((id) => !getMove(id));
  if (unknown.length) missingMoves += unknown.length;
  if (rejected.length) legalityDrops.set(name, rejected);

  // 2. Does the generated set stay inside the real pool?
  const legalArr = await legalMoves(species.id);
  const set = autofillSet(species, legalArr);
  const outside = set.moves.filter((id) => !pool.has(id));
  if (outside.length) {
    contaminated++;
    if (contaminatedExamples.length < 12) {
      contaminatedExamples.push(`${name}: [${set.moves.join(',')}] outside=[${outside.join(',')}]`);
    }
  }
}

console.log(`species checked: ${speciesChecked} (not in our dex: ${missingSpecies})`);
console.log(`randbats moves unknown to our dex: ${missingMoves}`);
console.log(`species with legality-rejected randbats moves: ${legalityDrops.size}`);
let shown = 0;
for (const [name, moves] of legalityDrops) {
  if (shown++ >= 10) break;
  console.log(`  ${name}: ${moves.join(', ')}`);
}
console.log(`species whose generated set left the real pool: ${contaminated}`);
for (const ex of contaminatedExamples) console.log(`  ${ex}`);
