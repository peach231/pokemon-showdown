/**
 * Sprite audit: for every base-forme species, verify the per-Pokémon sprite
 * files we plan to use actually exist on the Showdown CDN:
 *  - mini:  sprites/gen5/{id}.png      (dex grid, team slots, switch menu)
 *  - anim:  sprites/ani/{id}.gif       (battle front; back variant assumed same coverage)
 * Also verifies the candidate battle background images under /fx/.
 * Run: npx tsx packages/server/scripts/audit-sprites.ts
 */
import { filterSpecies } from '@simple-showdown/data';

const CDN = 'https://play.pokemonshowdown.com';

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>, size = 20): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await worker(item);
    }
  }));
}

const species = filterSpecies({ baseFormesOnly: true });
console.log(`Auditing ${species.length} species...`);

const missingMini: string[] = [];
const missingAni: string[] = [];

await pool(species, async (s) => {
  if (!await exists(`${CDN}/sprites/gen5/${s.id}.png`)) missingMini.push(s.id);
  if (!await exists(`${CDN}/sprites/ani/${s.id}.gif`)) missingAni.push(s.id);
});

console.log(`gen5 mini sprites missing: ${missingMini.length}`);
if (missingMini.length) console.log('  ', missingMini.join(', '));
console.log(`ani battle sprites missing: ${missingAni.length}`);
if (missingAni.length) console.log('  ', missingAni.slice(0, 60).join(', '));

const BGS = [
  'bg-beachshore', 'bg-city', 'bg-dampcave', 'bg-darkbeach', 'bg-darkcity',
  'bg-darkmeadow', 'bg-deepsea', 'bg-desert', 'bg-earthycave', 'bg-forest',
  'bg-icecave', 'bg-leaderwallace', 'bg-library', 'bg-meadow', 'bg-mountain',
  'bg-orasdesert', 'bg-orassea', 'bg-skypillar', 'bg-thunderplains', 'bg-volcanocave',
];
const okBgs: string[] = [];
await pool(BGS, async (bg) => {
  if (await exists(`${CDN}/fx/${bg}.jpg`)) okBgs.push(bg);
});
console.log(`backgrounds available: ${okBgs.length}/${BGS.length}`);
console.log('  ', okBgs.sort().join(', '));
