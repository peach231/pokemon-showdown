import { PRNG, type PRNGSeed } from './prng.js';
import { BattlePokemon, type ResolvedPokemonSet } from './pokemon.js';
import { Side, type SideID, type Choice, type RequestJSON } from './side.js';
import { calculateDamage } from './damage.js';
import { typeEffectiveness } from './typechart.js';
import { addBoost } from './stats.js';
import { accuracyBoostMultiplier } from './stats.js';
import type { MoveData, StatusID, BoostID, TypeName, WeatherID } from './types.js';

const WEATHER_NAMES: Record<Exclude<WeatherID, ''>, string> = {
  raindance: 'RainDance',
  sunnyday: 'SunnyDay',
  sandstorm: 'Sandstorm',
  snow: 'Snow',
};

/** Types immune to sandstorm chip damage. */
const SAND_IMMUNE: readonly TypeName[] = ['Rock', 'Ground', 'Steel'];

/** Pinch abilities: 1.5x power of their type when the user is at ≤1/3 HP. */
const PINCH_ABILITIES: Record<string, TypeName> = {
  Blaze: 'Fire', Torrent: 'Water', Overgrow: 'Grass', Swarm: 'Bug',
};

function hasAbility(pokemon: BattlePokemon, ability: string): boolean {
  return pokemon.ability === ability;
}

export interface PlayerOptions {
  name: string;
  team: ResolvedPokemonSet[];
  /** Trainer avatar sprite name (cosmetic, echoed in |player|). */
  avatar?: string;
}

export interface BattleOptions {
  seed?: PRNGSeed;
  p1: PlayerOptions;
  p2: PlayerOptions;
  /** Format label shown in the log header. */
  formatName?: string;
}

/** Struggle: used automatically when no moves have PP. */
const STRUGGLE: MoveData = {
  id: 'struggle',
  name: 'Struggle',
  type: 'Normal',
  category: 'Physical',
  basePower: 50,
  accuracy: true,
  pp: 1,
  priority: 0,
  target: 'normal',
  flags: { contact: 1, protect: 1 },
};

const PROTECT_MOVES = new Set(['protect', 'detect']);

/** Type-based immunities to major statuses (Gen 6+ rules). */
function isStatusImmune(pokemon: BattlePokemon, status: StatusID): boolean {
  const types = pokemon.types;
  switch (status) {
    case 'brn': return types.includes('Fire');
    case 'par': return types.includes('Electric');
    case 'psn':
    case 'tox': return types.includes('Poison') || types.includes('Steel');
    case 'frz': return types.includes('Ice');
    case 'slp': return false;
  }
}

interface Action {
  side: Side;
  pokemon: BattlePokemon;
  choice: Choice;
  priority: number;
  speed: number;
  /** Random tiebreak drawn up front so speed ties are a fair coin flip. */
  tieBreak: number;
}

/**
 * A complete singles battle. The server owns one of these per battle room:
 * feed player choices in via `choose()`, and protocol lines come out through
 * `onUpdate` (public log) and `onSideUpdate` (per-player |request|/|error|).
 */
export class Battle {
  readonly prng: PRNG;
  readonly sides: { p1: Side; p2: Side };
  readonly formatName: string;
  private p1Avatar: string;
  private p2Avatar: string;

  turn = 0;
  ended = false;
  winner: string | null = null;
  rqid = 0;
  weather: WeatherID = '';
  weatherTurns = 0;

  /** Full public protocol log (this is also the replay). */
  readonly log: string[] = [];
  /** Every input fed to the battle, for exact re-simulation. */
  readonly inputLog: string[] = [];

  /** Subscriber for public protocol lines. */
  onUpdate: ((lines: string[]) => void) | null = null;
  /** Subscriber for side-specific lines (requests, choice errors). */
  onSideUpdate: ((side: SideID, line: string) => void) | null = null;

  private phase: 'teampreview' | 'battle' | 'ended' = 'teampreview';

  constructor(options: BattleOptions) {
    this.prng = new PRNG(options.seed ?? `battle-${Math.floor(Date.now())}`);
    this.formatName = options.formatName ?? 'Simple Singles';
    this.sides = {
      p1: new Side('p1', options.p1.name, options.p1.team),
      p2: new Side('p2', options.p2.name, options.p2.team),
    };
    this.p1Avatar = options.p1.avatar ?? '';
    this.p2Avatar = options.p2.avatar ?? '';
    this.inputLog.push(`>seed ${JSON.stringify(this.prng.initialSeed)}`);
  }

  // ------------------------------------------------------------------
  // Protocol output
  // ------------------------------------------------------------------

  private add(...parts: (string | number)[]): void {
    const line = `|${parts.join('|')}`;
    this.log.push(line);
    this.onUpdate?.([line]);
  }

  private sendRequest(side: Side): void {
    const request = side.buildRequest(this.rqid);
    this.onSideUpdate?.(side.id, `|request|${JSON.stringify(request)}`);
  }

  /** Rebuild the current request JSON for a side (for reconnects). */
  currentRequest(sideId: SideID): RequestJSON {
    return this.sides[sideId].buildRequest(this.rqid);
  }

  // ------------------------------------------------------------------
  // Battle lifecycle
  // ------------------------------------------------------------------

  /** Emit the header + team preview and ask both players for a team order. */
  start(): void {
    this.add('player', 'p1', this.sides.p1.name, this.p1Avatar);
    this.add('player', 'p2', this.sides.p2.name, this.p2Avatar);
    this.add('teamsize', 'p1', this.sides.p1.team.length);
    this.add('teamsize', 'p2', this.sides.p2.team.length);
    this.add('gametype', 'singles');
    this.add('gen', 9);
    this.add('tier', this.formatName);
    this.add('clearpoke');
    for (const side of [this.sides.p1, this.sides.p2]) {
      for (const p of side.team) {
        this.add('poke', side.id, p.details);
      }
    }
    this.add('teampreview');
    this.newRequestWave('teampreview');
  }

  /** Submit a player's choice. Returns null on success or an error string. */
  choose(sideId: SideID, input: string): string | null {
    if (this.ended) return 'The battle has already ended.';
    const side = this.sides[sideId];
    const parsed = side.parseChoice(input);
    if ('error' in parsed) {
      this.onSideUpdate?.(sideId, `|error|[Invalid choice] ${parsed.error}`);
      return parsed.error;
    }
    side.choice = parsed;
    this.inputLog.push(`>${sideId} ${input.trim()}`);
    this.maybeCommit();
    return null;
  }

  /** True if every side that owes a decision has submitted one. */
  private allChoicesIn(): boolean {
    for (const side of [this.sides.p1, this.sides.p2]) {
      if (side.requestState !== 'wait' && !side.choice) return false;
    }
    return true;
  }

  private maybeCommit(): void {
    if (!this.allChoicesIn()) return;
    if (this.phase === 'teampreview') {
      this.commitTeamPreview();
    } else if (this.sides.p1.requestState === 'switch' || this.sides.p2.requestState === 'switch') {
      this.commitFaintReplacements();
    } else {
      this.runTurn();
    }
  }

  private newRequestWave(kind: 'teampreview' | 'move'): void {
    this.rqid++;
    for (const side of [this.sides.p1, this.sides.p2]) {
      side.choice = null;
      side.requestState = kind === 'teampreview' ? 'teampreview' : 'move';
      this.sendRequest(side);
    }
  }

  private commitTeamPreview(): void {
    for (const side of [this.sides.p1, this.sides.p2]) {
      const choice = side.choice!;
      if (choice.type === 'team') {
        const reordered = choice.order.map((i) => side.team[i]!);
        side.team.length = 0;
        side.team.push(...reordered);
        side.team.forEach((p, i) => { p.position = i; });
      }
    }
    this.phase = 'battle';
    this.add('start');
    // Send out leads, faster side first (cosmetic order; both happen together).
    const leads = [this.sides.p1, this.sides.p2]
      .sort((a, b) => (b.team[0]!.getStat('spe') - a.team[0]!.getStat('spe')) || (this.prng.randomChance(1, 2) ? 1 : -1));
    for (const side of leads) {
      this.switchIn(side, 0);
    }
    this.nextTurn();
  }

  private commitFaintReplacements(): void {
    const replacing = [this.sides.p1, this.sides.p2]
      .filter((s) => s.requestState === 'switch' && s.choice?.type === 'switch');
    // Faster replacement enters first (cosmetic).
    replacing.sort((a, b) => b.team[0]!.getStat('spe') - a.team[0]!.getStat('spe'));
    for (const side of replacing) {
      const choice = side.choice as Extract<Choice, { type: 'switch' }>;
      this.switchIn(side, choice.teamIndex);
    }
    // A replacement may faint to Stealth Rock — re-request if so.
    this.requestReplacementsOrContinue();
  }

  private nextTurn(): void {
    if (this.checkWin()) return;
    this.turn++;
    this.add('turn', this.turn);
    this.newRequestWave('move');
  }

  // ------------------------------------------------------------------
  // Turn resolution
  // ------------------------------------------------------------------

  private runTurn(): void {
    const actions: Action[] = [];
    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active!;
      const choice = side.choice!;
      let priority = 0;
      if (choice.type === 'switch') {
        priority = 100; // switches always resolve before moves
      } else if (choice.type === 'move') {
        const move = this.moveForChoice(pokemon, choice);
        priority = move.priority;
      }
      actions.push({
        side,
        pokemon,
        choice,
        priority,
        speed: pokemon.getStat('spe'),
        tieBreak: this.prng.random(1_000_000),
      });
    }

    actions.sort((a, b) =>
      (b.priority - a.priority) || (b.speed - a.speed) || (a.tieBreak - b.tieBreak));

    for (const action of actions) {
      if (this.ended) return;
      if (action.pokemon.fainted) continue; // fainted before acting
      if (action.choice.type === 'switch') {
        this.switchIn(action.side, action.choice.teamIndex);
      } else if (action.choice.type === 'move') {
        const defenderSide = action.side.id === 'p1' ? this.sides.p2 : this.sides.p1;
        const defender = defenderSide.active!;
        this.runMove(action.pokemon, defender, action.choice);
      }
    }

    if (this.ended) return;
    this.residualPhase();
    if (this.ended) return;
    this.add('upkeep');
    this.requestReplacementsOrContinue();
  }

  /** Ask for faint replacements if needed (hazards can re-faint them), else next turn. */
  private requestReplacementsOrContinue(): void {
    if (this.ended) return;
    const needsSwitch = [this.sides.p1, this.sides.p2]
      .filter((s) => s.active?.fainted && s.hasRemainingPokemon());
    if (needsSwitch.length > 0) {
      this.rqid++;
      for (const side of [this.sides.p1, this.sides.p2]) {
        side.choice = null;
        side.requestState = needsSwitch.includes(side) ? 'switch' : 'wait';
        this.sendRequest(side);
      }
      return;
    }
    this.nextTurn();
  }

  private moveForChoice(pokemon: BattlePokemon, choice: Extract<Choice, { type: 'move' }>): MoveData {
    if (choice.moveIndex < 0) return STRUGGLE;
    return pokemon.moveSlots[choice.moveIndex]!.move;
  }

  // ------------------------------------------------------------------
  // Switching
  // ------------------------------------------------------------------

  private switchIn(side: Side, teamIndex: number): void {
    const outgoing = side.active;
    if (outgoing && !outgoing.fainted) {
      outgoing.clearOnSwitchOut();
    }
    side.activeIndex = teamIndex;
    const incoming = side.active!;
    incoming.revealed = true;
    this.add('switch', incoming.activeIdent, incoming.details, incoming.condition);

    // Entry hazards: Stealth Rock damage scales with Rock effectiveness.
    if (side.sideConditions.has('stealthrock')) {
      const eff = typeEffectiveness('Rock', incoming.types);
      const damage = Math.max(1, Math.floor((incoming.maxhp * eff) / 8));
      incoming.damage(damage);
      this.add('-damage', incoming.activeIdent, incoming.condition, '[from] Stealth Rock');
      this.checkFaint(incoming);
    }

    // Intimidate: drop the opposing active Pokémon's Attack on entry.
    if (!incoming.fainted && hasAbility(incoming, 'Intimidate')) {
      const foe = (side.id === 'p1' ? this.sides.p2 : this.sides.p1).active;
      if (foe && !foe.fainted) {
        this.add('-ability', incoming.activeIdent, 'Intimidate');
        this.applyBoosts(foe, { atk: -1 });
      }
    }
  }

  // ------------------------------------------------------------------
  // Move execution
  // ------------------------------------------------------------------

  private runMove(
    attacker: BattlePokemon,
    defender: BattlePokemon,
    choice: Extract<Choice, { type: 'move' }>,
  ): void {
    const move = this.moveForChoice(attacker, choice);

    if (!this.beforeMove(attacker)) return;

    // Deduct PP.
    if (choice.moveIndex >= 0) {
      const slot = attacker.moveSlots[choice.moveIndex]!;
      slot.pp = Math.max(0, slot.pp - 1);
    }

    this.add('move', attacker.activeIdent, move.name, defender.activeIdent);

    // Protect/Detect: succeeds with chance 1/3^chain.
    if (PROTECT_MOVES.has(move.id)) {
      const stall = attacker.volatiles.get('stall');
      const chain = stall?.turns ?? 0;
      const denom = Math.pow(3, chain);
      if (this.prng.randomChance(1, denom)) {
        attacker.addVolatile('protect');
        attacker.volatiles.set('stall', { turns: chain + 1 });
        attacker.volatiles.set('usedstall', {});
        this.add('-singleturn', attacker.activeIdent, 'Protect');
      } else {
        attacker.removeVolatile('stall');
        this.add('-fail', attacker.activeIdent);
      }
      return;
    }

    // Target protected?
    if (move.flags.protect && defender.hasVolatile('protect') && move.target !== 'self') {
      this.add('-activate', defender.activeIdent, 'move: Protect');
      return;
    }

    // Accuracy check.
    if (!this.accuracyCheck(attacker, defender, move)) {
      this.add('-miss', attacker.activeIdent, defender.activeIdent);
      return;
    }

    if (move.category === 'Status') {
      this.runStatusMove(attacker, defender, move);
    } else {
      this.runDamagingMove(attacker, defender, move);
    }
  }

  /** Sleep/freeze/flinch/confusion/paralysis gates. True = the move proceeds. */
  private beforeMove(pokemon: BattlePokemon): boolean {
    // Sleep.
    if (pokemon.status === 'slp') {
      const remaining = pokemon.statusState.sleepTurns ?? 0;
      if (remaining > 0) {
        pokemon.statusState.sleepTurns = remaining - 1;
        this.add('cant', pokemon.activeIdent, 'slp');
        return false;
      }
      pokemon.cureStatus();
      this.add('-curestatus', pokemon.activeIdent, 'slp');
    }
    // Freeze: 20% chance to thaw each attempt.
    if (pokemon.status === 'frz') {
      if (this.prng.randomChance(1, 5)) {
        pokemon.cureStatus();
        this.add('-curestatus', pokemon.activeIdent, 'frz');
      } else {
        this.add('cant', pokemon.activeIdent, 'frz');
        return false;
      }
    }
    // Flinch.
    if (pokemon.hasVolatile('flinch')) {
      pokemon.removeVolatile('flinch');
      this.add('cant', pokemon.activeIdent, 'flinch');
      return false;
    }
    // Confusion.
    if (pokemon.hasVolatile('confusion')) {
      const state = pokemon.volatiles.get('confusion')!;
      const turns = state.turns ?? 0;
      if (turns <= 0) {
        pokemon.removeVolatile('confusion');
        this.add('-end', pokemon.activeIdent, 'confusion');
      } else {
        state.turns = turns - 1;
        this.add('-activate', pokemon.activeIdent, 'confusion');
        if (this.prng.randomChance(33, 100)) {
          // 40 BP typeless physical self-hit.
          const atk = pokemon.getStat('atk');
          const def = pokemon.getStat('def');
          let dmg = Math.floor(
            Math.floor((Math.floor((2 * pokemon.level) / 5 + 2) * 40 * atk) / def) / 50,
          ) + 2;
          dmg = Math.floor((dmg * (100 - this.prng.random(16))) / 100);
          pokemon.damage(dmg);
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] confusion');
          this.checkFaint(pokemon);
          return false;
        }
      }
    }
    if (pokemon.fainted) return false;
    // Paralysis: 25% full paralysis.
    if (pokemon.status === 'par' && this.prng.randomChance(1, 4)) {
      this.add('cant', pokemon.activeIdent, 'par');
      return false;
    }
    return true;
  }

  private accuracyCheck(attacker: BattlePokemon, defender: BattlePokemon, move: MoveData): boolean {
    if (move.accuracy === true) return true;
    let acc = move.accuracy;
    const stage = attacker.boosts.accuracy - defender.boosts.evasion;
    acc *= accuracyBoostMultiplier(stage);
    acc = Math.min(100, acc);
    return this.prng.randomChance(Math.round(acc * 10), 1000);
  }

  private runStatusMove(attacker: BattlePokemon, defender: BattlePokemon, move: MoveData): void {
    // Weather moves.
    if (move.weather) {
      const weather = move.weather as Exclude<WeatherID, ''>;
      if (!WEATHER_NAMES[weather] || this.weather === weather) {
        this.add('-fail', attacker.activeIdent);
        return;
      }
      this.weather = weather;
      this.weatherTurns = 5;
      this.add('-weather', WEATHER_NAMES[weather]);
      return;
    }

    // Entry hazards (Stealth Rock) go on the DEFENDER's side.
    if (move.sideCondition === 'stealthrock') {
      const foeSide = attacker.sideId === 'p1' ? this.sides.p2 : this.sides.p1;
      if (foeSide.sideConditions.has('stealthrock')) {
        this.add('-fail', attacker.activeIdent);
        return;
      }
      foeSide.sideConditions.add('stealthrock');
      this.add('-sidestart', `${foeSide.id}: ${foeSide.name}`, 'move: Stealth Rock');
      return;
    }

    const targetsSelf = move.target === 'self';
    const target = targetsSelf ? attacker : defender;

    // A Substitute blocks most status moves aimed at the holder.
    if (!targetsSelf && target.hasVolatile('substitute') && !move.flags.sound) {
      this.add('-fail', target.activeIdent);
      return;
    }

    let didSomething = false;

    if (move.boosts) {
      didSomething = this.applyBoosts(target, move.boosts) || didSomething;
    }
    if (move.self?.boosts && !targetsSelf) {
      didSomething = this.applyBoosts(attacker, move.self.boosts) || didSomething;
    }
    if (move.status) {
      didSomething = this.trySetStatus(target, move.status) || didSomething;
    }
    if (move.volatileStatus) {
      didSomething = this.tryAddVolatile(target, move.volatileStatus, attacker) || didSomething;
    }
    if (move.heal) {
      const healed = target.heal(Math.floor((target.maxhp * move.heal) / 100));
      if (healed > 0) {
        this.add('-heal', target.activeIdent, target.condition);
        didSomething = true;
      }
    }

    if (!didSomething) {
      this.add('-fail', defender.activeIdent);
    }
  }

  private runDamagingMove(attacker: BattlePokemon, defender: BattlePokemon, move: MoveData): void {
    const isStruggle = move.id === 'struggle';

    // Ability-based immunities and absorbs.
    if (!isStruggle && this.checkAbilityImmunity(attacker, defender, move)) return;

    // Type immunity (fixed-damage and OHKO moves still respect immunity).
    const eff = isStruggle ? 1 : typeEffectiveness(move.type, defender.types);
    if (eff === 0) {
      this.add('-immune', defender.activeIdent);
      return;
    }

    // Number of hits.
    let hits = 1;
    if (typeof move.multihit === 'number') {
      hits = move.multihit;
    } else if (Array.isArray(move.multihit)) {
      // 2-5 hit distribution: 2 or 3 hits 35% each, 4 or 5 hits 15% each.
      const roll = this.prng.random(100);
      hits = roll < 35 ? 2 : roll < 70 ? 3 : roll < 85 ? 4 : 5;
      const [min, max] = move.multihit;
      hits = Math.max(min, Math.min(max, hits));
    }

    let totalDealt = 0;
    let actualHits = 0;

    for (let hit = 0; hit < hits; hit++) {
      if (attacker.fainted || defender.fainted) break;

      let damage: number;
      let crit = false;

      if (move.ohko) {
        damage = defender.hp;
      } else if (move.damage === 'level') {
        damage = attacker.level;
      } else if (typeof move.damage === 'number') {
        damage = move.damage;
      } else {
        crit = this.prng.randomChance(1, 24);

        // Ability modifiers.
        let basePower = move.basePower;
        const pinchType = PINCH_ABILITIES[attacker.ability];
        if (pinchType === move.type && attacker.hp <= Math.floor(attacker.maxhp / 3)) {
          basePower = Math.floor(basePower * 1.5); // Blaze/Torrent/Overgrow/Swarm
        }
        if (attacker.hasVolatile('flashfire') && move.type === 'Fire') {
          basePower = Math.floor(basePower * 1.5);
        }
        if (hasAbility(defender, 'Thick Fat') && (move.type === 'Fire' || move.type === 'Ice')) {
          basePower = Math.floor(basePower * 0.5);
        }
        let attackStat = move.category === 'Physical'
          ? attacker.getStat('atk', { ignoreBoosts: crit && attacker.boosts.atk < 0 })
          : attacker.getStat('spa', { ignoreBoosts: crit && attacker.boosts.spa < 0 });
        if (move.category === 'Physical' && hasAbility(attacker, 'Huge Power')) {
          attackStat *= 2;
        }
        const guts = hasAbility(attacker, 'Guts') && attacker.status !== '';
        if (guts && move.category === 'Physical') {
          attackStat = Math.floor(attackStat * 1.5);
        }

        const result = calculateDamage({
          level: attacker.level,
          basePower,
          category: move.category as 'Physical' | 'Special',
          moveType: move.type,
          attackStat,
          defenseStat: move.category === 'Physical'
            ? defender.getStat('def', { ignoreBoosts: crit && defender.boosts.def > 0 })
            : defender.getStat('spd', { ignoreBoosts: crit && defender.boosts.spd > 0 }),
          attackerTypes: isStruggle ? [] : attacker.types,
          defenderTypes: isStruggle ? [] : defender.types,
          isCrit: crit,
          isBurned: attacker.status === 'brn' && !guts, // Guts ignores burn's halving
          prng: this.prng,
          weather: this.weather,
        }).damage;
        damage = result;
      }

      // Sturdy: survive any hit from full HP with 1 HP.
      if (hasAbility(defender, 'Sturdy') && defender.hp === defender.maxhp
        && damage >= defender.hp && !defender.hasVolatile('substitute')) {
        this.add('-ability', defender.activeIdent, 'Sturdy');
        damage = defender.hp - 1;
      }

      // Substitute takes the hit instead.
      const sub = defender.volatiles.get('substitute');
      if (sub && !move.flags.sound) {
        const subHp = sub.hp ?? 0;
        const dealt = Math.min(subHp, damage);
        sub.hp = subHp - dealt;
        actualHits++;
        if (crit) this.add('-crit', defender.activeIdent);
        if (sub.hp <= 0) {
          defender.removeVolatile('substitute');
          this.add('-end', defender.activeIdent, 'Substitute');
        } else {
          this.add('-activate', defender.activeIdent, 'move: Substitute', '[damage]');
        }
        continue;
      }

      const dealt = defender.damage(damage);
      totalDealt += dealt;
      actualHits++;

      if (crit) this.add('-crit', defender.activeIdent);
      if (!isStruggle && !move.ohko && move.damage === undefined) {
        if (eff > 1) this.add('-supereffective', defender.activeIdent);
        else if (eff < 1) this.add('-resisted', defender.activeIdent);
      }
      this.add('-damage', defender.activeIdent, defender.condition);
      if (move.ohko) this.add('-ohko');

      if (defender.fainted) break;
    }

    if (Array.isArray(move.multihit) || (typeof move.multihit === 'number' && move.multihit > 1)) {
      this.add('-hitcount', defender.activeIdent, actualHits);
    }

    // Drain / recoil.
    if (move.drain && totalDealt > 0 && !attacker.fainted) {
      const healed = attacker.heal(Math.max(1, Math.floor((totalDealt * move.drain[0]) / move.drain[1])));
      if (healed > 0) {
        this.add('-heal', attacker.activeIdent, attacker.condition, `[from] drain`, `[of] ${defender.activeIdent}`);
      }
    }
    if (isStruggle && !attacker.fainted) {
      attacker.damage(Math.max(1, Math.floor(attacker.maxhp / 4)));
      this.add('-damage', attacker.activeIdent, attacker.condition, '[from] recoil');
    } else if (move.recoil && totalDealt > 0 && !attacker.fainted) {
      attacker.damage(Math.max(1, Math.floor((totalDealt * move.recoil[0]) / move.recoil[1])));
      this.add('-damage', attacker.activeIdent, attacker.condition, '[from] recoil');
    }

    // Secondary effects (blocked by a surviving Substitute).
    if (move.secondaries && totalDealt > 0 && !defender.fainted && !defender.hasVolatile('substitute')) {
      for (const secondary of move.secondaries) {
        if (!this.prng.randomChance(secondary.chance, 100)) continue;
        if (secondary.status) this.trySetStatus(defender, secondary.status, true);
        if (secondary.volatileStatus) this.tryAddVolatile(defender, secondary.volatileStatus, attacker, true);
        if (secondary.boosts) this.applyBoosts(defender, secondary.boosts);
        if (secondary.self?.boosts) this.applyBoosts(attacker, secondary.self.boosts);
      }
    }
    // Guaranteed self boosts on damaging moves (e.g. Dragon Dance is Status,
    // but Close Combat's drop arrives via move.self).
    if (move.self?.boosts && !attacker.fainted) {
      this.applyBoosts(attacker, move.self.boosts);
    }

    // Static: contact moves have a 30% chance to paralyze the attacker.
    if (hasAbility(defender, 'Static') && move.flags.contact && totalDealt > 0
      && !attacker.fainted && this.prng.randomChance(3, 10)) {
      this.add('-ability', defender.activeIdent, 'Static');
      this.trySetStatus(attacker, 'par', true);
    }

    this.checkFaint(defender);
    this.checkFaint(attacker);
  }

  /** Levitate / Flash Fire / Water Absorb / Volt Absorb. True = move absorbed. */
  private checkAbilityImmunity(attacker: BattlePokemon, defender: BattlePokemon, move: MoveData): boolean {
    if (defender.fainted) return false;
    if (hasAbility(defender, 'Levitate') && move.type === 'Ground') {
      this.add('-immune', defender.activeIdent, '[from] ability: Levitate');
      return true;
    }
    if (hasAbility(defender, 'Flash Fire') && move.type === 'Fire') {
      if (defender.addVolatile('flashfire')) {
        this.add('-start', defender.activeIdent, 'ability: Flash Fire');
      } else {
        this.add('-immune', defender.activeIdent, '[from] ability: Flash Fire');
      }
      return true;
    }
    const absorb = hasAbility(defender, 'Water Absorb') && move.type === 'Water' ? 'Water Absorb'
      : hasAbility(defender, 'Volt Absorb') && move.type === 'Electric' ? 'Volt Absorb'
        : null;
    if (absorb) {
      const healed = defender.heal(Math.floor(defender.maxhp / 4));
      if (healed > 0) {
        this.add('-heal', defender.activeIdent, defender.condition, `[from] ability: ${absorb}`);
      } else {
        this.add('-immune', defender.activeIdent, `[from] ability: ${absorb}`);
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------

  /** Returns true if any stage actually changed. */
  private applyBoosts(target: BattlePokemon, boosts: Partial<Record<BoostID, number>>): boolean {
    if (target.fainted) return false;
    let changed = false;
    for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
      if (!delta) continue;
      const applied = addBoost(target.boosts, stat, delta);
      if (applied === 0) continue;
      changed = true;
      this.add(applied > 0 ? '-boost' : '-unboost', target.activeIdent, stat, Math.abs(applied));
    }
    return changed;
  }

  /** Returns true if the status was applied (silent=true skips the fail message). */
  private trySetStatus(target: BattlePokemon, status: StatusID, silent = false): boolean {
    if (target.fainted) return false;
    if (target.status || isStatusImmune(target, status)) {
      if (!silent) {
        this.add(target.status ? '-fail' : '-immune', target.activeIdent);
      }
      return false;
    }
    const state = status === 'slp'
      ? { sleepTurns: this.prng.random(1, 4) } // 1-3 turns asleep
      : status === 'tox'
        ? { toxicTurns: 0 }
        : {};
    target.setStatus(status, state);
    this.add('-status', target.activeIdent, status);
    return true;
  }

  private tryAddVolatile(
    target: BattlePokemon,
    id: string,
    source: BattlePokemon,
    silent = false,
  ): boolean {
    if (target.fainted) return false;

    if (id === 'substitute') {
      // Substitute targets the user and costs 1/4 max HP.
      const cost = Math.floor(source.maxhp / 4);
      if (source.hasVolatile('substitute') || source.hp <= cost) {
        if (!silent) this.add('-fail', source.activeIdent);
        return false;
      }
      source.damage(cost);
      source.addVolatile('substitute', { hp: cost });
      this.add('-start', source.activeIdent, 'Substitute');
      this.add('-damage', source.activeIdent, source.condition);
      return true;
    }

    if (id === 'leechseed' && target.types.includes('Grass')) {
      if (!silent) this.add('-immune', target.activeIdent);
      return false;
    }

    if (target.hasVolatile(id)) {
      if (!silent) this.add('-fail', target.activeIdent);
      return false;
    }

    const state: { turns?: number } = {};
    if (id === 'confusion') state.turns = this.prng.random(2, 6); // 2-5 attack attempts
    target.addVolatile(id, state);
    if (id !== 'flinch') {
      this.add('-start', target.activeIdent, id === 'confusion' ? 'confusion' : `move: ${id}`);
    }
    return true;
  }

  // ------------------------------------------------------------------
  // End of turn
  // ------------------------------------------------------------------

  private residualPhase(): void {
    // Weather ticks first: duration, then sandstorm chip damage.
    if (this.weather) {
      this.weatherTurns--;
      if (this.weatherTurns <= 0) {
        this.add('-weather', 'none');
        this.weather = '';
      } else {
        this.add('-weather', WEATHER_NAMES[this.weather], '[upkeep]');
        if (this.weather === 'sandstorm') {
          for (const side of [this.sides.p1, this.sides.p2]) {
            const pokemon = side.active;
            if (!pokemon || pokemon.fainted) continue;
            if (pokemon.types.some((t) => SAND_IMMUNE.includes(t))) continue;
            pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 16)));
            this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] Sandstorm');
            this.checkFaint(pokemon);
          }
        }
      }
    }

    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active;
      if (!pokemon || pokemon.fainted) continue;

      // Status residuals.
      switch (pokemon.status) {
        case 'brn':
          pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 16)));
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] brn');
          break;
        case 'psn':
          pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 8)));
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] psn');
          break;
        case 'tox': {
          const turns = (pokemon.statusState.toxicTurns ?? 0) + 1;
          pokemon.statusState.toxicTurns = turns;
          pokemon.damage(Math.max(1, Math.floor((pokemon.maxhp * turns) / 16)));
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] psn');
          break;
        }
      }
      this.checkFaint(pokemon);
      if (pokemon.fainted) continue;

      // Leech Seed drains into the opposing active Pokémon.
      if (pokemon.hasVolatile('leechseed')) {
        const foe = (side.id === 'p1' ? this.sides.p2 : this.sides.p1).active;
        if (foe && !foe.fainted) {
          const drained = pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 8)));
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] Leech Seed');
          const healed = foe.heal(drained);
          if (healed > 0) {
            this.add('-heal', foe.activeIdent, foe.condition, '[silent]');
          }
          this.checkFaint(pokemon);
        }
      }
    }

    // Clear one-turn volatiles; break Protect chains that weren't extended.
    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active;
      if (!pokemon) continue;
      pokemon.removeVolatile('protect');
      pokemon.removeVolatile('flinch');
      if (!pokemon.removeVolatile('usedstall')) {
        pokemon.removeVolatile('stall');
      }
    }
  }

  private checkFaint(pokemon: BattlePokemon): void {
    if (!pokemon.fainted || pokemon.hasVolatile('faintemitted')) return;
    pokemon.addVolatile('faintemitted');
    this.add('faint', pokemon.activeIdent);
    this.checkWin();
  }

  private checkWin(): boolean {
    if (this.ended) return true;
    const p1Alive = this.sides.p1.hasRemainingPokemon();
    const p2Alive = this.sides.p2.hasRemainingPokemon();
    if (p1Alive && p2Alive) return false;
    this.ended = true;
    this.phase = 'ended';
    if (!p1Alive && !p2Alive) {
      this.add('tie');
    } else {
      this.winner = p1Alive ? this.sides.p1.name : this.sides.p2.name;
      this.add('win', this.winner);
    }
    return true;
  }

  /** Forfeit: the named side loses immediately. */
  forfeit(sideId: SideID): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'ended';
    const winnerSide = sideId === 'p1' ? this.sides.p2 : this.sides.p1;
    this.winner = winnerSide.name;
    this.add('-message', `${this.sides[sideId].name} forfeited.`);
    this.add('win', this.winner);
  }
}
