# Simple Showdown

A simplified, web-based, online Pokémon battle simulator inspired by
[Pokémon Showdown](https://github.com/smogon/pokemon-showdown).

**Design principle (borrowed from Showdown):** the server runs the battle and emits a
pipe-delimited text protocol; the browser client is a renderer that turns each `|...|`
line into sprites, animations, and sound. Replays and spectating fall out of this for free.

## Simplifications vs. real Showdown

- Singles only, teams of 6, Team Preview + switching.
- **No EVs, IVs, or natures** — every Pokémon uses base stats at a fixed level.
- No tiers/banlists — all species available, filterable by type/generation/evolution stage.
- One universal attack animation instead of per-move choreography.
- Single-server auth (guest names + optional accounts), no federated login server.

## Packages

| Package | Purpose |
|---|---|
| `packages/sim` | The battle engine: PRNG, stats, damage, type chart, battle loop. Emits protocol. |
| `packages/data` | Wrapper over `@pkmn/dex`: all species/moves + type/gen/evolution filters. |
| `packages/protocol` | Shared protocol message builders/parsers (planned). |
| `packages/server` | WebSocket server: rooms, auth, matchmaking, ladder, replays (planned). |
| `packages/client` | Browser client: battle renderer, teambuilder, chat (planned). |

## Assets are served from our own origin

Sprites, trainer avatars, backdrops, cries and BGM all originate on
`play.pokemonshowdown.com`, but the client never requests that host directly.
The game server mirrors it under **`/cdn/<upstream path>`**
(`packages/server/src/asset-proxy.ts`), with an in-memory cache and a strict
path allowlist.

The reason is filtered networks: school and office web filters classify
`play.pokemonshowdown.com` as "Games" and block it, which left the game fully
playable but drawn as a wall of broken-image icons. Same-origin assets are
reachable by construction — if the page loaded, the proxy loaded. The real CDN
remains a per-image second try, and anything that still fails renders an inline
Poké Ball placeholder rather than the browser's broken-image glyph.

## Getting started

Requires **Node.js >= 18** (`winget install OpenJS.NodeJS.LTS`).

```sh
npm install
npm test          # run all unit tests
npm run server    # start the dev server (once M3 lands)
```

## Status

Milestone 1 (foundations: monorepo, PRNG, stat/damage/type math, data wrapper + tests) — in progress.
See the milestone list in the project plan.
