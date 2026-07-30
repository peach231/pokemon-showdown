/**
 * Sprite/asset URLs, built directly from species ids against the Showdown CDN.
 *
 * We intentionally do NOT use @pkmn/img's icon-sheet offsets: the shared
 * pokemonicons-sheet.png is re-indexed upstream over time, so a pinned
 * package maps many Pokémon to the wrong tile (the Jigglypuff/Poliwrath bug).
 * Per-Pokémon image files are immune to that drift, and a CDN audit confirmed
 * the gen5 static set covers all 1025 base species.
 *
 * WHERE THE BYTES COME FROM. Not from play.pokemonshowdown.com directly.
 * Filtered networks — school and office web filters especially — block that
 * host by category ("Games"), which left the game perfectly playable but drawn
 * as a wall of broken-image icons. Every asset therefore goes through /cdn on
 * the game server's own origin, which is reachable by construction: it is the
 * origin that just served this page. See packages/server/src/asset-proxy.ts.
 *
 * The real CDN stays as a per-image SECOND try, for the reverse case where the
 * proxy is the thing that is unavailable (e.g. the Vite dev client running
 * with no game server behind it).
 */

import { getSpecies } from '@simple-showdown/data';

const CDN = 'https://play.pokemonshowdown.com';

/** Dev (Vite on :5173) talks to the game server on :8000, same as the socket. */
const ASSET_BASE = location.port === '5173'
  ? `${location.protocol}//${location.hostname || 'localhost'}:8000/cdn`
  : '/cdn';

/** A same-origin URL for an upstream CDN path, e.g. `sprites/gen5/pikachu.png`. */
function asset(path: string): string {
  return `${ASSET_BASE}/${path}`;
}

export function toID(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * PS sprite filename: base species id, plus a hyphenated forme suffix for
 * alternate formes (rotom-wash.png, not rotomwash.png).
 */
function spriteId(speciesName: string): string {
  const s = getSpecies(speciesName);
  if (s?.forme) return `${toID(s.baseSpecies ?? s.name)}-${toID(s.forme)}`;
  return toID(speciesName);
}

/** Small static sprite (96px, full coverage): dex grid, team slots, menus. */
export function miniSpriteUrl(speciesName: string): string {
  return asset(`sprites/gen5/${spriteId(speciesName)}.png`);
}

/**
 * Battle sprite candidates, best-first. Animated gifs are missing for ~21 of
 * the newest legendaries, so callers walk this list on img error.
 */
export function battleSpriteUrls(speciesName: string, view: 'front' | 'back'): string[] {
  const id = spriteId(speciesName);
  return view === 'back'
    ? [asset(`sprites/ani-back/${id}.gif`), asset(`sprites/gen5-back/${id}.png`), asset(`sprites/gen5/${id}.png`)]
    : [asset(`sprites/ani/${id}.gif`), asset(`sprites/gen5/${id}.png`)];
}

export function cryUrl(speciesName: string): string {
  // Formes have no cry files on the CDN; they share the base species' cry.
  const s = getSpecies(speciesName);
  return asset(`audio/cries/${toID(s?.baseSpecies ?? speciesName)}.mp3`);
}

/** Battle FX image (`pokeball`, ...). */
export function fxUrl(name: string): string {
  return asset(`fx/${name}.png`);
}

/** Looping battle BGM track, by upstream filename. */
export function bgmUrl(file: string): string {
  return asset(`audio/${file}`);
}

/** Trainer avatar portrait; shared by the picker, lobby rows and the ladder. */
export function trainerAvatarUrl(avatar: string): string {
  return asset(`sprites/trainers/${avatar || 'red'}.png`);
}

/** Real PS battle backdrops (existence verified against the CDN). */
export const BATTLE_BACKDROPS = [
  'bg-aquacordetown', 'bg-beach', 'bg-city', 'bg-dampcave', 'bg-darkbeach',
  'bg-darkcity', 'bg-darkmeadow', 'bg-deepsea', 'bg-desert', 'bg-earthycave',
  'bg-elite4drake', 'bg-forest', 'bg-icecave', 'bg-leaderwallace', 'bg-library',
  'bg-meadow', 'bg-orasdesert', 'bg-orassea', 'bg-skypillar',
] as const;

export function backdropUrl(name: string): string {
  return asset(`sprites/gen6bgs/${name}.jpg`);
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Drawn in place of the browser's broken-image glyph. Inline so it needs no
 * network of its own — the one thing that must render when nothing else can.
 */
const MISSING_SPRITE =
  'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="13" fill="none" stroke="#7c8598" stroke-width="2" opacity=".55"/>
      <path d="M3 16h9m8 0h9" stroke="#7c8598" stroke-width="2" opacity=".55"/>
      <circle cx="16" cy="16" r="4" fill="none" stroke="#7c8598" stroke-width="2" opacity=".55"/>
    </svg>`.replace(/\s+/g, ' '),
  );

/** The direct-CDN equivalent of a proxied URL, or '' if this isn't one of ours. */
function directEquivalent(src: string): string {
  const at = src.indexOf('/cdn/');
  return at < 0 ? '' : `${CDN}/${src.slice(at + '/cdn/'.length)}`;
}

let warnedBlocked = false;

function noteBlocked(url: string): void {
  if (warnedBlocked) return;
  warnedBlocked = true;
  console.warn(
    `[sprites] Could not load ${url} from either the game server or ${CDN}. ` +
    'If every sprite is missing, this network is most likely blocking the ' +
    'Pokémon Showdown media CDN.',
  );
}

/**
 * Last-resort net for images built through innerHTML, which have no element
 * handle to attach a chain to. Retries once against the real CDN, then swaps
 * in the placeholder so a filtered network never shows a torn-page icon.
 *
 * Registered in the CAPTURE phase because `error` does not bubble. Images
 * driven by setSpriteWithFallback opt out — they run their own chain.
 */
export function installSpriteFallback(): void {
  document.addEventListener('error', (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset['ssManaged'] === '1') return;
    const failed = img.currentSrc || img.src;
    if (!failed || failed === MISSING_SPRITE) return;   // placeholder failed: stop
    const direct = directEquivalent(failed);
    if (!direct) noteBlocked(failed);
    img.src = direct || MISSING_SPRITE;
  }, true);
}

/**
 * Set an img to try each URL in order until one loads.
 *
 * Every proxied candidate is tried before any direct-CDN one, so the common
 * "this species has no animated gif" case resolves on the second same-origin
 * request without ever touching a host the network may be blocking.
 */
export function setSpriteWithFallback(img: HTMLImageElement, urls: string[]): void {
  const chain = [...urls, ...urls.map(directEquivalent).filter(Boolean), MISSING_SPRITE];
  img.dataset['ssManaged'] = '1';
  let i = 0;
  img.onerror = () => {
    i++;
    if (i === chain.length - 1) noteBlocked(urls[0] ?? '');
    if (i < chain.length) img.src = chain[i]!;
    else img.onerror = null;
  };
  img.src = chain[0]!;
}
