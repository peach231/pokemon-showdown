import { parseLine } from '@simple-showdown/protocol';
import { getMove } from '@simple-showdown/data';

export type SideID = 'p1' | 'p2';

export interface ActivePokemon {
  name: string;
  species: string;
  level: number;
  hp: number;
  maxhp: number;
  status: string;
  boosts: Record<string, number>;
  fainted: boolean;
}

export interface SideState {
  playerName: string;
  avatar: string;
  active: ActivePokemon | null;
  /** Species revealed at team preview. */
  previewTeam: string[];
  /** Bench display: every known species and whether it has fainted. */
  bench: { species: string; fainted: boolean }[];
}

export interface RequestData {
  rqid: number;
  teamPreview?: boolean;
  forceSwitch?: [boolean];
  wait?: boolean;
  active?: { moves: { id: string; name: string; pp: number; maxpp: number; disabled: boolean }[] }[];
  side: {
    id: SideID;
    name: string;
    pokemon: {
      ident: string; details: string; condition: string; active: boolean;
      moves: string[]; item?: string; ability?: string;
    }[];
  };
}

/** Frozen copy of a Pokémon's display state at the moment an event fired.
 *  Animations play back later on a queue, so they must not read live state. */
export interface StatSnap {
  name: string;
  species: string;
  level: number;
  hp: number;
  maxhp: number;
  status: string;
  boosts: Record<string, number>;
  fainted: boolean;
}

function snap(p: ActivePokemon): StatSnap {
  return { ...p, boosts: { ...p.boosts } };
}

export type HitEffectiveness = 'normal' | 'super' | 'resisted';

/** Renderer-facing events emitted while consuming protocol lines. */
export interface BattleEvents {
  onLog(html: string, cls: 'chat' | 'system' | 'major' | 'minor'): void;
  onSwitch(side: SideID, pokemon: StatSnap): void;
  onMove(side: SideID, moveName: string, category: 'Physical' | 'Special' | 'Status', type: string): void;
  onHPChange(side: SideID, kind: 'damage' | 'heal', pokemon: StatSnap, eff?: HitEffectiveness): void;
  onStatbar(side: SideID, pokemon: StatSnap): void;
  onFaint(side: SideID, pokemon: StatSnap): void;
  onFx(side: SideID, text: string): void;
  onWeather(weather: string): void;
  onStatusApplied(side: SideID, status: string): void;
  onTurnTimer(seconds: number): void;
  onBench(): void;
  onTurn(turn: number): void;
  onTeamPreview(): void;
  onRequest(request: RequestData): void;
  onEnd(message: string): void;
}

function parseDetails(details: string): { species: string; level: number } {
  const parts = details.split(',').map((s) => s.trim());
  let level = 100;
  for (const p of parts.slice(1)) {
    if (p.startsWith('L')) level = parseInt(p.slice(1), 10) || 100;
  }
  return { species: parts[0] ?? details, level };
}

function parseCondition(condition: string): { hp: number; maxhp: number; status: string; fainted: boolean } {
  if (condition.endsWith(' fnt') || condition === '0 fnt') {
    // maxhp 0 = "unknown, keep whatever we already knew".
    return { hp: 0, maxhp: 0, status: '', fainted: true };
  }
  const [hpPart, status] = condition.split(' ');
  const [hp, maxhp] = (hpPart ?? '').split('/').map((n) => parseInt(n, 10));
  return { hp: hp || 0, maxhp: maxhp || 100, status: status ?? '', fainted: (hp || 0) <= 0 };
}

/** Which side an ident like `p1a: Garchomp` belongs to. */
function sideOf(ident: string): SideID {
  return ident.startsWith('p2') ? 'p2' : 'p1';
}

function nameOf(ident: string): string {
  const colon = ident.indexOf(':');
  return colon < 0 ? ident : ident.slice(colon + 1).trim();
}

/**
 * Client-side battle state. Feed protocol lines with `receiveLine`; it
 * mutates the model and emits semantic events the renderer turns into
 * sprites/animations — exactly Showdown's model/scene split, miniaturized.
 */
export class BattleModel {
  readonly sides: Record<SideID, SideState> = {
    p1: { playerName: '', avatar: '', active: null, previewTeam: [], bench: [] },
    p2: { playerName: '', avatar: '', active: null, previewTeam: [], bench: [] },
  };
  turn = 0;
  ended = false;
  request: RequestData | null = null;
  /** Which side this client is playing ('p1'/'p2'), or null when spectating. */
  mySide: SideID | null = null;
  weather = '';
  private myName: string;
  private events: BattleEvents;
  /** Set by |-supereffective|/|-resisted|, consumed by the next |-damage|. */
  private pendingEff: HitEffectiveness | null = null;

  constructor(myName: string, events: BattleEvents) {
    this.myName = myName;
    this.events = events;
  }

  receiveLine(line: string): void {
    if (!line.startsWith('|')) {
      if (line.trim()) this.events.onLog(line, 'system');
      return;
    }
    const parts = parseLine(line);
    const type = parts[0] ?? '';

    switch (type) {
      case 'player': {
        const [, slot, name, avatar] = parts;
        if (slot === 'p1' || slot === 'p2') {
          this.sides[slot].playerName = name ?? '';
          this.sides[slot].avatar = avatar ?? '';
          if (name === this.myName) this.mySide = slot;
        }
        break;
      }
      case 'poke': {
        const [, slot, details] = parts;
        if (slot === 'p1' || slot === 'p2') {
          const species = parseDetails(details ?? '').species;
          this.sides[slot].previewTeam.push(species);
          this.sides[slot].bench.push({ species, fainted: false });
          this.events.onBench();
        }
        break;
      }
      case 'turntimer': {
        this.events.onTurnTimer(parseInt(parts[1] ?? '0', 10));
        break;
      }
      case 'teampreview':
        this.events.onTeamPreview();
        break;
      case 'start':
        this.events.onLog('The battle started!', 'major');
        break;
      case 'turn': {
        this.turn = parseInt(parts[1] ?? '0', 10);
        this.events.onTurn(this.turn);
        this.events.onLog(`— Turn ${this.turn} —`, 'major');
        break;
      }
      case 'switch':
      case 'drag': {
        const [, ident, details, condition] = parts;
        const side = sideOf(ident ?? '');
        const det = parseDetails(details ?? '');
        const cond = parseCondition(condition ?? '');
        const pokemon: ActivePokemon = {
          name: nameOf(ident ?? ''),
          species: det.species,
          level: det.level,
          hp: cond.hp,
          maxhp: cond.maxhp,
          status: cond.status,
          boosts: {},
          fainted: cond.fainted,
        };
        this.sides[side].active = pokemon;
        if (!this.sides[side].bench.some((b) => b.species === det.species)) {
          this.sides[side].bench.push({ species: det.species, fainted: false });
          this.events.onBench();
        }
        this.events.onSwitch(side, snap(pokemon));
        this.events.onLog(
          `${this.sides[side].playerName} sent out <b>${det.species}</b>!`, 'major');
        break;
      }
      case 'move': {
        const [, ident, moveName] = parts;
        const side = sideOf(ident ?? '');
        const data = getMove(moveName ?? '');
        this.events.onMove(side, moveName ?? '', data?.category ?? 'Physical', data?.type ?? 'Normal');
        const colored = data
          ? `<span class="log-move t-${data.type}">${moveName}</span>`
          : `<b>${moveName}</b>`;
        this.events.onLog(`<b>${nameOf(ident ?? '')}</b> used ${colored}!`, 'major');
        break;
      }
      case 'cant': {
        const [, ident, reason] = parts;
        const why: Record<string, string> = {
          slp: 'is fast asleep', frz: 'is frozen solid', par: 'is fully paralyzed',
          flinch: 'flinched', recharge: 'must recharge', 'Focus Punch': 'lost its focus',
        };
        this.events.onLog(`${nameOf(ident ?? '')} ${why[reason ?? ''] ?? "couldn't move"}!`, 'minor');
        break;
      }
      case '-prepare': {
        const [, ident, moveName] = parts;
        this.events.onLog(`${nameOf(ident ?? '')} is charging ${moveName}!`, 'minor');
        break;
      }
      case '-mustrecharge': {
        this.events.onLog(`${nameOf(parts[1] ?? '')} must recharge next turn!`, 'minor');
        break;
      }
      case '-damage':
      case '-heal': {
        const [, ident, condition, from] = parts;
        const side = sideOf(ident ?? '');
        const active = this.sides[side].active;
        if (active) {
          const cond = parseCondition(condition ?? '');
          const prev = active.hp;
          const maxhp = cond.maxhp || active.maxhp; // 0 = unknown, keep known value
          active.hp = cond.hp;
          active.maxhp = maxhp;
          active.status = cond.status;
          active.fainted = cond.fainted;
          const delta = Math.abs(cond.hp - prev);
          const pct = Math.round((delta / maxhp) * 100);
          const eff = type === '-damage' ? (this.pendingEff ?? 'normal') : undefined;
          this.pendingEff = null;
          this.events.onHPChange(side, type === '-damage' ? 'damage' : 'heal', snap(active), eff);
          const suffix = from?.startsWith('[from]') ? ` (${from.replace('[from] ', '')})` : '';
          this.events.onLog(
            `${nameOf(ident ?? '')} ${type === '-damage' ? 'lost' : 'restored'} ${pct}% HP${suffix}.`, 'minor');
        }
        break;
      }
      case '-status': {
        const [, ident, status] = parts;
        const side = sideOf(ident ?? '');
        const active = this.sides[side].active;
        if (active) active.status = status ?? '';
        if (active) {
          this.events.onStatbar(side, snap(active));
          this.events.onStatusApplied(side, status ?? '');
        }
        const text: Record<string, string> = {
          brn: 'was burned', par: 'was paralyzed', psn: 'was poisoned',
          tox: 'was badly poisoned', slp: 'fell asleep', frz: 'was frozen solid',
        };
        this.events.onLog(`${nameOf(ident ?? '')} ${text[status ?? ''] ?? status}!`, 'minor');
        break;
      }
      case '-curestatus': {
        const [, ident, status] = parts;
        const side = sideOf(ident ?? '');
        const active = this.sides[side].active;
        if (active) active.status = '';
        if (active) this.events.onStatbar(side, snap(active));
        this.events.onLog(`${nameOf(ident ?? '')} recovered from ${status}!`, 'minor');
        break;
      }
      case '-boost':
      case '-unboost': {
        const [, ident, stat, amount] = parts;
        const side = sideOf(ident ?? '');
        const active = this.sides[side].active;
        const delta = (type === '-boost' ? 1 : -1) * parseInt(amount ?? '0', 10);
        if (active && stat) {
          active.boosts[stat] = (active.boosts[stat] ?? 0) + delta;
        }
        if (active) this.events.onStatbar(side, snap(active));
        const statNames: Record<string, string> = {
          atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed',
          accuracy: 'accuracy', evasion: 'evasiveness',
        };
        this.events.onLog(
          `${nameOf(ident ?? '')}'s ${statNames[stat ?? ''] ?? stat} ${delta > 0 ? 'rose' : 'fell'}${Math.abs(delta) > 1 ? ' sharply' : ''}!`, 'minor');
        break;
      }
      case '-crit':
        this.events.onLog('A critical hit!', 'minor');
        this.events.onFx(sideOf(parts[1] ?? ''), 'Critical!');
        break;
      case '-supereffective':
        this.pendingEff = 'super';
        this.events.onLog("It's super effective!", 'minor');
        break;
      case '-resisted':
        this.pendingEff = 'resisted';
        this.events.onLog("It's not very effective…", 'minor');
        break;
      case '-immune':
        this.events.onLog(`It doesn't affect ${nameOf(parts[1] ?? '')}…`, 'minor');
        break;
      case '-miss':
        this.events.onLog(`${nameOf(parts[1] ?? '')}'s attack missed!`, 'minor');
        break;
      case '-fail':
        this.events.onLog('But it failed!', 'minor');
        break;
      case '-ohko':
        this.events.onLog("It's a one-hit KO!", 'minor');
        break;
      case '-hitcount':
        this.events.onLog(`Hit ${parts[2]} time(s)!`, 'minor');
        break;
      case '-start': {
        const [, ident, what] = parts;
        this.events.onLog(`${nameOf(ident ?? '')}: ${what?.replace('move: ', '')} started!`, 'minor');
        break;
      }
      case '-end': {
        const [, ident, what] = parts;
        this.events.onLog(`${nameOf(ident ?? '')}: ${what} ended.`, 'minor');
        break;
      }
      case '-activate': {
        const [, ident, what] = parts;
        this.events.onLog(`${nameOf(ident ?? '')}: ${what?.replace('move: ', '')}!`, 'minor');
        break;
      }
      case '-singleturn': {
        const [, ident, what] = parts;
        this.events.onLog(`${nameOf(ident ?? '')} protected itself!`.replace('itself!', `${what === 'Protect' ? 'itself!' : what + '!'}`), 'minor');
        break;
      }
      case '-weather': {
        const weather = parts[1] ?? '';
        const upkeep = parts[2] === '[upkeep]';
        if (weather === 'none') {
          this.weather = '';
          this.events.onWeather('');
          this.events.onLog('The weather calmed down.', 'minor');
        } else {
          this.weather = weather;
          this.events.onWeather(weather);
          if (!upkeep) {
            const text: Record<string, string> = {
              RainDance: 'Rain began to fall!',
              SunnyDay: 'The sunlight turned harsh!',
              Sandstorm: 'A sandstorm kicked up!',
              Snow: 'It started to snow!',
            };
            this.events.onLog(text[weather] ?? `The weather became ${weather}!`, 'minor');
          }
        }
        break;
      }
      case '-sidestart': {
        const [, sideDesc, what] = parts;
        const cond = (what ?? '').replace('move: ', '');
        const who = (sideDesc ?? '').split(':')[1]?.trim() ?? '';
        this.events.onLog(
          cond === 'Stealth Rock'
            ? `Pointed stones float in the air around ${who}'s team!`
            : `${cond} started on ${who}'s side!`, 'minor');
        break;
      }
      case '-sideend': {
        const [, sideDesc, what] = parts;
        this.events.onLog(`${(what ?? '').replace('move: ', '')} ended on ${(sideDesc ?? '').split(':')[1]?.trim() ?? ''}'s side.`, 'minor');
        break;
      }
      case '-ability': {
        const [, ident, ability] = parts;
        this.events.onLog(`[${nameOf(ident ?? '')}'s <b>${ability}</b>!]`, 'minor');
        break;
      }
      case '-item': {
        const [, ident, item] = parts;
        this.events.onLog(`${nameOf(ident ?? '')} is holding a <b>${item}</b>!`, 'minor');
        break;
      }
      case '-enditem': {
        const [, ident, item] = parts;
        this.events.onLog(`${nameOf(ident ?? '')}'s <b>${item}</b> was used up!`, 'minor');
        break;
      }
      case '-message':
        this.events.onLog(parts.slice(1).join('|'), 'system');
        break;
      case 'inactive':
        this.events.onLog(`⏱ ${parts.slice(1).join('|')}`, 'system');
        break;
      case 'inactiveoff':
        this.events.onLog(parts.slice(1).join('|'), 'system');
        break;
      case 'faint': {
        const [, ident] = parts;
        const side = sideOf(ident ?? '');
        const active = this.sides[side].active;
        if (active) {
          active.fainted = true;
          active.hp = 0;
          const benched = this.sides[side].bench.find(
            (b) => b.species === active.species && !b.fainted);
          if (benched) benched.fainted = true;
          this.events.onBench();
          this.events.onFaint(side, snap(active));
        }
        this.events.onLog(`<b>${nameOf(ident ?? '')}</b> fainted!`, 'major');
        break;
      }
      case 'win': {
        this.ended = true;
        this.events.onEnd(`${parts[1]} won the battle!`);
        break;
      }
      case 'tie': {
        this.ended = true;
        this.events.onEnd('The battle ended in a tie!');
        break;
      }
      case 'request': {
        try {
          this.request = JSON.parse(parts.slice(1).join('|')) as RequestData;
          if (this.request.side?.id) this.mySide = this.request.side.id;
          this.events.onRequest(this.request);
        } catch { /* malformed request */ }
        break;
      }
      case 'error': {
        this.events.onLog(parts.slice(1).join('|'), 'system');
        break;
      }
      case 'c': {
        const [, user, ...rest] = parseLine(line, 3);
        this.events.onLog(`<b>${user}:</b> ${rest.join('|')}`, 'chat');
        break;
      }
      // Header lines that need no visuals:
      case 'teamsize': case 'gametype': case 'gen': case 'tier':
      case 'clearpoke': case 'upkeep': case 'title': case 'init':
        break;
      default:
        break;
    }
  }
}
