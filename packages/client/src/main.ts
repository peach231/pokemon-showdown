import '@fontsource/press-start-2p';
import '@fontsource/vt323';
import './scenes.css';
import { parseLine } from '@simple-showdown/protocol';
import { Connection } from './connection.js';
import { BattleModel } from './battle-model.js';
import { BattleRenderer } from './battle-renderer.js';
import { initDex } from './dex.js';
import { TeamBox } from './team.js';
import { Sound } from './sound.js';
import { showModal } from './modal.js';
import { initAuthUI, getSession } from './auth-ui.js';
import { initLadderUI } from './ladder-ui.js';
import { showAvatarPicker, trainerSpriteUrl } from './avatars.js';

// Dev (Vite on 5173): game server on :8000. Production: same origin as the page.
const SERVER_URL = location.port === '5173'
  ? `ws://${location.hostname || 'localhost'}:8000`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------
const usernameEl = document.getElementById('username')!;
const onlineCountEl = document.getElementById('online-count')!;
const createLobbyBtn = document.getElementById('create-lobby-btn') as HTMLButtonElement;
const lobbyListEl = document.getElementById('lobby-list')!;
const searchStatus = document.getElementById('search-status')!;
const lobbyLog = document.getElementById('lobby-log')!;
const lobbyForm = document.getElementById('lobby-chat-form') as HTMLFormElement;
const lobbyInput = document.getElementById('lobby-chat-input') as HTMLInputElement;
const battlePanel = document.getElementById('battle-panel')!;
const homePanel = document.getElementById('home-panel')!;
const battleChatForm = document.getElementById('battle-chat-form') as HTMLFormElement;
const battleChatInput = document.getElementById('battle-chat-input') as HTMLInputElement;
const rankedBtn = document.getElementById('ranked-btn') as HTMLButtonElement;
const userlistBtn = document.getElementById('userlist-btn')!;
const userlistEl = document.getElementById('userlist')!;
const avatarImg = document.getElementById('avatar-img') as HTMLImageElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let myName = '';
let myAvatar = localStorage.getItem('ss-avatar') ?? 'red';
let battleRoomId: string | null = null;
let battleModel: BattleModel | null = null;
let iAmHosting = false;
let searching = false;
const lobbyUsers = new Set<string>();

const connection = new Connection(SERVER_URL);
const teamBox = new TeamBox();

const renderer = new BattleRenderer({
  choose: (choice) => {
    if (!battleRoomId) return;
    if (choice === '__rematch__') connection.send(battleRoomId, '/rematch');
    else connection.send(battleRoomId, `/choose ${choice}`);
  },
  leaveBattle: () => {
    if (battleRoomId) connection.send(battleRoomId, '/leave');
    battleRoomId = null;
    battleModel = null;
    Sound.stopBgm();
    battlePanel.classList.add('hidden');
    homePanel.classList.remove('hidden');
    setHosting(false);
  },
});

const auth = initAuthUI({
  send: (roomId, text) => connection.send(roomId, text),
  getName: () => myName,
  isGuest: () => /^guest/i.test(myName),
  onSearchAnyway: () => connection.send('', `/search ${teamBox.serialize()}`),
});

const ladderUI = initLadderUI({
  requestLadder: () => connection.send('', '/ladder'),
  isGuest: () => /^guest/i.test(myName),
});

initDex({
  onAddToTeam: (species) => {
    const err = teamBox.add(species);
    lobbyLine(err ?? `${species.name} added to your team.`);
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function lobbyLine(html: string, cls = 'system'): void {
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = html;
  lobbyLog.appendChild(div);
  lobbyLog.scrollTop = lobbyLog.scrollHeight;
}

/** Diagonal wipe transition into battle, like the games' encounter flash. */
function playBattleWipe(): void {
  const wipe = document.createElement('div');
  wipe.className = 'battle-wipe';
  document.body.appendChild(wipe);
  setTimeout(() => wipe.remove(), 750);
}

function enterBattle(roomId: string): void {
  battleRoomId = roomId;
  battleModel = new BattleModel(myName, renderer);
  renderer.attach(battleModel);
  playBattleWipe();
  setTimeout(() => {
    homePanel.classList.add('hidden');
    battlePanel.classList.remove('hidden');
  }, 280); // swap behind the wipe
}

function setHosting(hosting: boolean): void {
  iAmHosting = hosting;
  createLobbyBtn.textContent = hosting ? 'Cancel lobby' : 'Create lobby';
  if (hosting) searchStatus.textContent = 'Waiting for someone to join your lobby…';
  else if (!searching) searchStatus.textContent = '';
}

function setSearching(on: boolean): void {
  searching = on;
  rankedBtn.textContent = on ? 'Cancel search' : 'Ranked Search';
  rankedBtn.classList.toggle('primary', !on);
  if (on) searchStatus.textContent = 'Searching for a ranked opponent…';
  else if (!iAmHosting) searchStatus.textContent = '';
}

function renderLobbies(lobbies: { id: string; host: string; avatar?: string }[]): void {
  lobbyListEl.innerHTML = '';
  if (lobbies.length === 0) {
    lobbyListEl.innerHTML = '<div class="lobby-empty">No open lobbies. Create one and invite a friend!</div>';
    return;
  }
  for (const lobby of lobbies) {
    const mine = lobby.host === myName;
    const row = document.createElement('div');
    row.className = `lobby-row${mine ? ' mine' : ''}`;
    row.innerHTML = `
      <span class="host"><img class="lobby-avatar" src="${trainerSpriteUrl(lobby.avatar ?? '')}" alt="" width="26" height="26" loading="lazy" />
      ${mine ? `${lobby.host} (you)` : `${lobby.host}'s lobby`}</span>`;
    const btn = document.createElement('button');
    if (mine) {
      btn.textContent = 'Cancel';
      btn.onclick = () => connection.send('', '/lobby cancel');
    } else {
      btn.className = 'primary';
      btn.textContent = 'Join';
      btn.onclick = () => connection.send('', `/lobby join ${lobby.id} ${teamBox.serialize()}`);
    }
    row.appendChild(btn);
    lobbyListEl.appendChild(row);
  }
}

function renderUserlist(): void {
  userlistBtn.textContent = `${lobbyUsers.size} in chat ▾`;
  userlistEl.innerHTML = '';
  for (const name of [...lobbyUsers].sort((a, b) => a.localeCompare(b))) {
    const chip = document.createElement('button');
    chip.className = 'user-chip';
    chip.textContent = name;
    chip.title = name === myName ? 'You' : `PM ${name}`;
    if (name !== myName) {
      chip.onclick = () => showModal({
        title: `PM ${name}`,
        fields: [{ name: 'message', label: 'Message' }],
        buttons: [
          {
            label: 'Send', primary: true,
            onClick: (v) => {
              if (!v['message']) return false;
              connection.send('', `/pm ${name},${v['message']}`);
            },
          },
          { label: 'Cancel' },
        ],
      });
    }
    userlistEl.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Server frame handling
// ---------------------------------------------------------------------------
connection.onFrame = ({ roomId, lines }) => {
  for (const line of lines) {
    if (roomId && roomId.startsWith('battle-')) {
      // Always re-init on |init|battle: reconnects to the SAME room replay
      // the full log, so the view must reset to render it cleanly.
      if (line === '|init|battle') {
        enterBattle(roomId);
      }
      battleModel?.receiveLine(line);
      continue;
    }

    const parts = parseLine(line, 4);
    switch (parts[0]) {
      case 'updateuser': {
        myName = parts[1] ?? '';
        usernameEl.textContent = myName;
        const named = parts[2] ?? '0';
        auth.setRegisteredUI(named === '2');
        if (named === '0') {
          const session = getSession();
          if (session) {
            connection.send('', `/login ${session.name},${session.token}`);
          } else {
            const saved = localStorage.getItem('simple-showdown-name');
            if (saved && !/^guest/i.test(saved)) connection.send('', `/trn ${saved}`);
          }
        } else {
          localStorage.setItem('simple-showdown-name', myName);
          connection.send('', '/ladder');
        }
        connection.send('', `/avatar ${myAvatar}`);
        break;
      }
      case 'usercount':
        onlineCountEl.innerHTML = `<span class="dot"></span>${parts[1] ?? '?'} online`;
        break;
      case 'lobbies': {
        try {
          const lobbies = JSON.parse(parts.slice(1).join('|'));
          renderLobbies(lobbies);
          setHosting(lobbies.some((l: { host: string }) => l.host === myName));
        } catch { /* ignore */ }
        break;
      }
      case 'users': {
        // |users|N, Name1, Name2...
        lobbyUsers.clear();
        for (const name of (parts.slice(1).join('|').split(',').slice(1))) {
          lobbyUsers.add(name.trim());
        }
        renderUserlist();
        break;
      }
      case 'nametaken':
        lobbyLine(`Name change failed: ${parts[2] ?? 'invalid name'}`);
        break;
      case 'updatesearch': {
        try {
          const data = JSON.parse(parts.slice(1).join('|'));
          setSearching(!!data.searching?.length);
        } catch { /* ignore */ }
        break;
      }
      case 'queryresponse': {
        try {
          const payload = JSON.parse(parts.slice(2).join('|'));
          if (parts[1] === 'ladder') ladderUI.renderLadder(payload);
          if (parts[1] === 'rating') ladderUI.setRatingChip(payload.elo);
          if (parts[1] === 'avatar') {
            myAvatar = payload.avatar || 'red';
            localStorage.setItem('ss-avatar', myAvatar);
            avatarImg.src = trainerSpriteUrl(myAvatar);
          }
          if (parts[1] === 'session') {
            localStorage.setItem('ss-session', JSON.stringify({ name: payload.name, token: payload.token }));
            lobbyLine(`Logged in as <b>${payload.name}</b>. Your account will stay signed in on this browser.`);
          }
          if (parts[1] === 'logout') {
            localStorage.removeItem('ss-session');
            location.reload();
          }
        } catch { /* ignore */ }
        break;
      }
      case 'pm':
        lobbyLine(`<b>[PM] ${parts[1]} → ${parts[2]}:</b> ${parts[3] ?? ''}`, 'chat');
        break;
      case 'c':
        lobbyLine(`<b>${parts[1]}:</b> ${parts.slice(2).join('|')}`, 'chat');
        break;
      case 'j': {
        const name = (parts[1] ?? '').trim();
        lobbyUsers.add(name);
        renderUserlist();
        lobbyLine(`${name} joined.`);
        break;
      }
      case 'l': {
        const name = (parts[1] ?? '').trim();
        lobbyUsers.delete(name);
        renderUserlist();
        lobbyLine(`${name} left.`);
        break;
      }
      case 'n':
        lobbyLine(`${(parts[1] ?? '').trim()} changed names.`);
        break;
      case 'error':
        lobbyLine(`Error: ${parts.slice(1).join('|')}`);
        break;
      case 'init': case 'title': case 'deinit': break;
      default: break;
    }
  }
};

connection.onOpen = () => {
  lobbyLine('Connected to server.');
};

// ---------------------------------------------------------------------------
// UI events
// ---------------------------------------------------------------------------
rankedBtn.addEventListener('click', () => {
  if (searching) {
    connection.send('', '/cancelsearch');
    return;
  }
  if (auth.maybeShowRankedGate()) return;
  connection.send('', `/search ${teamBox.serialize()}`);
});

createLobbyBtn.addEventListener('click', () => {
  if (iAmHosting) connection.send('', '/lobby cancel');
  else connection.send('', `/lobby create ${teamBox.serialize()}`);
});

document.getElementById('bot-btn')!.addEventListener('click', () => {
  showModal({
    title: 'Battle a bot',
    bodyHTML: '<p>Pick a difficulty:</p>',
    buttons: [
      { label: 'Hard (smart)', primary: true, onClick: () => { connection.send('', `/botbattle hard ${teamBox.serialize()}`); } },
      { label: 'Easy (random)', onClick: () => { connection.send('', `/botbattle easy ${teamBox.serialize()}`); } },
      { label: 'Cancel' },
    ],
  });
});

document.getElementById('clear-team-btn')!.addEventListener('click', () => {
  teamBox.clear();
  lobbyLine('Team cleared — battles will use random Pokémon.');
});

document.getElementById('avatar-btn')!.addEventListener('click', () => {
  showAvatarPicker(myAvatar, (avatar) => connection.send('', `/avatar ${avatar}`));
});

userlistBtn.addEventListener('click', () => {
  userlistEl.classList.toggle('hidden');
});

document.getElementById('forfeit-btn')!.addEventListener('click', () => {
  if (!battleRoomId) return;
  showModal({
    title: 'Forfeit?',
    bodyHTML: '<p>Give up this battle?</p>',
    buttons: [
      { label: 'Forfeit', primary: true, onClick: () => { connection.send(battleRoomId!, '/forfeit'); } },
      { label: 'Keep battling' },
    ],
  });
});

lobbyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = lobbyInput.value.trim();
  if (text) connection.send('lobby', text);
  lobbyInput.value = '';
});

battleChatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = battleChatInput.value.trim();
  if (text && battleRoomId) connection.send(battleRoomId, text);
  battleChatInput.value = '';
});

// Keyboard battle controls (skip while typing in an input).
document.addEventListener('keydown', (e) => {
  if (battlePanel.classList.contains('hidden')) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
  renderer.handleKey(e);
});

// Fullscreen toggle: fullscreens THIS page (works inside website embeds too,
// as long as the iframe has allow="fullscreen").
const fullscreenBtn = document.getElementById('fullscreen-btn')!;
fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => { /* not fullscreen */ });
  } else {
    void document.documentElement.requestFullscreen().catch(() => {
      // Blocked (e.g. embed without allow="fullscreen"): open directly instead.
      window.open(location.href, '_blank');
    });
  }
});
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  fullscreenBtn.classList.toggle('active-toggle', on);
  fullscreenBtn.title = on ? 'Exit full screen' : 'Full screen';
});

const muteBtn = document.getElementById('mute-btn')!;
muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
muteBtn.addEventListener('click', () => {
  muteBtn.textContent = Sound.toggleMuted() ? '🔇' : '🔊';
});
avatarImg.src = trainerSpriteUrl(myAvatar);

connection.connect();
