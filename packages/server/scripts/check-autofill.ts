/** Print the REAL auto-filled sets for top candidates, using the client's
 *  own autofillMoves(), so a zero-effort lineup can be chosen honestly. */
import { getSpecies, legalMoves } from '@simple-showdown/data';
import { autofillMoves } from '../../client/src/team.js';
import { balancedLevel } from '../src/random-team.js';

const CANDIDATES = [
  'Slaking', 'Regigigas', 'Zacian', 'Miraidon', 'Koraidon', 'Eternatus',
  'Arceus', 'Rayquaza', 'Mewtwo', 'Kyogre', 'Groudon', 'Zekrom',
  'Ho-Oh', 'Lugia', 'Garchomp', 'Dragapult', 'Ting-Lu', 'Regieleki',
];

for (const name of CANDIDATES) {
  const species = getSpecies(name);
  if (!species) {
    console.log(`${name}: NOT FOUND`);
    continue;
  }
  const legal = await legalMoves(species.id);
  const set = autofillMoves(species, legal);
  console.log(`${name} (Lv${balancedLevel(species)}): ${set.join(', ')}`);
}
