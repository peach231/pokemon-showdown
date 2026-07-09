/** Print the auto-filled sets — now sourced from REAL PS randbats data. */
import { getSpecies, legalMoves } from '@simple-showdown/data';
import { autofillSet } from '../../client/src/team.js';
import { balancedLevel } from '../src/random-team.js';

const CANDIDATES = [
  'Garchomp', 'Dragapult', 'Kyogre', 'Zacian', 'Great Tusk', 'Kingambit',
  'Slaking', 'Regigigas', 'Pikachu', 'Ting-Lu', 'Iron Valiant', 'Gholdengo',
];

for (const name of CANDIDATES) {
  const species = getSpecies(name);
  if (!species) {
    console.log(`${name}: NOT FOUND`);
    continue;
  }
  const legal = await legalMoves(species.id);
  const set = autofillSet(species, legal);
  const ability = set.ability !== undefined ? species.abilities[set.ability] : species.abilities[0];
  console.log(`${name} (Lv${balancedLevel(species)}): [${set.moves.join(', ')}] ` +
    `ability=${ability} item=${set.item ?? '—'}`);
}
