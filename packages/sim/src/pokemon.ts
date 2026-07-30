import type {
  SpeciesData, MoveData, StatsTable, BoostsTable, StatusID, StatID, TypeName,
} from './types.js';
import { calcStats, applyBoost, emptyBoosts } from './stats.js';

/** A team slot as chosen in the teambuilder (already resolved to full data). */
export interface ResolvedPokemonSet {
  species: SpeciesData;
  moves: MoveData[];
  /** Display nickname; defaults to the species name. */
  name?: string;
  item?: string;
  ability?: string;
  level?: number;
}

export interface MoveSlot {
  id: string;
  move: MoveData;
  pp: number;
  maxpp: number;
  disabled: boolean;
}

/** Extra per-status bookkeeping (sleep counter, toxic counter). */
export interface StatusState {
  /** Remaining sleep turns. */
  sleepTurns?: number;
  /** Turns badly poisoned (damage = n/16 of max HP). */
  toxicTurns?: number;
}

export interface VolatileState {
  /** Generic turn counter (confusion turns left, protect chain length, ...). */
  turns?: number;
  /** Substitute's remaining HP. */
  hp?: number;
  /** Binding Band doubles binding-move chip damage. */
  bindingBand?: boolean;
  /** Move id Encore locks the target into. */
  moveId?: string;
  [key: string]: number | string | boolean | undefined;
}

export const DEFAULT_LEVEL = 100;

/** One Pokémon within an active battle. */
export class BattlePokemon {
  readonly set: ResolvedPokemonSet;
  readonly species: SpeciesData;
  readonly name: string;
  readonly level: number;
  readonly stats: StatsTable;
  readonly maxhp: number;
  /** Current types (mutable: Protean/Libero change them mid-battle). */
  types: TypeName[];
  /** Current ability (mutable: Trace copies the foe's on entry). */
  ability: string;
  /** Held item (display name); empty after consumption. */
  item: string;
  /** Normalized item id ('' when none/consumed). */
  itemId = '';
  /** Display name of the item, kept for protocol messages after consumption. */
  itemName = '';
  /** True once an item has been used up — what Unburden watches for. */
  itemLost = false;

  /** Stat boosted by Protosynthesis / Quark Drive, if either is active. */
  boostedStat: Exclude<StatID, 'hp'> | null = null;
  /** The boost came from Booster Energy, so it outlives the field condition. */
  boosterFromItem = false;

  /** Side id this Pokémon belongs to ('p1' | 'p2'). */
  readonly sideId: 'p1' | 'p2';
  /** Index within its side's team (0-5); stable identity for the battle. */
  position: number;

  hp: number;
  status: StatusID | '' = '';
  statusState: StatusState = {};
  boosts: BoostsTable = emptyBoosts();
  volatiles = new Map<string, VolatileState>();
  moveSlots: MoveSlot[];
  fainted = false;
  /** True once this Pokémon has been sent out at least once. */
  revealed = false;
  /** Hit by an attack this turn (breaks Focus Punch). Reset each turn. */
  tookDamageThisTurn = false;
  /** Two-turn move being charged (Sky Attack, Solar Beam...). */
  charging: { move: MoveData; slotIndex: number } | null = null;
  /** Move id a Choice item has locked the holder into ('' = unlocked). */
  lockedMoveId = '';
  /** Last move this Pokémon actually used — what Encore locks it into. */
  lastMoveId = '';
  /** Came in this turn: what Stakeout punishes. Cleared in the residual phase. */
  switchedInThisTurn = false;
  /** Turns of Slow Start remaining (halved Atk/Spe). */
  slowStartTurns = 0;
  /** Truant alternates: true = loafing next action. */
  loafing = false;
  /** Team-mate this Pokémon is disguised as (Illusion), until it takes a hit. */
  illusionOf: BattlePokemon | null = null;
  /** Imposter has already copied the opponent. */
  transformed = false;
  /** Zero to Hero has unlocked the Hero forme. */
  heroForme = false;
  /** Heavy Metal / Light Metal multiplier for weight-based moves. */
  weightFactor = 1;

  constructor(set: ResolvedPokemonSet, sideId: 'p1' | 'p2', position: number) {
    this.set = set;
    this.species = set.species;
    this.name = set.name ?? set.species.name;
    this.level = set.level ?? DEFAULT_LEVEL;
    this.stats = calcStats(set.species.baseStats, this.level);
    this.maxhp = this.stats.hp;
    this.hp = this.maxhp;
    this.types = [...set.species.types];
    this.ability = set.ability ?? set.species.abilities[0] ?? '';
    this.item = set.item ?? '';
    this.itemId = this.item.toLowerCase().replace(/[^a-z0-9]/g, '');
    this.itemName = this.item;
    this.sideId = sideId;
    this.position = position;
    this.moveSlots = set.moves.map((move) => ({
      id: move.id,
      move,
      pp: move.pp,
      maxpp: move.pp,
      disabled: false,
    }));
  }

  /** Protocol identity for the active slot, e.g. `p1a: Garchomp`. */
  get activeIdent(): string {
    return `${this.sideId}a: ${this.name}`;
  }

  /** Protocol identity without slot, e.g. `p1: Garchomp`. */
  get ident(): string {
    return `${this.sideId}: ${this.name}`;
  }

  /** Protocol details, e.g. `Garchomp, L85`. */
  get details(): string {
    return this.level === 100 ? this.species.name : `${this.species.name}, L${this.level}`;
  }

  /** Protocol HP/status condition string, e.g. `211/326 brn` or `0 fnt`. */
  get condition(): string {
    if (this.fainted) return '0 fnt';
    return `${this.hp}/${this.maxhp}${this.status ? ` ${this.status}` : ''}`;
  }

  /** Effective value of a main stat after boost stages (and paralysis for speed). */
  getStat(stat: Exclude<StatID, 'hp'>, options: { ignoreBoosts?: boolean } = {}): number {
    let value = this.stats[stat];
    if (!options.ignoreBoosts) value = applyBoost(value, this.boosts[stat]);
    if (stat === 'spe' && this.status === 'par') value = Math.floor(value * 0.5);
    return value;
  }

  /** Apply damage; returns the amount actually dealt. Marks fainted at 0. */
  damage(amount: number): number {
    if (amount <= 0 || this.fainted) return 0;
    const dealt = Math.min(this.hp, Math.max(1, Math.floor(amount)));
    this.hp -= dealt;
    if (this.hp <= 0) {
      this.hp = 0;
      this.fainted = true;
    }
    return dealt;
  }

  /** Heal HP; returns the amount actually restored. */
  heal(amount: number): number {
    if (this.fainted || amount <= 0) return 0;
    const healed = Math.min(this.maxhp - this.hp, Math.max(1, Math.floor(amount)));
    this.hp += healed;
    return healed;
  }

  hasVolatile(id: string): boolean {
    return this.volatiles.has(id);
  }

  addVolatile(id: string, state: VolatileState = {}): boolean {
    if (this.volatiles.has(id)) return false;
    this.volatiles.set(id, state);
    return true;
  }

  removeVolatile(id: string): boolean {
    return this.volatiles.delete(id);
  }

  /** Reset everything that leaves the field with the Pokémon on switch-out. */
  clearOnSwitchOut(): void {
    this.boosts = emptyBoosts();
    this.volatiles.clear();
    this.charging = null;
    this.tookDamageThisTurn = false;
    this.lockedMoveId = ''; // Choice lock releases on switch
    this.lastMoveId = '';   // and so does anything Encore locked in
    this.boostedStat = null;
    this.boosterFromItem = false;
    this.itemLost = false;
    this.slowStartTurns = 0;
    this.loafing = false;
    this.types = [...this.species.types]; // undo Protean/Libero
    // Toxic resets to regular-poison counter on switch (classic behavior keeps
    // tox but restarts the counter).
    if (this.status === 'tox') this.statusState.toxicTurns = 0;
  }

  setStatus(status: StatusID, state: StatusState = {}): boolean {
    if (this.status || this.fainted) return false;
    this.status = status;
    this.statusState = state;
    return true;
  }

  cureStatus(): StatusID | '' {
    const prev = this.status;
    this.status = '';
    this.statusState = {};
    return prev;
  }

  /** Consume the held item (berries, Focus Sash, popped Air Balloon...). */
  consumeItem(): void {
    if (this.itemId) {
      this.lastItemId = this.itemId;
      this.itemLost = true;
    }
    this.item = '';
    this.itemId = '';
  }

  /** Last item consumed — what Harvest and Recycle can bring back. */
  lastItemId = '';

  /** Highest raw stat, ignoring HP: what the Booster abilities pick. */
  highestStat(): Exclude<StatID, 'hp'> {
    const order: Exclude<StatID, 'hp'>[] = ['atk', 'def', 'spa', 'spd', 'spe'];
    let best = order[0]!;
    for (const stat of order) {
      if (this.stats[stat] > this.stats[best]) best = stat;
    }
    return best;
  }

  /** Moves currently selectable (PP left, not disabled, item rules). */
  availableMoves(): MoveSlot[] {
    return this.moveSlots.filter((m) => {
      if (m.pp <= 0 || m.disabled) return false;
      if (this.lockedMoveId && m.id !== this.lockedMoveId) return false; // Choice lock
      // Cursed Body / Disable lock out one specific move.
      if (this.volatiles.get('disable')?.moveId === m.id) return false;
      // Taunt bars status moves from being selectable at all.
      if (this.hasVolatile('taunt') && m.move.category === 'Status') return false;
      if (this.itemId === 'assaultvest' && m.move.category === 'Status') return false;
      return true;
    });
  }
}
