/**
 * The Pokédex discovery panel: a filterable grid of every species.
 * Filters: name search, generation, type, evolution stage.
 * Clicking a Pokémon opens a detail card (stats, types, abilities) with
 * an "Add to team" action.
 */
import { filterSpecies } from '@simple-showdown/data';
import type { SpeciesData, TypeName } from '@simple-showdown/sim';
import { miniSpriteUrl, battleSpriteUrls, setSpriteWithFallback } from './sprites.js';

const TYPES: TypeName[] = [
  'Normal', 'Fire', 'Water', 'Grass', 'Electric', 'Ice', 'Fighting', 'Poison',
  'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark',
  'Steel', 'Fairy',
];

const STAT_LABELS: [keyof SpeciesData['baseStats'], string][] = [
  ['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe'],
];

const PAGE_SIZE = 400;

function statColor(value: number): string {
  if (value >= 120) return '#22c65b';
  if (value >= 90) return '#7ac74c';
  if (value >= 60) return '#fbc02d';
  return '#e57373';
}

export function initDex(options: { onAddToTeam: (species: SpeciesData) => void }): void {
  const searchEl = document.getElementById('dex-search') as HTMLInputElement;
  const genEl = document.getElementById('dex-gen') as HTMLSelectElement;
  const typeEl = document.getElementById('dex-type') as HTMLSelectElement;
  const evoEl = document.getElementById('dex-evo') as HTMLSelectElement;
  const gridEl = document.getElementById('dex-grid')!;
  const pagerEl = document.getElementById('dex-pager')!;
  const detailEl = document.getElementById('dex-detail')!;
  let page = 0;

  for (const t of TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    typeEl.appendChild(opt);
  }

  function currentList(): SpeciesData[] {
    let list = filterSpecies({
      baseFormesOnly: true,
      gens: genEl.value ? [parseInt(genEl.value, 10)] : undefined,
      types: typeEl.value ? [typeEl.value as TypeName] : undefined,
    });
    switch (evoEl.value) {
      case 'base': list = list.filter((s) => !s.prevo); break;
      case 'middle': list = list.filter((s) => s.prevo && s.evos?.length); break;
      case 'final': list = list.filter((s) => !s.evos?.length); break;
    }
    const q = searchEl.value.trim().toLowerCase();
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    list.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
    return list;
  }

  function render(): void {
    const list = currentList();
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (page >= totalPages) page = totalPages - 1;
    const start = page * PAGE_SIZE;
    const shown = list.slice(start, start + PAGE_SIZE);

    gridEl.innerHTML = '';
    const count = document.createElement('div');
    count.className = 'dex-count';
    count.textContent = totalPages > 1
      ? `${list.length} Pokémon — showing ${start + 1}–${start + shown.length}`
      : `${list.length} Pokémon`;
    gridEl.appendChild(count);
    for (const species of shown) {
      const icon = document.createElement('img');
      icon.className = 'dex-icon';
      icon.title = species.name;
      icon.alt = species.name;
      icon.width = 48;
      icon.height = 48;
      icon.loading = 'lazy';
      icon.src = miniSpriteUrl(species.name);
      icon.addEventListener('click', () => showDetail(species));
      gridEl.appendChild(icon);
    }
    renderPager(totalPages);
  }

  function renderPager(totalPages: number): void {
    pagerEl.classList.toggle('hidden', totalPages <= 1);
    pagerEl.innerHTML = '';
    if (totalPages <= 1) return;
    const goto = (p: number) => {
      page = Math.max(0, Math.min(totalPages - 1, p));
      render();
      gridEl.scrollTop = 0;
    };
    const prev = document.createElement('button');
    prev.textContent = '‹ Prev';
    prev.disabled = page === 0;
    prev.onclick = () => goto(page - 1);
    pagerEl.appendChild(prev);
    for (let i = 0; i < totalPages; i++) {
      const btn = document.createElement('button');
      btn.textContent = String(i + 1);
      btn.className = i === page ? 'page-btn active' : 'page-btn';
      btn.onclick = () => goto(i);
      pagerEl.appendChild(btn);
    }
    const next = document.createElement('button');
    next.textContent = 'Next ›';
    next.disabled = page === totalPages - 1;
    next.onclick = () => goto(page + 1);
    pagerEl.appendChild(next);
  }

  function showDetail(species: SpeciesData): void {
    const bst = Object.values(species.baseStats).reduce((a, b) => a + b, 0);
    const evoBits: string[] = [];
    if (species.prevo) evoBits.push(`evolves from ${cap(species.prevo)}`);
    if (species.evos?.length) evoBits.push(`evolves into ${species.evos.map(cap).join(', ')}`);
    if (!species.prevo && !species.evos?.length) evoBits.push('does not evolve');

    detailEl.classList.remove('hidden');
    detailEl.innerHTML = `
      <div class="detail-sprite">
        <img id="dex-detail-img" alt="${species.name}" />
      </div>
      <div class="detail-info">
        <h3>${species.name} <small style="color:var(--muted)">#${species.num}</small></h3>
        <div>${species.types.map((t) => `<span class="type-badge t-${t}">${t}</span>`).join('')}</div>
        <div class="meta">Gen ${species.gen} · ${evoBits.join(' · ')}<br/>
          Abilities: ${species.abilities.join(', ')}</div>
        ${STAT_LABELS.map(([key, label]) => {
          const v = species.baseStats[key];
          return `<div class="stat-row">
            <span class="stat-name">${label}</span>
            <span class="stat-val">${v}</span>
            <span class="stat-bar"><span class="stat-fill" style="width:${Math.min(100, (v / 200) * 100)}%;background:${statColor(v)}"></span></span>
          </div>`;
        }).join('')}
        <div class="stat-row"><span class="stat-name">BST</span><span class="stat-val">${bst}</span><span class="stat-bar"></span></div>
        <div class="detail-actions">
          <button class="primary" id="dex-add-btn">Add to team</button>
          <button id="dex-close-btn">Close</button>
        </div>
      </div>`;
    setSpriteWithFallback(
      detailEl.querySelector('#dex-detail-img') as HTMLImageElement,
      battleSpriteUrls(species.name, 'front'),
    );
    detailEl.querySelector('#dex-add-btn')!.addEventListener('click', () => options.onAddToTeam(species));
    detailEl.querySelector('#dex-close-btn')!.addEventListener('click', () => {
      detailEl.classList.add('hidden');
      detailEl.innerHTML = '';
    });
  }

  const resetAndRender = () => {
    page = 0;
    render();
  };
  for (const el of [genEl, typeEl, evoEl]) el.addEventListener('change', resetAndRender);
  searchEl.addEventListener('input', resetAndRender);
  render();
}

function cap(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
