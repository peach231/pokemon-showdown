/**
 * The game server: WebSocket connections, users, rooms, matchmaking, ladder,
 * accounts, bots, and battle lifecycle (including turn timers, rematches,
 * and crash/restart persistence).
 *
 * Framing follows the protocol package:
 *   client -> server: `ROOMID|TEXT`
 *   server -> client: `>ROOMID\n|TYPE|DATA...` (no prefix for the global room)
 */
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  parseClientMessage, serializeServerFrame, toID, isValidUsername, GLOBAL_ROOM,
} from '@simple-showdown/protocol';
import { Battle, PRNG, type SideID, type PRNGSeed } from '@simple-showdown/sim';
import {
  generateRandomTeam, generateTeamFromSpecs, parseTeamSpecs, type TeamSpec,
} from './random-team.js';
import { LadderStore, STARTING_ELO } from './ladder.js';
import { AccountStore } from './accounts.js';
import { createDb } from './db.js';
import { User } from './user.js';
import { BattleRoom } from './battle-room.js';
import { runBot } from './bot.js';

/** How long a disconnected player has to reconnect before forfeiting. */
const DISCONNECT_MS = Number(process.env['SS_DISCONNECT_MS'] ?? 60_000);
/** How long each battle decision may take before auto-choosing. */
const TURN_MS = Number(process.env['SS_TURN_MS'] ?? 60_000);
const BOT_NAME = 'Trainer Bot';
const LOBBY = 'lobby';

const DATA_DIR = path.join(process.cwd(), 'packages', 'server', 'data');
const BATTLES_DIR = path.join(DATA_DIR, 'battles');
/** Built client (production): served over the same HTTP port as the WebSocket. */
const CLIENT_DIST = path.join(process.cwd(), 'packages', 'client', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

/** An open lobby a friend can join to start a battle with the host. */
interface Lobby {
  id: string;
  host: User;
  hostTeam: TeamSpec[];
}

/** On-disk snapshot of a live battle (enough to replay it after a restart). */
interface PersistedBattle {
  id: string;
  seed: PRNGSeed;
  teamSeed: string;
  p1: { id: string; name: string; avatar: string };
  p2: { id: string; name: string; avatar: string };
  teams: { p1: TeamSpec[]; p2: TeamSpec[] };
  rated: boolean;
  botSide: SideID | null;
  botHard: boolean;
  inputs: string[];
}

export class GameServer {
  private wss!: WebSocketServer;
  readonly users = new Map<string, User>();
  private socketUsers = new Map<WebSocket, User>();
  readonly battles = new Map<string, BattleRoom>();
  private chatRooms = new Map<string, Set<User>>([[LOBBY, new Set()]]);
  private lobbies = new Map<string, Lobby>();
  private guestCounter = 0;
  private battleCounter = 0;
  private lobbyCounter = 0;
  /** Pending disconnect-forfeit timers, keyed `roomId|userid`. */
  private dcTimers = new Map<string, NodeJS.Timeout>();
  /** Pending per-decision timers, keyed `roomId|side`. */
  private turnTimers = new Map<string, NodeJS.Timeout>();
  private db = createDb();
  readonly ladder = new LadderStore(this.db, path.join(DATA_DIR, 'ladder.json'));
  readonly accounts = new AccountStore(this.db, path.join(DATA_DIR, 'accounts.json'));
  private rankedQueue: { user: User; team: TeamSpec[] }[] = [];
  /** Resolves once stores are warm and the socket is listening. */
  readonly ready: Promise<void>;

  constructor(port: number) {
    this.ready = this.bootstrap(port);
    this.ready.catch((err) => {
      console.error('fatal: server failed to start:', err);
      process.exit(1);
    });
  }

  private async bootstrap(port: number): Promise<void> {
    // Warm the persistent stores BEFORE accepting connections, so logins
    // and ratings are never served from a cold cache.
    await this.accounts.init();
    await this.ladder.init();

    // One HTTP server: serves the built client AND carries the WebSocket,
    // so a single Render/Fly/VM port runs the whole game.
    const httpServer = http.createServer((req, res) => this.serveStatic(req, res));
    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
    console.log(`simple-showdown server listening on http+ws://localhost:${port}`);
    await this.restoreBattles();
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    // Sanitize: strip any path traversal.
    const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/\\/g, '/');
    let filePath = path.join(CLIENT_DIST, safe === '/' ? 'index.html' : safe);
    if (!filePath.startsWith(CLIENT_DIST)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, content) => {
      if (err) {
        // SPA fallback for unknown routes; plain notice when no build exists (dev).
        filePath = path.join(CLIENT_DIST, 'index.html');
        fs.readFile(filePath, (err2, index) => {
          if (err2) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Game server running. In dev, open the Vite client (port 5173).');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(index);
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': filePath.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(content);
    });
  }

  // ------------------------------------------------------------------
  // Connections & identity
  // ------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const user = new User(`Guest ${++this.guestCounter}`);
    user.sockets.add(ws);
    this.users.set(user.id, user);
    this.socketUsers.set(ws, user);
    user.sendGlobal([`|updateuser|${user.name}|0`]);

    this.joinRoom(user, LOBBY);
    this.broadcastUserCount();
    user.sendGlobal([this.lobbiesLine()]);

    ws.on('message', (data) => {
      try {
        this.onMessage(ws, String(data));
      } catch (err) {
        console.error('error handling message:', err);
      }
    });
    ws.on('close', () => this.onClose(ws));
  }

  private onClose(ws: WebSocket): void {
    const user = this.socketUsers.get(ws);
    if (!user) return;
    this.socketUsers.delete(ws);
    user.sockets.delete(ws);
    if (user.sockets.size === 0) {
      this.rankedQueue = this.rankedQueue.filter((s) => s.user !== user);
      this.removeLobbyOf(user);
      for (const roomId of user.rooms) {
        this.leaveRoom(user, roomId, /* silentGone */ true);
      }
      let inBattle = false;
      for (const room of this.battles.values()) {
        if (room.ended) continue;
        const side = room.sideOf(user);
        if (!side) continue;
        inBattle = true;
        this.startDisconnectTimer(room, user, side);
      }
      if (!inBattle) this.users.delete(user.id);
      this.broadcastUserCount();
    }
  }

  // ------------------------------------------------------------------
  // Message routing
  // ------------------------------------------------------------------

  private onMessage(ws: WebSocket, raw: string): void {
    const user = this.socketUsers.get(ws);
    if (!user) return;
    const { roomId, text } = parseClientMessage(raw);
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (line.startsWith('/')) {
        this.runCommand(user, roomId, line);
      } else {
        this.chat(user, roomId || LOBBY, line);
      }
    }
  }

  private runCommand(user: User, roomId: string, line: string): void {
    const space = line.indexOf(' ');
    const cmd = (space < 0 ? line.slice(1) : line.slice(1, space)).toLowerCase();
    const arg = space < 0 ? '' : line.slice(space + 1).trim();

    switch (cmd) {
      case 'trn':
      case 'nick':
        this.rename(user, arg);
        break;
      case 'register': {
        const comma = arg.indexOf(',');
        if (comma < 0) return this.errorTo(user, '', 'Usage: /register name,password');
        this.registerAccount(user, arg.slice(0, comma).trim(), arg.slice(comma + 1));
        break;
      }
      case 'login': {
        const comma = arg.indexOf(',');
        if (comma < 0) return this.errorTo(user, '', 'Usage: /login name,password');
        this.loginAccount(user, arg.slice(0, comma).trim(), arg.slice(comma + 1));
        break;
      }
      case 'logout':
        this.accounts.revokeToken(user.id, arg.trim());
        user.sendGlobal([`|queryresponse|logout|{"ok":true}`]);
        break;
      case 'avatar': {
        const avatar = arg.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
        user.avatar = avatar;
        user.sendGlobal([`|queryresponse|avatar|${JSON.stringify({ avatar })}`]);
        this.broadcastLobbies(); // lobby rows show host avatars
        break;
      }
      case 'join':
        if (arg) this.joinRoom(user, toID(arg));
        break;
      case 'leave':
        this.leaveRoom(user, roomId || toID(arg));
        break;
      case 'search': {
        if (user.isGuest) {
          return this.errorTo(user, '', 'Pick a name (top right) before playing ranked!');
        }
        if (this.rankedQueue.some((s) => s.user === user)) return;
        this.rankedQueue.push({ user, team: parseTeamSpecs(arg) });
        user.sendGlobal([`|updatesearch|${JSON.stringify({ searching: ['ranked'], games: null })}`]);
        this.tryPairRanked();
        break;
      }
      case 'cancelsearch':
        this.rankedQueue = this.rankedQueue.filter((s) => s.user !== user);
        user.sendGlobal([`|updatesearch|${JSON.stringify({ searching: [], games: null })}`]);
        break;
      case 'ladder': {
        const me = this.ladder.get(user.id);
        user.sendGlobal([`|queryresponse|ladder|${JSON.stringify({
          top: this.ladder.top(25),
          me: me ?? { userid: user.id, name: user.name, elo: STARTING_ELO, wins: 0, losses: 0, ties: 0 },
          rated: !!me,
        })}`]);
        break;
      }
      case 'lobby': {
        const [sub, ...restParts] = arg.split(' ');
        if (sub === 'create') {
          this.removeLobbyOf(user);
          const id = `lobby-${++this.lobbyCounter}`;
          this.lobbies.set(id, { id, host: user, hostTeam: parseTeamSpecs(restParts[0] ?? '') });
          this.broadcastLobbies();
        } else if (sub === 'join') {
          const lobby = this.lobbies.get(restParts[0] ?? '');
          if (!lobby) return this.errorTo(user, '', 'That lobby no longer exists.');
          if (lobby.host === user) return this.errorTo(user, '', "You can't join your own lobby.");
          this.lobbies.delete(lobby.id);
          this.removeLobbyOf(user);
          this.broadcastLobbies();
          void this.createBattle(lobby.host, user, lobby.hostTeam, parseTeamSpecs(restParts[1] ?? ''));
        } else if (sub === 'cancel') {
          this.removeLobbyOf(user);
        }
        break;
      }
      case 'botbattle': {
        // /botbattle [easy|hard] [team]
        const [tier, ...teamParts] = arg.split(' ');
        const isTier = tier === 'easy' || tier === 'hard';
        const bot = new User(BOT_NAME);
        bot.avatar = 'scientist';
        void this.createBattle(
          user, bot,
          parseTeamSpecs(isTier ? (teamParts[0] ?? '') : arg), [],
          'p2', false, tier !== 'easy',
        );
        break;
      }
      case 'choose': {
        const room = this.battles.get(roomId);
        if (!room) return this.errorTo(user, roomId, 'You are not in that battle.');
        const side = room.sideOf(user);
        if (!side) return this.errorTo(user, roomId, 'You are not a player in this battle.');
        if (room.submitChoice(side, arg) === null) {
          this.clearTurnTimer(room.id, side);
        }
        break;
      }
      case 'forfeit': {
        const room = this.battles.get(roomId);
        if (!room) return;
        const side = room.sideOf(user);
        if (side && !room.battle.ended) room.battle.forfeit(side);
        break;
      }
      case 'rematch': {
        const room = this.battles.get(roomId);
        if (!room || !room.battle.ended) return;
        const side = room.sideOf(user);
        if (!side) return;
        if (room.botSide) {
          // Instant rematch against a fresh bot.
          const bot = new User(BOT_NAME);
          bot.avatar = 'scientist';
          void this.createBattle(user, bot, room.teams.p1, [], 'p2', false, room.botHard);
          return;
        }
        room.rematchVotes.add(side);
        const other = side === 'p1' ? room.players.p2 : room.players.p1;
        if (room.rematchVotes.size >= 2) {
          void this.createBattle(
            room.players.p1, room.players.p2, room.teams.p1, room.teams.p2, null, room.rated);
        } else {
          room.broadcast([`|-message|${user.name} wants a rematch! (${other.name}: click Rematch to accept)`]);
        }
        break;
      }
      case 'pm': {
        const comma = arg.indexOf(',');
        if (comma < 0) return;
        const target = this.users.get(toID(arg.slice(0, comma)));
        const message = arg.slice(comma + 1).trim();
        if (!target) return this.errorTo(user, '', 'That user is not online.');
        const pmLine = `|pm|${user.name}|${target.name}|${message}`;
        target.sendGlobal([pmLine]);
        user.sendGlobal([pmLine]);
        break;
      }
      default:
        this.errorTo(user, roomId, `Unknown command: /${cmd}`);
    }
  }

  private errorTo(user: User, roomId: string, message: string): void {
    user.send(serializeServerFrame(roomId, [`|error|${message}`]));
  }

  // ------------------------------------------------------------------
  // Identity: rename, accounts, reconnect
  // ------------------------------------------------------------------

  private rename(user: User, newName: string): void {
    if (!isValidUsername(newName)) {
      user.sendGlobal([`|nametaken|${newName}|Invalid name.`]);
      return;
    }
    const newId = toID(newName);
    if (this.accounts.isRegistered(newId)) {
      user.sendGlobal([`|nametaken|${newName}|That name is registered. Log in with its password.`]);
      return;
    }
    const existing = this.users.get(newId);
    if (existing && existing !== user) {
      if (existing.sockets.size > 0) {
        user.sendGlobal([`|nametaken|${newName}|Someone is already using that name.`]);
        return;
      }
      this.reconnectAs(user, existing);
      return;
    }
    this.users.delete(user.id);
    user.name = newName;
    user.id = newId;
    this.users.set(newId, user);
    user.sendGlobal([`|updateuser|${user.name}|1`]);
    for (const roomId of user.rooms) {
      this.broadcastRoom(roomId, [`|n|${user.name}`]);
    }
  }

  /** Rename in place, or merge into an existing User with that id. */
  private takeIdentity(user: User, name: string): User {
    const id = toID(name);
    const existing = this.users.get(id);
    if (existing && existing !== user) {
      this.reconnectAs(user, existing);
      existing.name = name;
      return existing;
    }
    this.users.delete(user.id);
    user.name = name;
    user.id = id;
    this.users.set(id, user);
    for (const roomId of user.rooms) {
      this.broadcastRoom(roomId, [`|n|${user.name}`]);
    }
    return user;
  }

  private registerAccount(user: User, name: string, password: string): void {
    if (!isValidUsername(name)) {
      return void user.sendGlobal([`|nametaken|${name}|Invalid name.`]);
    }
    const id = toID(name);
    if (this.accounts.isRegistered(id)) {
      return void user.sendGlobal([`|nametaken|${name}|That name is already registered. Log in instead.`]);
    }
    const existing = this.users.get(id);
    if (existing && existing !== user && existing.sockets.size > 0) {
      return void user.sendGlobal([`|nametaken|${name}|Someone is using that name right now.`]);
    }
    const result = this.accounts.register(id, name, password);
    if ('error' in result) {
      return void user.sendGlobal([`|nametaken|${name}|${result.error}`]);
    }
    const identity = this.takeIdentity(user, name);
    identity.sendGlobal([`|updateuser|${identity.name}|2`]);
    identity.sendGlobal([`|queryresponse|session|${JSON.stringify({ name: identity.name, token: result.token })}`]);
  }

  private loginAccount(user: User, name: string, secret: string): void {
    const id = toID(name);
    const result = this.accounts.login(id, secret);
    if ('error' in result) {
      return void user.sendGlobal([`|nametaken|${name}|${result.error}`]);
    }
    const identity = this.takeIdentity(user, result.name);
    identity.sendGlobal([`|updateuser|${identity.name}|2`]);
    identity.sendGlobal([`|queryresponse|session|${JSON.stringify({ name: identity.name, token: result.token })}`]);
  }

  /** Move a fresh connection into an existing identity, rejoining battles. */
  private reconnectAs(tempUser: User, identity: User): void {
    for (const ws of tempUser.sockets) {
      this.socketUsers.set(ws, identity);
      identity.sockets.add(ws);
    }
    tempUser.sockets.clear();
    this.rankedQueue = this.rankedQueue.filter((s) => s.user !== tempUser);
    this.removeLobbyOf(tempUser);
    for (const roomId of tempUser.rooms) {
      this.leaveRoom(tempUser, roomId, true);
    }
    this.users.delete(tempUser.id);

    identity.sendGlobal([`|updateuser|${identity.name}|1`]);
    identity.sendGlobal([this.lobbiesLine()]);
    this.joinRoom(identity, LOBBY);
    for (const room of this.battles.values()) {
      if (!room.ended && room.sideOf(identity)) {
        this.joinRoom(identity, room.id);
      }
    }
    this.cancelDisconnectTimers(identity);
    this.broadcastUserCount();
  }

  // ------------------------------------------------------------------
  // Presence & lobby broadcasts
  // ------------------------------------------------------------------

  private onlineCount(): number {
    let n = 0;
    for (const user of this.users.values()) {
      if (user.sockets.size > 0) n++;
    }
    return n;
  }

  private broadcastUserCount(): void {
    const frame = serializeServerFrame(GLOBAL_ROOM, [`|usercount|${this.onlineCount()}`]);
    for (const user of this.users.values()) user.send(frame);
  }

  private lobbiesLine(): string {
    const list = [...this.lobbies.values()]
      .map((l) => ({ id: l.id, host: l.host.name, avatar: l.host.avatar }));
    return `|lobbies|${JSON.stringify(list)}`;
  }

  private broadcastLobbies(): void {
    const frame = serializeServerFrame(GLOBAL_ROOM, [this.lobbiesLine()]);
    for (const user of this.users.values()) user.send(frame);
  }

  private removeLobbyOf(user: User): void {
    let changed = false;
    for (const [id, lobby] of this.lobbies) {
      if (lobby.host === user) {
        this.lobbies.delete(id);
        changed = true;
      }
    }
    if (changed) this.broadcastLobbies();
  }

  // ------------------------------------------------------------------
  // Chat rooms
  // ------------------------------------------------------------------

  private joinRoom(user: User, roomId: string): void {
    if (this.battles.has(roomId)) {
      const room = this.battles.get(roomId)!;
      if (!room.sideOf(user)) room.spectators.add(user);
      user.rooms.add(roomId);
      user.send(serializeServerFrame(roomId, ['|init|battle', ...room.battle.log]));
      const side = room.sideOf(user);
      if (side && !room.battle.ended) {
        user.send(serializeServerFrame(
          roomId, [`|request|${JSON.stringify(room.battle.currentRequest(side))}`]));
      }
      return;
    }
    let members = this.chatRooms.get(roomId);
    if (!members) {
      members = new Set();
      this.chatRooms.set(roomId, members);
    }
    if (members.has(user)) return;
    members.add(user);
    user.rooms.add(roomId);
    const userList = [...members].map((u) => ` ${u.name}`).join(',');
    user.send(serializeServerFrame(roomId, [
      '|init|chat', `|title|${roomId}`,
      `|users|${members.size}${userList ? ',' + userList : ''}`,
    ]));
    this.broadcastRoom(roomId, [`|j| ${user.name}`], user);
  }

  private leaveRoom(user: User, roomId: string, silentGone = false): void {
    const battle = this.battles.get(roomId);
    if (battle) {
      battle.spectators.delete(user);
      user.rooms.delete(roomId);
      return;
    }
    const members = this.chatRooms.get(roomId);
    if (!members?.has(user)) return;
    members.delete(user);
    user.rooms.delete(roomId);
    if (!silentGone) user.send(serializeServerFrame(roomId, ['|deinit']));
    this.broadcastRoom(roomId, [`|l| ${user.name}`]);
  }

  private chat(user: User, roomId: string, message: string): void {
    if (message.length > 1000) return;
    const battle = this.battles.get(roomId);
    const line = `|c|${user.name}|${message}`;
    if (battle) {
      battle.broadcast([line]);
      return;
    }
    if (!this.chatRooms.get(roomId)?.has(user)) return;
    this.broadcastRoom(roomId, [line]);
  }

  private broadcastRoom(roomId: string, lines: string[], except?: User): void {
    const members = this.chatRooms.get(roomId);
    if (!members) return;
    const frame = serializeServerFrame(roomId, lines);
    for (const member of members) {
      if (member !== except) member.send(frame);
    }
  }

  // ------------------------------------------------------------------
  // Matchmaking & battles
  // ------------------------------------------------------------------

  private tryPairRanked(): void {
    if (this.rankedQueue.length < 2) return;
    let best: [number, number] = [0, 1];
    let bestGap = Infinity;
    for (let i = 0; i < this.rankedQueue.length; i++) {
      for (let j = i + 1; j < this.rankedQueue.length; j++) {
        const gap = Math.abs(
          this.ladder.getElo(this.rankedQueue[i]!.user.id) -
          this.ladder.getElo(this.rankedQueue[j]!.user.id));
        if (gap < bestGap) {
          bestGap = gap;
          best = [i, j];
        }
      }
    }
    const s2 = this.rankedQueue.splice(best[1], 1)[0]!;
    const s1 = this.rankedQueue.splice(best[0], 1)[0]!;
    void this.createBattle(s1.user, s2.user, s1.team, s2.team, null, true);
  }

  private async createBattle(
    p1: User, p2: User,
    p1Team: TeamSpec[] = [], p2Team: TeamSpec[] = [],
    botSide: SideID | null = null,
    rated = false,
    botHard = true,
  ): Promise<void> {
    const roomId = `battle-simplesingles-${++this.battleCounter}`;
    const teamSeed = `${roomId}-${Date.now()}`;
    const teamPrng = new PRNG(`${teamSeed}-teams`);

    const makeTeam = (specs: TeamSpec[]) =>
      specs.length ? generateTeamFromSpecs(teamPrng, specs) : generateRandomTeam(teamPrng);

    const battle = new Battle({
      seed: teamSeed,
      p1: { name: p1.name, team: await makeTeam(p1Team), avatar: p1.avatar },
      p2: { name: p2.name, team: await makeTeam(p2Team), avatar: p2.avatar },
    });
    const room = new BattleRoom(roomId, battle, p1, p2);
    room.rated = rated;
    room.botSide = botSide;
    room.botHard = botHard;
    room.teams = { p1: p1Team, p2: p2Team };
    this.battles.set(roomId, room);
    p1.rooms.add(roomId);
    p2.rooms.add(roomId);

    this.wireRoom(room, teamSeed);

    for (const player of [p1, p2]) {
      player.send(serializeServerFrame(roomId, ['|init|battle', `|title|${p1.name} vs. ${p2.name}`]));
      player.sendGlobal([`|updatesearch|${JSON.stringify({ searching: [], games: { [roomId]: `${p1.name} vs. ${p2.name}` } })}`]);
    }
    battle.start();
    this.persistBattle(room);
  }

  /** Attach protocol handlers (broadcast, bot, timers, ratings) to a room. */
  private wireRoom(room: BattleRoom, teamSeed: string): void {
    room.battle.onUpdate = (lines) => {
      room.broadcast(lines);
      if (room.battle.ended) {
        room.ended = true;
        this.clearTurnTimers(room.id);
        this.reportRatings(room);
        this.unpersistBattle(room.id);
      }
    };
    room.battle.onSideUpdate = (side, line) => {
      if (line.startsWith('|request|')) {
        this.armTurnTimer(room, side, line);
      }
      if (side === room.botSide) {
        runBot(room, side, line);
        return;
      }
      room.players[side].send(serializeServerFrame(room.id, [line]));
    };
    room.onPersist = () => this.persistBattle(room);
    room.teamSeed = teamSeed;
  }

  // ------------------------------------------------------------------
  // Turn timers (per decision)
  // ------------------------------------------------------------------

  private armTurnTimer(room: BattleRoom, side: SideID, requestLine: string): void {
    this.clearTurnTimer(room.id, side);
    if (room.botSide === side || room.battle.ended) return;
    let isWait = false;
    try {
      isWait = !!JSON.parse(requestLine.slice('|request|'.length)).wait;
    } catch { /* treat as active */ }
    if (isWait) return;
    const rqid = room.battle.rqid;
    const seconds = Math.round(TURN_MS / 1000);
    room.players[side].send(serializeServerFrame(room.id, [`|turntimer|${seconds}`]));
    this.turnTimers.set(`${room.id}|${side}`, setTimeout(() => {
      this.turnTimers.delete(`${room.id}|${side}`);
      if (room.battle.ended || room.battle.rqid !== rqid) return;
      room.broadcast([`|-message|${room.players[side].name} ran out of time!`]);
      room.submitChoice(side, 'default');
    }, TURN_MS));
  }

  private clearTurnTimer(roomId: string, side: SideID): void {
    const key = `${roomId}|${side}`;
    const timer = this.turnTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(key);
    }
  }

  private clearTurnTimers(roomId: string): void {
    this.clearTurnTimer(roomId, 'p1');
    this.clearTurnTimer(roomId, 'p2');
  }

  // ------------------------------------------------------------------
  // Ratings
  // ------------------------------------------------------------------

  private reportRatings(room: BattleRoom): void {
    if (!room.rated || room.ratingReported) return;
    room.ratingReported = true;
    const { p1, p2 } = room.players;
    const winner = room.battle.winner;
    const score = winner === null ? 0.5 : winner === p1.name ? 1 : 0;
    const result = this.ladder.reportResult(
      { userid: p1.id, name: p1.name, avatar: p1.avatar },
      { userid: p2.id, name: p2.name, avatar: p2.avatar },
      score,
    );
    const fmt = (name: string, r: { before: number; after: number }) => {
      const delta = r.after - r.before;
      return `${name}: ${r.before} → ${r.after} (${delta >= 0 ? '+' : ''}${delta})`;
    };
    room.broadcast([`|-message|Ranked: ${fmt(p1.name, result.p1)} · ${fmt(p2.name, result.p2)}`]);
    for (const [player, r] of [[p1, result.p1], [p2, result.p2]] as const) {
      player.sendGlobal([`|queryresponse|rating|${JSON.stringify({ elo: r.after })}`]);
    }
  }

  // ------------------------------------------------------------------
  // Disconnect timers
  // ------------------------------------------------------------------

  private startDisconnectTimer(room: BattleRoom, user: User, side: SideID): void {
    const key = `${room.id}|${user.id}`;
    if (this.dcTimers.has(key)) return;
    const seconds = Math.round(DISCONNECT_MS / 1000);
    room.broadcast([`|inactive|${user.name} disconnected and has ${seconds} seconds to reconnect!`]);
    this.dcTimers.set(key, setTimeout(() => {
      this.dcTimers.delete(key);
      if (!room.battle.ended) {
        room.broadcast([`|-message|${user.name} lost due to inactivity.`]);
        room.battle.forfeit(side);
      }
    }, DISCONNECT_MS));
  }

  private cancelDisconnectTimers(user: User): void {
    for (const [key, timer] of this.dcTimers) {
      if (!key.endsWith(`|${user.id}`)) continue;
      clearTimeout(timer);
      this.dcTimers.delete(key);
      const room = this.battles.get(key.split('|')[0] ?? '');
      room?.broadcast([`|inactiveoff|${user.name} reconnected.`]);
    }
  }

  // ------------------------------------------------------------------
  // Battle persistence: live battles survive a server restart
  // ------------------------------------------------------------------

  private persistBattle(room: BattleRoom): void {
    if (room.ended) return;
    try {
      const data: PersistedBattle = {
        id: room.id,
        seed: room.battle.prng.initialSeed,
        teamSeed: room.teamSeed,
        p1: { id: room.players.p1.id, name: room.players.p1.name, avatar: room.players.p1.avatar },
        p2: { id: room.players.p2.id, name: room.players.p2.name, avatar: room.players.p2.avatar },
        teams: room.teams,
        rated: room.rated,
        botSide: room.botSide,
        botHard: room.botHard,
        inputs: room.persistedInputs,
      };
      fs.mkdirSync(BATTLES_DIR, { recursive: true });
      fs.writeFileSync(path.join(BATTLES_DIR, `${room.id}.json`), JSON.stringify(data));
    } catch (err) {
      console.error('persistBattle failed:', err);
    }
  }

  private unpersistBattle(roomId: string): void {
    try {
      fs.unlinkSync(path.join(BATTLES_DIR, `${roomId}.json`));
    } catch { /* absent */ }
  }

  private async restoreBattles(): Promise<void> {
    let files: string[] = [];
    try {
      files = fs.readdirSync(BATTLES_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return; // no battles dir yet
    }
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(BATTLES_DIR, file), 'utf8')) as PersistedBattle;
        // Keep the battle counter ahead of restored ids.
        const num = parseInt(data.id.split('-').pop() ?? '0', 10);
        if (num > this.battleCounter) this.battleCounter = num;

        // Offline identities the players can reconnect into.
        const p1 = this.users.get(data.p1.id) ?? new User(data.p1.name);
        p1.avatar = data.p1.avatar;
        this.users.set(p1.id, p1);
        const p2 = data.botSide === 'p2'
          ? Object.assign(new User(data.p2.name), { avatar: data.p2.avatar })
          : (() => {
            const u = this.users.get(data.p2.id) ?? new User(data.p2.name);
            u.avatar = data.p2.avatar;
            this.users.set(u.id, u);
            return u;
          })();

        // Rebuild teams and battle deterministically, then replay all inputs.
        const teamPrng = new PRNG(`${data.teamSeed}-teams`);
        const makeTeam = (specs: TeamSpec[]) =>
          specs.length ? generateTeamFromSpecs(teamPrng, specs) : generateRandomTeam(teamPrng);
        const battle = new Battle({
          seed: data.seed,
          p1: { name: data.p1.name, team: await makeTeam(data.teams.p1), avatar: data.p1.avatar },
          p2: { name: data.p2.name, team: await makeTeam(data.teams.p2), avatar: data.p2.avatar },
        });
        battle.start();
        for (const input of data.inputs) {
          const m = /^>(p[12]) (.*)$/.exec(input);
          if (m) battle.choose(m[1] as SideID, m[2]!);
        }
        if (battle.ended) {
          this.unpersistBattle(data.id);
          continue;
        }

        const room = new BattleRoom(data.id, battle, p1, p2);
        room.rated = data.rated;
        room.botSide = data.botSide;
        room.botHard = data.botHard;
        room.teams = data.teams;
        room.persistedInputs = data.inputs;
        this.battles.set(data.id, room);
        p1.rooms.add(data.id);
        p2.rooms.add(data.id);
        this.wireRoom(room, data.teamSeed);

        // Nudge the bot if it owes a decision; humans get theirs on reconnect.
        if (room.botSide) {
          const req = battle.currentRequest(room.botSide);
          if (!req.wait) runBot(room, room.botSide, `|request|${JSON.stringify(req)}`);
        }
        // Both humans are offline right now: start their reconnect clocks.
        for (const [side, player] of [['p1', p1], ['p2', p2]] as const) {
          if (side !== room.botSide && player.sockets.size === 0) {
            this.startDisconnectTimer(room, player, side);
          }
        }
        console.log(`restored battle ${data.id} (${data.p1.name} vs ${data.p2.name})`);
      } catch (err) {
        console.error(`failed to restore ${file}:`, err);
        try { fs.unlinkSync(path.join(BATTLES_DIR, file)); } catch { /* ignore */ }
      }
    }
  }
}
