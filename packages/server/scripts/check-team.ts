/** Verify a proposed "perfect lineup" against the real engine rules. */
import { getSpecies, canLearn } from '@simple-showdown/data';
import { balancedLevel } from '../src/random-team.js';

const TEAM: [string, string[]][] = [
  ['Zacian', ['playrough', 'ironhead', 'closecombat', 'swordsdance']],
  ['Miraidon', ['electrodrift', 'dragonpulse', 'overheat', 'calmmind']],
  ['Slaking', ['gigaimpact', 'earthquake', 'shadowclaw', 'slackoff']],
  ['Regigigas', ['gigaimpact', 'earthquake', 'knockoff', 'thunderwave']],
  ['Eternatus', ['dynamaxcannon', 'sludgebomb', 'recover', 'toxic']],
  ['Garchomp', ['stealthrock', 'earthquake', 'outrage', 'swordsdance']],
];

for (const [name, moves] of TEAM) {
  const species = getSpecies(name);
  if (!species) {
    console.log(`${name}: NOT FOUND`);
    continue;
  }
  const level = balancedLevel(species);
  const bst = Object.values(species.baseStats).reduce((a, b) => a + b, 0);
  const legal: string[] = [];
  const illegal: string[] = [];
  for (const move of moves) {
    (await canLearn(species.id, move) ? legal : illegal).push(move);
  }
  console.log(`${name} (BST ${bst}, Lv${level}, ability[0]=${species.abilities[0]}): ` +
    `legal=[${legal.join(', ')}]${illegal.length ? ` ILLEGAL=[${illegal.join(', ')}]` : ''}`);
}
