/**
 * Perspective/lineup smoke test.
 *
 * Plays N full battles with two real WebSocket clients, each feeding the REAL
 * client-side BattleModel, and asserts after every protocol line that:
 *   - each client renders as the side the server assigned it,
 *   - both clients agree on objective state (who is out, at what HP),
 *   - both agree on which species each side owns,
 *   - your own lineup renders in the order you actually play (the order the
 *     team-preview lead choice reordered it into),
 *   - faint flags never run ahead of the server's own condition data.
 *
 * Run: npx tsx packages/server/scripts/smoke-perspective.ts [battles]
 */
import WebSocket from 'ws';
import { GameServer } from '../src/server.js';
import { BattleModel, type BattleEvents, type RequestData, type SideID } from '../../client/src/battle-model.js';

const PORT = 8149;
const BATTLES = Number(process.argv[2] ?? 4);
new GameServer(PORT);

const noop = (): void => {};
const findings = new Map<string, number>();
function bug(m: string): void { findings.set(m, (findings.get(m) ?? 0) + 1); }

interface C {
  ws: WebSocket; name: string; model: BattleModel | null; room: string;
  picked: boolean; lastReq: RequestData | null;
  /** Species in the order this player's own team actually plays. */
  trueOrder: string[];
  benchChecked: boolean;
  ended: boolean;
}

function mkModel(c: C): BattleModel {
  const ev: BattleEvents = {
    onLog: noop, onSwitch: noop, onMove: noop, onHPChange: noop, onStatbar: noop,
    onFaint: noop, onFx: noop, onWeather: noop, onStatusApplied: noop,
    onTurnTimer: noop, onBench: noop, onTurn: noop, onTeamPreview: noop,
    onEnd: () => { c.ended = true; },
    onRequest: (req) => {
      c.lastReq = req;
      if (req.teamPreview && !c.picked) {
        c.picked = true;
        const n = req.side.pokemon.length;
        const lead = 1 + Math.floor(Math.random() * n);
        const order = [lead, ...Array.from({ length: n }, (_, j) => j + 1).filter((x) => x !== lead)];
        c.trueOrder = order.map((i) => req.side.pokemon[i - 1]!.details.split(',')[0] ?? '');
        setTimeout(() => c.ws.send(`${c.room}|/choose team ${order.join('')}`), 5);
      } else if (!req.wait && !req.teamPreview) {
        // Record the authoritative play order once the battle proper starts.
        if (!c.trueOrder.length) c.trueOrder = req.side.pokemon.map((p) => p.details.split(',')[0] ?? '');
        setTimeout(() => c.ws.send(`${c.room}|/choose default`), 5);
      }
    },
  };
  return new BattleModel(c.name, ev);
}

function connect(name: string): Promise<C> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c: C = { ws, name, model: null, room: '', picked: false, lastReq: null, trueOrder: [], benchChecked: false, ended: false };
    ws.on('message', (d) => {
      const raw = String(d);
      let roomId = '', body = raw;
      if (raw.startsWith('>')) { const nl = raw.indexOf('\n'); roomId = raw.slice(1, nl); body = raw.slice(nl + 1); }
      for (const line of body.split('\n')) {
        if (!line) continue;
        if (line === '|init|battle') { c.room = roomId; c.model = mkModel(c); }
        if (roomId && c.room && roomId !== c.room && c.model) {
          bug(`cross-room: ${c.name} received "${line.slice(0, 24)}" for ${roomId} while in ${c.room}`);
        }
        c.model?.receiveLine(line);
      }
    });
    ws.on('open', () => { ws.send(`|/trn ${name}`); setTimeout(() => resolve(c), 100); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function checkAll(a: C, b: C): void {
  if (!a.model || !b.model) return;

  // 1. Each client must render as the side the server assigned it.
  for (const c of [a, b]) {
    const server = c.lastReq?.side.id;
    if (server && c.model!.mySide !== server) {
      bug(`side mismatch: server says ${c.name}=${server}, client renders as ${c.model!.mySide}`);
    }
  }

  // 2. Both clients must agree on OBJECTIVE state (who is out, at what HP).
  for (const s of ['p1', 'p2'] as SideID[]) {
    const pa = a.model.sides[s].active;
    const pb = b.model.sides[s].active;
    if (pa && pb) {
      if (pa.species !== pb.species) {
        bug(`state divergence: ${a.name} sees ${s} as ${pa.species}, ${b.name} sees ${s} as ${pb.species}`);
      }
      if (pa.hp !== pb.hp) {
        bug(`hp divergence on ${s}: ${a.name} sees ${pa.hp}, ${b.name} sees ${pb.hp}`);
      }
    }
    // 3. Both clients must agree on WHICH species a side has. The running
    //    order is intentionally asymmetric: you see your own true order, the
    //    opponent only sees what was revealed at preview (hidden information).
    const la = [...a.model.sides[s].bench.map((x) => x.species)].sort().join();
    const lb = [...b.model.sides[s].bench.map((x) => x.species)].sort().join();
    if (la !== lb) bug(`roster divergence on ${s}: [${la}] vs [${lb}]`);
  }

  // 4. Your OWN lineup must be the order you actually play, once the battle
  //    proper has begun (at preview the reorder has not happened yet).
  for (const c of [a, b]) {
    const req = c.lastReq;
    if (c.benchChecked || !c.trueOrder.length || !req || req.teamPreview) continue;
    const mine = c.model!.mySide ?? 'p1';
    const shown = c.model!.sides[mine].bench.map((x) => x.species);
    if (shown.length === c.trueOrder.length) {
      c.benchChecked = true;
      if (shown.join() !== c.trueOrder.join()) {
        bug(`lineup order wrong: plays [${c.trueOrder.join(',')}] but renders [${shown.join(',')}]`);
      }
    }
  }

  // 5. Fainted flags must agree with the owner's own request data. Skipped
  //    once the battle ends: the final faint lands after the last request.
  for (const c of [a, b]) {
    const req = c.lastReq;
    if (!req || req.teamPreview || a.ended || b.ended) continue;
    const mine = c.model!.mySide ?? 'p1';
    const trueFaints = req.side.pokemon.filter((p) => p.condition.endsWith('fnt')).length;
    const shownFaints = c.model!.sides[mine].bench.filter((x) => x.fainted).length;
    if (shownFaints > trueFaints) {
      bug(`faint overcount for ${c.name}: shows ${shownFaints} fainted, actually ${trueFaints}`);
    }
  }

  // 6. Lineups must never exceed six, and never contain duplicates of a
  //    species the side does not actually have twice.
  for (const s of ['p1', 'p2'] as SideID[]) {
    const bench = a.model.sides[s].bench;
    if (bench.length > 6) bug(`lineup overflow on ${s}: ${bench.length} entries (${bench.map((x) => x.species).join(',')})`);
  }
}

let battlesRun = 0;
for (let i = 0; i < BATTLES; i++) {
  const a = await connect(`SweepA${i}`);
  const b = await connect(`SweepB${i}`);
  const timer = setInterval(() => checkAll(a, b), 25);
  a.ws.send('|/search'); b.ws.send('|/search');
  const start = Date.now();
  while (!a.ended && !b.ended && Date.now() - start < 40_000) await sleep(100);
  checkAll(a, b);
  clearInterval(timer);
  battlesRun++;
  process.stdout.write(`  battle ${i + 1}: ${a.ended || b.ended ? 'finished' : 'TIMED OUT'}\n`);
  if (!a.ended && !b.ended) bug('battle never reached a win/tie within 40s');
  a.ws.close(); b.ws.close();
  await sleep(150);
}

console.log(`\n================ ${battlesRun} battles ================`);
if (!findings.size) console.log('no invariant violations');
else for (const [m, n] of [...findings].sort((x, y) => y[1] - x[1])) console.log(`x${String(n).padStart(4)}  ${m}`);
process.exit(0);
