/** Right-panel tabs (Pokédex | Ladder), the ladder table, and the rating chip. */
import { trainerSpriteUrl } from './avatars.js';

export interface LadderData {
  top: { userid: string; name: string; elo: number; wins: number; losses: number; ties: number; avatar?: string }[];
  me: { userid: string; name: string; elo: number; wins: number; losses: number };
  rated: boolean;
}

export function initLadderUI(deps: { requestLadder: () => void; isGuest: () => boolean }): {
  renderLadder: (data: LadderData) => void;
  setRatingChip: (elo: number | null) => void;
} {
  const ratingChip = document.getElementById('rating-chip')!;
  const ladderRows = document.getElementById('ladder-rows')!;
  const tabDex = document.getElementById('tab-dex')!;
  const tabLadder = document.getElementById('tab-ladder')!;
  const dexView = document.getElementById('dex-view')!;
  const ladderView = document.getElementById('ladder-view')!;

  function showTab(tab: 'dex' | 'ladder'): void {
    tabDex.classList.toggle('active', tab === 'dex');
    tabLadder.classList.toggle('active', tab === 'ladder');
    dexView.classList.toggle('hidden', tab !== 'dex');
    ladderView.classList.toggle('hidden', tab !== 'ladder');
    if (tab === 'ladder') deps.requestLadder();
  }
  tabDex.addEventListener('click', () => showTab('dex'));
  tabLadder.addEventListener('click', () => showTab('ladder'));

  function setRatingChip(elo: number | null): void {
    if (elo === null || deps.isGuest()) {
      ratingChip.classList.add('hidden');
      return;
    }
    ratingChip.classList.remove('hidden');
    ratingChip.textContent = `⚔ ${elo}`;
  }

  function renderLadder(data: LadderData): void {
    setRatingChip(data.rated ? data.me.elo : null);
    ladderRows.innerHTML = '';
    if (data.top.length === 0) {
      ladderRows.innerHTML = '<div class="lobby-empty">No rated battles yet. Be the first on the board!</div>';
      return;
    }
    data.top.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = `ladder-row${entry.userid === data.me.userid ? ' me' : ''}${i < 3 ? ` top-${i + 1}` : ''}`;
      row.innerHTML = `
        <span class="rank">${i + 1}</span>
        <img class="ladder-avatar" src="${trainerSpriteUrl(entry.avatar ?? '')}" alt="" width="28" height="28" loading="lazy" />
        <span class="lname">${entry.name}</span>
        <span class="record">${entry.wins}–${entry.losses}</span>
        <span class="elo">${entry.elo}</span>`;
      ladderRows.appendChild(row);
    });
  }

  return { renderLadder, setRatingChip };
}
