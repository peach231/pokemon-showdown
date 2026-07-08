/**
 * Account-system smoke test — the "close the tab and re-enter" guarantee:
 * 1. Redd registers, gets a session token.
 * 2. Redd battles Blue (lobby), then Redd's socket closes (tab closed).
 * 3. A brand-new socket logs in with the TOKEN (no password) -> must get
 *    the Redd identity back AND be dropped back into the battle (log replay).
 * 4. Squat attempt: /trn Redd from another socket -> rejected.
 * 5. Wrong password login -> rejected.
 *
 * Run: npx tsx packages/server/scripts/smoke-accounts.ts
 */
process.env['SS_DISCONNECT_MS'] = '5000';

import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { GameServer } from '../src/server.js';

// Fresh account/ladder state for the test run.
const dataDir = path.join(process.cwd(), 'packages', 'server', 'data');
try { fs.unlinkSync(path.join(dataDir, 'accounts.json')); } catch { /* absent */ }

const PORT = 8125;
new GameServer(PORT);

const seen = {
  token: '', registeredFlag: false, rejoinedBattle: false,
  squatRejected: false, wrongPwRejected: false, request: false,
};

function client(onLine?: (ws: WebSocket, roomId: string, line: string) => void): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('message', (data) => {
      const raw = String(data);
      let roomId = '';
      let body = raw;
      if (raw.startsWith('>')) {
        const nl = raw.indexOf('\n');
        roomId = raw.slice(1, nl);
        body = raw.slice(nl + 1);
      }
      for (const line of body.split('\n')) {
        if (line) onLine?.(ws, roomId, line);
      }
    });
    ws.on('open', () => resolve(ws));
  });
}

function autoplay(ws: WebSocket, roomId: string, line: string): void {
  if (line.startsWith('|request|')) {
    const req = JSON.parse(line.slice(9));
    if (!req.wait) setTimeout(() => ws.send(`${roomId}|/choose default`), 30);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string) => { console.error(`SMOKE-ACCOUNTS FAIL: ${msg}`, seen); process.exit(1); };

// (1) Register Redd.
const redd = await client((ws, roomId, line) => {
  if (line.startsWith('|queryresponse|session|')) {
    seen.token = JSON.parse(line.slice('|queryresponse|session|'.length)).token;
  }
  if (line.startsWith('|updateuser|Redd|2')) seen.registeredFlag = true;
  autoplay(ws, roomId, line);
});
redd.send('|/register Redd,hunter22');
await sleep(400);
if (!seen.token) fail('no session token after register');
if (!seen.registeredFlag) fail('no registered updateuser flag');

// (2) Battle vs Blue, then close Redd's tab mid-battle.
const blue = await client((ws, roomId, line) => autoplay(ws, roomId, line));
blue.send('|/trn BlueRival');
await sleep(200);
redd.send('|/lobby create');
await sleep(300);
blue.send('|/lobby join lobby-1');
await sleep(900);
redd.close(); // tab closed mid-battle
await sleep(400);

// (3) Fresh socket, token login (exactly what the client does on re-entry).
const redd2 = await client((ws, roomId, line) => {
  if (roomId.startsWith('battle-') && line === '|start') seen.rejoinedBattle = true;
  if (line.startsWith('|request|')) seen.request = true;
  autoplay(ws, roomId, line);
});
redd2.send(`|/login Redd,${seen.token}`);
await sleep(700);
if (!seen.rejoinedBattle) fail('token login did not rejoin the battle');
if (!seen.request) fail('no battle request after rejoin');

// (4) Name squatting must be rejected.
const squatter = await client((_ws, _roomId, line) => {
  if (line.startsWith('|nametaken|Redd|') && line.includes('registered')) seen.squatRejected = true;
});
squatter.send('|/trn Redd');
await sleep(300);
if (!seen.squatRejected) fail('/trn onto a registered name was not rejected');

// (5) Wrong password must be rejected.
const thief = await client((_ws, _roomId, line) => {
  if (line.startsWith('|nametaken|Redd|Wrong password.')) seen.wrongPwRejected = true;
});
thief.send('|/login Redd,letmein');
await sleep(300);
if (!seen.wrongPwRejected) fail('wrong password was not rejected');

console.log('SMOKE-ACCOUNTS OK: register -> battle -> tab close -> token re-entry rejoined the battle; squat + wrong password rejected');
process.exit(0);
