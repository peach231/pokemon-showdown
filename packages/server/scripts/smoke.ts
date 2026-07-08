/**
 * End-to-end smoke test: boots the GameServer, connects two WebSocket
 * clients, searches for a match, and plays a full random battle with
 * "default" choices until |win|.
 *
 * Run: npx tsx packages/server/scripts/smoke.ts
 */
import WebSocket from 'ws';
import { GameServer } from '../src/server.js';

const PORT = 8123;
new GameServer(PORT);

function connect(name: string): Promise<{ ws: WebSocket; name: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('open', () => {
      ws.send(`|/trn ${name}`);
      resolve({ ws, name });
    });
  });
}

let battleRoom = '';
let logLines = 0;
let done = false;

function handle(client: { ws: WebSocket; name: string }) {
  client.ws.on('message', (data) => {
    const raw = String(data);
    let roomId = '';
    let body = raw;
    if (raw.startsWith('>')) {
      const nl = raw.indexOf('\n');
      roomId = raw.slice(1, nl);
      body = raw.slice(nl + 1);
    }
    for (const line of body.split('\n')) {
      if (!line) continue;
      logLines++;
      if (line.startsWith('|init|battle')) battleRoom = roomId;
      if (line.startsWith('|request|')) {
        const req = JSON.parse(line.slice('|request|'.length));
        if (!req.wait) {
          setTimeout(() => client.ws.send(`${roomId}|/choose default`), 5);
        }
      }
      if (line.startsWith('|win|') || line === '|tie') {
        if (!done) {
          done = true;
          console.log(`SMOKE OK: battle "${battleRoom}" finished: ${line} (${logLines} lines seen)`);
          process.exit(0);
        }
      }
    }
  });
}

setTimeout(() => {
  console.error('SMOKE FAIL: battle did not finish within 60s');
  process.exit(1);
}, 60_000);

const [a, b] = await Promise.all([connect('SmokeAlice'), connect('SmokeBob')]);
handle(a);
handle(b);
a.ws.send('|/search');
b.ws.send('|/search');
