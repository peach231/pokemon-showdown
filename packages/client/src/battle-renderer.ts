import type { BattleModel, BattleEvents, RequestData, SideID, StatSnap, HitEffectiveness } from './battle-model.js';
import {
  miniSpriteUrl, battleSpriteUrls, setSpriteWithFallback,
  BATTLE_BACKDROPS, backdropUrl,
} from './sprites.js';
import { Sound } from './sound.js';
import { trainerSpriteUrl } from './avatars.js';
import { getMove, getSpecies } from '@simple-showdown/data';

const TYPE_COLORS: Record<string, string> = {
  Normal: '#a8a878', Fire: '#f08030', Water: '#6890f0', Grass: '#78c850',
  Electric: '#f8d030', Ice: '#98d8d8', Fighting: '#c03028', Poison: '#a040a0',
  Ground: '#e0c068', Flying: '#a890f0', Psychic: '#f85888', Bug: '#a8b820',
  Rock: '#b8a038', Ghost: '#705898', Dragon: '#7038f8', Dark: '#705848',
  Steel: '#b8b8d0', Fairy: '#ee99ac',
};
const CATEGORY_ICON: Record<string, string> = { Physical: '⚔', Special: '✦', Status: '◎' };

/** Visual slot: the local player is always rendered bottom-left ("ally"). */
type Slot = 'ally' | 'foe';

const STAT_BADGES: Record<string, string> = {
  atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
  accuracy: 'Acc', evasion: 'Eva',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tiny abbreviated type pills (beginner reminder) for bench/lead buttons. */
function typePillsHTML(speciesName: string): string {
  const species = getSpecies(speciesName);
  if (!species) return '';
  return `<span class="slot-types-inline">${species.types.map((t) =>
    `<i class="type-mini t-${t}" title="${t}">${t.slice(0, 3)}</i>`).join('')}</span>`;
}

/** Hard Game-Boy-style HP thresholds — no smooth hue blending. */
function hpColor(pct: number): string {
  return pct > 50 ? '#30b53a' : pct > 20 ? '#c8a400' : '#d0402c';
}

/**
 * Renders one battle into the fixed DOM scene.
 * Every model event is queued and played back SEQUENTIALLY, so actions read
 * like the games: your Pokémon lunges, particles burst, the foe's HP drains
 * slowly — and only then does the opponent take its turn. The move menu is
 * itself queued, so it can't appear before the animations finish.
 */
export class BattleRenderer implements BattleEvents {
  private model: BattleModel | null = null;
  private choose: (choice: string) => void;
  private leaveBattle: () => void;

  private sprites: Record<Slot, HTMLImageElement>;
  private statbars: Record<Slot, HTMLElement>;
  private logEl: HTMLElement;
  private menuEl: HTMLElement;
  private fxLayer: HTMLElement;
  private fieldEl: HTMLElement;

  /** Last displayed HP fraction per slot (drain animations start from it). */
  private shownPct: Record<Slot, number> = { ally: 100, foe: 100 };
  private sceneClass = '';

  /** Crisp procedural scenes (see scenes.css), themed after the classic set. */
  private static readonly SCENES = [
    'meadow', 'forest', 'beach', 'desert', 'icecave', 'deepsea',
    'nightcity', 'volcano', 'sky',
  ];

  /** Sequential animation queue. */
  private queue: (() => Promise<void>)[] = [];
  private running = false;
  private generation = 0; // bumped on attach() to cancel stale tasks

  constructor(options: { choose: (choice: string) => void; leaveBattle: () => void }) {
    this.choose = options.choose;
    this.leaveBattle = options.leaveBattle;
    this.sprites = {
      ally: document.getElementById('sprite-ally') as HTMLImageElement,
      foe: document.getElementById('sprite-foe') as HTMLImageElement,
    };
    this.statbars = {
      ally: document.getElementById('statbar-ally')!,
      foe: document.getElementById('statbar-foe')!,
    };
    this.logEl = document.getElementById('battle-log')!;
    this.menuEl = document.getElementById('battle-menu')!;
    this.fxLayer = document.getElementById('fx-layer')!;
    this.fieldEl = document.getElementById('field')!;
  }

  /** Attach a fresh model for a new battle, clear the scene, roll a backdrop. */
  attach(model: BattleModel): void {
    this.model = model;
    this.generation++;
    this.queue = [];
    this.running = false;
    this.shownPct = { ally: 100, foe: 100 };
    this.logEl.innerHTML = '';
    this.menuEl.innerHTML = '<span class="menu-label">Waiting for the battle to start…</span>';
    for (const slot of ['ally', 'foe'] as Slot[]) {
      this.sprites[slot].className = 'sprite';
      this.sprites[slot].removeAttribute('src');
      this.statbars[slot].classList.add('hidden');
    }
    this.fxLayer.innerHTML = '';
    this.hideTurnTimer();
    for (const id of ['trainer-ally', 'trainer-foe']) {
      const el = document.getElementById(id);
      el?.classList.add('hidden');
      el?.classList.remove('gone');
    }
    if (this.sceneClass) this.fieldEl.classList.remove(this.sceneClass);
    this.fieldEl.style.backgroundImage = '';
    if (localStorage.getItem('ss-classic-bg') === '1') {
      // Fallback: the original low-res Showdown jpg backdrops.
      const backdrop = BATTLE_BACKDROPS[Math.floor(Math.random() * BATTLE_BACKDROPS.length)]!;
      this.fieldEl.style.backgroundImage = `url(${backdropUrl(backdrop)})`;
      this.sceneClass = '';
    } else {
      const scene = BattleRenderer.SCENES[Math.floor(Math.random() * BattleRenderer.SCENES.length)]!;
      this.sceneClass = `scene-${scene}`;
      this.fieldEl.classList.add(this.sceneClass);
    }
    this.setWeatherOverlay('');
    Sound.playBgm();
  }

  // ------------------------------------------------------------------
  // Queue plumbing
  // ------------------------------------------------------------------

  private enqueue(task: () => Promise<void> | void): void {
    const gen = this.generation;
    this.queue.push(async () => {
      if (gen !== this.generation) return; // battle changed; drop stale task
      await task();
    });
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length) {
      await this.queue.shift()!();
    }
    this.running = false;
  }

  // ------------------------------------------------------------------
  // BattleEvents -> queued visuals
  // ------------------------------------------------------------------

  onLog(html: string, cls: 'chat' | 'system' | 'major' | 'minor'): void {
    // Chat should be instant; battle narration syncs with the animations.
    if (cls === 'chat') {
      this.appendLog(html, cls);
      return;
    }
    this.enqueue(() => this.appendLog(html, cls));
  }

  onSwitch(side: SideID, pokemon: StatSnap): void {
    const slot = this.slotFor(side);
    this.enqueue(async () => {
      // The trainer steps aside as their Pokémon comes out.
      document.getElementById(`trainer-${slot}`)?.classList.add('gone');
      const img = this.sprites[slot];
      img.className = 'sprite';
      // Start loading while the ball is in the air.
      setSpriteWithFallback(img, battleSpriteUrls(pokemon.species, slot === 'ally' ? 'back' : 'front'));
      await this.throwBall(slot);
      img.classList.add('visible', 'materialize');
      this.playCry(pokemon.species);
      this.shownPct[slot] = (pokemon.hp / pokemon.maxhp) * 100;
      this.renderStatbar(slot, pokemon, this.shownPct[slot]);
      await sleep(500);
    });
  }

  /** Pokéball arcs in from the trainer's side, pops with a white burst. */
  private async throwBall(slot: Slot): Promise<void> {
    const spot = this.spotEl(slot);
    if (!spot) return;
    const x = spot.offsetLeft;
    const y = spot.offsetTop;
    const fromX = slot === 'ally' ? -50 : this.fieldEl.clientWidth + 50;
    const fromY = y - 30;

    const ball = document.createElement('img');
    ball.src = 'https://play.pokemonshowdown.com/fx/pokeball.png';
    ball.className = 'throw-ball';
    this.fxLayer.appendChild(ball);
    const spin = slot === 'ally' ? 2 : -2;
    // Fire-and-forget: never await animation.finished — throttled/background
    // tabs may never resolve it, which would stall the whole battle queue.
    ball.animate([
      { transform: `translate(${fromX}px, ${fromY}px) rotate(0turn)`, opacity: 1 },
      { transform: `translate(${(fromX + x) / 2}px, ${y - 130}px) rotate(${spin / 2}turn)`, offset: 0.55 },
      { transform: `translate(${x - 12}px, ${y - 40}px) rotate(${spin}turn)`, opacity: 1 },
    ], { duration: 480, easing: 'ease-in', fill: 'forwards' });
    await sleep(490);

    const flash = document.createElement('div');
    flash.className = 'ball-flash';
    flash.style.left = `${x}px`;
    flash.style.top = `${y - 40}px`;
    this.fxLayer.appendChild(flash);
    ball.remove();
    setTimeout(() => flash.remove(), 500);
    await sleep(120); // ball pops, flash blooms, then the Pokémon appears
  }

  onMove(side: SideID, _moveName: string, category: 'Physical' | 'Special' | 'Status', type: string): void {
    const slot = this.slotFor(side);
    this.enqueue(async () => {
      await sleep(300); // beat before each action: whose turn is obvious
      const img = this.sprites[slot];
      Sound.attack(category, type); // guaranteed sound on every move
      if (category === 'Special') {
        // Type-tinted orb flies attacker -> target.
        this.fireProjectile(slot, type);
        await sleep(420);
      } else if (category === 'Status') {
        // Soft self-glow pulse.
        img.classList.remove('status-casting');
        void img.offsetWidth;
        img.classList.add('status-casting');
        await sleep(380);
      } else {
        img.classList.remove('attacking-ally', 'attacking-foe');
        void img.offsetWidth;
        img.classList.add(slot === 'ally' ? 'attacking-ally' : 'attacking-foe');
        await sleep(380);
      }
    });
  }

  /** A glowing type-colored orb from the attacker's spot to the target's. */
  private fireProjectile(fromSlot: Slot, type: string): void {
    const from = this.spotEl(fromSlot);
    const to = this.spotEl(fromSlot === 'ally' ? 'foe' : 'ally');
    if (!from || !to) return;
    const orb = document.createElement('div');
    orb.className = 'projectile';
    const color = TYPE_COLORS[type] ?? '#ffffff';
    orb.style.background = `radial-gradient(circle, #ffffff 15%, ${color} 55%, transparent 75%)`;
    orb.style.boxShadow = `0 0 14px 4px ${color}aa`;
    this.fxLayer.appendChild(orb);
    orb.animate([
      { transform: `translate(${from.offsetLeft}px, ${from.offsetTop - 60}px) scale(0.5)`, opacity: 0.9 },
      { transform: `translate(${(from.offsetLeft + to.offsetLeft) / 2}px, ${Math.min(from.offsetTop, to.offsetTop) - 110}px) scale(1.1)`, offset: 0.5, opacity: 1 },
      { transform: `translate(${to.offsetLeft}px, ${to.offsetTop - 60}px) scale(0.7)`, opacity: 0.9 },
    ], { duration: 400, easing: 'ease-in' });
    setTimeout(() => orb.remove(), 420);
  }

  onHPChange(side: SideID, kind: 'damage' | 'heal', pokemon: StatSnap, eff?: HitEffectiveness): void {
    const slot = this.slotFor(side);
    this.enqueue(async () => {
      const targetPct = Math.max(0, Math.min(100, (pokemon.hp / pokemon.maxhp) * 100));
      const fromPct = this.shownPct[slot];
      const deltaPct = Math.round(Math.abs(targetPct - fromPct));

      if (kind === 'damage') {
        const img = this.sprites[slot];
        img.classList.remove('hurt');
        void img.offsetWidth;
        img.classList.add('hurt');
        this.spawnHitParticles(slot);
        Sound.hit(eff ?? 'normal');
        if (eff === 'super') {
          // Screen shake sells the big hit.
          this.fieldEl.classList.remove('shake');
          void this.fieldEl.offsetWidth;
          this.fieldEl.classList.add('shake');
        }
      }
      if (deltaPct > 0) {
        this.floatText(slot, `${kind === 'damage' ? '−' : '+'}${deltaPct}%`, kind);
      }
      await this.drainHP(slot, pokemon, fromPct, targetPct);
      await sleep(280);
    });
  }

  onStatbar(side: SideID, pokemon: StatSnap): void {
    const slot = this.slotFor(side);
    this.enqueue(() => {
      this.renderStatbar(slot, pokemon, this.shownPct[slot]);
    });
  }

  onFaint(side: SideID, pokemon: StatSnap): void {
    const slot = this.slotFor(side);
    this.enqueue(async () => {
      this.updateSleepVisual(slot, false);
      this.playCry(pokemon.species);
      Sound.faint();
      this.sprites[slot].classList.add('fainting');
      await sleep(500);
      this.statbars[slot].classList.add('hidden');
      await sleep(250);
    });
  }

  onFx(side: SideID, text: string): void {
    const slot = this.slotFor(side);
    this.enqueue(() => {
      this.floatText(slot, text, 'crit');
    });
  }

  onWeather(weather: string): void {
    this.enqueue(() => {
      this.setWeatherOverlay(weather);
    });
  }

  private setWeatherOverlay(weather: string): void {
    const layer = document.getElementById('weather-layer');
    if (!layer) return;
    const cls: Record<string, string> = {
      RainDance: 'weather-rain', SunnyDay: 'weather-sun',
      Sandstorm: 'weather-sand', Snow: 'weather-snow',
    };
    layer.className = cls[weather] ?? '';
  }

  onStatusApplied(side: SideID, status: string): void {
    const slot = this.slotFor(side);
    this.enqueue(async () => {
      const img = this.sprites[slot];
      img.classList.remove('flash-brn', 'flash-par', 'flash-psn', 'flash-tox', 'flash-slp', 'flash-frz');
      void img.offsetWidth;
      img.classList.add(`flash-${status || 'brn'}`);
      await sleep(450);
    });
  }

  onBench(): void {
    this.enqueue(() => this.updateTeamDots());
  }

  /** The 6 pokéball dots inside each statbar (lit = alive, grey = fainted). */
  private teamDotsHTML(slot: Slot): string {
    if (!this.model) return '';
    const mySide = this.model.mySide ?? 'p1';
    const side: SideID = slot === 'ally' ? mySide : (mySide === 'p1' ? 'p2' : 'p1');
    const bench = this.model.sides[side].bench;
    if (!bench.length) return '';
    return `<span class="team-dots">${bench.map((b) =>
      `<span class="dot-ball${b.fainted ? ' fainted' : ''}" title="${b.species}${b.fainted ? ' (fainted)' : ''}"></span>`,
    ).join('')}</span>`;
  }

  private updateTeamDots(): void {
    for (const slot of ['ally', 'foe'] as Slot[]) {
      const dots = this.statbars[slot].querySelector('.team-dots');
      if (dots) dots.outerHTML = this.teamDotsHTML(slot) || '<span class="team-dots"></span>';
    }
  }

  /** Trainers stand on the platforms during team preview. */
  private showTrainers(): void {
    if (!this.model) return;
    const mySide = this.model.mySide ?? 'p1';
    for (const [slot, side] of [['ally', mySide], ['foe', mySide === 'p1' ? 'p2' : 'p1']] as const) {
      const img = document.getElementById(`trainer-${slot}`) as HTMLImageElement | null;
      if (img) {
        img.src = trainerSpriteUrl(this.model.sides[side as SideID].avatar);
        img.classList.remove('hidden', 'gone');
      }
    }
  }

  private timerInterval: ReturnType<typeof setInterval> | null = null;

  onTurnTimer(seconds: number): void {
    // Not queued: the countdown reflects the server clock in real time.
    const el = document.getElementById('turn-timer');
    if (!el) return;
    if (this.timerInterval) clearInterval(this.timerInterval);
    let left = seconds;
    const paint = () => {
      el.textContent = `⏱ ${left}s`;
      el.classList.toggle('urgent', left <= 15);
      el.classList.remove('hidden');
    };
    paint();
    this.timerInterval = setInterval(() => {
      left--;
      if (left <= 0) {
        this.hideTurnTimer();
      } else {
        paint();
      }
    }, 1000);
  }

  private hideTurnTimer(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = null;
    document.getElementById('turn-timer')?.classList.add('hidden');
  }

  onTurn(_turn: number): void {
    this.enqueue(() => sleep(250));
  }

  onTeamPreview(): void {
    this.enqueue(() => this.showTrainers());
  }

  onRequest(request: RequestData): void {
    this.enqueue(() => {
      this.buildMenu(request);
    });
  }

  onEnd(message: string): void {
    this.enqueue(() => {
      Sound.stopBgm();
      Sound.victory();
      this.hideTurnTimer();
      this.appendLog(`<b>${message}</b>`, 'major');
      this.menuEl.innerHTML = '';
      const banner = document.createElement('div');
      banner.className = 'win-banner';
      banner.textContent = message;
      const row = document.createElement('div');
      row.className = 'menu-row';
      if (this.model?.mySide) {
        const rematch = document.createElement('button');
        rematch.className = 'primary';
        rematch.textContent = 'Rematch';
        rematch.onclick = () => {
          rematch.disabled = true;
          rematch.textContent = 'Waiting…';
          this.choose('__rematch__');
        };
        row.appendChild(rematch);
      }
      const back = document.createElement('button');
      back.textContent = 'Return to lobby';
      back.onclick = () => this.leaveBattle();
      row.appendChild(back);
      this.menuEl.append(banner, row);
    });
  }

  // ------------------------------------------------------------------
  // Visual pieces
  // ------------------------------------------------------------------

  private slotFor(side: SideID): Slot {
    const mySide = this.model?.mySide ?? 'p1';
    return side === mySide ? 'ally' : 'foe';
  }

  private appendLog(html: string, cls: string): void {
    const div = document.createElement('div');
    div.className = cls;
    div.innerHTML = html;
    this.logEl.appendChild(div);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Chunky stepped HP drain: whole-percent steps, hard color switches. */
  private async drainHP(slot: Slot, pokemon: StatSnap, fromPct: number, toPct: number): Promise<void> {
    const bar = this.statbars[slot].querySelector('.hpfill') as HTMLElement | null;
    const hpText = this.statbars[slot].querySelector('.hptext') as HTMLElement | null;
    const steps = Math.max(1, Math.min(24, Math.round(Math.abs(toPct - fromPct))));
    const stepMs = Math.max(28, Math.min(60, 900 / steps));
    for (let i = 1; i <= steps; i++) {
      const pct = fromPct + ((toPct - fromPct) * i) / steps;
      const shown = Math.round(pct); // whole-percent notches, no smoothing
      if (bar) {
        bar.style.width = `${shown}%`;
        bar.style.backgroundColor = hpColor(shown);
      }
      if (hpText) {
        const hpNow = Math.round((shown / 100) * pokemon.maxhp);
        hpText.textContent = `${Math.max(pokemon.hp, Math.min(hpNow, pokemon.maxhp))}/${pokemon.maxhp}`;
      }
      await sleep(stepMs);
    }
    this.shownPct[slot] = toPct;
    this.renderStatbar(slot, pokemon, toPct);
  }

  /** Persistent sleep visual: bobbing sprite + floating Z's over the spot. */
  private updateSleepVisual(slot: Slot, asleep: boolean): void {
    const img = this.sprites[slot];
    img.classList.toggle('is-asleep', asleep);
    const id = `sleep-zzz-${slot}`;
    const existing = document.getElementById(id);
    if (asleep && !existing) {
      const spot = this.spotEl(slot);
      if (!spot) return;
      const zzz = document.createElement('div');
      zzz.id = id;
      zzz.className = 'sleep-zzz';
      zzz.innerHTML = '<span>Z</span><span>z</span><span>z</span>';
      zzz.style.left = `${spot.offsetLeft + 30}px`;
      zzz.style.top = `${spot.offsetTop - 90}px`;
      this.fxLayer.appendChild(zzz);
    } else if (!asleep && existing) {
      existing.remove();
    }
  }

  private renderStatbar(slot: Slot, pokemon: StatSnap, pct: number): void {
    this.updateSleepVisual(slot, pokemon.status === 'slp' && !pokemon.fainted);
    const bar = this.statbars[slot];
    if (pokemon.fainted) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const shownPct = Math.max(0, Math.min(100, pct));
    const badges: string[] = [];
    if (pokemon.status) badges.push(`<span class="badge ${pokemon.status}">${pokemon.status}</span>`);
    for (const [stat, val] of Object.entries(pokemon.boosts)) {
      if (val) badges.push(`<span class="badge boost">${val > 0 ? '+' : ''}${val} ${STAT_BADGES[stat] ?? stat}</span>`);
    }
    bar.innerHTML = `
      <div class="row1">
        <span class="name">${pokemon.name}</span>
        <span class="level">Lv.${pokemon.level}</span>
        ${this.teamDotsHTML(slot)}
      </div>
      <div class="hpbar"><div class="hpfill" style="width:${shownPct}%;background-color:${hpColor(shownPct)}"></div></div>
      <div class="row2">
        <span class="hptext">${pokemon.hp}/${pokemon.maxhp}</span>
        ${badges.join('')}
      </div>`;
  }

  private spotEl(slot: Slot): HTMLElement | null {
    return document.querySelector(slot === 'ally' ? '.spot-ally' : '.spot-foe');
  }

  private floatText(slot: Slot, text: string, kind: 'damage' | 'heal' | 'crit'): void {
    const spot = this.spotEl(slot);
    if (!spot) return;
    const fx = document.createElement('div');
    fx.className = `fx-text fx-${kind}`;
    fx.textContent = text;
    fx.style.left = `${spot.offsetLeft}px`;
    fx.style.top = `${spot.offsetTop - 85}px`;
    this.fxLayer.appendChild(fx);
    setTimeout(() => fx.remove(), 950);
  }

  /** Pixel-square burst at the target — the "hit" feedback. */
  private spawnHitParticles(slot: Slot): void {
    const spot = this.spotEl(slot);
    if (!spot) return;
    const colors = ['#fff', '#ffcb05', '#ff5027', '#ffe9a8'];
    for (let i = 0; i < 9; i++) {
      const p = document.createElement('div');
      p.className = 'hit-particle';
      const angle = (Math.PI * 2 * i) / 9 + Math.random() * 0.6;
      const dist = 34 + Math.random() * 30;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist - 20}px`);
      p.style.background = colors[i % colors.length]!;
      p.style.left = `${spot.offsetLeft}px`;
      p.style.top = `${spot.offsetTop - 45}px`;
      this.fxLayer.appendChild(p);
      setTimeout(() => p.remove(), 520);
    }
  }

  // ------------------------------------------------------------------
  // Decision menus (from |request| JSON)
  // ------------------------------------------------------------------

  private buildMenu(request: RequestData): void {
    this.menuEl.innerHTML = '';

    if (request.wait) {
      this.menuEl.innerHTML = '<span class="menu-label">Waiting for your opponent…</span>';
      return;
    }

    if (request.teamPreview) {
      // Opponent's team first — preview is a mutual information game.
      const mySide = this.model?.mySide ?? 'p1';
      const foeSide = this.model?.sides[mySide === 'p1' ? 'p2' : 'p1'];
      if (foeSide?.previewTeam.length) {
        const foeLabel = document.createElement('div');
        foeLabel.className = 'menu-label';
        foeLabel.innerHTML = `<b>${foeSide.playerName}</b>'s team:`;
        const foeRow = document.createElement('div');
        foeRow.className = 'menu-row foe-preview';
        foeRow.innerHTML = foeSide.previewTeam.map((s) =>
          `<span class="foe-preview-mon" title="${s}"><img src="${miniSpriteUrl(s)}" width="40" height="40" loading="lazy" alt="${s}" /></span>`,
        ).join('');
        this.menuEl.append(foeLabel, foeRow);
      }
      const label = document.createElement('div');
      label.className = 'menu-label';
      label.textContent = 'Choose your lead:';
      const row = document.createElement('div');
      row.className = 'menu-row';
      request.side.pokemon.forEach((p, i) => {
        const species = p.details.split(',')[0] ?? p.details;
        const btn = document.createElement('button');
        btn.innerHTML = `${this.iconHTML(species)} ${species}${typePillsHTML(species)}`;
        btn.onclick = () => {
          const order = [i + 1, ...request.side.pokemon.map((_, j) => j + 1).filter((n) => n !== i + 1)];
          this.chooseAndLock(`team ${order.join('')}`);
        };
        row.appendChild(btn);
      });
      this.menuEl.append(label, row);
      return;
    }

    if (request.forceSwitch) {
      this.buildSwitchRow(request, 'Choose your next Pokémon:');
      return;
    }

    if (request.active) {
      const moveRow = document.createElement('div');
      moveRow.className = 'menu-row moves-row';
      request.active[0]?.moves.forEach((m, i) => {
        const data = getMove(m.id);
        const type = data?.type ?? 'Normal';
        const color = TYPE_COLORS[type] ?? '#888';
        const category = data?.category ?? 'Physical';
        const power = category === 'Status' ? '—' : String(data?.basePower || '?');
        const btn = document.createElement('button');
        btn.className = 'move-btn';
        btn.disabled = m.disabled;
        btn.style.borderLeftColor = color;
        btn.innerHTML = `
          <span class="mv-top"><span class="type-badge t-${type}">${type}</span>
          <span class="mv-cat" title="${category}">${CATEGORY_ICON[category]}</span></span>
          ${m.name}
          <span class="pp">${power} BP · ${m.pp}/${m.maxpp} PP</span>`;
        btn.onclick = () => this.chooseAndLock(`move ${i + 1}`);
        moveRow.appendChild(btn);
      });
      this.menuEl.append(moveRow);
      this.buildSwitchRow(request, 'Switch:');
    }
  }

  /** Keyboard: 1-4 = moves, Shift+1-5 = switches, Enter = first button. */
  handleKey(e: KeyboardEvent): void {
    const digit = parseInt(e.key, 10);
    if (e.shiftKey && !Number.isNaN(digit)) {
      const btns = this.menuEl.querySelectorAll<HTMLButtonElement>('.switch-btn:not(:disabled)');
      btns[digit - 1]?.click();
    } else if (!Number.isNaN(digit)) {
      const btns = this.menuEl.querySelectorAll<HTMLButtonElement>('.move-btn:not(:disabled)');
      btns[digit - 1]?.click();
    } else if (e.key === 'Enter') {
      (this.menuEl.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.click();
    }
  }

  private buildSwitchRow(request: RequestData, labelText: string): void {
    const switchable = request.side.pokemon
      .map((p, i) => ({ p, n: i + 1 }))
      .filter(({ p }) => !p.active && !p.condition.endsWith('fnt'));
    if (switchable.length === 0) return;
    const label = document.createElement('div');
    label.className = 'menu-label';
    label.textContent = labelText;
    const row = document.createElement('div');
    row.className = 'menu-row';
    for (const { p, n } of switchable) {
      const species = p.details.split(',')[0] ?? p.details;
      const btn = document.createElement('button');
      btn.className = 'switch-btn';
      btn.innerHTML = `${this.iconHTML(species)} ${species}${typePillsHTML(species)} <span class="pp">${p.condition}</span>`;
      btn.onclick = () => this.chooseAndLock(`switch ${n}`);
      row.appendChild(btn);
    }
    this.menuEl.append(label, row);
  }

  private chooseAndLock(choice: string): void {
    this.choose(choice);
    this.hideTurnTimer();
    this.menuEl.innerHTML = '<span class="menu-label">Waiting for your opponent…</span>';
  }

  private iconHTML(species: string): string {
    return `<img class="mini-icon" src="${miniSpriteUrl(species)}" alt="" width="28" height="28" loading="lazy" />`;
  }

  private playCry(species: string): void {
    Sound.cry(species);
  }
}
