/**
 * Sprite/asset URLs, built directly from species ids against the Showdown CDN.
 *
 * We intentionally do NOT use @pkmn/img's icon-sheet offsets: the shared
 * pokemonicons-sheet.png is re-indexed upstream over time, so a pinned
 * package maps many Pokémon to the wrong tile (the Jigglypuff/Poliwrath bug).
 * Per-Pokémon image files are immune to that drift, and a CDN audit confirmed
 * the gen5 static set covers all 1025 base species.
 */

const CDN = 'https://play.pokemonshowdown.com';

export function toID(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Small static sprite (96px, full coverage): dex grid, team slots, menus. */
export function miniSpriteUrl(speciesName: string): string {
  return `${CDN}/sprites/gen5/${toID(speciesName)}.png`;
}

/**
 * Battle sprite candidates, best-first. Animated gifs are missing for ~21 of
 * the newest legendaries, so callers walk this list on img error.
 */
export function battleSpriteUrls(speciesName: string, view: 'front' | 'back'): string[] {
  const id = toID(speciesName);
  return view === 'back'
    ? [`${CDN}/sprites/ani-back/${id}.gif`, `${CDN}/sprites/gen5-back/${id}.png`, `${CDN}/sprites/gen5/${id}.png`]
    : [`${CDN}/sprites/ani/${id}.gif`, `${CDN}/sprites/gen5/${id}.png`];
}

export function cryUrl(speciesName: string): string {
  return `${CDN}/audio/cries/${toID(speciesName)}.mp3`;
}

/** Real PS battle backdrops (existence verified against the CDN). */
export const BATTLE_BACKDROPS = [
  'bg-aquacordetown', 'bg-beach', 'bg-city', 'bg-dampcave', 'bg-darkbeach',
  'bg-darkcity', 'bg-darkmeadow', 'bg-deepsea', 'bg-desert', 'bg-earthycave',
  'bg-elite4drake', 'bg-forest', 'bg-icecave', 'bg-leaderwallace', 'bg-library',
  'bg-meadow', 'bg-orasdesert', 'bg-orassea', 'bg-skypillar',
] as const;

export function backdropUrl(name: string): string {
  return `${CDN}/sprites/gen6bgs/${name}.jpg`;
}

/** Set an img to try each URL in order until one loads. */
export function setSpriteWithFallback(img: HTMLImageElement, urls: string[]): void {
  let i = 0;
  img.onerror = () => {
    i++;
    if (i < urls.length) img.src = urls[i]!;
    else img.onerror = null;
  };
  img.src = urls[0]!;
}
