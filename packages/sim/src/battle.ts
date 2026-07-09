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

/** Abilities that set weather on switch-in. */
const WEATHER_SETTERS: Record<string, Exclude<WeatherID, ''>> = {
  Drizzle: 'raindance', Drought: 'sunnyday', 'Orichalcum Pulse': 'sunnyday',
  'Sand Stream': 'sandstorm', 'Snow Warning': 'snow',
};

/** Abilities that double Speed in their weather. */
const WEATHER_SPEED: Record<string, Exclude<WeatherID, ''>> = {
  'Swift Swim': 'raindance', Chlorophyll: 'sunnyday',
  'Sand Rush': 'sandstorm', 'Slush Rush': 'snow',
};

/** Ability-based immunities to major statuses. */
const STATUS_IMMUNE_ABILITY: Record<StatusID, string[]> = {
  par: ['Limber'],
  brn: ['Water Veil', 'Water Bubble', 'Thermal Exchange'],
  psn: ['Immunity'],
  tox: ['Immunity'],
  slp: ['Insomnia', 'Vital Spirit', 'Sweet Veil'],
  frz: ['Magma Armor'],
};

/** Type-boosting held items: itemId -> boosted type (x1.2). */
const TYPE_BOOST_ITEMS: Record<string, TypeName> = {
  charcoal: 'Fire', mysticwater: 'Water', magnet: 'Electric', miracleseed: 'Grass',
  nevermeltice: 'Ice', blackbelt: 'Fighting', poisonbarb: 'Poison', softsand: 'Ground',
  sharpbeak: 'Flying', twistedspoon: 'Psychic', silverpowder: 'Bug', hardstone: 'Rock',
  spelltag: 'Ghost', dragonfang: 'Dragon', blackglasses: 'Dark', metalcoat: 'Steel',
  fairyfeather: 'Fairy', silkscarf: 'Normal',
};

const CHOICE_ITEMS = new Set(['choiceband', 'choicespecs', 'choicescarf']);

function hasAbility(pokemon: BattlePokemon, ...abilities: string[]): boolean {
  return abilities.includes(pokemon.ability);
}

/** Magic Guard blocks all indirect damage. */
function guardsIndirect(pokemon: BattlePokemon): boolean {
  return pokemon.ability === 'Magic Guard';
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

  /** Per-turn info used by conditional moves (Sucker Punch). */
  private turnInfo: Partial<Record<'p1' | 'p2', { choseDamagingMove: boolean; moved: boolean }>> = {};

  private runTurn(): void {
    const actions: Action[] = [];
    this.turnInfo = {};
    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active!;
      const choice = side.choice!;
      pokemon.tookDamageThisTurn = false;
      let priority = 0;
      if (choice.type === 'switch') {
        priority = 100; // switches always resolve before moves
      } else if (choice.type === 'move') {
        const move = pokemon.charging?.move ?? this.moveForChoice(pokemon, choice);
        priority = move.priority;
        this.turnInfo[side.id] = {
          choseDamagingMove: move.category !== 'Status',
          moved: false,
        };
      }
      if (choice.type === 'move') {
        const move = pokemon.charging?.move ?? this.moveForChoice(pokemon, choice);
        // Prankster: status moves gain +1 priority.
        if (move.category === 'Status' && hasAbility(pokemon, 'Prankster')) priority += 1;
      }
      actions.push({
        side,
        pokemon,
        choice,
        priority,
        speed: this.effectiveSpe(pokemon),
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
        const info = this.turnInfo[action.side.id];
        if (info) info.moved = true;
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

  /** Speed with weather abilities, Choice Scarf, Quick Feet, Slow Start. */
  effectiveSpe(pokemon: BattlePokemon): number {
    let spe = pokemon.getStat('spe'); // includes boosts + paralysis
    const weatherAbility = WEATHER_SPEED[pokemon.ability];
    if (weatherAbility && this.weather === weatherAbility) spe *= 2;
    if (pokemon.itemId === 'choicescarf') spe = Math.floor(spe * 1.5);
    if (hasAbility(pokemon, 'Quick Feet') && pokemon.status) {
      spe = Math.floor(spe * 1.5);
      if (pokemon.status === 'par') spe *= 2; // undo the paralysis drop
    }
    if (pokemon.slowStartTurns > 0) spe = Math.floor(spe * 0.5);
    return spe;
  }

  // ------------------------------------------------------------------
  // Switching
  // ------------------------------------------------------------------

  private switchIn(side: Side, teamIndex: number): void {
    const outgoing = side.active;
    if (outgoing && !outgoing.fainted) {
      // Regenerator: heal 1/3 max HP on the way out.
      if (hasAbility(outgoing, 'Regenerator')) {
        outgoing.heal(Math.floor(outgoing.maxhp / 3));
      }
      outgoing.clearOnSwitchOut();
    }
    side.activeIndex = teamIndex;
    const incoming = side.active!;
    incoming.revealed = true;
    this.add('switch', incoming.activeIdent, incoming.details, incoming.condition);

    // Entry hazards (Heavy-Duty Boots and Magic Guard ignore them).
    if (side.sideConditions.has('stealthrock')
      && incoming.itemId !== 'heavydutyboots' && !guardsIndirect(incoming)) {
      const eff = typeEffectiveness('Rock', incoming.types);
      const damage = Math.max(1, Math.floor((incoming.maxhp * eff) / 8));
      incoming.damage(damage);
      this.add('-damage', incoming.activeIdent, incoming.condition, '[from] Stealth Rock');
      this.checkFaint(incoming);
    }
    if (incoming.fainted) return;

    const foe = (side.id === 'p1' ? this.sides.p2 : this.sides.p1).active;

    // Entry abilities.
    if (hasAbility(incoming, 'Intimidate') && foe && !foe.fainted) {
      this.add('-ability', incoming.activeIdent, 'Intimidate');
      this.applyBoosts(foe, { atk: -1 });
    }
    const setWeather = WEATHER_SETTERS[incoming.ability];
    if (setWeather && this.weather !== setWeather) {
      this.add('-ability', incoming.activeIdent, incoming.ability);
      this.weather = setWeather;
      this.weatherTurns = 5;
      this.add('-weather', WEATHER_NAMES[setWeather]);
    }
    if (hasAbility(incoming, 'Intrepid Sword')) {
      this.add('-ability', incoming.activeIdent, 'Intrepid Sword');
      this.applyBoosts(incoming, { atk: 1 });
    }
    if (hasAbility(incoming, 'Dauntless Shield')) {
      this.add('-ability', incoming.activeIdent, 'Dauntless Shield');
      this.applyBoosts(incoming, { def: 1 });
    }
    if (hasAbility(incoming, 'Download') && foe && !foe.fainted) {
      this.add('-ability', incoming.activeIdent, 'Download');
      this.applyBoosts(incoming, foe.getStat('def') <= foe.getStat('spd') ? { atk: 1 } : { spa: 1 });
    }
    if (hasAbility(incoming, 'Slow Start')) {
      incoming.slowStartTurns = 5;
      this.add('-start', incoming.activeIdent, 'ability: Slow Start');
    }
    if (incoming.itemId === 'airballoon') {
      this.add('-item', incoming.activeIdent, 'Air Balloon');
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
    // Recharge turn (the price of Hyper Beam / Giga Impact).
    if (attacker.hasVolatile('mustrecharge')) {
      attacker.removeVolatile('mustrecharge');
      this.add('cant', attacker.activeIdent, 'recharge');
      return;
    }

    // Releasing a charged two-turn move (Sky Attack, Solar Beam...)?
    let move: MoveData;
    let releasing = false;
    if (attacker.charging) {
      move = attacker.charging.move;
      attacker.charging = null;
      releasing = true;
    } else {
      move = this.moveForChoice(attacker, choice);
    }

    if (!this.beforeMove(attacker)) return;

    // Focus Punch: fails if the user was hit earlier this turn.
    if (move.id === 'focuspunch' && attacker.tookDamageThisTurn) {
      this.add('cant', attacker.activeIdent, 'Focus Punch');
      return;
    }

    // Deduct PP (charge moves pay on the charging turn only). Pressure
    // on the target drains one extra PP.
    if (!releasing && choice.moveIndex >= 0) {
      const slot = attacker.moveSlots[choice.moveIndex]!;
      slot.pp = Math.max(0, slot.pp - 1);
      if (hasAbility(defender, 'Pressure') && move.target !== 'self') {
        slot.pp = Math.max(0, slot.pp - 1);
      }
    }

    // Choice items lock the holder into its first move until it switches.
    if (CHOICE_ITEMS.has(attacker.itemId) && !attacker.lockedMoveId && move.id !== 'struggle') {
      attacker.lockedMoveId = move.id;
    }

    this.add('move', attacker.activeIdent, move.name, defender.activeIdent);

    // Two-turn moves spend this turn charging (Solar Beam skips it in sun,
    // Power Herb is consumed to skip it outright).
    if (!releasing && move.flags.charge) {
      let skipCharge = move.id === 'solarbeam' && this.weather === 'sunnyday';
      if (!skipCharge && attacker.itemId === 'powerherb') {
        attacker.consumeItem();
        this.add('-enditem', attacker.activeIdent, 'Power Herb');
        skipCharge = true;
      }
      if (!skipCharge) {
        this.add('-prepare', attacker.activeIdent, move.name);
        attacker.charging = { move, slotIndex: choice.moveIndex };
        return;
      }
    }

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

    // Sucker Punch: only works if the target is about to attack.
    if (move.id === 'suckerpunch' || move.id === 'thunderclap') {
      const foeInfo = this.turnInfo[attacker.sideId === 'p1' ? 'p2' : 'p1'];
      if (!foeInfo || foeInfo.moved || !foeInfo.choseDamagingMove) {
        this.add('-fail', attacker.activeIdent);
        return;
      }
    }

    let outcome: 'hit' | 'blocked' | 'missed' | 'immune' | 'status' = 'status';
    if (move.flags.protect && defender.hasVolatile('protect') && move.target !== 'self') {
      this.add('-activate', defender.activeIdent, 'move: Protect');
      outcome = 'blocked';
    } else if (!this.accuracyCheck(attacker, defender, move)) {
      this.add('-miss', attacker.activeIdent, defender.activeIdent);
      outcome = 'missed';
    } else if (move.category === 'Status') {
      this.runStatusMove(attacker, defender, move);
    } else {
      outcome = this.runDamagingMove(attacker, defender, move);
    }

    // Self-destructing moves: the user faints whenever the move executes
    // (hit, blocked, or missed) — but not against an immune target.
    if (move.selfDestruct && outcome !== 'immune' && !attacker.fainted) {
      attacker.damage(attacker.hp);
      this.checkFaint(attacker);
    }

    // Recharge moves cost the next turn (only when they actually hit).
    if (move.flags.recharge && outcome === 'hit' && !attacker.fainted) {
      attacker.addVolatile('mustrecharge');
      this.add('-mustrecharge', attacker.activeIdent);
    }
  }

  /** Sleep/freeze/flinch/confusion/paralysis gates. True = the move proceeds. */
  private beforeMove(pokemon: BattlePokemon): boolean {
    // Truant: loafs around every other turn.
    if (hasAbility(pokemon, 'Truant')) {
      if (pokemon.loafing) {
        pokemon.loafing = false;
        this.add('cant', pokemon.activeIdent, 'ability: Truant');
        return false;
      }
      pokemon.loafing = true;
    }
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

  private runDamagingMove(attacker: BattlePokemon, defender: BattlePokemon, move: MoveData): 'hit' | 'immune' {
    const isStruggle = move.id === 'struggle';

    // Protean/Libero: the user becomes the move's type before it fires.
    if (!isStruggle && hasAbility(attacker, 'Protean', 'Libero')
      && !(attacker.types.length === 1 && attacker.types[0] === move.type)) {
      attacker.types = [move.type];
      this.add('-start', attacker.activeIdent, 'typechange', move.type, `[from] ability: ${attacker.ability}`);
    }

    // Ability-based immunities and absorbs.
    if (!isStruggle && this.checkAbilityImmunity(attacker, defender, move)) return 'immune';
    if (move.flags.sound && hasAbility(defender, 'Soundproof')) {
      this.add('-immune', defender.activeIdent, '[from] ability: Soundproof');
      return 'immune';
    }
    if (move.flags.bullet && hasAbility(defender, 'Bulletproof')) {
      this.add('-immune', defender.activeIdent, '[from] ability: Bulletproof');
      return 'immune';
    }
    if (move.type === 'Ground' && defender.itemId === 'airballoon') {
      this.add('-immune', defender.activeIdent, '[from] item: Air Balloon');
      return 'immune';
    }

    // Type immunity (fixed-damage and OHKO moves still respect immunity).
    const eff = isStruggle ? 1 : typeEffectiveness(move.type, defender.types);
    if (eff === 0) {
      this.add('-immune', defender.activeIdent);
      return 'immune';
    }
    // Wonder Guard: only super-effective moves deal damage.
    if (hasAbility(defender, 'Wonder Guard') && eff <= 1) {
      this.add('-immune', defender.activeIdent, '[from] ability: Wonder Guard');
      return 'immune';
    }

    const sheerForce = hasAbility(attacker, 'Sheer Force') && !!move.secondaries;

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

      if (move.id === 'superfang' || move.id === 'ruination' || move.id === 'naturesmadness') {
        // Halve the target's current HP.
        damage = Math.max(1, Math.floor(defender.hp / 2));
      } else if (move.ohko) {
        damage = defender.hp;
      } else if (move.damage === 'level') {
        damage = attacker.level;
      } else if (typeof move.damage === 'number') {
        damage = move.damage;
      } else {
        crit = this.prng.randomChance(1, 24);

        // Moves with computed base power.
        let basePower = move.basePower;
        switch (move.id) {
          case 'waterspout': case 'eruption': case 'dragonenergy':
            basePower = Math.max(1, Math.floor((150 * attacker.hp) / attacker.maxhp));
            break;
          case 'gyroball':
            basePower = Math.min(150,
              Math.floor((25 * defender.getStat('spe')) / Math.max(1, attacker.getStat('spe'))) + 1);
            break;
          case 'electroball': {
            const ratio = attacker.getStat('spe') / Math.max(1, defender.getStat('spe'));
            basePower = ratio >= 4 ? 150 : ratio >= 3 ? 120 : ratio >= 2 ? 80 : ratio >= 1 ? 60 : 40;
            break;
          }
          case 'grassknot': case 'lowkick': {
            const kg = defender.species.weightkg ?? 50;
            basePower = kg >= 200 ? 120 : kg >= 100 ? 100 : kg >= 50 ? 80 : kg >= 25 ? 60 : kg >= 10 ? 40 : 20;
            break;
          }
          case 'heavyslam': case 'heatcrash': {
            const ratio = (attacker.species.weightkg ?? 50) / Math.max(0.1, defender.species.weightkg ?? 50);
            basePower = ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
            break;
          }
        }
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
        // Offensive ability power modifiers.
        if (hasAbility(attacker, 'Technician') && basePower <= 60) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Tough Claws') && move.flags.contact) basePower = Math.floor(basePower * 1.3);
        if (hasAbility(attacker, 'Strong Jaw') && move.flags.bite) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Iron Fist') && move.flags.punch) basePower = Math.floor(basePower * 1.2);
        if (hasAbility(attacker, 'Sharpness') && move.flags.slicing) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Sand Force') && this.weather === 'sandstorm'
          && (move.type === 'Rock' || move.type === 'Ground' || move.type === 'Steel')) {
          basePower = Math.floor(basePower * 1.3);
        }
        if (sheerForce) basePower = Math.floor(basePower * 1.3);
        // Held item power modifiers.
        const typeBoost = TYPE_BOOST_ITEMS[attacker.itemId];
        if (typeBoost === move.type) basePower = Math.floor(basePower * 1.2);
        if (attacker.itemId === 'muscleband' && move.category === 'Physical') basePower = Math.floor(basePower * 1.1);
        if (attacker.itemId === 'wiseglasses' && move.category === 'Special') basePower = Math.floor(basePower * 1.1);

        let attackStat = move.overrideOffensiveStat === 'def'
          ? attacker.getStat('def', { ignoreBoosts: crit && attacker.boosts.def < 0 }) // Body Press
          : move.category === 'Physical'
            ? attacker.getStat('atk', { ignoreBoosts: crit && attacker.boosts.atk < 0 })
            : attacker.getStat('spa', { ignoreBoosts: crit && attacker.boosts.spa < 0 });
        if (move.category === 'Physical' && hasAbility(attacker, 'Huge Power', 'Pure Power')) {
          attackStat *= 2;
        }
        const guts = hasAbility(attacker, 'Guts') && attacker.status !== '';
        if (guts && move.category === 'Physical') {
          attackStat = Math.floor(attackStat * 1.5);
        }
        if (move.category === 'Physical') {
          if (attacker.itemId === 'choiceband') attackStat = Math.floor(attackStat * 1.5);
          if (attacker.slowStartTurns > 0) attackStat = Math.floor(attackStat * 0.5);
          if (hasAbility(attacker, 'Toxic Boost') && (attacker.status === 'psn' || attacker.status === 'tox')) {
            attackStat = Math.floor(attackStat * 1.5);
          }
        } else {
          if (attacker.itemId === 'choicespecs') attackStat = Math.floor(attackStat * 1.5);
          if (hasAbility(attacker, 'Flare Boost') && attacker.status === 'brn') {
            attackStat = Math.floor(attackStat * 1.5);
          }
          if (hasAbility(attacker, 'Solar Power') && this.weather === 'sunnyday') {
            attackStat = Math.floor(attackStat * 1.5);
          }
        }
        if (attacker.itemId === 'lightball' && attacker.species.id === 'pikachu') {
          attackStat *= 2;
        }

        let defenseStat = move.category === 'Physical'
          ? defender.getStat('def', { ignoreBoosts: crit && defender.boosts.def > 0 })
          : defender.getStat('spd', { ignoreBoosts: crit && defender.boosts.spd > 0 });
        if (move.category === 'Physical') {
          if (hasAbility(defender, 'Fur Coat')) defenseStat *= 2;
          if (hasAbility(defender, 'Marvel Scale') && defender.status) defenseStat = Math.floor(defenseStat * 1.5);
          if (defender.itemId === 'eviolite' && defender.species.evos?.length) defenseStat = Math.floor(defenseStat * 1.5);
        } else {
          if (defender.itemId === 'assaultvest') defenseStat = Math.floor(defenseStat * 1.5);
          if (defender.itemId === 'eviolite' && defender.species.evos?.length) defenseStat = Math.floor(defenseStat * 1.5);
        }

        const result = calculateDamage({
          level: attacker.level,
          basePower,
          category: move.category as 'Physical' | 'Special',
          moveType: move.type,
          attackStat,
          defenseStat,
          attackerTypes: isStruggle ? [] : attacker.types,
          defenderTypes: isStruggle ? [] : defender.types,
          isCrit: crit,
          isBurned: attacker.status === 'brn' && !guts, // Guts ignores burn's halving
          prng: this.prng,
          weather: this.weather,
          stabMultiplier: hasAbility(attacker, 'Adaptability') ? 2 : 1.5,
        }).damage;
        damage = result;

        // Final damage multipliers.
        if (hasAbility(defender, 'Multiscale', 'Shadow Shield') && defender.hp === defender.maxhp) {
          damage = Math.floor(damage * 0.5);
        }
        if (hasAbility(defender, 'Ice Scales') && move.category === 'Special') {
          damage = Math.floor(damage * 0.5);
        }
        if (hasAbility(defender, 'Filter', 'Solid Rock', 'Prism Armor') && eff > 1) {
          damage = Math.floor(damage * 0.75);
        }
        if (attacker.itemId === 'expertbelt' && eff > 1) damage = Math.floor(damage * 1.2);
        if (attacker.itemId === 'lifeorb') damage = Math.floor(damage * 1.3);
        if (damage < 1) damage = 1;
      }

      // Sturdy / Focus Sash: survive any hit from full HP with 1 HP.
      if (defender.hp === defender.maxhp && damage >= defender.hp
        && !defender.hasVolatile('substitute')) {
        if (hasAbility(defender, 'Sturdy')) {
          this.add('-ability', defender.activeIdent, 'Sturdy');
          damage = defender.hp - 1;
        } else if (defender.itemId === 'focussash') {
          defender.consumeItem();
          this.add('-enditem', defender.activeIdent, 'Focus Sash');
          damage = defender.hp - 1;
        }
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
      if (dealt > 0) {
        defender.tookDamageThisTurn = true; // breaks Focus Punch
        if (defender.itemId === 'airballoon') {
          defender.consumeItem();
          this.add('-enditem', defender.activeIdent, 'Air Balloon');
        }
      }

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
    } else if (move.recoil && totalDealt > 0 && !attacker.fainted
      && !guardsIndirect(attacker) && !hasAbility(attacker, 'Rock Head')) {
      attacker.damage(Math.max(1, Math.floor((totalDealt * move.recoil[0]) / move.recoil[1])));
      this.add('-damage', attacker.activeIdent, attacker.condition, '[from] recoil');
    }

    // Life Orb: the power boost costs 1/10 max HP per attack.
    if (attacker.itemId === 'lifeorb' && totalDealt > 0 && !attacker.fainted && !guardsIndirect(attacker)) {
      attacker.damage(Math.max(1, Math.floor(attacker.maxhp / 10)));
      this.add('-damage', attacker.activeIdent, attacker.condition, '[from] item: Life Orb');
    }

    // Secondary effects (blocked by a Substitute; erased by Sheer Force;
    // chance doubled by Serene Grace).
    if (move.secondaries && totalDealt > 0 && !defender.fainted
      && !defender.hasVolatile('substitute') && !sheerForce
      && !hasAbility(defender, 'Shield Dust')) {
      const chanceMultiplier = hasAbility(attacker, 'Serene Grace') ? 2 : 1;
      for (const secondary of move.secondaries) {
        if (!this.prng.randomChance(Math.min(100, secondary.chance * chanceMultiplier), 100)) continue;
        if (secondary.status) this.trySetStatus(defender, secondary.status, true);
        if (secondary.volatileStatus) this.tryAddVolatile(defender, secondary.volatileStatus, attacker, true);
        if (secondary.boosts) this.applyBoosts(defender, secondary.boosts);
        if (secondary.self?.boosts) this.applyBoosts(attacker, secondary.self.boosts);
      }
    }

    // Contact consequences for the attacker.
    if (move.flags.contact && totalDealt > 0 && !attacker.fainted) {
      if (hasAbility(defender, 'Rough Skin', 'Iron Barbs') && !guardsIndirect(attacker)) {
        attacker.damage(Math.max(1, Math.floor(attacker.maxhp / 8)));
        this.add('-damage', attacker.activeIdent, attacker.condition, `[from] ability: ${defender.ability}`);
      }
      if (defender.itemId === 'rockyhelmet' && !guardsIndirect(attacker)) {
        attacker.damage(Math.max(1, Math.floor(attacker.maxhp / 6)));
        this.add('-damage', attacker.activeIdent, attacker.condition, '[from] item: Rocky Helmet');
      }
      if (hasAbility(defender, 'Flame Body') && this.prng.randomChance(3, 10)) {
        this.add('-ability', defender.activeIdent, 'Flame Body');
        this.trySetStatus(attacker, 'brn', true);
      }
      if (hasAbility(defender, 'Poison Point') && this.prng.randomChance(3, 10)) {
        this.add('-ability', defender.activeIdent, 'Poison Point');
        this.trySetStatus(attacker, 'psn', true);
      }
      if (hasAbility(defender, 'Effect Spore') && this.prng.randomChance(3, 10)) {
        this.add('-ability', defender.activeIdent, 'Effect Spore');
        this.trySetStatus(attacker, this.prng.sample(['slp', 'par', 'psn'] as const), true);
      }
      if (hasAbility(defender, 'Aftermath') && defender.fainted && !guardsIndirect(attacker)) {
        this.add('-ability', defender.activeIdent, 'Aftermath');
        attacker.damage(Math.max(1, Math.floor(attacker.maxhp / 4)));
        this.add('-damage', attacker.activeIdent, attacker.condition, '[from] ability: Aftermath');
      }
    }

    // Justified: taking a Dark move raises Attack.
    if (move.type === 'Dark' && totalDealt > 0 && !defender.fainted && hasAbility(defender, 'Justified')) {
      this.add('-ability', defender.activeIdent, 'Justified');
      this.applyBoosts(defender, { atk: 1 });
    }

    // Weakness Policy: +2 Atk/SpA when struck super-effectively.
    if (eff > 1 && totalDealt > 0 && !defender.fainted && defender.itemId === 'weaknesspolicy') {
      defender.consumeItem();
      this.add('-enditem', defender.activeIdent, 'Weakness Policy');
      this.applyBoosts(defender, { atk: 2, spa: 2 });
    }

    // Sitrus Berry: heal 1/4 when knocked to half HP or below.
    if (!defender.fainted && defender.itemId === 'sitrusberry'
      && defender.hp <= Math.floor(defender.maxhp / 2)) {
      defender.consumeItem();
      this.add('-enditem', defender.activeIdent, 'Sitrus Berry');
      defender.heal(Math.floor(defender.maxhp / 4));
      this.add('-heal', defender.activeIdent, defender.condition, '[from] item: Sitrus Berry');
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
    // Moxie-style abilities: a KO fuels the attacker.
    if (defender.fainted && !attacker.fainted) {
      if (hasAbility(attacker, 'Moxie', 'Chilling Neigh')) {
        this.add('-ability', attacker.activeIdent, attacker.ability);
        this.applyBoosts(attacker, { atk: 1 });
      } else if (hasAbility(attacker, 'Grim Neigh')) {
        this.add('-ability', attacker.activeIdent, 'Grim Neigh');
        this.applyBoosts(attacker, { spa: 1 });
      }
    }
    this.checkFaint(attacker);
    return 'hit';
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
    const abilityImmune = hasAbility(target, ...(STATUS_IMMUNE_ABILITY[status] ?? []));
    if (target.status || isStatusImmune(target, status) || abilityImmune) {
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
    // Lum Berry cures any status the moment it lands.
    if (target.itemId === 'lumberry') {
      target.cureStatus();
      target.consumeItem();
      this.add('-enditem', target.activeIdent, 'Lum Berry');
      this.add('-curestatus', target.activeIdent, status, '[from] item: Lum Berry');
      return false;
    }
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
    if (id === 'confusion' && hasAbility(target, 'Own Tempo')) {
      if (!silent) this.add('-immune', target.activeIdent, '[from] ability: Own Tempo');
      return false;
    }
    if (id === 'flinch' && hasAbility(target, 'Inner Focus')) {
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
            if (hasAbility(pokemon, 'Sand Force', 'Sand Rush', 'Sand Veil', 'Overcoat')
              || guardsIndirect(pokemon)) continue;
            pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 16)));
            this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] Sandstorm');
            this.checkFaint(pokemon);
          }
        }
        // Weather-fed healing/damage abilities.
        for (const side of [this.sides.p1, this.sides.p2]) {
          const pokemon = side.active;
          if (!pokemon || pokemon.fainted) continue;
          if (this.weather === 'raindance' && hasAbility(pokemon, 'Rain Dish')
            && pokemon.heal(Math.floor(pokemon.maxhp / 16)) > 0) {
            this.add('-heal', pokemon.activeIdent, pokemon.condition, '[from] ability: Rain Dish');
          }
          if (this.weather === 'raindance' && hasAbility(pokemon, 'Dry Skin')
            && pokemon.heal(Math.floor(pokemon.maxhp / 8)) > 0) {
            this.add('-heal', pokemon.activeIdent, pokemon.condition, '[from] ability: Dry Skin');
          }
          if (this.weather === 'sunnyday' && hasAbility(pokemon, 'Dry Skin', 'Solar Power')
            && !guardsIndirect(pokemon)) {
            pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 8)));
            this.add('-damage', pokemon.activeIdent, pokemon.condition, `[from] ability: ${pokemon.ability}`);
            this.checkFaint(pokemon);
          }
          if (this.weather === 'snow' && hasAbility(pokemon, 'Ice Body')
            && pokemon.heal(Math.floor(pokemon.maxhp / 16)) > 0) {
            this.add('-heal', pokemon.activeIdent, pokemon.condition, '[from] ability: Ice Body');
          }
        }
      }
    }

    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active;
      if (!pokemon || pokemon.fainted) continue;

      // Held-item residuals.
      if (pokemon.itemId === 'leftovers' && pokemon.heal(Math.floor(pokemon.maxhp / 16)) > 0) {
        this.add('-heal', pokemon.activeIdent, pokemon.condition, '[from] item: Leftovers');
      }
      if (pokemon.itemId === 'blacksludge') {
        if (pokemon.types.includes('Poison')) {
          if (pokemon.heal(Math.floor(pokemon.maxhp / 16)) > 0) {
            this.add('-heal', pokemon.activeIdent, pokemon.condition, '[from] item: Black Sludge');
          }
        } else if (!guardsIndirect(pokemon)) {
          pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 8)));
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] item: Black Sludge');
        }
      }

      // Status residuals (Poison Heal converts, Magic Guard blocks).
      switch (pokemon.status) {
        case 'brn':
          if (guardsIndirect(pokemon)) break;
          pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 16)));
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] brn');
          break;
        case 'psn':
        case 'tox': {
          if (hasAbility(pokemon, 'Poison Heal')) {
            if (pokemon.heal(Math.floor(pokemon.maxhp / 8)) > 0) {
              this.add('-heal', pokemon.activeIdent, pokemon.condition, '[from] ability: Poison Heal');
            }
            break;
          }
          if (guardsIndirect(pokemon)) break;
          if (pokemon.status === 'psn') {
            pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 8)));
          } else {
            const turns = (pokemon.statusState.toxicTurns ?? 0) + 1;
            pokemon.statusState.toxicTurns = turns;
            pokemon.damage(Math.max(1, Math.floor((pokemon.maxhp * turns) / 16)));
          }
          this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] psn');
          break;
        }
      }
      this.checkFaint(pokemon);
      if (pokemon.fainted) continue;

      // Flame/Toxic Orb inflict their status at the end of the turn.
      if (pokemon.itemId === 'flameorb' && !pokemon.status) {
        this.trySetStatus(pokemon, 'brn', true);
      } else if (pokemon.itemId === 'toxicorb' && !pokemon.status) {
        this.trySetStatus(pokemon, 'tox', true);
      }
      // Speed Boost / Slow Start countdown.
      if (hasAbility(pokemon, 'Speed Boost') && pokemon.boosts.spe < 6) {
        this.add('-ability', pokemon.activeIdent, 'Speed Boost');
        this.applyBoosts(pokemon, { spe: 1 });
      }
      if (pokemon.slowStartTurns > 0) {
        pokemon.slowStartTurns--;
        if (pokemon.slowStartTurns === 0) {
          this.add('-end', pokemon.activeIdent, 'ability: Slow Start');
        }
      }

      // Leech Seed drains into the opposing active Pokémon.
      if (pokemon.hasVolatile('leechseed') && !guardsIndirect(pokemon)) {
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
