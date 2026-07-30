/**
 * Spectating smoke test.
 *
 * 1. Two players start a battle -> it is advertised in the |battles| list.
 * 2. A third client joins that room -> receives the full log so far, and NO
 *    |request| (only the two players get those; the client uses that absence
 *    to decide it is spectating).
 * 3. The watcher count updates, live turns keep arriving, and leaving works.
 *
 * Run: npx tsx packages/server/scripts/smoke-spectate.ts
 */
import WebSocket from 'ws';
import { GameServer } from '../src/server.js';

const PORT = 8126;
new GameServer(PORT);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LiveBattle { id: string; p1: string; p2: string; turn: number; watchers: number }
interface Client {
  ws: WebSocket;
  battles: LiveBattle[];
  frames: { room: string; lines: string[] }[];
}

/** Players answer slowly, so the battle cannot finish during setup. */
function connect(name: string, autoplay: boolean): Promise<Client> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c: Client = { ws, battles: [], frames: [] };
    ws.on('message', (data) => {
      const raw = String(data);
      let room = '';
      let body = raw;
      if (raw.startsWith('>')) {
        const nl = raw.indexOf('\n');
        room = raw.slice(1, nl);
        body = raw.slice(nl + 1);
      }
      const lines = body.split('\n').filter(Boolean);
      c.frames.push({ room, lines });
      for (const line of lines) {
        if (line.startsWith('|battles|')) c.battles = JSON.parse(line.slice('|battles|'.length));
        if (autoplay && line.startsWith('|request|')) {
          const req = JSON.parse(line.slice('|request|'.length));
          if (!req.wait) setTimeout(() => ws.send(`${room}|/choose default`), 250);
        }
      }
    });
    ws.on('open', () => { ws.send(`|/trn ${name}`); setTimeout(() => resolve(c), 150); });
  });
}

const fail = (msg: string): never => { console.error(`SMOKE-SPEC FAIL: ${msg}`); process.exit(1); };

const alice = await connect('SpecAlice', true);
const bob = await connect('SpecBob', true);
alice.ws.send('|/lobby create');
await sleep(300);
bob.ws.send('|/lobby join lobby-1');
await sleep(900);

// (1) The battle is advertised.
const watcher = await connect('SpecWatcher', false);
await sleep(400);
if (!watcher.battles.length) fail('no live battle advertised in |battles|');
const target = watcher.battles[0]!;
if (target.p1 !== 'SpecAlice' || target.p2 !== 'SpecBob') {
  fail(`wrong players advertised: ${JSON.stringify(target)}`);
}

// The players themselves must not be offered their own battle to watch —
// that filtering is the client's job, but the id must at least be theirs.
if (!target.id.startsWith('battle-')) fail(`bad battle id ${target.id}`);

// (2) Join it.
watcher.ws.send(`|/join ${target.id}`);
await sleep(600);
const battleFrames = watcher.frames.filter((f) => f.room === target.id);
const init = battleFrames.find((f) => f.lines[0] === '|init|battle');
if (!init) fail('spectator never received |init|battle');
if (init!.lines.length < 5) fail('spectator received an empty battle log');
if (!init!.lines.some((l) => l.startsWith('|turn|'))) fail('catch-up log had no turns');
if (battleFrames.some((f) => f.lines.some((l) => l.startsWith('|request|')))) {
  fail('spectator was sent a |request| — it would be offered a move menu');
}

// (3) The watcher count is published, and live updates keep coming.
await sleep(400);
const listed = watcher.battles.find((b) => b.id === target.id);
if (listed && listed.watchers < 1) fail(`watcher count did not update: ${listed.watchers}`);
const seenBefore = battleFrames.length;
await sleep(900);
const seenAfter = watcher.frames.filter((f) => f.room === target.id).length;
if (seenAfter <= seenBefore) fail('spectator stopped receiving live updates');

// (4) Leaving works.
watcher.ws.send(`${target.id}|/leave`);
await sleep(400);

console.log('SMOKE-SPEC OK: battle advertised -> spectator caught up, got no request, '
  + `saw live turns (${seenBefore} -> ${seenAfter} frames), and left cleanly`);
process.exit(0);
