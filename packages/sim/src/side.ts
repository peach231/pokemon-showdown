import { BattlePokemon, type ResolvedPokemonSet } from './pokemon.js';

export type SideID = 'p1' | 'p2';

/** A player's parsed choice for the pending request. */
export type Choice =
  | { type: 'move'; moveIndex: number }
  | { type: 'switch'; teamIndex: number }
  | { type: 'team'; order: number[] }
  | { type: 'pass' };

/** The JSON sent to a client as `|request|`; mirrors Showdown's shape, trimmed. */
export interface RequestJSON {
  rqid: number;
  teamPreview?: boolean;
  forceSwitch?: [boolean];
  wait?: boolean;
  active?: {
    moves: { id: string; name: string; pp: number; maxpp: number; disabled: boolean }[];
  }[];
  side: {
    id: SideID;
    name: string;
    pokemon: {
      ident: string;
      details: string;
      condition: string;
      active: boolean;
      moves: string[];
      item?: string;
      ability?: string;
    }[];
  };
}

export class Side {
  readonly id: SideID;
  readonly name: string;
  readonly team: BattlePokemon[];
  /** Index into `team` of the active Pokémon (-1 before leads are out). */
  activeIndex = -1;
  /** The player's submitted choice for the current request (null = undecided). */
  choice: Choice | null = null;
  /** Entry hazards etc. on this side's field (currently just 'stealthrock'). */
  readonly sideConditions = new Set<string>();
  /** What kind of decision this side owes right now. */
  requestState: 'teampreview' | 'move' | 'switch' | 'wait' = 'wait';

  constructor(id: SideID, name: string, team: ResolvedPokemonSet[]) {
    this.id = id;
    this.name = name;
    this.team = team.map((set, i) => new BattlePokemon(set, id, i));
  }

  get active(): BattlePokemon | null {
    return this.activeIndex >= 0 ? (this.team[this.activeIndex] ?? null) : null;
  }

  /** Team indexes that can legally be switched in right now. */
  switchableIndexes(): number[] {
    return this.team
      .map((p, i) => (!p.fainted && i !== this.activeIndex ? i : -1))
      .filter((i) => i >= 0);
  }

  hasRemainingPokemon(): boolean {
    return this.team.some((p) => !p.fainted);
  }

  pokemonLeft(): number {
    return this.team.filter((p) => !p.fainted).length;
  }

  /** Build the `|request|` JSON for this side's pending decision. */
  buildRequest(rqid: number): RequestJSON {
    const base: RequestJSON = {
      rqid,
      side: {
        id: this.id,
        name: this.name,
        pokemon: this.team.map((p) => ({
          ident: p.ident,
          details: p.details,
          condition: p.condition,
          active: p === this.active,
          moves: p.moveSlots.map((m) => m.id),
          item: p.item,
          ability: p.ability,
        })),
      },
    };
    switch (this.requestState) {
      case 'teampreview':
        base.teamPreview = true;
        break;
      case 'switch':
        base.forceSwitch = [true];
        break;
      case 'move': {
        const active = this.active!;
        const available = active.availableMoves();
        base.active = [{
          moves: active.moveSlots.map((m, i) => ({
            id: m.id,
            name: m.move.name,
            pp: m.pp,
            maxpp: m.maxpp,
            // Mid-charge (Sky Attack turn 2): locked into the charging move.
            disabled: active.charging
              ? i !== active.charging.slotIndex
              : m.disabled || m.pp <= 0 || (available.length === 0 ? false : !available.includes(m)),
          })),
        }];
        break;
      }
      case 'wait':
        base.wait = true;
        break;
    }
    return base;
  }

  /**
   * Parse a raw choice string against the current request.
   * Returns a Choice or an error message string.
   */
  parseChoice(input: string): Choice | { error: string } {
    const trimmed = input.trim();
    const [verb, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ');

    if (this.requestState === 'wait') {
      return { error: `You don't have a decision to make right now.` };
    }

    if (verb === 'default') {
      return this.defaultChoice();
    }

    if (this.requestState === 'teampreview') {
      if (verb !== 'team') return { error: `You must choose a team order (e.g. "team 123456").` };
      const digits = arg.replace(/[^1-6]/g, '').split('').map((d) => parseInt(d, 10) - 1);
      const seen = new Set<number>();
      const order: number[] = [];
      for (const d of digits) {
        if (d < 0 || d >= this.team.length || seen.has(d)) continue;
        seen.add(d);
        order.push(d);
      }
      // Fill any unspecified slots in existing order.
      for (let i = 0; i < this.team.length; i++) {
        if (!seen.has(i)) order.push(i);
      }
      if (order.length !== this.team.length) return { error: `Invalid team order "${arg}".` };
      return { type: 'team', order };
    }

    if (verb === 'switch') {
      const teamIndex = parseInt(arg, 10) - 1;
      if (Number.isNaN(teamIndex)) return { error: `Switch to which Pokémon? (e.g. "switch 2")` };
      const target = this.team[teamIndex];
      if (!target) return { error: `You don't have a Pokémon in slot ${teamIndex + 1}.` };
      if (target.fainted) return { error: `${target.name} has fainted and can't battle.` };
      if (teamIndex === this.activeIndex) return { error: `${target.name} is already in battle.` };
      return { type: 'switch', teamIndex };
    }

    if (verb === 'move') {
      if (this.requestState !== 'move') return { error: `You must switch in a Pokémon.` };
      const active = this.active!;
      // Accept a 1-based slot number or a move id/name.
      let moveIndex = parseInt(arg, 10) - 1;
      if (Number.isNaN(moveIndex)) {
        const norm = arg.toLowerCase().replace(/[^a-z0-9]/g, '');
        moveIndex = active.moveSlots.findIndex((m) => m.id === norm);
      }
      const slot = active.moveSlots[moveIndex];
      if (!slot) return { error: `${active.name} doesn't have that move.` };
      const usable = active.availableMoves();
      if (usable.length === 0) {
        // No usable moves: any "move" choice becomes Struggle (index -1 sentinel).
        return { type: 'move', moveIndex: -1 };
      }
      if (slot.pp <= 0) return { error: `${slot.move.name} is out of PP.` };
      if (!usable.includes(slot)) {
        return { error: `${slot.move.name} can't be used right now.` };
      }
      return { type: 'move', moveIndex };
    }

    return { error: `Unrecognized choice "${trimmed}".` };
  }

  /** The automatic fallback decision (used for "default" and timer expiry). */
  defaultChoice(): Choice {
    switch (this.requestState) {
      case 'teampreview':
        return { type: 'team', order: this.team.map((_, i) => i) };
      case 'switch': {
        const first = this.switchableIndexes()[0];
        return first === undefined ? { type: 'pass' } : { type: 'switch', teamIndex: first };
      }
      case 'move': {
        const active = this.active!;
        const usable = active.availableMoves();
        if (usable.length === 0) return { type: 'move', moveIndex: -1 }; // Struggle
        const idx = active.moveSlots.indexOf(usable[0]!);
        return { type: 'move', moveIndex: idx };
      }
      default:
        return { type: 'pass' };
    }
  }
}
