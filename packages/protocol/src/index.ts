/**
 * Shared client<->server protocol, modeled on Pokémon Showdown's framing:
 *
 *   Client -> server:  `ROOMID|TEXT` (ROOMID may be empty for global commands)
 *   Server -> client:  `>ROOMID\n` followed by newline-separated `|TYPE|DATA` lines
 *                      (the `>ROOMID` prefix is omitted for the global room)
 *
 * IMPORTANT: DATA fields (chat text especially) may themselves contain `|`,
 * so parsers must split with a max-parts limit, never naively.
 */

export type RoomID = string;
export const GLOBAL_ROOM: RoomID = '';

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface ClientMessage {
  roomId: RoomID;
  text: string;
}

/** Parse one raw client frame: `ROOMID|TEXT` (TEXT may contain `|`). */
export function parseClientMessage(raw: string): ClientMessage {
  const sep = raw.indexOf('|');
  if (sep < 0) return { roomId: GLOBAL_ROOM, text: raw };
  return { roomId: raw.slice(0, sep), text: raw.slice(sep + 1) };
}

export function serializeClientMessage(roomId: RoomID, text: string): string {
  return `${roomId}|${text}`;
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Build one server frame for a room: `>ROOMID\nLINE\nLINE...`. */
export function serializeServerFrame(roomId: RoomID, lines: string[]): string {
  const body = lines.join('\n');
  return roomId === GLOBAL_ROOM ? body : `>${roomId}\n${body}`;
}

export interface ServerFrame {
  roomId: RoomID;
  lines: string[];
}

/** Parse one server frame back into (roomId, protocol lines). */
export function parseServerFrame(raw: string): ServerFrame {
  let roomId: RoomID = GLOBAL_ROOM;
  let body = raw;
  if (raw.startsWith('>')) {
    const nl = raw.indexOf('\n');
    if (nl < 0) return { roomId: raw.slice(1), lines: [] };
    roomId = raw.slice(1, nl);
    body = raw.slice(nl + 1);
  }
  return { roomId, lines: body.split('\n').filter((l) => l.length > 0) };
}

// ---------------------------------------------------------------------------
// Protocol lines
// ---------------------------------------------------------------------------

/**
 * Split a `|TYPE|DATA|DATA...` line into its parts.
 * `maxParts` bounds the split so trailing fields keep embedded `|`s
 * (e.g. chat messages). Returns [] for non-protocol lines.
 */
export function parseLine(line: string, maxParts = Infinity): string[] {
  if (!line.startsWith('|')) return ['', line];
  const parts: string[] = [];
  let start = 1;
  while (parts.length < maxParts - 1) {
    const next = line.indexOf('|', start);
    if (next < 0) break;
    parts.push(line.slice(start, next));
    start = next + 1;
  }
  parts.push(line.slice(start));
  return parts;
}

/** Join parts into a `|TYPE|DATA` line. */
export function buildLine(...parts: (string | number)[]): string {
  return `|${parts.join('|')}`;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** Normalize a display name into a stable lowercase alphanumeric user id. */
export function toID(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isValidUsername(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 18) return false;
  if (/[|,\n\r]/.test(trimmed)) return false;
  if (toID(trimmed).length === 0) return false;
  if (/^guest/i.test(trimmed)) return false; // reserved for auto-assigned guests
  return true;
}

// ---------------------------------------------------------------------------
// Well-known message types (for reference and typo-safety)
// ---------------------------------------------------------------------------

export const MSG = {
  // Global / room management
  UPDATEUSER: 'updateuser',
  NAMETAKEN: 'nametaken',
  POPUP: 'popup',
  PM: 'pm',
  USERCOUNT: 'usercount',
  INIT: 'init',
  TITLE: 'title',
  USERS: 'users',
  JOIN: 'j',
  LEAVE: 'l',
  CHAT: 'c',
  CHAT_TS: 'c:',
  UPDATESEARCH: 'updatesearch',
  UPDATECHALLENGES: 'updatechallenges',
  DEINIT: 'deinit',
  // Battle
  REQUEST: 'request',
  ERROR: 'error',
  PLAYER: 'player',
  TEAMSIZE: 'teamsize',
  GAMETYPE: 'gametype',
  GEN: 'gen',
  TIER: 'tier',
  CLEARPOKE: 'clearpoke',
  POKE: 'poke',
  TEAMPREVIEW: 'teampreview',
  START: 'start',
  TURN: 'turn',
  UPKEEP: 'upkeep',
  MOVE: 'move',
  SWITCH: 'switch',
  DRAG: 'drag',
  CANT: 'cant',
  FAINT: 'faint',
  WIN: 'win',
  TIE: 'tie',
} as const;
