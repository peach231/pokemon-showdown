/**
 * The 6-slot team builder with a move editor.
 * - Slots: pokéball when empty, Pokémon icon when filled.
 * - Click a filled slot to open the editor: pick up to 4 moves manually from
 *   the legal learnset, or "Auto-fill" an intuitive set (STAB + coverage +
 *   status). Remove the Pokémon from there too.
 * - Persists to localStorage; `serialize()` produces the wire format sent
 *   with lobby create/join (`species~move1+move2,...`).
 */
import {
  getSpecies, getMove, legalMoves, getShowdownSet, BATTLE_ITEMS,
} from '@simple-showdown/data';
import type { SpeciesData, MoveData } from '@simple-showdown/sim';
import { miniSpriteUrl } from './sprites.js';

const STORAGE_KEY = 'simple-showdown-team';
const TEAM_SIZE = 6;

export interface TeamEntry {
  species: string;
  moves: string[];
  /** Index into species.abilities. */
  ability?: number;
  /** Implemented battle-item id. */
  item?: string;
}

/**
 * The real Pokémon Showdown Random Battle set for this species (moves
 * filtered to the legal learnset), or the scored heuristic when PS doesn't
 * run the species in its random pool.
 */
export function autofillSet(species: SpeciesData, legal: MoveData[]): {
  moves: string[]; ability?: number; item?: string;
} {
  const legalIds = new Set(legal.map((m) => m.id));
  const showdown = getShowdownSet(species.name);
  if (showdown) {
    const moves = showdown.moves.filter((id) => legalIds.has(id));
    if (moves.length > 0) {
      const abilityIdx = showdown.ability ? species.abilities.indexOf(showdown.ability) : -1;
      const itemId = showdown.item ? showdown.item.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
      return {
        moves: moves.length >= 4 ? moves : [...moves, ...autofillMoves(species, legal).filter((m) => !moves.includes(m))].slice(0, 4),
        ability: abilityIdx >= 0 ? abilityIdx : undefined,
        item: BATTLE_ITEMS.some((i) => i.id === itemId) ? itemId : undefined,
      };
    }
  }
  return { moves: autofillMoves(species, legal) };
}

/** Pick an intuitive 4: best STAB per type, coverage, then a good status move. */
export function autofillMoves(species: SpeciesData, legal: MoveData[]): string[] {
  const score = (m: MoveData): number => {
    const stab = species.types.includes(m.type) ? 1.5 : 1;
    const acc = m.accuracy === true ? 1 : m.accuracy / 100;
    return m.basePower * stab * acc;
  };
  const damaging = legal
    .filter((m) => m.basePower >= 40)
    .sort((a, b) => score(b) - score(a));

  // Best damaging move per type (avoids Surf + Hydro Pump redundancy).
  const bestPerType = new Map<string, MoveData>();
  for (const m of damaging) {
    if (!bestPerType.has(m.type)) bestPerType.set(m.type, m);
  }
  const ranked = [...bestPerType.values()].sort((a, b) => score(b) - score(a));

  const picks: MoveData[] = [];
  // 1-2: STAB attacks.
  for (const m of ranked) {
    if (picks.length >= 2) break;
    if (species.types.includes(m.type)) picks.push(m);
  }
  // 3: best coverage (non-STAB).
  for (const m of ranked) {
    if (picks.length >= 3) break;
    if (!picks.includes(m)) picks.push(m);
  }
  // 4: a good status move, by rough usefulness priority.
  const STATUS_PRIORITY = [
    'swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'quiverdance', 'bulkup',
    'recover', 'roost', 'slackoff', 'softboiled', 'moonlight', 'synthesis',
    'willowisp', 'thunderwave', 'toxic', 'protect', 'substitute', 'leechseed',
  ];
  const statusMoves = legal.filter((m) => m.category === 'Status');
  const statusPick = STATUS_PRIORITY
    .map((id) => statusMoves.find((m) => m.id === id))
    .find((m): m is MoveData => !!m);
  if (statusPick) picks.push(statusPick);
  // Fill remaining with next-best attacks.
  for (const m of ranked) {
    if (picks.length >= 4) break;
    if (!picks.includes(m)) picks.push(m);
  }
  return picks.slice(0, 4).map((m) => m.id);
}

export class TeamBox {
  private entries: TeamEntry[] = [];
  private boxesEl: HTMLElement;
  private editorEl: HTMLElement;
  private editingIndex = -1;
  private legalCache = new Map<string, MoveData[]>();

  constructor() {
    this.boxesEl = document.getElementById('team-boxes')!;
    this.editorEl = document.getElementById('team-editor')!;
    this.load();
    this.render();
    void this.autofillEmptySets();
  }

  /** Any Pokémon without chosen moves gets an auto-filled set (async). */
  private async autofillEmptySets(): Promise<void> {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.moves.length) continue;
      const species = getSpecies(entry.species);
      if (!species) continue;
      const legal = await this.getLegal(species.id);
      const auto = autofillSet(species, legal);
      entry.moves = auto.moves;
      entry.ability ??= auto.ability;
      entry.item ??= auto.item;
      changed = true;
    }
    if (changed) {
      this.save();
      this.render();
    }
  }

  private load(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(saved)) return;
      for (const item of saved.slice(0, TEAM_SIZE)) {
        // Migrate the old format (plain species-id strings).
        if (typeof item === 'string' && getSpecies(item)) {
          this.entries.push({ species: item, moves: [] });
        } else if (item && typeof item === 'object' && typeof item.species === 'string'
          && getSpecies(item.species)) {
          this.entries.push({
            species: item.species,
            moves: Array.isArray(item.moves) ? item.moves.filter((m: unknown) => typeof m === 'string').slice(0, 4) : [],
            ability: typeof item.ability === 'number' ? item.ability : undefined,
            item: typeof item.item === 'string' ? item.item : undefined,
          });
        }
      }
    } catch { /* fresh team */ }
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
  }

  /** Empty the team: battles will use fully random Pokémon. */
  clear(): void {
    this.entries = [];
    this.save();
    this.closeEditor();
  }

  /** Wire format for /lobby & /botbattle: `species~moves~abilityIdx~itemid,...` */
  serialize(): string {
    return this.entries
      .map((e) => `${e.species}~${e.moves.join('+')}~${e.ability ?? ''}~${e.item ?? ''}`)
      .join(',');
  }

  /** Add a species with an auto-filled moveset; returns an error or null. */
  add(species: SpeciesData): string | null {
    if (this.entries.length >= TEAM_SIZE) return 'Your team is full (6 Pokémon).';
    if (this.entries.some((e) => e.species === species.id)) {
      return `${species.name} is already on your team.`;
    }
    const entry: TeamEntry = { species: species.id, moves: [] };
    this.entries.push(entry);
    this.save();
    this.render();
    const index = this.entries.length - 1;
    // Auto-fill with the real Showdown set, then open the editor.
    void this.getLegal(species.id).then((legal) => {
      if (!entry.moves.length) {
        const auto = autofillSet(species, legal);
        entry.moves = auto.moves;
        entry.ability = auto.ability;
        entry.item = auto.item;
        this.save();
      }
      void this.openEditor(index);
    });
    return null;
  }

  private removeAt(index: number): void {
    this.entries.splice(index, 1);
    this.save();
    this.render();
    this.closeEditor();
  }

  // ------------------------------------------------------------------
  // Slots
  // ------------------------------------------------------------------

  private render(): void {
    this.boxesEl.innerHTML = '';
    for (let i = 0; i < TEAM_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'team-slot';
      const entry = this.entries[i];
      const species = entry ? getSpecies(entry.species) : undefined;
      if (entry && species) {
        slot.classList.add('filled');
        if (i === this.editingIndex) slot.classList.add('editing');
        slot.title = `${species.name} — click to edit`;
        const icon = document.createElement('img');
        icon.src = miniSpriteUrl(species.name);
        icon.alt = species.name;
        icon.width = 48;
        icon.height = 48;
        icon.className = 'mini-icon';
        slot.appendChild(icon);
        if (!entry.moves.length) {
          const dot = document.createElement('span');
          dot.className = 'needs-moves';
          dot.title = 'No moves chosen yet (will be randomized)';
          dot.textContent = '!';
          slot.appendChild(dot);
        }
        slot.addEventListener('click', () => this.openEditor(i));
      } else {
        slot.title = 'Empty slot — add from the Pokédex';
        const ball = document.createElement('span');
        ball.className = 'ball-css';
        slot.appendChild(ball);
      }
      this.boxesEl.appendChild(slot);
    }
  }

  // ------------------------------------------------------------------
  // Move editor
  // ------------------------------------------------------------------

  private closeEditor(): void {
    this.editingIndex = -1;
    this.editorEl.classList.add('hidden');
    this.editorEl.innerHTML = '';
    this.render();
  }

  private async getLegal(speciesId: string): Promise<MoveData[]> {
    let legal = this.legalCache.get(speciesId);
    if (!legal) {
      legal = await legalMoves(speciesId);
      legal.sort((a, b) => a.name.localeCompare(b.name));
      this.legalCache.set(speciesId, legal);
    }
    return legal;
  }

  async openEditor(index: number): Promise<void> {
    const entry = this.entries[index];
    const species = entry ? getSpecies(entry.species) : undefined;
    if (!entry || !species) return;
    this.editingIndex = index;
    this.render();
    this.editorEl.classList.remove('hidden');
    this.editorEl.innerHTML = `<div class="hint">Loading ${species.name}'s moves…</div>`;

    const legal = await this.getLegal(species.id);
    if (this.editingIndex !== index) return; // editor changed while loading

    this.editorEl.innerHTML = `
      <div class="editor-head">
        <span class="editor-icon"></span>
        <span class="editor-name">${species.name}</span>
        <span class="editor-actions">
          <button id="ed-autofill" class="primary">Auto-fill</button>
          <button id="ed-clear">Clear</button>
          <button id="ed-remove">Remove</button>
          <button id="ed-done">Done</button>
        </span>
      </div>
      <div class="editor-chips" id="ed-chips"></div>
      <div class="editor-extras">
        <label>Ability
          <select id="ed-ability">${species.abilities.map((a, i) =>
            `<option value="${i}" ${((entry.ability ?? 0) === i) ? 'selected' : ''}>${a}</option>`).join('')}
          </select>
        </label>
        <label>Item
          <select id="ed-item">
            <option value="">(none)</option>
            ${BATTLE_ITEMS.map((it) =>
              `<option value="${it.id}" ${entry.item === it.id ? 'selected' : ''}>${it.name}</option>`).join('')}
          </select>
        </label>
      </div>
      <input id="ed-search" placeholder="Search ${legal.length} legal moves…" />
      <div class="editor-list" id="ed-list"></div>`;
    this.editorEl.querySelector('.editor-icon')!.innerHTML =
      `<img class="mini-icon" src="${miniSpriteUrl(species.name)}" alt="" width="36" height="36" />`;

    const chipsEl = this.editorEl.querySelector('#ed-chips') as HTMLElement;
    const listEl = this.editorEl.querySelector('#ed-list') as HTMLElement;
    const searchEl = this.editorEl.querySelector('#ed-search') as HTMLInputElement;

    const renderChips = () => {
      chipsEl.innerHTML = '';
      for (let i = 0; i < 4; i++) {
        const chip = document.createElement('span');
        const moveId = entry.moves[i];
        const move = moveId ? getMove(moveId) : undefined;
        chip.className = `move-chip${move ? '' : ' empty'}`;
        if (move) {
          chip.innerHTML = `<span class="type-badge t-${move.type}">${move.type}</span> ${move.name} <b class="chip-x">×</b>`;
          chip.title = 'Click to remove';
          chip.addEventListener('click', () => {
            entry.moves.splice(i, 1);
            this.save();
            renderChips();
            renderList();
            this.render();
          });
        } else {
          chip.textContent = `Move ${i + 1}`;
        }
        chipsEl.appendChild(chip);
      }
    };

    const renderList = () => {
      const q = searchEl.value.trim().toLowerCase();
      listEl.innerHTML = '';
      const shown = legal.filter((m) => !q || m.name.toLowerCase().includes(q)).slice(0, 120);
      for (const move of shown) {
        const row = document.createElement('div');
        const chosen = entry.moves.includes(move.id);
        row.className = `move-row${chosen ? ' chosen' : ''}`;
        const power = move.category === 'Status' ? '—' : String(move.basePower || '?');
        const acc = move.accuracy === true ? '—' : `${move.accuracy}%`;
        row.innerHTML = `
          <span class="type-badge t-${move.type}">${move.type}</span>
          <span class="mv-name">${move.name}</span>
          <span class="mv-meta">${move.category} · ${power} BP · ${acc}</span>`;
        row.addEventListener('click', () => {
          if (chosen) {
            entry.moves = entry.moves.filter((id) => id !== move.id);
          } else if (entry.moves.length < 4) {
            entry.moves.push(move.id);
          }
          this.save();
          renderChips();
          renderList();
          this.render();
        });
        listEl.appendChild(row);
      }
      if (!shown.length) {
        listEl.innerHTML = '<div class="hint">No moves match.</div>';
      }
    };

    searchEl.addEventListener('input', renderList);
    (this.editorEl.querySelector('#ed-ability') as HTMLSelectElement).addEventListener('change', (e) => {
      entry.ability = parseInt((e.target as HTMLSelectElement).value, 10) || 0;
      this.save();
    });
    (this.editorEl.querySelector('#ed-item') as HTMLSelectElement).addEventListener('change', (e) => {
      entry.item = (e.target as HTMLSelectElement).value || undefined;
      this.save();
    });
    this.editorEl.querySelector('#ed-autofill')!.addEventListener('click', () => {
      const auto = autofillSet(species, legal);
      entry.moves = auto.moves;
      entry.ability = auto.ability;
      entry.item = auto.item;
      this.save();
      renderChips();
      renderList();
      this.render();
      void this.openEditor(index); // refresh the selects
    });
    this.editorEl.querySelector('#ed-clear')!.addEventListener('click', () => {
      entry.moves = [];
      this.save();
      renderChips();
      renderList();
      this.render();
    });
    this.editorEl.querySelector('#ed-remove')!.addEventListener('click', () => this.removeAt(index));
    this.editorEl.querySelector('#ed-done')!.addEventListener('click', () => this.closeEditor());

    renderChips();
    renderList();
  }
}
