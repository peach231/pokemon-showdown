/**
 * Same-origin proxy for the Showdown media CDN.
 *
 * WHY THIS EXISTS. Every sprite, trainer avatar, backdrop, cry and music track
 * this game draws lives on play.pokemonshowdown.com. School and workplace web
 * filters routinely categorise that host as "Games" and block it outright — so
 * the game itself loaded and played fine (its own origin is allowed) while
 * every single `<img>` failed and rendered as the browser's broken-image icon.
 * A blocked filter can return NXDOMAIN, a TCP reset, or an HTML block page with
 * a 200; all three look identical to an <img>, and no client-side retry helps
 * because every fallback URL was on the same blocked host.
 *
 * Re-serving the same bytes from THIS origin fixes it by construction: if the
 * page loaded, this route is reachable. Assets are cached in memory so a
 * classroom full of players costs one upstream fetch per file.
 *
 * This is NOT a general-purpose proxy. There is no caller-supplied host or URL
 * parameter; request paths are matched against a fixed allowlist of upstream
 * paths, so it cannot be pointed at anything but the Showdown CDN.
 */
import type * as http from 'node:http';

/** Public route prefix. Client builds every asset URL against this. */
export const ASSET_PREFIX = '/cdn/';

const UPSTREAM = 'https://play.pokemonshowdown.com';

/**
 * Upstream paths we are willing to fetch. Showdown ids are `toID`-normalised
 * (a-z0-9) with `-` only as a forme separator, so this is the full character
 * set the client can ever produce.
 */
const ALLOWED: RegExp[] = [
  /^sprites\/(?:gen5|gen5-back|ani|ani-back)\/[a-z0-9-]{1,64}\.(?:png|gif)$/,
  /^sprites\/trainers\/[a-z0-9-]{1,64}\.png$/,
  /^sprites\/gen6bgs\/[a-z0-9-]{1,64}\.jpg$/,
  /^fx\/[a-z0-9-]{1,64}\.png$/,
  /^audio\/cries\/[a-z0-9-]{1,64}\.mp3$/,
  /^audio\/[a-z0-9-]{1,64}\.mp3$/,
];

/**
 * The whole security boundary of this module: an upstream path is fetched only
 * if it matches here. Exported so the allowlist is unit-testable on its own.
 */
export function isAllowedAssetPath(path: string): boolean {
  return ALLOWED.some((re) => re.test(path));
}

const MIME: Record<string, string> = {
  png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', mp3: 'audio/mpeg',
};

/** Upstream request timeout. Well past a cold CDN edge, short enough to fail fast. */
const FETCH_TIMEOUT_MS = 10_000;
/** Total bytes held in the sprite cache before the oldest entries are dropped. */
const CACHE_BUDGET = 48 * 1024 * 1024;
/**
 * Bodies larger than this are streamed straight through instead of cached —
 * the seven BGM tracks are ~2.5 MB each and would eat the whole budget for a
 * file the browser caches on its own anyway.
 */
const CACHE_MAX_ENTRY = 512 * 1024;
/** A blocked/broken upstream shouldn't be re-hammered on every sprite request. */
const NEGATIVE_TTL_MS = 60_000;

interface Cached {
  status: number;
  type: string;
  body: Buffer;
}

/** Insertion-ordered, so iteration order is oldest-first for eviction. */
const cache = new Map<string, Cached>();
/** In-flight fetches, so N simultaneous requests for one sprite make one call. */
const inflight = new Map<string, Promise<Cached>>();
/** Paths that recently 404'd or errored, with the time they may be retried. */
const negative = new Map<string, number>();
let cacheBytes = 0;

function remember(path: string, entry: Cached): void {
  if (entry.body.length > CACHE_MAX_ENTRY) return;
  cache.set(path, entry);
  cacheBytes += entry.body.length;
  for (const [key, value] of cache) {
    if (cacheBytes <= CACHE_BUDGET) break;
    cache.delete(key);
    cacheBytes -= value.body.length;
  }
}

function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase();
}

async function fetchUpstream(path: string): Promise<Cached> {
  const type = MIME[extensionOf(path)] ?? 'application/octet-stream';
  try {
    const res = await fetch(`${UPSTREAM}/${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'simple-showdown-asset-proxy' },
    });
    if (!res.ok) return { status: res.status === 404 ? 404 : 502, type, body: Buffer.alloc(0) };
    return { status: 200, type: res.headers.get('content-type') ?? type, body: Buffer.from(await res.arrayBuffer()) };
  } catch {
    // DNS failure, timeout, TLS error — the CDN is unreachable FROM THE SERVER.
    return { status: 502, type, body: Buffer.alloc(0) };
  }
}

/** Fetch once per path even under concurrent requests; cache the result. */
async function load(path: string): Promise<Cached> {
  const hit = cache.get(path);
  if (hit) return hit;
  const pending = inflight.get(path);
  if (pending) return pending;

  const job = fetchUpstream(path).then((entry) => {
    inflight.delete(path);
    if (entry.status === 200) remember(path, entry);
    else negative.set(path, Date.now() + NEGATIVE_TTL_MS);
    return entry;
  });
  inflight.set(path, job);
  return job;
}

/**
 * Pass a ranged request (BGM seeking) straight through without caching, so
 * `audio.currentTime = loopStart` still works on the looping battle music.
 */
async function pipeRange(
  path: string, range: string, res: http.ServerResponse,
): Promise<void> {
  try {
    const upstream = await fetch(`${UPSTREAM}/${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Range: range, 'User-Agent': 'simple-showdown-asset-proxy' },
    });
    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? MIME[extensionOf(path)] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
      'Accept-Ranges': 'bytes',
    };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    const body = Buffer.from(await upstream.arrayBuffer());
    headers['Content-Length'] = String(body.length);
    res.writeHead(upstream.status, headers).end(body);
  } catch {
    res.writeHead(502).end();
  }
}

/**
 * Serve `/cdn/<upstream path>` if it is one we allow. Returns false when the
 * path is not an asset route, so the caller can fall through to static files.
 */
export function serveAsset(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): boolean {
  if (!urlPath.startsWith(ASSET_PREFIX)) return false;

  const path = decodeURIComponent(urlPath.slice(ASSET_PREFIX.length));
  if (!isAllowedAssetPath(path)) {
    res.writeHead(404).end();
    return true;
  }

  const range = req.headers.range;
  if (range) {
    void pipeRange(path, range, res);
    return true;
  }

  const blockedUntil = negative.get(path);
  if (blockedUntil !== undefined && blockedUntil > Date.now()) {
    // Fail fast while upstream is known-bad; the client falls back to its
    // own placeholder rather than waiting out a timeout per sprite.
    res.writeHead(504).end();
    return true;
  }
  negative.delete(path);

  void load(path).then((entry) => {
    if (entry.status !== 200) {
      res.writeHead(entry.status).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': String(entry.body.length),
      // Sprite files never change under a given name.
      'Cache-Control': 'public, max-age=604800, immutable',
      'Accept-Ranges': 'bytes',
    }).end(entry.body);
  }).catch(() => {
    if (!res.headersSent) res.writeHead(502).end();
  });
  return true;
}
