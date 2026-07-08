/**
 * Disconnect/reconnect smoke test (uses a 2s timer via SS_DISCONNECT_MS):
 * 1. Alice and Bob battle via a lobby.
 * 2. Bob disconnects mid-battle -> expect |inactive| broadcast.
 * 3a. Bob reconnects with /trn -> expect |inactiveoff| + battle log resent.
 * 3b. Bob disconnects again and stays gone -> expect Alice to win by timeout.
 *
 * Run: SS_DISCONNECT_MS=2000 npx tsx packages/server/scripts/smoke-disconnect.ts
 */
process.env['SS_DISCONNECT_MS'] = process.env['SS_DISCONNECT_MS'] ?? '2000';

import WebSocket from 'ws';
import { GameServer } from '../src/server.js';

const PORT = 8124;
new GameServer(PORT);

const seen = { inactive: false, inactiveoff: false, rejoinedLog: false, win: '' };

function connect(name: string, tag: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    autoplay(ws, tag); // listen BEFORE /trn: reconnect replays the log instantly
    ws.on('open', () => {
      ws.send(`|/trn ${name}`);
      setTimeout(() => resolve(ws), 150);
    });
  });
}

function autoplay(ws: WebSocket, tag: string): void {
  ws.on('message', (data) => {
    const raw = String(data);
    let roomId = '';
    let body = raw;
    if (raw.startsWith('>')) {
      const nl = raw.indexOf('\n');
      roomId = raw.slice(1, nl);
      body = raw.slice(nl + 1);
    }
    let sawStart = false;
    for (const line of body.split('\n')) {
      if (line === '|start') sawStart = true;
      if (line.startsWith('|inactive|')) seen.inactive = true;
      if (line.startsWith('|inactiveoff|')) seen.inactiveoff = true;
      if (line.startsWith('|win|')) seen.win = line.slice(5);
      if (line.startsWith('|request|')) {
        const req = JSON.parse(line.slice(9));
        if (!req.wait) setTimeout(() => ws.send(`${roomId}|/choose default`), 30);
      }
    }
    // A reconnect resends the whole log in one frame, |start| included.
    if (sawStart && tag === 'bob-reconnected') seen.rejoinedLog = true;
  });
}

const fail = (msg: string) => { console.error(`SMOKE-DC FAIL: ${msg}`, seen); process.exit(1); };

const alice = await connect('SmokeAliceDC', 'alice');
let bob = await connect('SmokeBobDC', 'bob');

// Start a lobby battle.
alice.send('|/lobby create');
await new Promise((r) => setTimeout(r, 300));
bob.send('|/lobby join lobby-1');
await new Promise((r) => setTimeout(r, 800));

// (2) Bob drops mid-battle.
bob.close();
await new Promise((r) => setTimeout(r, 500));
if (!seen.inactive) fail('no |inactive| after disconnect');

// (3a) Bob reconnects before the 2s timer fires.
bob = await connect('SmokeBobDC', 'bob-reconnected');
await new Promise((r) => setTimeout(r, 700));
if (!seen.inactiveoff) fail('no |inactiveoff| after reconnect');
if (!seen.rejoinedLog) fail('battle log was not resent on reconnect');
if (seen.win) fail(`battle ended early: ${seen.win}`);

// (3b) Bob leaves for good; Alice should win by timeout (~2s).
bob.close();
await new Promise((r) => setTimeout(r, 3500));
if (seen.win !== 'SmokeAliceDC') fail(`expected SmokeAliceDC to win by timeout, got "${seen.win}"`);

console.log('SMOKE-DC OK: inactive -> reconnect (log resent) -> timeout forfeit all worked');
process.exit(0);
