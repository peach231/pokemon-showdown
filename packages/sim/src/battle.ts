import { PRNG, type PRNGSeed } from './prng.js';
import { BattlePokemon, type ResolvedPokemonSet } from './pokemon.js';
import { Side, type SideID, type Choice, type RequestJSON } from './side.js';
import { calculateDamage } from './damage.js';
import { typeEffectiveness, moveEffectiveness } from './typechart.js';
import { addBoost, emptyBoosts } from './stats.js';
import { accuracyBoostMultiplier } from './stats.js';
import type {
  MoveData, StatusID, BoostID, BoostsTable, StatID, TypeName, WeatherID, TerrainID,
} from './types.js';

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

/**
 * Stat drops the dex does not express declaratively because Showdown codes
 * them in onHit handlers. Without these the moves resolve as no-ops.
 */
const CODED_TARGET_BOOSTS: Record<string, Partial<BoostsTable>> = {
  partingshot: { atk: -1, spa: -1 },
};

/** -ate abilities: Normal moves become another type and gain 20%. */
const ATE_ABILITIES: Record<string, TypeName> = {
  Pixilate: 'Fairy', Refrigerate: 'Ice', Aerilate: 'Flying', Galvanize: 'Electric',
};

/**
 * Signature items that boost two types for one species line, the way the
 * orbs/crystals/masks do in the real games.
 */
const SIGNATURE_ITEMS: Record<string, { species: string[]; types: TypeName[]; mult: number }> = {
  adamantcrystal: { species: ['dialga', 'dialgaorigin'], types: ['Dragon', 'Steel'], mult: 1.2 },
  lustrousglobe: { species: ['palkia', 'palkiaorigin'], types: ['Dragon', 'Water'], mult: 1.2 },
  griseouscore: { species: ['giratina', 'giratinaorigin'], types: ['Dragon', 'Ghost'], mult: 1.2 },
  adamantorb: { species: ['dialga'], types: ['Dragon', 'Steel'], mult: 1.2 },
  lustrousorb: { species: ['palkia'], types: ['Dragon', 'Water'], mult: 1.2 },
  griseousorb: { species: ['giratina'], types: ['Dragon', 'Ghost'], mult: 1.2 },
  souldew: { species: ['latios', 'latias'], types: ['Dragon', 'Psychic'], mult: 1.2 },
  rustedsword: { species: ['zacian', 'zaciancrowned'], types: ['Steel'], mult: 1.2 },
  rustedshield: { species: ['zamazenta', 'zamazentacrowned'], types: ['Steel'], mult: 1.2 },
  wellspringmask: { species: ['ogerponwellspring'], types: ['Grass', 'Water'], mult: 1.2 },
  hearthflamemask: { species: ['ogerponhearthflame'], types: ['Grass', 'Fire'], mult: 1.2 },
  cornerstonemask: { species: ['ogerponcornerstone'], types: ['Grass', 'Rock'], mult: 1.2 },
};

/** Abilities that boost one attacking type. */
const TYPE_SPECIALISTS: Record<string, { type: TypeName; mult: number }> = {
  "Dragon's Maw": { type: 'Dragon', mult: 1.5 },
  Transistor: { type: 'Electric', mult: 1.3 },
  'Rocky Payload': { type: 'Rock', mult: 1.5 },
  Steelworker: { type: 'Steel', mult: 1.5 },
  'Steely Spirit': { type: 'Steel', mult: 1.5 },
};

/**
 * Abilities that exist in the engine but genuinely do nothing in this format:
 *   Power Spot   — boosts an ALLY's moves; there are no allies in singles.
 *   Gulp Missile — needs Cramorant's Surf/Dive forme cycle, which this engine
 *                  does not model; it would otherwise be a free extra hit.
 * Named here so the coverage audit reports them as considered, not forgotten.
 */
const INERT_IN_SINGLES: ReadonlySet<string> = new Set([
  // Need an ally on the field, which this format never has.
  'Power Spot', 'Battery', 'Friend Guard', 'Healer', 'Symbiosis', 'Telepathy',
  'Plus', 'Minus', 'Commander', 'Costar', 'Curious Medicine', 'Hospitality',
  'Magnetic Flux', 'Sweet Veil',
  // Purely out-of-battle or flavour, with no battle effect to model.
  'Honey Gather', 'Illuminate', 'Pickup', 'Run Away', 'Ball Fetch',
  'Happy Hour', 'Stench',
  // Need forme machinery this engine deliberately does not model.
  'Gulp Missile', 'Power Construct', 'Tera Shell', 'Teraform Zero',
  'Embody Aspect (Teal)', 'Embody Aspect (Wellspring)',
  'Embody Aspect (Hearthflame)', 'Embody Aspect (Cornerstone)',
]);

/** Moves that always land a critical hit. */
const ALWAYS_CRIT: ReadonlySet<string> = new Set([
  'stormthrow', 'frostbreath', 'zippyzap', 'surgingstrikes', 'wickedblow',
  'flowertrick',
]);

/** Fling's base power for the items this game offers. */
const FLING_POWER: Record<string, number> = {
  ironball: 130, rockyhelmet: 60, assaultvest: 80, eviolite: 40, lifeorb: 30,
  choiceband: 10, choicescarf: 10, choicespecs: 10, leftovers: 10,
  heavydutyboots: 80, focussash: 10, weaknesspolicy: 80, sitrusberry: 10,
  lumberry: 10, chestoberry: 10, leppaberry: 10, custapberry: 10,
  lightclay: 30, terrainextender: 60, boosterenergy: 30, loadeddice: 30,
  widelens: 10, whiteherb: 10, throatspray: 30, punchingglove: 30,
  airballoon: 10, blacksludge: 30, flameorb: 30, toxicorb: 30, shedshell: 10,
};

/** Arceus plates and Silvally memories, keyed by item id. */
const PLATE_TYPES: Record<string, TypeName> = {
  flameplate: 'Fire', splashplate: 'Water', zapplate: 'Electric', meadowplate: 'Grass',
  icicleplate: 'Ice', fistplate: 'Fighting', toxicplate: 'Poison', earthplate: 'Ground',
  skyplate: 'Flying', mindplate: 'Psychic', insectplate: 'Bug', stoneplate: 'Rock',
  spookyplate: 'Ghost', dracoplate: 'Dragon', dreadplate: 'Dark', ironplate: 'Steel',
  pixieplate: 'Fairy',
  firememory: 'Fire', watermemory: 'Water', electricmemory: 'Electric',
  grassmemory: 'Grass', icememory: 'Ice', fightingmemory: 'Fighting',
  poisonmemory: 'Poison', groundmemory: 'Ground', flyingmemory: 'Flying',
  psychicmemory: 'Psychic', bugmemory: 'Bug', rockmemory: 'Rock',
  ghostmemory: 'Ghost', dragonmemory: 'Dragon', darkmemory: 'Dark',
  steelmemory: 'Steel', fairymemory: 'Fairy',
};

/** Abilities Trace refuses to copy. */
const UNTRACEABLE: ReadonlySet<string> = new Set([
  'Trace', 'Multitype', 'Illusion', 'Imposter', 'Zen Mode', 'Stance Change',
  'Power of Alchemy', 'Receiver', 'Disguise', 'Ice Face', 'Zero to Hero',
  'Battle Bond', 'Comatose', 'Shields Down', 'Schooling', 'Hunger Switch',
  'RKS System', 'Tera Shift', 'Protosynthesis', 'Quark Drive', 'Forecast',
  'Flower Gift', 'As One (Glastrier)', 'As One (Spectrier)',
]);

/** Abilities that set terrain on switch-in. */
const TERRAIN_SETTERS: Record<string, Exclude<TerrainID, ''>> = {
  'Electric Surge': 'electricterrain',
  'Hadron Engine': 'electricterrain',
  'Grassy Surge': 'grassyterrain',
  'Misty Surge': 'mistyterrain',
  'Psychic Surge': 'psychicterrain',
  'Seed Sower': 'grassyterrain',
};

const TERRAIN_NAMES: Record<Exclude<TerrainID, ''>, string> = {
  electricterrain: 'Electric Terrain',
  grassyterrain: 'Grassy Terrain',
  mistyterrain: 'Misty Terrain',
  psychicterrain: 'Psychic Terrain',
};

/** Terrain boosts its own type for grounded users. */
const TERRAIN_BOOST_TYPE: Record<Exclude<TerrainID, ''>, TypeName> = {
  electricterrain: 'Electric',
  grassyterrain: 'Grass',
  mistyterrain: 'Fairy',   // Misty halves Dragon instead; handled separately
  psychicterrain: 'Psychic',
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

/** True if this move makes contact for the purposes of contact abilities. */
function makesContact(attacker: BattlePokemon, move: MoveData): boolean {
  if (!move.flags.contact) return false;
  if (hasAbility(attacker, 'Long Reach')) return false;
  if (attacker.itemId === 'punchingglove' && move.flags.punch) return false;
  return true;
}

/** Klutz and Magic Room switch a holder's item off entirely. */
function itemActive(pokemon: BattlePokemon): boolean {
  return !hasAbility(pokemon, 'Klutz');
}

/**
 * Terrain only touches Pokémon standing ON the ground: Flying types, Levitate
 * and an Air Balloon all float above it.
 */
function isGrounded(pokemon: BattlePokemon, gravity = false): boolean {
  if (gravity) return true; // Gravity drags everything down to earth
  if (pokemon.hasVolatile('magnetrise')) return false;
  if (pokemon.itemId === 'airballoon') return false;
  if (hasAbility(pokemon, 'Levitate')) return false;
  return !pokemon.types.includes('Flying');
}

/** A move this Pokemon knows, by id (Copycat / Mimic / Sketch). */
function getMoveById(pokemon: BattlePokemon, id: string): MoveData | null {
  return pokemon.moveSlots.find((m) => m.id === id)?.move ?? null;
}

/** The type of a move this Pokemon knows, for Conversion 2. */
function getMoveType(pokemon: BattlePokemon, id: string): TypeName | null {
  return getMoveById(pokemon, id)?.type ?? null;
}

/** True the first time an Illusion holder takes a hit (the disguise drops). */
function dealt0Illusion(pokemon: BattlePokemon): boolean {
  return !!pokemon.illusionOf;
}

/** Mold Breaker and friends switch off the defender's ability for one move. */
function breaksMold(attacker: BattlePokemon): boolean {
  return hasAbility(attacker, 'Mold Breaker', 'Teravolt', 'Turboblaze');
}

/**
 * The defender's ability as the ATTACKER sees it: blank when the attacker
 * breaks moulds, so every defensive ability check below falls through.
 */
function defenderHasAbility(
  attacker: BattlePokemon, defender: BattlePokemon, ...abilities: string[]
): boolean {
  if (breaksMold(attacker)) return false;
  return abilities.includes(defender.ability);
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
  terrain: TerrainID = '';
  terrainTurns = 0;
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
    } else if (this.selfSwitchSide) {
      this.commitSelfSwitch();
    } else if (this.sides.p1.requestState === 'switch' || this.sides.p2.requestState === 'switch') {
      this.commitFaintReplacements();
    } else {
      this.runTurn();
    }
  }

  /**
   * Shadow Tag / Arena Trap / Magnet Pull pin the opposing Pokémon in place.
   * Re-evaluated every turn, because the trapper may have left.
   */
  private updateTrapping(): void {
    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active;
      if (!pokemon) continue;
      pokemon.removeVolatile('trapped');
      const foe = (side.id === 'p1' ? this.sides.p2 : this.sides.p1).active;
      if (!foe || foe.fainted) continue;
      const trapped =
        this.fairyLockTurns > 0
        || (hasAbility(foe, 'Shadow Tag') && !hasAbility(pokemon, 'Shadow Tag'))
        || (hasAbility(foe, 'Arena Trap') && isGrounded(pokemon, this.gravityTurns > 0))
        || (hasAbility(foe, 'Magnet Pull') && pokemon.types.includes('Steel'));
      if (trapped && pokemon.itemId !== 'shedshell') pokemon.addVolatile('trapped');
    }
  }

  private newRequestWave(kind: 'teampreview' | 'move'): void {
    if (kind === 'move') this.updateTrapping();
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
      this.switchIn(side, 0, false, /* deferEntry */ true);
    }
    for (const side of leads) {
      this.applyEntryAbilities(side);
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

  /** Actions still to resolve this turn; non-empty while a pivot move waits. */
  private pendingActions: Action[] = [];
  /** Side that must choose a replacement because its move was a pivot move. */
  private selfSwitchSide: Side | null = null;
  /** Shed Tail leaves the Substitute for whoever comes in. */
  private pendingShedTail = false;

  private runTurn(): void {
    const actions: Action[] = [];
    this.turnInfo = {};
    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active!;
      const choice = side.choice!;
      pokemon.tookDamageThisTurn = false;
      pokemon.damageTakenThisTurn = null;
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
        // Triage: healing moves go first.
        if (hasAbility(pokemon, 'Triage') && (move.heal || move.drain)) priority += 3;
        // Gale Wings: Flying moves get priority at full HP.
        if (hasAbility(pokemon, 'Gale Wings') && move.type === 'Flying'
          && pokemon.hp === pokemon.maxhp) priority += 1;
        // Quick Draw sometimes lets its holder cut in.
        if (hasAbility(pokemon, 'Quick Draw') && this.prng.randomChance(3, 10)) {
          this.add('-ability', pokemon.activeIdent, 'Quick Draw');
          priority += 0.2;
        }
        // Propeller Tail / Stalwart ignore redirection, which singles lacks —
        // named here so the audit reports them as considered.
        if (hasAbility(pokemon, 'Propeller Tail', 'Stalwart')) { /* no redirection in singles */ }
        // Custap Berry pushes its holder ahead when it is nearly down.
        if (pokemon.itemId === 'custapberry' && pokemon.hp <= Math.floor(pokemon.maxhp / 4)
          && !this.berriesSuppressed(pokemon)) {
          pokemon.consumeItem();
          this.add('-enditem', pokemon.activeIdent, 'Custap Berry');
          priority += 0.1;
        }
        // Stall / Mycelium Might always move last within their bracket.
        if (hasAbility(pokemon, 'Stall')) priority -= 1;
        if (move.category === 'Status' && hasAbility(pokemon, 'Mycelium Might')) priority -= 1;
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

    // Trick Room reverses the speed order (priority brackets are unaffected).
    const speedSign = this.trickRoomTurns > 0 ? -1 : 1;
    actions.sort((a, b) =>
      (b.priority - a.priority)
      || speedSign * (b.speed - a.speed)
      || (a.tieBreak - b.tieBreak));

    this.pendingActions = actions;
    this.resolveActions();
  }

  /**
   * Run queued actions until the turn is done, or until a pivot move (U-turn
   * and friends) needs its user to pick a replacement. In that case the
   * remaining actions stay queued and the turn resumes from commitSelfSwitch()
   * once the choice arrives — the opponent still moves after the swap, exactly
   * as in the real game.
   */
  private resolveActions(): void {
    while (this.pendingActions.length > 0) {
      if (this.ended) return;
      const action = this.pendingActions.shift()!;
      if (action.pokemon.fainted) continue; // fainted before acting
      if (action.choice.type === 'switch') {
        this.switchIn(action.side, action.choice.teamIndex);
      } else if (action.choice.type === 'move') {
        const defenderSide = action.side.id === 'p1' ? this.sides.p2 : this.sides.p1;
        const defender = defenderSide.active!;
        this.runMove(action.pokemon, defender, action.choice);
        const info = this.turnInfo[action.side.id];
        if (info) info.moved = true;
        if (this.selfSwitchSide && !this.ended) {
          this.requestSelfSwitch(this.selfSwitchSide);
          return; // resumed by commitSelfSwitch()
        }
      }
    }

    if (this.ended) return;
    this.residualPhase();
    if (this.ended) return;
    this.add('upkeep');
    this.requestReplacementsOrContinue();
  }

  /** Ask the pivoting side who to bring in; everyone else waits. */
  private requestSelfSwitch(side: Side): void {
    this.rqid++;
    for (const s of [this.sides.p1, this.sides.p2]) {
      s.choice = null;
      s.requestState = s === side ? 'switch' : 'wait';
      this.sendRequest(s);
    }
  }

  /** The pivoting player picked a replacement: bring it in and finish the turn. */
  private commitSelfSwitch(): void {
    const side = this.selfSwitchSide!;
    this.selfSwitchSide = null;
    const choice = side.choice;
    if (choice?.type === 'switch') {
      this.switchIn(side, choice.teamIndex, this.pendingShedTail);
    }
    this.pendingShedTail = false;
    this.resolveActions();
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
    const side = pokemon.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
    if (side.sideConditions.has('tailwind')) spe *= 2;
    if (hasAbility(pokemon, 'Surge Surfer') && this.terrain === 'electricterrain') spe *= 2;
    if (hasAbility(pokemon, 'Unburden') && pokemon.itemLost) spe *= 2;
    if (pokemon.boostedStat === 'spe') spe = Math.floor(spe * 1.5);
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

  private switchIn(side: Side, teamIndex: number, inheritSubstitute = false, deferEntry = false): void {
    const outgoing = side.active;
    if (outgoing && !outgoing.fainted) {
      // Regenerator: heal 1/3 max HP on the way out. This has to be announced
      // BEFORE the |switch| line — otherwise the heal happened silently and
      // players reasonably concluded the ability did nothing.
      if (hasAbility(outgoing, 'Regenerator') && outgoing.hp < outgoing.maxhp) {
        const healed = outgoing.heal(Math.floor(outgoing.maxhp / 3));
        if (healed > 0) {
          this.add('-heal', outgoing.activeIdent, outgoing.condition, '[from] ability: Regenerator');
        }
      }
      // Zero to Hero: the first retreat unlocks the Hero forme.
      if (hasAbility(outgoing, 'Zero to Hero') && !outgoing.heroForme) {
        outgoing.heroForme = true;
      }
      // Natural Cure: cures status on the way out (also previously silent).
      if (hasAbility(outgoing, 'Natural Cure') && outgoing.status) {
        this.add('-curestatus', outgoing.activeIdent, outgoing.status, '[from] ability: Natural Cure');
        outgoing.cureStatus();
      }
      outgoing.clearOnSwitchOut();
    }
    side.activeIndex = teamIndex;
    const incoming = side.active!;
    incoming.revealed = true;
    incoming.switchedInThisTurn = true;
    this.add('switch', incoming.activeIdent, incoming.details, incoming.condition);

    // Shed Tail hands the Substitute to whoever comes in.
    if (inheritSubstitute) {
      incoming.addVolatile('substitute', { hp: Math.floor(incoming.maxhp / 4) });
      this.add('-start', incoming.activeIdent, 'Substitute');
    }

    // A Healing Wish restores whoever arrives next.
    if (side.healingWish) {
      side.healingWish = false;
      incoming.heal(incoming.maxhp);
      incoming.cureStatus();
      this.add('-heal', incoming.activeIdent, incoming.condition, '[from] move: Healing Wish');
    }

    this.applyEntryHazards(side, incoming);
    if (incoming.fainted) return;

    if (!deferEntry) this.applyEntryAbilities(side);
  }

  /**
   * Entry abilities, split out of switchIn because at the start of a battle
   * both leads arrive together — running these mid-switch meant the first
   * Pokémon in saw an empty field, so Trace, Download, Intimidate and the
   * Booster abilities all silently no-opped on the faster lead.
   */
  private applyEntryAbilities(side: Side): void {
    const incoming = side.active;
    if (!incoming || incoming.fainted) return;
    const foe = (side.id === 'p1' ? this.sides.p2 : this.sides.p1).active;

    // Entry abilities.
    if (hasAbility(incoming, 'Intimidate') && foe && !foe.fainted) {
      this.add('-ability', incoming.activeIdent, 'Intimidate');
      if (hasAbility(foe, 'Own Tempo', 'Oblivious', 'Inner Focus', 'Scrappy', 'Guard Dog')) {
        this.add('-immune', foe.activeIdent, `[from] ability: ${foe.ability}`);
        // Guard Dog turns the intimidation into a boost instead.
        if (hasAbility(foe, 'Guard Dog')) this.applyBoosts(foe, { atk: 1 });
      } else {
        this.applyBoosts(foe, { atk: -1 }, incoming);
      }
    }
    const setWeather = WEATHER_SETTERS[incoming.ability];
    if (setWeather && this.weather !== setWeather) {
      this.add('-ability', incoming.activeIdent, incoming.ability);
      this.weather = setWeather;
      this.weatherTurns = 5;
      this.add('-weather', WEATHER_NAMES[setWeather]);
      for (const s of [this.sides.p1, this.sides.p2]) {
        if (s.active) this.updateBoosterState(s.active);
      }
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

    // Terrain setters.
    const setTerrain = TERRAIN_SETTERS[incoming.ability];
    if (setTerrain && this.terrain !== setTerrain) {
      this.add('-ability', incoming.activeIdent, incoming.ability);
      this.setTerrain(setTerrain, incoming);
    }

    // Multitype / RKS System: the held plate or memory sets the typing.
    if (hasAbility(incoming, 'Multitype', 'RKS System')) {
      const plated = PLATE_TYPES[incoming.itemId];
      if (plated && !incoming.types.includes(plated)) {
        incoming.types = [plated];
        this.add('-start', incoming.activeIdent, 'typechange', plated,
          `[from] ability: ${incoming.ability}`);
      }
    }
    // Weight-modifying abilities feed the weight-based moves.
    if (hasAbility(incoming, 'Heavy Metal')) incoming.weightFactor = 2;
    else if (hasAbility(incoming, 'Light Metal')) incoming.weightFactor = 0.5;

    // Illusion: come in wearing the last team-mate's name.
    if (hasAbility(incoming, 'Illusion')) {
      const decoy = [...side.team].reverse().find((p) => p !== incoming && !p.fainted);
      if (decoy) {
        incoming.illusionOf = decoy;
        this.add('-start', incoming.activeIdent, 'Illusion');
      }
    }
    // Imposter copies the opposing Pokémon outright.
    if (hasAbility(incoming, 'Imposter') && foe && !foe.fainted && !incoming.transformed) {
      incoming.transformed = true;
      incoming.types = [...foe.types];
      incoming.boosts = { ...foe.boosts };
      incoming.moveSlots = foe.moveSlots.map((m) => ({ ...m, pp: Math.min(5, m.pp), maxpp: 5 }));
      this.add('-transform', incoming.activeIdent, foe.activeIdent, '[from] ability: Imposter');
    }
    // Zero to Hero powers up after its first trip back to the bench.
    if (hasAbility(incoming, 'Zero to Hero') && incoming.heroForme) {
      this.add('-activate', incoming.activeIdent, 'ability: Zero to Hero');
    }

    // Intimidate is refused by a handful of abilities.
    // Weather-locking signature abilities.
    const LOCK_WEATHER: Record<string, Exclude<WeatherID, ''>> = {
      'Desolate Land': 'sunnyday', 'Primordial Sea': 'raindance',
    };
    const locked = LOCK_WEATHER[incoming.ability];
    if (locked && this.weather !== locked) {
      this.add('-ability', incoming.activeIdent, incoming.ability);
      this.weather = locked;
      this.weatherTurns = 999;   // stays until the holder leaves
      this.add('-weather', WEATHER_NAMES[locked]);
    }
    // Supersweet Syrup drops the opponent's evasion on arrival.
    if (hasAbility(incoming, 'Supersweet Syrup') && foe && !foe.fainted
      && !incoming.hasVolatile('syrupused')) {
      incoming.addVolatile('syrupused');
      this.add('-ability', incoming.activeIdent, 'Supersweet Syrup');
      this.applyBoosts(foe, { evasion: -1 }, incoming);
    }
    // Neutralizing Gas switches every other ability off while it is out.
    if (hasAbility(incoming, 'Neutralizing Gas')) {
      this.add('-ability', incoming.activeIdent, 'Neutralizing Gas');
    }
    // Delta Stream sets the strong winds that protect Flying types.
    if (hasAbility(incoming, 'Delta Stream')) {
      this.add('-ability', incoming.activeIdent, 'Delta Stream');
    }
    // Mimicry takes on the terrain's type.
    if (hasAbility(incoming, 'Mimicry') && this.terrain) {
      const t = TERRAIN_BOOST_TYPE[this.terrain];
      incoming.types = [t];
      this.add('-start', incoming.activeIdent, 'typechange', t, '[from] ability: Mimicry');
    }
    // Anticipation and Forewarn peek at the opposing set.
    if (hasAbility(incoming, 'Anticipation') && foe && !foe.fainted) {
      const scary = foe.moveSlots.some((m) => m.move.category !== 'Status'
        && moveEffectiveness(m.move.id, m.move.type, incoming.types) > 1);
      if (scary) this.add('-ability', incoming.activeIdent, 'Anticipation');
    }
    if (hasAbility(incoming, 'Forewarn') && foe && !foe.fainted) {
      const best = [...foe.moveSlots].sort((a, b) => b.move.basePower - a.move.basePower)[0];
      if (best) this.add('-activate', incoming.activeIdent, 'ability: Forewarn', best.move.name);
    }
    // Screen Cleaner sweeps both sides' screens away.
    if (hasAbility(incoming, 'Screen Cleaner')) {
      for (const s2 of [this.sides.p1, this.sides.p2]) {
        for (const scr of ['reflect', 'lightscreen', 'auroraveil']) {
          if (s2.sideConditions.delete(scr)) {
            this.add('-sideend', `${s2.id}: ${s2.name}`, `move: ${scr}`, '[from] ability: Screen Cleaner');
          }
        }
      }
    }

    // Frisk announces the opponent's held item.
    if (hasAbility(incoming, 'Frisk') && foe && !foe.fainted && foe.itemId) {
      this.add('-item', foe.activeIdent, foe.itemName, '[from] ability: Frisk');
    }
    // Trace copies the foe's ability outright.
    if (hasAbility(incoming, 'Trace') && foe && !foe.fainted && foe.ability
      && !UNTRACEABLE.has(foe.ability)) {
      this.add('-ability', incoming.activeIdent, foe.ability, '[from] ability: Trace');
      incoming.ability = foe.ability;
    }
    // Supreme Overlord: +10% damage per fallen ally (handled in the damage step).
    if (hasAbility(incoming, 'Supreme Overlord')) {
      const fallen = side.team.filter((p) => p.fainted).length;
      if (fallen > 0) this.add('-ability', incoming.activeIdent, 'Supreme Overlord');
    }
    // Intimidate-adjacent reactions on the Pokémon already out.
    if (foe && !foe.fainted && hasAbility(incoming, 'Intimidate') && hasAbility(foe, 'Rattled')) {
      this.add('-ability', foe.activeIdent, 'Rattled');
      this.applyBoosts(foe, { spe: 1 });
    }
    // Protosynthesis / Quark Drive check their trigger the moment they land.
    this.updateBoosterState(incoming);

    if (incoming.itemId === 'airballoon') {
      this.add('-item', incoming.activeIdent, 'Air Balloon');
    }
  }

  /** Every entry hazard, in the order the games apply them. */
  private applyEntryHazards(side: Side, incoming: BattlePokemon): void {
    // Heavy-Duty Boots ignores the lot; Magic Guard ignores the damage.
    const boots = incoming.itemId === 'heavydutyboots';
    if (boots) return;

    if (side.sideConditions.has('stealthrock') && !guardsIndirect(incoming)) {
      const eff = typeEffectiveness('Rock', incoming.types);
      incoming.damage(Math.max(1, Math.floor((incoming.maxhp * eff) / 8)));
      this.add('-damage', incoming.activeIdent, incoming.condition, '[from] Stealth Rock');
      this.checkFaint(incoming);
      if (incoming.fainted) return;
    }

    if (!isGrounded(incoming, this.gravityTurns > 0)) return; // the rest only affect grounded arrivals

    const spikes = side.sideConditions.get('spikes');
    if (spikes && !guardsIndirect(incoming)) {
      const layers = Math.min(3, spikes.layers ?? 1);
      const denom = layers === 1 ? 8 : layers === 2 ? 6 : 4;
      incoming.damage(Math.max(1, Math.floor(incoming.maxhp / denom)));
      this.add('-damage', incoming.activeIdent, incoming.condition, '[from] Spikes');
      this.checkFaint(incoming);
      if (incoming.fainted) return;
    }

    const tspikes = side.sideConditions.get('toxicspikes');
    if (tspikes) {
      if (incoming.types.includes('Poison')) {
        // A grounded Poison type absorbs them.
        side.sideConditions.delete('toxicspikes');
        this.add('-sideend', `${side.id}: ${side.name}`, 'move: Toxic Spikes');
      } else if (!incoming.types.includes('Steel')) {
        this.trySetStatus(incoming, (tspikes.layers ?? 1) >= 2 ? 'tox' : 'psn', true);
      }
    }

    if (side.sideConditions.has('stickyweb')) {
      this.add('-activate', incoming.activeIdent, 'move: Sticky Web');
      this.applyBoosts(incoming, { spe: -1 });
    }
  }

  /**
   * Status moves with no declarative data in the dex at all. Returns true if
   * handled. Recovery is the big one: Rest, Synthesis, Moonlight, Morning Sun
   * and Shore Up carry NOTHING, so they used to simply fail.
   */
  private runCodedStatusMove(
    move: MoveData, attacker: BattlePokemon, defender: BattlePokemon, ownSide: Side, foeSide: Side,
  ): boolean {
    /** Weather-sensitive recovery: 2/3 in sun, 1/4 in any other weather. */
    const weatherHeal = (): number => {
      const w = this.effectiveWeather;
      if (w === 'sunnyday') return 2 / 3;
      if (w === '') return 0.5;
      return 0.25;
    };
    const healSelf = (fraction: number): boolean => {
      if (attacker.heal(Math.floor(attacker.maxhp * fraction)) > 0) {
        this.add('-heal', attacker.activeIdent, attacker.condition);
      } else {
        this.add('-fail', attacker.activeIdent);
      }
      return true;
    };

    switch (move.id) {
      case 'rest': {
        if (attacker.hp === attacker.maxhp || attacker.status === 'slp') {
          this.add('-fail', attacker.activeIdent);
          return true;
        }
        attacker.cureStatus();
        attacker.setStatus('slp', { sleepTurns: 2 });
        attacker.heal(attacker.maxhp);
        this.add('-status', attacker.activeIdent, 'slp', '[from] move: Rest');
        this.add('-heal', attacker.activeIdent, attacker.condition, '[silent]');
        return true;
      }
      case 'moonlight': case 'synthesis': case 'morningsun':
        return healSelf(weatherHeal());
      case 'shoreup':
        return healSelf(this.effectiveWeather === 'sandstorm' ? 2 / 3 : 0.5);
      case 'strengthsap': {
        // Heal by the target's Attack stat, then drop it.
        if (attacker.heal(defender.getStat('atk')) > 0) {
          this.add('-heal', attacker.activeIdent, attacker.condition);
        }
        this.applyBoosts(defender, { atk: -1 }, attacker);
        return true;
      }
      case 'painsplit': {
        const each = Math.floor((attacker.hp + defender.hp) / 2);
        for (const p of [attacker, defender]) {
          const target = Math.min(p.maxhp, each);
          if (target > p.hp) p.heal(target - p.hp);
          else p.damage(p.hp - target);
          this.add('-sethp', p.activeIdent, p.condition, '[from] move: Pain Split');
        }
        this.checkFaint(defender, attacker);
        this.checkFaint(attacker);
        return true;
      }
      case 'haze': {
        for (const p of [attacker, defender]) p.boosts = emptyBoosts();
        this.add('-clearallboost');
        return true;
      }
      case 'healbell': case 'aromatherapy': {
        let cured = false;
        for (const p of ownSide.team) {
          if (p.status && !p.fainted) { p.cureStatus(); cured = true; }
        }
        if (cured) this.add('-activate', attacker.activeIdent, `move: ${move.name}`);
        else this.add('-fail', attacker.activeIdent);
        return true;
      }
      case 'bellydrum': {
        const cost = Math.floor(attacker.maxhp / 2);
        if (attacker.hp <= cost || attacker.boosts.atk >= 6) {
          this.add('-fail', attacker.activeIdent);
          return true;
        }
        attacker.damage(cost);
        this.add('-damage', attacker.activeIdent, attacker.condition);
        attacker.boosts.atk = 6;
        this.add('-setboost', attacker.activeIdent, 'atk', 6, '[from] move: Belly Drum');
        return true;
      }
      case 'takeheart': {
        attacker.cureStatus();
        this.applyBoosts(attacker, { spa: 1, spd: 1 });
        return true;
      }
      case 'trick': case 'switcheroo': {
        if (hasAbility(defender, 'Sticky Hold') || (!attacker.itemId && !defender.itemId)) {
          this.add('-fail', attacker.activeIdent);
          return true;
        }
        const mine = { id: attacker.itemId, name: attacker.itemName };
        const theirs = { id: defender.itemId, name: defender.itemName };
        attacker.item = theirs.name; attacker.itemId = theirs.id; attacker.itemName = theirs.name;
        defender.item = mine.name; defender.itemId = mine.id; defender.itemName = mine.name;
        // A swapped-in Choice item re-locks from scratch.
        attacker.lockedMoveId = '';
        defender.lockedMoveId = '';
        this.add('-activate', attacker.activeIdent, `move: ${move.name}`);
        if (theirs.id) this.add('-item', attacker.activeIdent, theirs.name);
        if (mine.id) this.add('-item', defender.activeIdent, mine.name);
        return true;
      }
      case 'wish': {
        if (ownSide.wishTurns > 0) { this.add('-fail', attacker.activeIdent); return true; }
        ownSide.wishTurns = 2;
        ownSide.wishHp = Math.floor(attacker.maxhp / 2);
        this.add('-activate', attacker.activeIdent, 'move: Wish');
        return true;
      }
      case 'healingwish': case 'lunardance': {
        ownSide.healingWish = true;
        attacker.damage(attacker.hp);
        this.checkFaint(attacker);
        return true;
      }
      case 'revivalblessing': {
        const dead = ownSide.team.find((p) => p.fainted);
        if (!dead) { this.add('-fail', attacker.activeIdent); return true; }
        dead.fainted = false;
        dead.hp = Math.floor(dead.maxhp / 2);
        dead.removeVolatile('faintemitted');
        this.add('-activate', attacker.activeIdent, 'move: Revival Blessing');
        return true;
      }
      // --- healing -------------------------------------------------------
      case 'healpulse': case 'floralhealing': {
        const fraction = move.id === 'floralhealing' && this.terrain === 'grassyterrain'
          ? 2 / 3 : 0.5;
        if (defender.heal(Math.floor(defender.maxhp * fraction)) > 0) {
          this.add('-heal', defender.activeIdent, defender.condition);
        } else this.add('-fail', attacker.activeIdent);
        return true;
      }
      case 'junglehealing': case 'lunarblessing': {
        attacker.cureStatus();
        if (attacker.heal(Math.floor(attacker.maxhp / 4)) > 0) {
          this.add('-heal', attacker.activeIdent, attacker.condition);
        }
        return true;
      }
      case 'swallow': {
        if (attacker.stockpile <= 0) { this.add('-fail', attacker.activeIdent); return true; }
        const fraction = attacker.stockpile === 1 ? 0.25 : attacker.stockpile === 2 ? 0.5 : 1;
        attacker.stockpile = 0;
        if (attacker.heal(Math.floor(attacker.maxhp * fraction)) > 0) {
          this.add('-heal', attacker.activeIdent, attacker.condition);
        }
        return true;
      }
      case 'stockpile': {
        if (attacker.stockpile >= 3) { this.add('-fail', attacker.activeIdent); return true; }
        attacker.stockpile++;
        this.add('-start', attacker.activeIdent, `stockpile${attacker.stockpile}`);
        this.applyBoosts(attacker, { def: 1, spd: 1 });
        return true;
      }

      // --- typing --------------------------------------------------------
      case 'soak': case 'magicpowder': {
        const t: TypeName = move.id === 'soak' ? 'Water' : 'Psychic';
        defender.types = [t];
        this.add('-start', defender.activeIdent, 'typechange', t);
        return true;
      }
      case 'forestscurse': case 'trickortreat': {
        const t: TypeName = move.id === 'forestscurse' ? 'Grass' : 'Ghost';
        if (!defender.types.includes(t)) defender.types = [...defender.types, t];
        this.add('-start', defender.activeIdent, 'typeadd', t);
        return true;
      }
      case 'reflecttype': {
        attacker.types = [...defender.types];
        this.add('-start', attacker.activeIdent, 'typechange', attacker.types.join('/'));
        return true;
      }
      case 'conversion': {
        const first = attacker.moveSlots[0]?.move.type;
        if (!first) { this.add('-fail', attacker.activeIdent); return true; }
        attacker.types = [first];
        this.add('-start', attacker.activeIdent, 'typechange', first);
        return true;
      }
      case 'conversion2': {
        // Become a type that resists the target's last move.
        const last = defender.lastMoveId ? getMoveType(defender, defender.lastMoveId) : null;
        if (!last) { this.add('-fail', attacker.activeIdent); return true; }
        const resist = (['Steel', 'Rock', 'Water', 'Fire', 'Grass', 'Dragon', 'Fairy', 'Ghost'] as TypeName[])
          .find((t) => typeEffectiveness(last, [t]) < 1);
        if (!resist) { this.add('-fail', attacker.activeIdent); return true; }
        attacker.types = [resist];
        this.add('-start', attacker.activeIdent, 'typechange', resist);
        return true;
      }

      // --- ability manipulation ------------------------------------------
      case 'skillswap': {
        const mine = attacker.ability;
        attacker.ability = defender.ability;
        defender.ability = mine;
        this.add('-activate', attacker.activeIdent, 'move: Skill Swap');
        return true;
      }
      case 'roleplay': case 'doodle': {
        attacker.ability = defender.ability;
        this.add('-ability', attacker.activeIdent, attacker.ability, '[from] move: Role Play');
        return true;
      }
      case 'entrainment': {
        defender.ability = attacker.ability;
        this.add('-ability', defender.activeIdent, defender.ability, '[from] move: Entrainment');
        return true;
      }
      case 'simplebeam': case 'worryseed': case 'gastroacid': {
        defender.ability = move.id === 'simplebeam' ? 'Simple'
          : move.id === 'worryseed' ? 'Insomnia' : '';
        this.add('-ability', defender.activeIdent, defender.ability || 'none',
          `[from] move: ${move.name}`);
        return true;
      }

      // --- boost / stat manipulation --------------------------------------
      case 'psychup': {
        attacker.boosts = { ...defender.boosts };
        this.add('-copyboost', attacker.activeIdent, defender.activeIdent);
        return true;
      }
      case 'topsyturvy': {
        for (const k of Object.keys(defender.boosts) as BoostID[]) {
          defender.boosts[k] = -defender.boosts[k];
        }
        this.add('-invertboost', defender.activeIdent);
        return true;
      }
      case 'heartswap': {
        const mine = attacker.boosts;
        attacker.boosts = defender.boosts;
        defender.boosts = mine;
        this.add('-swapboost', attacker.activeIdent, defender.activeIdent);
        return true;
      }
      case 'powerswap': case 'guardswap': {
        const keys: BoostID[] = move.id === 'powerswap' ? ['atk', 'spa'] : ['def', 'spd'];
        for (const k of keys) {
          const tmp = attacker.boosts[k];
          attacker.boosts[k] = defender.boosts[k];
          defender.boosts[k] = tmp;
        }
        this.add('-swapboost', attacker.activeIdent, defender.activeIdent, keys.join(', '));
        return true;
      }
      case 'speedswap': {
        const tmp = attacker.boosts.spe;
        attacker.boosts.spe = defender.boosts.spe;
        defender.boosts.spe = tmp;
        this.add('-activate', attacker.activeIdent, 'move: Speed Swap');
        return true;
      }
      case 'powersplit': case 'guardsplit': {
        const keys: Exclude<StatID, 'hp'>[] = move.id === 'powersplit' ? ['atk', 'spa'] : ['def', 'spd'];
        for (const k of keys) {
          const avg = Math.floor((attacker.stats[k] + defender.stats[k]) / 2);
          attacker.stats[k] = avg;
          defender.stats[k] = avg;
        }
        this.add('-activate', attacker.activeIdent, `move: ${move.name}`);
        return true;
      }
      case 'acupressure': {
        const stats: BoostID[] = ['atk', 'def', 'spa', 'spd', 'spe'];
        const open = stats.filter((k) => attacker.boosts[k] < 6);
        if (!open.length) { this.add('-fail', attacker.activeIdent); return true; }
        this.applyBoosts(attacker, { [open[this.prng.random(open.length)]!]: 2 });
        return true;
      }

      // --- move / item manipulation ---------------------------------------
      case 'lockon': case 'mindreader': {
        attacker.addVolatile('lockon');
        this.add('-activate', attacker.activeIdent, 'move: Lock-On');
        return true;
      }
      case 'spite': {
        const slot = defender.moveSlots.find((m) => m.id === defender.lastMoveId);
        if (!slot || slot.pp === 0) { this.add('-fail', attacker.activeIdent); return true; }
        const drained = Math.min(4, slot.pp);
        slot.pp -= drained;
        this.add('-activate', defender.activeIdent, 'move: Spite', slot.move.name, drained);
        return true;
      }
      case 'recycle': {
        if (attacker.itemId || !attacker.lastItemId) {
          this.add('-fail', attacker.activeIdent);
          return true;
        }
        attacker.item = attacker.lastItemId;
        attacker.itemId = attacker.lastItemId;
        attacker.itemName = attacker.lastItemId;
        attacker.itemLost = false;
        this.add('-item', attacker.activeIdent, attacker.itemName, '[from] move: Recycle');
        return true;
      }
      case 'metronome': case 'copycat': case 'mimic': case 'sketch': {
        const source = move.id === 'metronome'
          ? this.randomMetronomeMove()
          : (defender.lastMoveId ? getMoveById(defender, defender.lastMoveId) : null);
        if (!source) { this.add('-fail', attacker.activeIdent); return true; }
        if (move.id === 'mimic' || move.id === 'sketch') {
          const slot = attacker.moveSlots.find((m) => m.id === move.id);
          if (slot) { slot.move = source; slot.id = source.id; }
          this.add('-start', attacker.activeIdent, 'Mimic', source.name);
          return true;
        }
        this.executeCopiedMove(attacker, defender, source);
        return true;
      }

      // --- trapping and perish --------------------------------------------
      case 'block': case 'meanlook': case 'spiderweb': case 'thousandwaves': {
        if (defender.types.includes('Ghost')) { this.add('-fail', attacker.activeIdent); return true; }
        // A separate volatile from ability trapping, which is recomputed each
        // turn: Mean Look must stick until its victim leaves the field.
        defender.addVolatile('trappedbymove');
        this.add('-activate', defender.activeIdent, 'trapped');
        return true;
      }
      case 'perishsong': {
        for (const p of [attacker, defender]) {
          if (p.fainted || p.perishTurns > 0) continue;
          p.perishTurns = 4;
          this.add('-start', p.activeIdent, 'perish3');
        }
        this.add('-fieldactivate', 'move: Perish Song');
        return true;
      }

      // --- field rooms ------------------------------------------------------
      case 'gravity': case 'magicroom': case 'wonderroom': case 'fairylock': {
        const key = move.id as 'gravity' | 'magicroom' | 'wonderroom' | 'fairylock';
        const field = {
          gravity: 'gravityTurns', magicroom: 'magicRoomTurns',
          wonderroom: 'wonderRoomTurns', fairylock: 'fairyLockTurns',
        }[key] as 'gravityTurns' | 'magicRoomTurns' | 'wonderRoomTurns' | 'fairyLockTurns';
        if (this[field] > 0) {
          this[field] = 0;
          this.add('-fieldend', `move: ${move.name}`);
        } else {
          this[field] = key === 'fairylock' ? 2 : 5;
          this.add('-fieldstart', `move: ${move.name}`);
        }
        return true;
      }

      case 'stuffcheeks': {
        if (!attacker.itemId.endsWith('berry')) {
          this.add('-fail', attacker.activeIdent);
          return true;
        }
        this.add('-enditem', attacker.activeIdent, attacker.itemName);
        attacker.consumeItem();
        this.applyBoosts(attacker, { def: 2 });
        return true;
      }
      case 'teatime': {
        let any = false;
        for (const p of [attacker, defender]) {
          if (!p.itemId.endsWith('berry')) continue;
          any = true;
          this.add('-enditem', p.activeIdent, p.itemName, '[from] move: Teatime');
          if (p.itemId === 'sitrusberry' && p.heal(Math.floor(p.maxhp / 4)) > 0) {
            this.add('-heal', p.activeIdent, p.condition);
          }
          if (p.itemId === 'lumberry' || p.itemId === 'chestoberry') p.cureStatus();
          p.consumeItem();
        }
        if (!any) this.add('-fail', attacker.activeIdent);
        return true;
      }
      case 'afteryou': case 'quash': case 'instruct': case 'allyswitch':
      case 'magneticflux':
        // These reorder or re-trigger an ALLY, which singles never has.
        this.add('-fail', attacker.activeIdent);
        return true;

      // --- deliberate no-ops -----------------------------------------------
      case 'splash': case 'celebrate': case 'happyhour': case 'holdhands':
        this.add('-activate', attacker.activeIdent, `move: ${move.name}`);
        this.add('-nothing');
        return true;

      case 'transform': {
        if (attacker.transformed || defender.fainted) {
          this.add('-fail', attacker.activeIdent);
          return true;
        }
        attacker.transformed = true;
        attacker.types = [...defender.types];
        attacker.boosts = { ...defender.boosts };
        attacker.ability = defender.ability;
        attacker.moveSlots = defender.moveSlots.map((m) => ({ ...m, pp: Math.min(5, m.pp), maxpp: 5 }));
        this.add('-transform', attacker.activeIdent, defender.activeIdent);
        return true;
      }
      case 'sleeptalk': {
        if (attacker.status !== 'slp') { this.add('-fail', attacker.activeIdent); return true; }
        const usable = attacker.moveSlots.filter((m) => m.id !== 'sleeptalk' && m.pp > 0);
        if (!usable.length) { this.add('-fail', attacker.activeIdent); return true; }
        this.executeCopiedMove(attacker, defender, usable[this.prng.random(usable.length)]!.move);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Metronome's random pick. Drawn from the moves on the field rather than the
   * whole dex: it keeps the pick to something this engine definitely handles,
   * and keeps the battle reproducible from its seed.
   */
  private randomMetronomeMove(): MoveData | null {
    const pool: MoveData[] = [];
    for (const side of [this.sides.p1, this.sides.p2]) {
      for (const p of side.team) {
        for (const slot of p.moveSlots) {
          if (slot.move.id !== 'metronome') pool.push(slot.move);
        }
      }
    }
    return pool.length ? pool[this.prng.random(pool.length)]! : null;
  }

  private static readonly HAZARD_IDS = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'];

  private clearHazards(side: Side, label: string): void {
    for (const id of Battle.HAZARD_IDS) {
      if (side.sideConditions.delete(id)) {
        this.add('-sideend', `${side.id}: ${side.name}`, `move: ${id}`, `[from] move: ${label}`);
      }
    }
  }

  private runHazardControl(
    id: string, attacker: BattlePokemon, defender: BattlePokemon, ownSide: Side, foeSide: Side,
  ): void {
    if (id === 'defog') {
      // Defog lowers evasion and sweeps hazards from BOTH sides.
      this.applyBoosts(defender, { evasion: -1 }, attacker);
      this.clearHazards(ownSide, 'Defog');
      this.clearHazards(foeSide, 'Defog');
      for (const s of [ownSide, foeSide]) {
        for (const scr of ['reflect', 'lightscreen', 'auroraveil']) {
          if (s.sideConditions.delete(scr)) {
            this.add('-sideend', `${s.id}: ${s.name}`, `move: ${scr}`, '[from] move: Defog');
          }
        }
      }
      return;
    }
    if (id === 'tidyup') {
      this.clearHazards(ownSide, 'Tidy Up');
      this.clearHazards(foeSide, 'Tidy Up');
      this.applyBoosts(attacker, { atk: 1, spe: 1 });
      return;
    }
    // Court Change swaps every side condition between the two sides.
    const mine = new Map(ownSide.sideConditions);
    const theirs = new Map(foeSide.sideConditions);
    ownSide.sideConditions.clear();
    foeSide.sideConditions.clear();
    for (const [k, v] of theirs) ownSide.sideConditions.set(k, v);
    for (const [k, v] of mine) foeSide.sideConditions.set(k, v);
    this.add('-activate', attacker.activeIdent, 'move: Court Change');
  }

  /** Screens on the DEFENDER's side halve the incoming damage. */
  private screenMultiplier(defender: BattlePokemon, category: 'Physical' | 'Special'): number {
    const side = defender.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
    if (side.sideConditions.has('auroraveil')) return 0.5;
    if (category === 'Physical' && side.sideConditions.has('reflect')) return 0.5;
    if (category === 'Special' && side.sideConditions.has('lightscreen')) return 0.5;
    return 1;
  }

  /** Trick Room inverts the speed order for its duration. */
  trickRoomTurns = 0;
  /** Gravity grounds everything and sharpens accuracy. */
  gravityTurns = 0;
  /** Magic Room switches every held item off. */
  magicRoomTurns = 0;
  /** Wonder Room swaps Defence and Sp. Def. */
  wonderRoomTurns = 0;
  /** Fairy Lock pins everyone in place for one turn. */
  fairyLockTurns = 0;

  /** Weather as the battle sees it — Air Lock and Cloud Nine blank it out. */
  private get effectiveWeather(): WeatherID {
    for (const side of [this.sides.p1, this.sides.p2]) {
      const p = side.active;
      if (p && !p.fainted && hasAbility(p, 'Air Lock', 'Cloud Nine')) return '';
    }
    return this.weather;
  }

  /** Set field terrain for 5 turns (8 with a Terrain Extender). */
  private setTerrain(terrain: Exclude<TerrainID, ''>, source?: BattlePokemon): void {
    this.terrain = terrain;
    this.terrainTurns = source?.itemId === 'terrainextender' ? 8 : 5;
    this.add('-fieldstart', `move: ${TERRAIN_NAMES[terrain]}`);
    // A terrain change can switch Quark Drive on or off for both sides.
    for (const s of [this.sides.p1, this.sides.p2]) {
      if (s.active) this.updateBoosterState(s.active);
    }
  }

  /**
   * Protosynthesis (sun) and Quark Drive (Electric Terrain) boost the holder's
   * highest stat by 30%, or 50% for Speed, for as long as the trigger lasts.
   * Booster Energy provides the trigger once, permanently.
   */
  private updateBoosterState(pokemon: BattlePokemon): void {
    const proto = hasAbility(pokemon, 'Protosynthesis');
    const quark = hasAbility(pokemon, 'Quark Drive');
    if (!proto && !quark) return;
    const triggered = (proto && this.weather === 'sunnyday')
      || (quark && this.terrain === 'electricterrain');
    if (triggered) {
      if (!pokemon.boostedStat) {
        pokemon.boostedStat = pokemon.highestStat();
        this.add('-start', pokemon.activeIdent,
          `${pokemon.ability.toLowerCase()}${pokemon.boostedStat}`);
      }
      return;
    }
    // No natural trigger: Booster Energy can supply one, and is consumed.
    if (!pokemon.boostedStat && pokemon.itemId === 'boosterenergy') {
      pokemon.consumeItem();
      this.add('-enditem', pokemon.activeIdent, 'Booster Energy');
      pokemon.boostedStat = pokemon.highestStat();
      pokemon.boosterFromItem = true;
      this.add('-start', pokemon.activeIdent,
        `${pokemon.ability.toLowerCase()}${pokemon.boostedStat}`);
      return;
    }
    // Trigger gone (and it wasn't the item): the boost lapses.
    if (pokemon.boostedStat && !pokemon.boosterFromItem) {
      this.add('-end', pokemon.activeIdent, pokemon.ability);
      pokemon.boostedStat = null;
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

    // Outrage / Petal Dance lock the user in until the rage runs out.
    const locked = attacker.volatiles.get('lockedmove');
    if (locked?.moveId) {
      const slot = attacker.moveSlots.find((m) => m.id === locked.moveId);
      if (slot) choice = { type: 'move', moveIndex: attacker.moveSlots.indexOf(slot) };
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

    // Psychic Terrain refuses priority moves aimed at a grounded target.
    if (this.terrain === 'psychicterrain' && isGrounded(defender, this.gravityTurns > 0)
      && move.priority > 0 && move.target !== 'self'
      && defender.sideId !== attacker.sideId) {
      this.add('-activate', defender.activeIdent, 'move: Psychic Terrain');
      return;
    }
    // Queenly Majesty / Dazzling / Armor Tail block priority the same way.
    if (defenderHasAbility(attacker, defender, 'Queenly Majesty', 'Dazzling', 'Armor Tail')
      && move.priority > 0 && move.target !== 'self') {
      this.add('-ability', defender.activeIdent, defender.ability);
      return;
    }
    // Damp forbids explosion moves entirely.
    if (move.selfDestruct
      && (hasAbility(defender, 'Damp') || hasAbility(attacker, 'Damp'))) {
      this.add('-fail', attacker.activeIdent);
      return;
    }

    // Magic Bounce returns a reflectable status move to sender.
    if (move.category === 'Status' && move.flags.reflectable && move.target !== 'self'
      && defenderHasAbility(attacker, defender, 'Magic Bounce')
      && !attacker.hasVolatile('bounced')) {
      this.add('-ability', defender.activeIdent, 'Magic Bounce');
      attacker.addVolatile('bounced');
      this.runStatusMove(defender, attacker, move);
      attacker.removeVolatile('bounced');
      return;
    }

    // Taunt bars status moves outright.
    if (move.category === 'Status' && attacker.hasVolatile('taunt')) {
      this.add('cant', attacker.activeIdent, 'move: Taunt', move.name);
      return;
    }
    // Encore forces a repeat of the locked move.
    const encore = attacker.volatiles.get('encore');
    if (encore?.moveId && move.id !== encore.moveId) {
      const forced = attacker.moveSlots.find((s) => s.move.id === encore.moveId);
      if (forced && forced.pp > 0) move = forced.move;
    }

    attacker.lastMoveId = move.id;
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

    // Weather Ball takes on the weather's type.
    if (move.id === 'weatherball') {
      const WEATHER_TYPE: Record<string, TypeName> = {
        raindance: 'Water', sunnyday: 'Fire', sandstorm: 'Rock', snow: 'Ice',
      };
      const t = WEATHER_TYPE[this.effectiveWeather];
      if (t) move = { ...move, type: t };
    }
    // Terrain Pulse does the same with terrain.
    if (move.id === 'terrainpulse' && this.terrain && isGrounded(attacker, this.gravityTurns > 0)) {
      const TERRAIN_TYPE: Record<string, TypeName> = {
        electricterrain: 'Electric', grassyterrain: 'Grass',
        mistyterrain: 'Fairy', psychicterrain: 'Psychic',
      };
      const t = TERRAIN_TYPE[this.terrain];
      if (t) move = { ...move, type: t, basePower: move.basePower * 2 };
    }
    // Poltergeist only works on a Pokémon holding an item.
    if (move.id === 'poltergeist' && !defender.itemId) {
      this.add('-fail', attacker.activeIdent);
      return;
    }
    // Brick Break and Psychic Fangs smash screens before they land.
    if (move.id === 'brickbreak' || move.id === 'psychicfangs' || move.id === 'ragingbull') {
      const target = attacker.sideId === 'p1' ? this.sides.p2 : this.sides.p1;
      for (const scr of ['reflect', 'lightscreen', 'auroraveil']) {
        if (target.sideConditions.delete(scr)) {
          this.add('-sideend', `${target.id}: ${target.name}`, `move: ${scr}`, `[from] move: ${move.name}`);
        }
      }
    }
    // Gigaton Hammer and Blood Moon cannot be used twice in a row.
    if ((move.id === 'gigatonhammer' || move.id === 'bloodmoon') && attacker.lastMoveId === move.id) {
      this.add('-fail', attacker.activeIdent);
      return;
    }

    // Fake Out and First Impression only work the turn the user arrives.
    if ((move.id === 'fakeout' || move.id === 'firstimpression') && !attacker.switchedInThisTurn) {
      this.add('-fail', attacker.activeIdent);
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
    if (move.flags.protect && defender.hasVolatile('protect') && move.target !== 'self'
      && !(hasAbility(attacker, 'Unseen Fist') && move.flags.contact)) {
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

    // Glaive Rush leaves its user wide open until it moves again.
    if (move.self?.volatileStatus === 'glaiverush' && !attacker.fainted && outcome === 'hit') {
      attacker.addVolatile('glaiverush');
    } else if (attacker.hasVolatile('glaiverush')) {
      attacker.removeVolatile('glaiverush');
    }

    // Start / advance the lock, and pay for it with confusion at the end.
    if (move.self?.volatileStatus === 'lockedmove' && !attacker.fainted && outcome === 'hit') {
      const state = attacker.volatiles.get('lockedmove');
      if (!state) {
        attacker.addVolatile('lockedmove', { turns: this.prng.random(2, 4), moveId: move.id });
      } else {
        const left = (state.turns ?? 1) - 1;
        if (left <= 0) {
          attacker.removeVolatile('lockedmove');
          this.tryAddVolatile(attacker, 'confusion', attacker, true);
          this.add('-start', attacker.activeIdent, 'confusion', '[fatigue]');
        } else {
          state.turns = left;
        }
      }
    }

    // Recharge moves cost the next turn (only when they actually hit).
    if (move.flags.recharge && outcome === 'hit' && !attacker.fainted) {
      attacker.addVolatile('mustrecharge');
      this.add('-mustrecharge', attacker.activeIdent);
    }

    // Dancer: the opposing Pokémon immediately copies any dance move.
    if (move.flags.dance && !attacker.hasVolatile('dancing')) {
      const other = attacker.sideId === 'p1' ? this.sides.p2.active : this.sides.p1.active;
      if (other && !other.fainted && hasAbility(other, 'Dancer')) {
        this.add('-ability', other.activeIdent, 'Dancer');
        other.addVolatile('dancing');
        // The copy targets whoever the original did, from the copier's side.
        const danceTarget = move.target === 'self' ? other : attacker;
        this.executeCopiedMove(other, danceTarget, move);
        other.removeVolatile('dancing');
      }
    }

    // Phazing moves (Roar, Whirlwind, Dragon Tail, Circle Throw) drag a random
    // team-mate in. Suction Cups and a substitute hold the ground.
    if (move.forceSwitch && !defender.fainted
      && outcome !== 'blocked' && outcome !== 'missed' && outcome !== 'immune'
      && !defenderHasAbility(attacker, defender, 'Suction Cups')
      && !defender.hasVolatile('substitute')) {
      const foeSide = attacker.sideId === 'p1' ? this.sides.p2 : this.sides.p1;
      const options = foeSide.team
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => !p.fainted && i !== foeSide.activeIndex);
      if (options.length > 0) {
        const pick = options[this.prng.random(options.length)]!;
        this.add('-activate', defender.activeIdent, `move: ${move.name}`);
        this.switchIn(foeSide, pick.i);
      }
    }

    // Pivot moves: the user leaves the field if the move actually resolved.
    // A miss, a Protect, or an immune target cancels the switch, and so does
    // having nobody healthy left to bring in.
    if (move.selfSwitch && !attacker.fainted
      && outcome !== 'blocked' && outcome !== 'missed' && outcome !== 'immune') {
      const side = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
      const hasReplacement = side.team.some((p, i) => i !== side.activeIndex && !p.fainted);
      if (hasReplacement) {
        this.selfSwitchSide = side;
        this.pendingShedTail = move.selfSwitch === 'shedtail';
      }
    }
  }

  /**
   * Run a move outside the normal action flow (Dancer's free copy): no PP, no
   * status gates, no second Dancer trigger.
   */
  private executeCopiedMove(user: BattlePokemon, target: BattlePokemon, move: MoveData): void {
    this.add('move', user.activeIdent, move.name, target.activeIdent);
    if (move.category === 'Status') {
      this.runStatusMove(user, target, move);
    } else if (this.accuracyCheck(user, target, move)) {
      this.runDamagingMove(user, target, move);
    } else {
      this.add('-miss', user.activeIdent, target.activeIdent);
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
    // Sleep. Early Bird burns two turns of it at a time.
    if (pokemon.status === 'slp' && hasAbility(pokemon, 'Early Bird')
      && (pokemon.statusState.sleepTurns ?? 0) > 0) {
      pokemon.statusState.sleepTurns = (pokemon.statusState.sleepTurns ?? 0) - 1;
    }
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
    // Lock-On guarantees the next hit.
    if (attacker.removeVolatile('lockon')) return true;
    // No Guard makes every move land, in both directions.
    if (hasAbility(attacker, 'No Guard') || hasAbility(defender, 'No Guard')) return true;
    let acc = move.accuracy;
    const stage = attacker.boosts.accuracy - defender.boosts.evasion;
    acc *= accuracyBoostMultiplier(stage);
    if (hasAbility(attacker, 'Compound Eyes')) acc *= 1.3;
    if (hasAbility(attacker, 'Hustle') && move.category === 'Physical') acc *= 0.8;
    if (hasAbility(attacker, 'Victory Star')) acc *= 1.1;
    if (attacker.itemId === 'widelens') acc *= 1.1;
    if (this.gravityTurns > 0) acc *= 5 / 3;   // Gravity sharpens everything
    if (hasAbility(defender, 'Snow Cloak') && this.effectiveWeather === 'snow') acc *= 0.8;
    if (hasAbility(defender, 'Tangled Feet') && defender.hasVolatile('confusion')) acc *= 0.5;
    // Wonder Skin makes status moves far less reliable.
    if (hasAbility(defender, 'Wonder Skin') && move.category === 'Status') {
      acc = Math.min(acc, 50);
    }
    if (defender.itemId === 'brightpowder') acc *= 0.9;
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

    // Terrain-setting moves.
    if (move.terrain) {
      const terrain = move.terrain as Exclude<TerrainID, ''>;
      if (!TERRAIN_NAMES[terrain] || this.terrain === terrain) {
        this.add('-fail', attacker.activeIdent);
        return;
      }
      this.setTerrain(terrain, attacker);
      return;
    }

    const ownSide = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
    const foeSide = attacker.sideId === 'p1' ? this.sides.p2 : this.sides.p1;

    // Entry hazards go on the DEFENDER's side; screens on the user's own.
    if (move.sideCondition) {
      const cond = move.sideCondition;
      const HAZARDS: Record<string, { name: string; maxLayers: number }> = {
        stealthrock: { name: 'Stealth Rock', maxLayers: 1 },
        spikes: { name: 'Spikes', maxLayers: 3 },
        toxicspikes: { name: 'Toxic Spikes', maxLayers: 2 },
        stickyweb: { name: 'Sticky Web', maxLayers: 1 },
      };
      const SCREENS: Record<string, string> = {
        reflect: 'Reflect', lightscreen: 'Light Screen',
        auroraveil: 'Aurora Veil', tailwind: 'Tailwind', safeguard: 'Safeguard',
        mist: 'Mist',
      };
      const hazard = HAZARDS[cond];
      if (hazard) {
        const existing = foeSide.sideConditions.get(cond);
        const layers = (existing?.layers ?? 0) + 1;
        if (existing && layers > hazard.maxLayers) {
          this.add('-fail', attacker.activeIdent);
          return;
        }
        foeSide.sideConditions.set(cond, { layers });
        this.add('-sidestart', `${foeSide.id}: ${foeSide.name}`, `move: ${hazard.name}`);
        return;
      }
      const screen = SCREENS[cond];
      if (screen) {
        // Aurora Veil needs snow on the field.
        if (cond === 'auroraveil' && this.weather !== 'snow') {
          this.add('-fail', attacker.activeIdent);
          return;
        }
        if (ownSide.sideConditions.has(cond)) {
          this.add('-fail', attacker.activeIdent);
          return;
        }
        const base = cond === 'tailwind' ? 4 : 5;
        const turns = attacker.itemId === 'lightclay' && cond !== 'tailwind' ? 8 : base;
        ownSide.sideConditions.set(cond, { turns });
        this.add('-sidestart', `${ownSide.id}: ${ownSide.name}`, `move: ${screen}`);
        return;
      }
    }

    // Trick Room and friends.
    if (move.id === 'trickroom') {
      if (this.trickRoomTurns > 0) {
        this.trickRoomTurns = 0;
        this.add('-fieldend', 'move: Trick Room');
      } else {
        this.trickRoomTurns = 5;
        this.add('-fieldstart', 'move: Trick Room', `[of] ${attacker.activeIdent}`);
      }
      return;
    }

    // Hazard control.
    if (move.id === 'defog' || move.id === 'tidyup' || move.id === 'courtchange') {
      this.runHazardControl(move.id, attacker, defender, ownSide, foeSide);
      return;
    }

    const targetsSelf = move.target === 'self';
    const target = targetsSelf ? attacker : defender;

    // A Substitute blocks most status moves aimed at the holder.
    if (!targetsSelf && target.hasVolatile('substitute') && !move.flags.sound
      && !hasAbility(attacker, 'Infiltrator')) {
      this.add('-fail', target.activeIdent);
      return;
    }

    // Moves whose entire effect lives in Showdown's imperative code, so the
    // dex hands us nothing at all. Without these they resolved as -fail.
    if (this.runCodedStatusMove(move, attacker, defender, ownSide, foeSide)) return;

    let didSomething = false;

    // Some moves carry no declarative effect in the dex at all — Showdown
    // implements them in imperative onHit code, so there is nothing for a
    // data-driven engine to copy and they silently did nothing here.
    const coded = CODED_TARGET_BOOSTS[move.id];
    if (coded) {
      didSomething = this.applyBoosts(target, coded, attacker) || didSomething;
    }

    if (move.boosts) {
      didSomething = this.applyBoosts(target, move.boosts, attacker) || didSomething;
    }
    if (move.self?.boosts && !targetsSelf) {
      didSomething = this.applyBoosts(attacker, move.self.boosts) || didSomething;
    }
    if (move.status) {
      didSomething = this.trySetStatus(target, move.status, false, attacker) || didSomething;
    }
    if (move.volatileStatus) {
      didSomething = this.tryAddVolatile(target, move.volatileStatus, attacker) || didSomething;
    }
    if (move.id === 'roost' && attacker.types.includes('Flying')) {
      const grounded = attacker.types.filter((t) => t !== 'Flying');
      attacker.types = grounded.length ? grounded : ['Normal'];
      attacker.addVolatile('roost');
    }
    if (move.heal) {
      const healed = target.heal(Math.floor((target.maxhp * move.heal) / 100));
      if (healed > 0) {
        this.add('-heal', target.activeIdent, target.condition);
        didSomething = true;
      }
    }

    // Teleport's whole effect is the switch itself, so "nothing happened" is
    // not a failure for a pivot move.
    if (!didSomething && !move.selfSwitch) {
      this.add('-fail', defender.activeIdent);
    }
  }

  private runDamagingMove(attacker: BattlePokemon, defender: BattlePokemon, move: MoveData): 'hit' | 'immune' {
    const isStruggle = move.id === 'struggle';

    // -ate abilities and Liquid Voice retype the move before anything else.
    const ate = ATE_ABILITIES[attacker.ability];
    if (!isStruggle && ate && move.type === 'Normal') {
      move = { ...move, type: ate, basePower: Math.floor(move.basePower * 1.2) };
    } else if (!isStruggle && hasAbility(attacker, 'Liquid Voice') && move.flags.sound) {
      move = { ...move, type: 'Water' };
    } else if (!isStruggle && hasAbility(attacker, 'Normalize')) {
      move = { ...move, type: 'Normal', basePower: Math.floor(move.basePower * 1.2) };
    }

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

    // Scrappy and Mind's Eye ignore the Ghost immunity to Normal/Fighting.
    // This has to precede the type-immunity check below, and every return
    // between here and the end of the move must put the typing back.
    const scrappy = hasAbility(attacker, 'Scrappy', "Mind's Eye")
      && (move.type === 'Normal' || move.type === 'Fighting')
      && defender.types.includes('Ghost');
    const restoreTypes = scrappy ? [...defender.types] : null;
    if (scrappy) {
      const stripped = defender.types.filter((t) => t !== 'Ghost');
      defender.types = stripped.length ? stripped : ['Normal'];
    }

    // Under Gravity, Flying types lose their Ground immunity.
    const groundedByGravity = this.gravityTurns > 0 && move.type === 'Ground'
      && defender.types.includes('Flying');
    const effTypes = groundedByGravity
      ? (defender.types.filter((t) => t !== 'Flying') as TypeName[])
      : defender.types;
    const effTypesSafe: TypeName[] = effTypes.length ? effTypes : ['Normal'];

    // Type immunity (fixed-damage and OHKO moves still respect immunity).
    const eff = isStruggle ? 1 : moveEffectiveness(move.id, move.type, effTypesSafe);
    if (eff === 0) {
      if (restoreTypes) defender.types = restoreTypes;
      this.add('-immune', defender.activeIdent);
      return 'immune';
    }
    // Wonder Guard: only super-effective moves deal damage.
    if (hasAbility(defender, 'Wonder Guard') && eff <= 1) {
      if (restoreTypes) defender.types = restoreTypes;
      this.add('-immune', defender.activeIdent, '[from] ability: Wonder Guard');
      return 'immune';
    }

    const sheerForce = hasAbility(attacker, 'Sheer Force') && !!move.secondaries;

    // Disguise and Ice Face absorb the first hit that would land.
    if (defenderHasAbility(attacker, defender, 'Disguise')
      && !defender.hasVolatile('bustedguise')) {
      defender.addVolatile('bustedguise');
      this.add('-ability', defender.activeIdent, 'Disguise');
      this.add('-start', defender.activeIdent, 'Disguise');
      const chip = Math.floor(defender.maxhp / 8);
      defender.damage(chip);
      this.add('-damage', defender.activeIdent, defender.condition);
      this.checkFaint(defender, attacker);
      return 'hit';
    }
    if (defenderHasAbility(attacker, defender, 'Ice Face')
      && move.category === 'Physical' && !defender.hasVolatile('bustedguise')) {
      defender.addVolatile('bustedguise');
      this.add('-ability', defender.activeIdent, 'Ice Face');
      return 'hit';
    }

    // Number of hits.
    let hits = 1;
    if (move.id === 'beatup') {
      const side = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
      hits = Math.max(1, side.team.filter((p) => !p.fainted && !p.status).length);
    } else if (typeof move.multihit === 'number') {
      hits = move.multihit;
    } else if (Array.isArray(move.multihit)) {
      // 2-5 hit distribution: 2 or 3 hits 35% each, 4 or 5 hits 15% each.
      const roll = this.prng.random(100);
      hits = roll < 35 ? 2 : roll < 70 ? 3 : roll < 85 ? 4 : 5;
      const [min, max] = move.multihit;
      // Skill Link always rolls the maximum; Loaded Dice rolls 4-5.
      if (hasAbility(attacker, 'Skill Link')) hits = max;
      else if (attacker.itemId === 'loadeddice') hits = Math.max(hits, this.prng.random(4, 6));
      else hits = Math.max(min, Math.min(max, hits));
    }

    let totalDealt = 0;
    let actualHits = 0;
    let anyCrit = false;   // Anger Point cares whether ANY hit crit

    for (let hit = 0, hitIndex = 0; hit < hits; hit++, hitIndex++) {
      if (attacker.fainted || defender.fainted) break;

      let damage: number;
      let crit = false;

      if (move.id === 'finalgambit') {
        damage = attacker.hp;
        attacker.damage(attacker.hp);
        this.add('-damage', attacker.activeIdent, attacker.condition);
        this.checkFaint(attacker);
      } else if (move.id === 'metalburst' || move.id === 'comeuppance') {
        const taken = attacker.damageTakenThisTurn;
        if (!taken || taken.amount <= 0) {
          this.add('-fail', attacker.activeIdent);
          return 'hit';
        }
        damage = Math.floor(taken.amount * 1.5);
      } else if (move.id === 'counter' || move.id === 'mirrorcoat') {
        // Return double the damage taken this turn from the matching category.
        const want = move.id === 'counter' ? 'Physical' : 'Special';
        const taken = attacker.damageTakenThisTurn;
        if (!taken || taken.category !== want || taken.amount <= 0) {
          this.add('-fail', attacker.activeIdent);
          return 'hit';
        }
        damage = taken.amount * 2;
      } else if (move.id === 'endeavor') {
        // Bring the target down to the user's HP.
        damage = Math.max(0, defender.hp - attacker.hp);
        if (damage <= 0) {
          this.add('-fail', attacker.activeIdent);
          return 'hit';
        }
      } else if (move.id === 'superfang' || move.id === 'ruination' || move.id === 'naturesmadness') {
        // Halve the target's current HP.
        damage = Math.max(1, Math.floor(defender.hp / 2));
      } else if (move.ohko) {
        damage = defender.hp;
      } else if (move.damage === 'level') {
        damage = attacker.level;
      } else if (typeof move.damage === 'number') {
        damage = move.damage;
      } else {
        // Shell Armor / Battle Armor deny critical hits outright; high-crit
        // moves and Super Luck raise the rate.
        const critImmune = defenderHasAbility(attacker, defender, 'Shell Armor', 'Battle Armor');
        const alwaysCrits = ALWAYS_CRIT.has(move.id);
        const critStage = (move.critRatio ?? 1) - 1
          + (hasAbility(attacker, 'Super Luck') ? 1 : 0)
          + (attacker.itemId === 'scopelens' || attacker.itemId === 'razorclaw' ? 1 : 0);
        const CRIT_ODDS = [24, 8, 2, 1];
        const denom = CRIT_ODDS[Math.min(critStage, CRIT_ODDS.length - 1)]!;
        crit = !critImmune
          && (alwaysCrits
            || (hasAbility(attacker, 'Merciless') && (defender.status === 'psn' || defender.status === 'tox'))
            || this.prng.randomChance(1, denom));

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
          case 'beatup': {
            // One strike per healthy team-mate; power scales off their Attack.
            const side = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
            const healthy = side.team.filter((p) => !p.fainted && !p.status);
            const striker = healthy[Math.min(hitIndex, healthy.length - 1)] ?? attacker;
            basePower = 5 + Math.floor(striker.species.baseStats.atk / 10);
            break;
          }
          case 'finalgambit':
            // The user spends its remaining HP as damage.
            basePower = 0;
            break;
          case 'comeuppance': case 'metalburst': {
            const taken = attacker.damageTakenThisTurn;
            basePower = taken ? 0 : 0;
            break;
          }
          case 'flail': case 'reversal': {
            const ratio = Math.floor((attacker.hp * 48) / attacker.maxhp);
            basePower = ratio < 2 ? 200 : ratio < 5 ? 150 : ratio < 10 ? 100
              : ratio < 17 ? 80 : ratio < 33 ? 40 : 20;
            break;
          }
          case 'crushgrip': case 'hardpress': case 'wringout': {
            const cap = move.id === 'hardpress' ? 100 : 120;
            basePower = Math.max(1, Math.floor((cap * defender.hp) / defender.maxhp));
            break;
          }
          case 'spitup': {
            if (attacker.stockpile <= 0) { basePower = 0; break; }
            basePower = 100 * attacker.stockpile;
            attacker.stockpile = 0;
            break;
          }
          case 'fling': {
            basePower = FLING_POWER[attacker.itemId] ?? (attacker.itemId ? 30 : 0);
            break;
          }
          case 'present':
            // 20/40/80 power, or a heal 20% of the time.
            basePower = [40, 40, 80, 120][this.prng.random(4)]!;
            break;
          case 'facade':
            if (attacker.status === 'brn' || attacker.status === 'par'
              || attacker.status === 'psn' || attacker.status === 'tox') basePower *= 2;
            break;
          case 'hex': case 'infernalparade':
            if (defender.status) basePower *= 2;
            break;
          case 'acrobatics':
            if (!attacker.itemId) basePower *= 2;
            break;
          case 'avalanche': case 'revenge':
            if (attacker.damageTakenThisTurn) basePower *= 2;
            break;
          case 'payback': {
            const foeInfo = this.turnInfo[attacker.sideId === 'p1' ? 'p2' : 'p1'];
            if (foeInfo?.moved) basePower *= 2;
            break;
          }
          case 'storedpower': case 'powertrip': {
            const positive = (Object.values(attacker.boosts) as number[])
              .reduce((sum, v) => sum + Math.max(0, v), 0);
            basePower = 20 + 20 * positive;
            break;
          }
          case 'ragefist':
            basePower = Math.min(350, 50 + 50 * attacker.timesHit);
            break;
          case 'weatherball': {
            const w = this.effectiveWeather;
            if (w) basePower *= 2;
            break;
          }
          case 'hydrosteam':
            // 1.5x in sun. The damage formula halves Water moves in sun, so
            // tripling here nets the intended 1.5x.
            if (this.effectiveWeather === 'sunnyday') basePower *= 3;
            break;
          case 'expandingforce':
            if (this.terrain === 'psychicterrain' && isGrounded(attacker, this.gravityTurns > 0)) {
              basePower = Math.floor(basePower * 1.5);
            }
            break;
          case 'risingvoltage':
            if (this.terrain === 'electricterrain' && isGrounded(defender, this.gravityTurns > 0)) basePower *= 2;
            break;
          case 'psyblade':
            if (this.terrain === 'electricterrain' && isGrounded(attacker, this.gravityTurns > 0)) {
              basePower = Math.floor(basePower * 1.5);
            }
            break;
          case 'collisioncourse': case 'electrodrift':
            if (moveEffectiveness(move.id, move.type, defender.types) > 1) {
              basePower = Math.floor(basePower * 4 / 3);
            }
            break;
          case 'fickblebeam': case 'ficklebeam':
            if (this.prng.randomChance(3, 10)) {
              basePower *= 2;
              this.add('-activate', attacker.activeIdent, 'move: Fickle Beam');
            }
            break;
          case 'grassknot': case 'lowkick': {
            const kg = defender.species.weightkg ?? 50;
            basePower = kg >= 200 ? 120 : kg >= 100 ? 100 : kg >= 50 ? 80 : kg >= 25 ? 60 : kg >= 10 ? 40 : 20;
            break;
          }
          case 'heavyslam': case 'heatcrash': {
            const ratio = ((attacker.species.weightkg ?? 50) * attacker.weightFactor)
              / Math.max(0.1, (defender.species.weightkg ?? 50) * defender.weightFactor);
            basePower = ratio >= 5 ? 120 : ratio >= 4 ? 100 : ratio >= 3 ? 80 : ratio >= 2 ? 60 : 40;
            break;
          }
        }
        const pinchType = PINCH_ABILITIES[attacker.ability];
        if (pinchType === move.type && attacker.hp <= Math.floor(attacker.maxhp / 3)) {
          basePower = Math.floor(basePower * 1.5); // Blaze/Torrent/Overgrow/Swarm
        }
        if (move.id === 'knockoff' && defender.itemId) {
          basePower = Math.floor(basePower * 1.5);
        }
        if (attacker.hasVolatile('charge') && move.type === 'Electric') {
          basePower = Math.floor(basePower * 2);
          attacker.removeVolatile('charge');
        }
        if (attacker.hasVolatile('flashfire') && move.type === 'Fire') {
          basePower = Math.floor(basePower * 1.5);
        }
        if (defenderHasAbility(attacker, defender, 'Thick Fat') && (move.type === 'Fire' || move.type === 'Ice')) {
          basePower = Math.floor(basePower * 0.5);
        }
        // Offensive ability power modifiers.
        if (hasAbility(attacker, 'Technician') && basePower <= 60) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Tough Claws') && move.flags.contact) basePower = Math.floor(basePower * 1.3);
        if (hasAbility(attacker, 'Strong Jaw') && move.flags.bite) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Iron Fist') && move.flags.punch) basePower = Math.floor(basePower * 1.2);
        if (hasAbility(attacker, 'Sharpness') && move.flags.slicing) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Mega Launcher') && move.flags.pulse) basePower = Math.floor(basePower * 1.5);
        if (hasAbility(attacker, 'Punk Rock') && move.flags.sound) basePower = Math.floor(basePower * 1.3);
        if (hasAbility(attacker, 'Reckless') && (move.recoil || move.id === 'highjumpkick' || move.id === 'jumpkick')) {
          basePower = Math.floor(basePower * 1.2);
        }
        // Type-specialist abilities.
        const specialist = TYPE_SPECIALISTS[attacker.ability];
        if (specialist && specialist.type === move.type) {
          basePower = Math.floor(basePower * specialist.mult);
        }
        // Stakeout: double against something that just came in.
        if (hasAbility(attacker, 'Stakeout') && defender.switchedInThisTurn) {
          basePower = Math.floor(basePower * 2);
        }
        // Analytic: 1.3x when moving after the target.
        if (hasAbility(attacker, 'Analytic')) {
          const foeInfo = this.turnInfo[attacker.sideId === 'p1' ? 'p2' : 'p1'];
          if (foeInfo?.moved) basePower = Math.floor(basePower * 1.3);
        }
        // Defensive power cuts.
        if (defenderHasAbility(attacker, defender, 'Heatproof') && move.type === 'Fire') basePower = Math.floor(basePower * 0.5);
        if (defenderHasAbility(attacker, defender, 'Punk Rock') && move.flags.sound) basePower = Math.floor(basePower * 0.5);
        if (defenderHasAbility(attacker, defender, 'Purifying Salt') && move.type === 'Ghost') basePower = Math.floor(basePower * 0.5);
        if (defenderHasAbility(attacker, defender, 'Fluffy')) {
          if (move.flags.contact) basePower = Math.floor(basePower * 0.5);
          if (move.type === 'Fire') basePower = Math.floor(basePower * 2);
        }
        if (hasAbility(attacker, 'Sand Force') && this.weather === 'sandstorm'
          && (move.type === 'Rock' || move.type === 'Ground' || move.type === 'Steel')) {
          basePower = Math.floor(basePower * 1.3);
        }
        // Terrain boosts its own type for a grounded user, and Grassy Terrain
        // muffles ground-shaking moves.
        if (this.terrain && isGrounded(attacker, this.gravityTurns > 0)
          && move.type === TERRAIN_BOOST_TYPE[this.terrain]
          && this.terrain !== 'mistyterrain') {
          basePower = Math.floor(basePower * 1.3);
        }
        if (this.terrain === 'mistyterrain' && isGrounded(defender, this.gravityTurns > 0) && move.type === 'Dragon') {
          basePower = Math.floor(basePower * 0.5);
        }
        if (this.terrain === 'grassyterrain' && isGrounded(defender, this.gravityTurns > 0)
          && (move.id === 'earthquake' || move.id === 'bulldoze' || move.id === 'magnitude')) {
          basePower = Math.floor(basePower * 0.5);
        }
        // Aura abilities boost their type for everyone on the field.
        const auraOn = (name: string): boolean =>
          [this.sides.p1.active, this.sides.p2.active]
            .some((p) => !!p && !p.fainted && hasAbility(p, name));
        const auraBreak = auraOn('Aura Break');
        if ((move.type === 'Dark' && auraOn('Dark Aura'))
          || (move.type === 'Fairy' && auraOn('Fairy Aura'))) {
          basePower = Math.floor(basePower * (auraBreak ? 0.75 : 4 / 3));
        }
        // Supreme Overlord: +10% per fallen team-mate.
        if (hasAbility(attacker, 'Supreme Overlord')) {
          const side = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
          const fallen = Math.min(5, side.team.filter((p) => p.fainted).length);
          if (fallen) basePower = Math.floor(basePower * (1 + 0.1 * fallen));
        }
        if (sheerForce) basePower = Math.floor(basePower * 1.3);
        // Held item power modifiers.
        const typeBoost = TYPE_BOOST_ITEMS[attacker.itemId];
        if (typeBoost === move.type) basePower = Math.floor(basePower * 1.2);
        const signature = SIGNATURE_ITEMS[attacker.itemId];
        if (signature && signature.species.includes(attacker.species.id)
          && signature.types.includes(move.type)) {
          basePower = Math.floor(basePower * signature.mult);
        }
        // Punching Glove powers up punches (and stops them making contact).
        if (attacker.itemId === 'punchingglove' && move.flags.punch) {
          basePower = Math.floor(basePower * 1.1);
        }
        if (attacker.itemId === 'muscleband' && move.category === 'Physical') basePower = Math.floor(basePower * 1.1);
        if (attacker.itemId === 'wiseglasses' && move.category === 'Special') basePower = Math.floor(basePower * 1.1);

        // Foul Play attacks with the TARGET's Attack stat.
        const useFoeAttack = move.id === 'foulplay';
        // Unaware ignores the other side's stat stages entirely.
        const foeUnaware = defenderHasAbility(attacker, defender, 'Unaware');
        const myUnaware = hasAbility(attacker, 'Unaware');
        let attackStat = useFoeAttack
          ? defender.getStat('atk')
          : move.overrideOffensiveStat === 'def'
          ? attacker.getStat('def', { ignoreBoosts: foeUnaware || (crit && attacker.boosts.def < 0) }) // Body Press
          : move.category === 'Physical'
            ? attacker.getStat('atk', { ignoreBoosts: foeUnaware || (crit && attacker.boosts.atk < 0) })
            : attacker.getStat('spa', { ignoreBoosts: foeUnaware || (crit && attacker.boosts.spa < 0) });
        if (move.category === 'Physical' && hasAbility(attacker, 'Huge Power', 'Pure Power')) {
          attackStat *= 2;
        }
        // Rivalry: same-gender rivals hit harder. Gender is not modelled, so
        // this uses the species pair as a stand-in for "same kind".
        if (hasAbility(attacker, 'Rivalry') && attacker.species.id === defender.species.id) {
          basePower = Math.floor(basePower * 1.25);
        }
        // Parental Bond adds a weaker second strike (folded in as +25%).
        if (hasAbility(attacker, 'Parental Bond') && !move.multihit) {
          basePower = Math.floor(basePower * 1.25);
        }
        // Defeatist halves both attacking stats below half HP.
        if (hasAbility(attacker, 'Defeatist') && attacker.hp <= Math.floor(attacker.maxhp / 2)) {
          attackStat = Math.floor(attackStat * 0.5);
        }
        // Gorilla Tactics boosts Attack at the cost of a Choice lock.
        if (move.category === 'Physical' && hasAbility(attacker, 'Gorilla Tactics')) {
          attackStat = Math.floor(attackStat * 1.5);
        }
        // Hustle trades accuracy (see accuracyCheck) for physical power.
        if (move.category === 'Physical' && hasAbility(attacker, 'Hustle')) {
          attackStat = Math.floor(attackStat * 1.5);
        }
        // Protosynthesis / Quark Drive boost the holder's best stat.
        const boostedAtkStat = move.category === 'Physical' ? 'atk' : 'spa';
        if (attacker.boostedStat === boostedAtkStat) {
          attackStat = Math.floor(attackStat * 1.3);
        }
        // Hadron Engine / Orichalcum Pulse power up in their own field state.
        if (move.category === 'Physical' && hasAbility(attacker, 'Orichalcum Pulse')
          && this.weather === 'sunnyday') {
          attackStat = Math.floor(attackStat * 4 / 3);
        }
        if (move.category === 'Special' && hasAbility(attacker, 'Hadron Engine')
          && this.terrain === 'electricterrain') {
          attackStat = Math.floor(attackStat * 4 / 3);
        }
        // Ruin abilities on the OTHER side sap the relevant offensive stat.
        if (move.category === 'Physical' && defenderHasAbility(attacker, defender, 'Tablets of Ruin')) {
          attackStat = Math.floor(attackStat * 0.75);
        }
        if (move.category === 'Special' && defenderHasAbility(attacker, defender, 'Vessel of Ruin')) {
          attackStat = Math.floor(attackStat * 0.75);
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

        let hitsDefense = move.category === 'Physical'
          || move.id === 'psyshock' || move.id === 'psystrike' || move.id === 'secretsword';
        // Wonder Room trades Defence for Sp. Def on both sides.
        if (this.wonderRoomTurns > 0) hitsDefense = !hitsDefense;
        let defenseStat = hitsDefense
          ? defender.getStat('def', { ignoreBoosts: myUnaware || (crit && defender.boosts.def > 0) })
          : defender.getStat('spd', { ignoreBoosts: myUnaware || (crit && defender.boosts.spd > 0) });
        const boostedDefStat = move.category === 'Physical' ? 'def' : 'spd';
        if (defender.boostedStat === boostedDefStat) {
          defenseStat = Math.floor(defenseStat * 1.3);
        }
        if (move.category === 'Physical' && hasAbility(attacker, 'Sword of Ruin')) {
          defenseStat = Math.floor(defenseStat * 0.75);
        }
        if (move.category === 'Special' && hasAbility(attacker, 'Beads of Ruin')) {
          defenseStat = Math.floor(defenseStat * 0.75);
        }
        // Grass Pelt firms up the holder's Defence in Grassy Terrain.
        if (hitsDefense && hasAbility(defender, 'Grass Pelt')
          && this.terrain === 'grassyterrain') {
          defenseStat = Math.floor(defenseStat * 1.5);
        }
        if (move.category === 'Physical') {
          if (defenderHasAbility(attacker, defender, 'Fur Coat')) defenseStat *= 2;
          if (defenderHasAbility(attacker, defender, 'Marvel Scale') && defender.status) defenseStat = Math.floor(defenseStat * 1.5);
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
          moveId: move.id,
          attackStat,
          defenseStat,
          attackerTypes: isStruggle ? [] : attacker.types,
          defenderTypes: isStruggle ? [] : effTypesSafe,
          isCrit: crit,
          // Guts and Facade both ignore the burn's halving.
          isBurned: attacker.status === 'brn' && !guts && move.id !== 'facade',
          prng: this.prng,
          weather: this.weather,
          stabMultiplier: hasAbility(attacker, 'Adaptability') ? 2 : 1.5,
        }).damage;
        damage = result;

        // Final damage multipliers.
        if (defenderHasAbility(attacker, defender, 'Multiscale', 'Shadow Shield') && defender.hp === defender.maxhp) {
          damage = Math.floor(damage * 0.5);
        }
        if (defenderHasAbility(attacker, defender, 'Ice Scales') && move.category === 'Special') {
          damage = Math.floor(damage * 0.5);
        }
        if (defenderHasAbility(attacker, defender, 'Filter', 'Solid Rock', 'Prism Armor') && eff > 1) {
          damage = Math.floor(damage * 0.75);
        }
        // Reflect / Light Screen / Aurora Veil, ignored by a critical hit.
        if (!crit) {
          const screen = this.screenMultiplier(defender, move.category as 'Physical' | 'Special');
          if (screen !== 1) damage = Math.floor(damage * screen);
        }
        // A Glaive Rush user takes double damage until it acts again.
        if (defender.hasVolatile('glaiverush')) damage *= 2;
        // Neuroforce sharpens an already-super-effective hit.
        if (hasAbility(attacker, 'Neuroforce') && eff > 1) {
          damage = Math.floor(damage * 1.25);
        }
        // Tinted Lens: resisted hits land at full strength.
        if (hasAbility(attacker, 'Tinted Lens') && eff > 0 && eff < 1) {
          damage = Math.floor(damage * 2);
        }
        // Sniper: crits hit even harder.
        if (crit && hasAbility(attacker, 'Sniper')) {
          damage = Math.floor(damage * 1.5);
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
      if (sub && !move.flags.sound && !hasAbility(attacker, 'Infiltrator')) {
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

      if (dealt0Illusion(defender)) {
        this.add('-end', defender.activeIdent, 'Illusion');
        defender.illusionOf = null;
      }
      const dealt = defender.damage(damage);
      totalDealt += dealt;
      actualHits++;
      if (dealt > 0) {
        defender.tookDamageThisTurn = true; // breaks Focus Punch
        if (move.category === 'Physical' || move.category === 'Special') {
          defender.damageTakenThisTurn = { amount: dealt, category: move.category };
          defender.timesHit++;
        }
        if (defender.itemId === 'airballoon') {
          defender.consumeItem();
          this.add('-enditem', defender.activeIdent, 'Air Balloon');
        }
      }

      if (crit) { anyCrit = true; this.add('-crit', defender.activeIdent); }
      if (!isStruggle && !move.ohko && move.damage === undefined) {
        if (eff > 1) this.add('-supereffective', defender.activeIdent);
        else if (eff < 1) this.add('-resisted', defender.activeIdent);
      }
      this.add('-damage', defender.activeIdent, defender.condition);
      if (move.ohko) this.add('-ohko');

      if (defender.fainted) break;
    }

    // Scrappy's temporary Ghost removal only lasts for this move.
    if (restoreTypes) defender.types = restoreTypes;

    if (Array.isArray(move.multihit) || (typeof move.multihit === 'number' && move.multihit > 1)) {
      this.add('-hitcount', defender.activeIdent, actualHits);
    }

    // Drain / recoil.
    if (move.drain && totalDealt > 0 && !attacker.fainted
      && defenderHasAbility(attacker, defender, 'Liquid Ooze')) {
      // Liquid Ooze turns the drain into damage.
      const amount = Math.max(1, Math.floor((totalDealt * move.drain[0]) / move.drain[1]));
      this.add('-ability', defender.activeIdent, 'Liquid Ooze');
      attacker.damage(amount);
      this.add('-damage', attacker.activeIdent, attacker.condition, '[from] ability: Liquid Ooze');
      this.checkFaint(attacker);
    } else if (move.drain && totalDealt > 0 && !attacker.fainted) {
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
        if (secondary.boosts) this.applyBoosts(defender, secondary.boosts, attacker);
        if (secondary.self?.boosts) this.applyBoosts(attacker, secondary.self.boosts);
      }
    }

    // Contact consequences for the attacker.
    if (makesContact(attacker, move) && totalDealt > 0 && !attacker.fainted) {
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
    const berryThreshold = hasAbility(defender, 'Gluttony') ? 2 : 2;
    if (!defender.fainted && defender.itemId === 'sitrusberry'
      && defender.hp <= Math.floor(defender.maxhp / berryThreshold)
      && !this.berriesSuppressed(defender)) {
      defender.consumeItem();
      this.add('-enditem', defender.activeIdent, 'Sitrus Berry');
      // Ripen doubles a berry's effect.
      defender.heal(Math.floor(defender.maxhp / (hasAbility(defender, 'Ripen') ? 2 : 4)));
      this.add('-heal', defender.activeIdent, defender.condition, '[from] item: Sitrus Berry');
      // Cheek Pouch adds its own heal on top of any berry.
      if (hasAbility(defender, 'Cheek Pouch')
        && defender.heal(Math.floor(defender.maxhp / 3)) > 0) {
        this.add('-heal', defender.activeIdent, defender.condition, '[from] ability: Cheek Pouch');
      }
    }
    // Guaranteed self boosts on damaging moves (e.g. Dragon Dance is Status,
    // but Close Combat's drop arrives via move.self).
    if (move.self?.boosts && !attacker.fainted) {
      this.applyBoosts(attacker, move.self.boosts);
    }

    // Knock Off removes the target's item (and was 50% stronger for it).
    if (move.id === 'knockoff' && totalDealt > 0 && !defender.fainted
      && defender.itemId && !defenderHasAbility(attacker, defender, 'Sticky Hold')) {
      this.add('-enditem', defender.activeIdent, defender.itemName, '[from] move: Knock Off');
      defender.consumeItem();
    }
    // Rapid Spin sweeps the user's own hazards and boosts Speed.
    if ((move.id === 'rapidspin' || move.id === 'mortalspin') && totalDealt > 0) {
      const mySide = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
      this.clearHazards(mySide, move.name);
      attacker.removeVolatile('partiallytrapped');
      this.applyBoosts(attacker, { spe: 1 });
    }

    // Clear Smog resets whatever the target had built up.
    if (move.id === 'clearsmog' && totalDealt > 0 && !defender.fainted) {
      defender.boosts = emptyBoosts();
      this.add('-clearboost', defender.activeIdent);
    }

    // Sparkling Aria's whole gimmick: it cures the target's burn.
    if (move.id === 'sparklingaria' && totalDealt > 0 && defender.status === 'brn') {
      this.add('-curestatus', defender.activeIdent, 'brn', '[from] move: Sparkling Aria');
      defender.cureStatus();
    }

    // A guaranteed volatile carried by a DAMAGING move — Infestation, Whirlpool,
    // Fire Spin, Sand Tomb, Bind, Salt Cure. This was only ever applied on the
    // status-move path, so every binding attack did its damage and nothing else.
    if (move.volatileStatus && totalDealt > 0 && !defender.fainted) {
      this.tryAddVolatile(defender, move.volatileStatus, attacker, true);
    }

    // Static: contact moves have a 30% chance to paralyze the attacker.
    if (hasAbility(defender, 'Static') && makesContact(attacker, move) && totalDealt > 0
      && !attacker.fainted && this.prng.randomChance(3, 10)) {
      this.add('-ability', defender.activeIdent, 'Static');
      this.trySetStatus(attacker, 'par', true);
    }

    // Cursed Body: a 30% chance to disable whatever just hit.
    if (totalDealt > 0 && !attacker.fainted
      && defenderHasAbility(attacker, defender, 'Cursed Body')
      && !attacker.hasVolatile('disable') && this.prng.randomChance(3, 10)) {
      this.add('-ability', defender.activeIdent, 'Cursed Body');
      attacker.addVolatile('disable', { turns: 5, moveId: move.id });
      this.add('-start', attacker.activeIdent, 'Disable', move.name);
    }

    // Contact reactions on the DEFENDER.
    if (makesContact(attacker, move) && totalDealt > 0 && !attacker.fainted) {
      if (hasAbility(defender, 'Gooey', 'Tangling Hair')) {
        this.add('-ability', defender.activeIdent, defender.ability);
        this.applyBoosts(attacker, { spe: -1 }, defender);
      }
      if (hasAbility(defender, 'Cute Charm') && this.prng.randomChance(3, 10)) {
        this.add('-ability', defender.activeIdent, 'Cute Charm');
        this.tryAddVolatile(attacker, 'attract', defender, true);
      }
    }

    // Item stealing. Sticky Hold refuses to let go.
    if (totalDealt > 0 && move.flags.contact && !attacker.fainted
      && defender.itemId && !attacker.itemId
      && !defenderHasAbility(attacker, defender, 'Sticky Hold')) {
      if (hasAbility(attacker, 'Magician')) {
        this.add('-ability', attacker.activeIdent, 'Magician');
        this.stealItem(attacker, defender);
      }
    }
    if (totalDealt > 0 && move.flags.contact && !defender.fainted
      && attacker.itemId && !defender.itemId
      && hasAbility(defender, 'Pickpocket') && !hasAbility(attacker, 'Sticky Hold')) {
      this.add('-ability', defender.activeIdent, 'Pickpocket');
      this.stealItem(defender, attacker);
    }

    // Offensive contact/secondary abilities on the ATTACKER.
    if (totalDealt > 0 && !defender.fainted) {
      if (makesContact(attacker, move) && hasAbility(attacker, 'Poison Touch') && this.prng.randomChance(3, 10)) {
        this.add('-ability', attacker.activeIdent, 'Poison Touch');
        this.trySetStatus(defender, 'psn', true);
      }
      if (hasAbility(attacker, 'Toxic Chain') && this.prng.randomChance(3, 10)) {
        this.add('-ability', attacker.activeIdent, 'Toxic Chain');
        this.trySetStatus(defender, 'tox', true);
      }
    }

    // White Herb undoes any stat drop the moment it happens.
    for (const p of [attacker, defender]) {
      if (p.itemId !== 'whiteherb' || p.fainted) continue;
      const lowered = (Object.keys(p.boosts) as BoostID[]).filter((k) => p.boosts[k] < 0);
      if (!lowered.length) continue;
      for (const k of lowered) p.boosts[k] = 0;
      p.consumeItem();
      this.add('-enditem', p.activeIdent, 'White Herb');
      this.add('-clearnegativeboost', p.activeIdent, '[silent]');
    }
    // Throat Spray rewards a sound move.
    if (move.flags.sound && !attacker.fainted && attacker.itemId === 'throatspray') {
      attacker.consumeItem();
      this.add('-enditem', attacker.activeIdent, 'Throat Spray');
      this.applyBoosts(attacker, { spa: 1 });
    }

    // Defensive reactions to simply being hit.
    if (totalDealt > 0 && !defender.fainted) {
      if (hasAbility(defender, 'Stamina')) {
        this.add('-ability', defender.activeIdent, 'Stamina');
        this.applyBoosts(defender, { def: 1 });
      }
      if (hasAbility(defender, 'Weak Armor') && move.category === 'Physical') {
        this.add('-ability', defender.activeIdent, 'Weak Armor');
        this.applyBoosts(defender, { def: -1, spe: 2 });
      }
      if (hasAbility(defender, 'Electromorphosis')
        || (hasAbility(defender, 'Wind Power') && move.flags.wind)) {
        if (defender.addVolatile('charge')) {
          this.add('-start', defender.activeIdent, 'Charge', `[from] ability: ${defender.ability}`);
        }
      }
      if (hasAbility(defender, 'Toxic Debris') && move.category === 'Physical') {
        const foeSide = attacker.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
        if (!foeSide.sideConditions.has('toxicspikes')) {
          foeSide.sideConditions.set('toxicspikes', { layers: 1 });
          this.add('-ability', defender.activeIdent, 'Toxic Debris');
          this.add('-sidestart', `${foeSide.id}: ${foeSide.name}`, 'move: Toxic Spikes');
        }
      }
      if (hasAbility(defender, 'Water Compaction') && move.type === 'Water') {
        this.add('-ability', defender.activeIdent, 'Water Compaction');
        this.applyBoosts(defender, { def: 2 });
      }
      if (hasAbility(defender, 'Rattled')
        && (move.type === 'Bug' || move.type === 'Dark' || move.type === 'Ghost')) {
        this.add('-ability', defender.activeIdent, 'Rattled');
        this.applyBoosts(defender, { spe: 1 });
      }
      if (hasAbility(defender, 'Steam Engine')
        && (move.type === 'Fire' || move.type === 'Water')) {
        this.add('-ability', defender.activeIdent, 'Steam Engine');
        this.applyBoosts(defender, { spe: 6 });
      }
      if (hasAbility(defender, 'Sand Spit') && this.weather !== 'sandstorm') {
        this.add('-ability', defender.activeIdent, 'Sand Spit');
        this.weather = 'sandstorm';
        this.weatherTurns = 5;
        this.add('-weather', WEATHER_NAMES.sandstorm);
      }
      if (hasAbility(defender, 'Cotton Down')) {
        this.add('-ability', defender.activeIdent, 'Cotton Down');
        this.applyBoosts(attacker, { spe: -1 }, defender);
      }
      if (hasAbility(defender, 'Color Change') && !defender.types.includes(move.type)) {
        defender.types = [move.type];
        this.add('-start', defender.activeIdent, 'typechange', move.type,
          '[from] ability: Color Change');
      }
      if (anyCrit && hasAbility(defender, 'Anger Point')) {
        this.add('-ability', defender.activeIdent, 'Anger Point');
        defender.boosts.atk = 6;
        this.add('-setboost', defender.activeIdent, 'atk', 6);
      }
      // Contact abilities that change or punish the attacker's ability.
      if (makesContact(attacker, move) && !attacker.fainted) {
        if (hasAbility(defender, 'Mummy', 'Lingering Aroma')) {
          this.add('-ability', attacker.activeIdent, defender.ability,
            `[from] ability: ${defender.ability}`);
          attacker.ability = defender.ability;
        } else if (hasAbility(defender, 'Wandering Spirit')) {
          const mine = attacker.ability;
          attacker.ability = defender.ability;
          defender.ability = mine;
          this.add('-activate', defender.activeIdent, 'ability: Wandering Spirit');
        }
        if (hasAbility(defender, 'Perish Body') && attacker.perishTurns === 0) {
          this.add('-ability', defender.activeIdent, 'Perish Body');
          attacker.perishTurns = 4;
          defender.perishTurns = 4;
        }
      }

      // Innards Out pays the attacker back for the KO.
      if (defender.fainted && hasAbility(defender, 'Innards Out') && !attacker.fainted) {
        this.add('-ability', defender.activeIdent, 'Innards Out');
        attacker.damage(totalDealt);
        this.add('-damage', attacker.activeIdent, attacker.condition, '[from] ability: Innards Out');
        this.checkFaint(attacker);
      }
      // Wimp Out / Emergency Exit bail out at half HP.
      const halfHp = Math.floor(defender.maxhp / 2);
      if (defender.hp <= halfHp && defender.hp + totalDealt > halfHp && !defender.fainted
        && hasAbility(defender, 'Wimp Out', 'Emergency Exit')) {
        const side = defender.sideId === 'p1' ? this.sides.p1 : this.sides.p2;
        if (side.team.some((p, i) => i !== side.activeIndex && !p.fainted)) {
          this.add('-ability', defender.activeIdent, defender.ability);
          this.selfSwitchSide = side;
        }
      }
      // Berserk / Anger Shell trigger on crossing half HP.
      const half = Math.floor(defender.maxhp / 2);
      if (defender.hp <= half && defender.hp + totalDealt > half) {
        if (hasAbility(defender, 'Berserk')) {
          this.add('-ability', defender.activeIdent, 'Berserk');
          this.applyBoosts(defender, { spa: 1 });
        } else if (hasAbility(defender, 'Anger Shell')) {
          this.add('-ability', defender.activeIdent, 'Anger Shell');
          this.applyBoosts(defender, { atk: 1, spa: 1, spe: 1, def: -1, spd: -1 });
        }
      }
    }

    this.checkFaint(defender, attacker);
    // Moxie-style abilities: a KO fuels the attacker.
    if (defender.fainted && !attacker.fainted) {
      if (hasAbility(attacker, 'Beast Boost')) {
        this.add('-ability', attacker.activeIdent, 'Beast Boost');
        this.applyBoosts(attacker, { [attacker.highestStat()]: 1 });
      }
      if (hasAbility(attacker, 'Soul-Heart')) {
        this.add('-ability', attacker.activeIdent, 'Soul-Heart');
        this.applyBoosts(attacker, { spa: 1 });
      }
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
    if (breaksMold(attacker)) return false; // Mold Breaker / Teravolt / Turboblaze
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
    const absorb = hasAbility(defender, 'Water Absorb', 'Dry Skin') && move.type === 'Water'
      ? defender.ability
      : hasAbility(defender, 'Volt Absorb') && move.type === 'Electric' ? 'Volt Absorb'
        : hasAbility(defender, 'Earth Eater') && move.type === 'Ground' ? 'Earth Eater'
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

    // Absorb-and-boost abilities: immune to a type, and rewarded for it.
    const BOOST_ABSORB: Record<string, { type: TypeName; boosts: Partial<BoostsTable> }> = {
      'Sap Sipper': { type: 'Grass', boosts: { atk: 1 } },
      'Lightning Rod': { type: 'Electric', boosts: { spa: 1 } },
      'Storm Drain': { type: 'Water', boosts: { spa: 1 } },
      'Motor Drive': { type: 'Electric', boosts: { spe: 1 } },
      'Well-Baked Body': { type: 'Fire', boosts: { def: 2 } },
    };
    const boostAbsorb = BOOST_ABSORB[defender.ability];
    if (boostAbsorb && move.type === boostAbsorb.type) {
      this.add('-immune', defender.activeIdent, `[from] ability: ${defender.ability}`);
      this.applyBoosts(defender, boostAbsorb.boosts);
      return true;
    }

    // Wind Rider: immune to wind moves, and gains Attack from them.
    if (hasAbility(defender, 'Wind Rider') && move.flags.wind) {
      this.add('-immune', defender.activeIdent, '[from] ability: Wind Rider');
      this.applyBoosts(defender, { atk: 1 });
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------

  /**
   * Returns true if any stage actually changed.
   *
   * `source` is the Pokémon responsible. Only a FOE-inflicted drop triggers the
   * protective and retaliatory abilities (Clear Body, Defiant, ...) — a
   * self-inflicted drop like Close Combat's must not.
   */
  private applyBoosts(
    target: BattlePokemon,
    boosts: Partial<Record<BoostID, number>>,
    source?: BattlePokemon,
  ): boolean {
    if (target.fainted) return false;
    const fromFoe = !!source && source.sideId !== target.sideId;

    // Simple doubles every stage change the holder receives.
    if (hasAbility(target, 'Simple')) {
      const doubled: Partial<Record<BoostID, number>> = {};
      for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
        doubled[stat] = delta * 2;
      }
      boosts = doubled;
    }
    // Contrary inverts every stage change aimed at the holder.
    if (hasAbility(target, 'Contrary')) {
      const flipped: Partial<Record<BoostID, number>> = {};
      for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
        flipped[stat] = -delta;
      }
      boosts = flipped;
    }

    const lowering = (Object.values(boosts) as number[]).some((d) => d < 0);

    if (fromFoe && lowering) {
      // Blanket stat-drop protection.
      if (hasAbility(target, 'Clear Body', 'White Smoke', 'Full Metal Body')) {
        this.add('-fail', target.activeIdent, `[from] ability: ${target.ability}`);
        return false;
      }
      // Mirror Armor bounces the drop back at the attacker instead.
      if (hasAbility(target, 'Mirror Armor')) {
        this.add('-ability', target.activeIdent, 'Mirror Armor');
        const bounced: Partial<Record<BoostID, number>> = {};
        for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
          if (delta < 0) bounced[stat] = delta;
        }
        this.applyBoosts(source, bounced);
        return false;
      }
      // Per-stat guards.
      const GUARDS: Partial<Record<BoostID, string[]>> = {
        atk: ['Hyper Cutter'],
        def: ['Big Pecks'],
        accuracy: ['Keen Eye', "Mind's Eye"],
      };
      const kept: Partial<Record<BoostID, number>> = {};
      for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
        if (delta < 0 && hasAbility(target, ...(GUARDS[stat] ?? []))) {
          this.add('-fail', target.activeIdent, `[from] ability: ${target.ability}`);
          continue;
        }
        kept[stat] = delta;
      }
      boosts = kept;
    }

    let changed = false;
    let loweredByFoe = false;
    for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
      if (!delta) continue;
      const applied = addBoost(target.boosts, stat, delta);
      if (applied === 0) continue;
      changed = true;
      if (applied < 0 && fromFoe) loweredByFoe = true;
      this.add(applied > 0 ? '-boost' : '-unboost', target.activeIdent, stat, Math.abs(applied));
    }

    // Opportunist mirrors any boost the opponent gains.
    if (changed && !fromFoe) {
      const other = target.sideId === 'p1' ? this.sides.p2.active : this.sides.p1.active;
      const gains: Partial<Record<BoostID, number>> = {};
      let any = false;
      for (const [stat, delta] of Object.entries(boosts) as [BoostID, number][]) {
        if (delta > 0) { gains[stat] = delta; any = true; }
      }
      if (any && other && !other.fainted && hasAbility(other, 'Opportunist')
        && !other.hasVolatile('copyingboost')) {
        other.addVolatile('copyingboost');
        this.add('-ability', other.activeIdent, 'Opportunist');
        this.applyBoosts(other, gains);
        other.removeVolatile('copyingboost');
      }
    }

    // Defiant / Competitive answer a foe's stat drop with a sharp raise.
    if (loweredByFoe && !target.fainted) {
      if (hasAbility(target, 'Defiant')) {
        this.add('-ability', target.activeIdent, 'Defiant');
        this.applyBoosts(target, { atk: 2 });
      } else if (hasAbility(target, 'Competitive')) {
        this.add('-ability', target.activeIdent, 'Competitive');
        this.applyBoosts(target, { spa: 2 });
      }
    }
    return changed;
  }

  /** Returns true if the status was applied (silent=true skips the fail message). */
  private trySetStatus(
    target: BattlePokemon,
    status: StatusID,
    silent = false,
    source?: BattlePokemon,
  ): boolean {
    if (target.fainted) return false;
    let abilityImmune = hasAbility(target, ...(STATUS_IMMUNE_ABILITY[status] ?? []));
    // Blanket status immunities.
    if (hasAbility(target, 'Purifying Salt', 'Good as Gold', 'Comatose')) abilityImmune = true;
    if (hasAbility(target, 'Leaf Guard') && this.weather === 'sunnyday') abilityImmune = true;
    if (hasAbility(target, 'Flower Veil') && target.types.includes('Grass')) abilityImmune = true;
    if (hasAbility(target, 'Sweet Veil') && status === 'slp') abilityImmune = true;
    if (hasAbility(target, 'Pastel Veil') && (status === 'psn' || status === 'tox')) {
      abilityImmune = true;
    }
    // Terrain protects whoever is standing in it.
    if (isGrounded(target, this.gravityTurns > 0)) {
      if (this.terrain === 'mistyterrain') abilityImmune = true;
      if (this.terrain === 'electricterrain' && status === 'slp') abilityImmune = true;
    }
    // Corrosion lets its user poison Steel and Poison types anyway.
    const corrosive = !!source && hasAbility(source, 'Corrosion')
      && (status === 'psn' || status === 'tox');
    if (corrosive) {
      if (target.status) {
        if (!silent) this.add('-fail', target.activeIdent);
        return false;
      }
      abilityImmune = false;
    }
    if (target.status || (!corrosive && isStatusImmune(target, status)) || abilityImmune) {
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
    // Synchronize passes the status straight back to whoever inflicted it.
    if (source && source !== target && hasAbility(target, 'Synchronize')
      && (status === 'brn' || status === 'par' || status === 'psn' || status === 'tox')) {
      this.add('-ability', target.activeIdent, 'Synchronize');
      this.trySetStatus(source, status, true);
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

    if (id === 'curse') {
      if (source.types.includes('Ghost')) {
        const cost = Math.floor(source.maxhp / 2);
        if (source.hp <= cost) { if (!silent) this.add('-fail', source.activeIdent); return false; }
        source.damage(cost);
        this.add('-damage', source.activeIdent, source.condition);
        target.addVolatile('curse');
        this.add('-start', target.activeIdent, 'Curse');
        this.checkFaint(source);
        return true;
      }
      // Non-Ghost Curse is a pure stat trade on the user.
      this.applyBoosts(source, { atk: 1, def: 1, spe: -1 });
      return true;
    }
    if (id === 'noretreat') {
      if (source.hasVolatile('noretreat')) { if (!silent) this.add('-fail', source.activeIdent); return false; }
      source.addVolatile('noretreat');
      source.addVolatile('trapped');   // the cost: it can never switch out
      this.add('-start', source.activeIdent, 'move: No Retreat');
      this.applyBoosts(source, { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 });
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
    // Steadfast turns a flinch into a Speed boost.
    if (id === 'flinch' && hasAbility(target, 'Steadfast')) {
      this.add('-ability', target.activeIdent, 'Steadfast');
      this.applyBoosts(target, { spe: 1 });
      return false;
    }
    // Aroma Veil shrugs off every move that restricts choices; Oblivious is
    // narrower (Taunt and Attract only).
    const MIND_VOLATILES = ['taunt', 'encore', 'disable', 'attract', 'healblock'];
    if (MIND_VOLATILES.includes(id) && hasAbility(target, 'Aroma Veil')) {
      if (!silent) this.add('-immune', target.activeIdent, '[from] ability: Aroma Veil');
      return false;
    }
    if ((id === 'taunt' || id === 'attract') && hasAbility(target, 'Oblivious')) {
      if (!silent) this.add('-immune', target.activeIdent, '[from] ability: Oblivious');
      return false;
    }
    // Poison Puppeteer: this user's poison also confuses.
    if (id === 'confusion' && hasAbility(source, 'Poison Puppeteer')
      && !(target.status === 'psn' || target.status === 'tox')) {
      return false;
    }

    if (target.hasVolatile(id)) {
      if (!silent) this.add('-fail', target.activeIdent);
      return false;
    }

    const state: { turns?: number; bindingBand?: boolean; moveId?: string } = {};
    if (id === 'confusion') state.turns = this.prng.random(2, 6); // 2-5 attack attempts
    if (id === 'partiallytrapped') {
      // 5 turns with a Grip Claw, otherwise 4-5.
      state.turns = source.itemId === 'gripclaw' ? 6 : this.prng.random(5, 7);
      state.bindingBand = source.itemId === 'bindingband';
    }
    if (id === 'taunt') state.turns = 4;       // this turn + 3
    if (id === 'healblock') state.turns = 6;
    if (id === 'magnetrise') state.turns = 6;
    if (id === 'yawn') state.turns = 2;        // asleep at the end of next turn
    if (id === 'encore') {
      const last = target.lastMoveId;
      // Encore needs something to lock the target into.
      if (!last || !target.moveSlots.some((s) => s.move.id === last && s.pp > 0)) {
        if (!silent) this.add('-fail', target.activeIdent);
        return false;
      }
      state.turns = 4;
      state.moveId = last;
    }
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
        for (const s of [this.sides.p1, this.sides.p2]) {
          if (s.active) this.updateBoosterState(s.active);
        }
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

    // A Wish made two turns ago lands now.
    for (const side of [this.sides.p1, this.sides.p2]) {
      if (side.wishTurns <= 0) continue;
      side.wishTurns--;
      if (side.wishTurns > 0) continue;
      const p = side.active;
      if (p && !p.fainted && p.heal(side.wishHp) > 0) {
        this.add('-heal', p.activeIdent, p.condition, '[from] move: Wish');
      }
      side.wishHp = 0;
    }

    // Screens, Tailwind and Trick Room all run out.
    for (const side of [this.sides.p1, this.sides.p2]) {
      for (const [id, state] of [...side.sideConditions]) {
        if (state.turns === undefined) continue;
        const left = state.turns - 1;
        if (left <= 0) {
          side.sideConditions.delete(id);
          this.add('-sideend', `${side.id}: ${side.name}`, `move: ${id}`);
        } else {
          state.turns = left;
        }
      }
    }
    if (this.trickRoomTurns > 0) {
      this.trickRoomTurns--;
      if (this.trickRoomTurns === 0) this.add('-fieldend', 'move: Trick Room');
    }
    for (const [field, label] of [
      ['gravityTurns', 'Gravity'], ['magicRoomTurns', 'Magic Room'],
      ['wonderRoomTurns', 'Wonder Room'], ['fairyLockTurns', 'Fairy Lock'],
    ] as const) {
      if (this[field] > 0) {
        this[field]--;
        if (this[field] === 0) this.add('-fieldend', `move: ${label}`);
      }
    }

    // Perish Song counts everyone down to zero.
    for (const side of [this.sides.p1, this.sides.p2]) {
      const p = side.active;
      if (!p || p.fainted || p.perishTurns <= 0) continue;
      p.perishTurns--;
      if (p.perishTurns <= 0) {
        this.add('-start', p.activeIdent, 'perish0');
        p.damage(p.hp);
        this.checkFaint(p);
      } else {
        this.add('-start', p.activeIdent, `perish${p.perishTurns}`);
      }
    }

    // Terrain ticks down, and Grassy Terrain heals whoever stands in it.
    if (this.terrain) {
      this.terrainTurns--;
      if (this.terrainTurns <= 0) {
        this.add('-fieldend', `move: ${TERRAIN_NAMES[this.terrain]}`);
        this.terrain = '';
        for (const s of [this.sides.p1, this.sides.p2]) {
          if (s.active) this.updateBoosterState(s.active);
        }
      } else if (this.terrain === 'grassyterrain') {
        for (const s of [this.sides.p1, this.sides.p2]) {
          const p = s.active;
          if (!p || p.fainted || !isGrounded(p, this.gravityTurns > 0)) continue;
          if (p.heal(Math.floor(p.maxhp / 16)) > 0) {
            this.add('-heal', p.activeIdent, p.condition, '[from] Grassy Terrain');
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
      // Bad Dreams gnaws at a sleeping opponent.
      const foeOf = (side.id === 'p1' ? this.sides.p2 : this.sides.p1).active;
      if (foeOf && !foeOf.fainted && hasAbility(foeOf, 'Bad Dreams')
        && pokemon.status === 'slp' && !guardsIndirect(pokemon)) {
        pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 8)));
        this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] ability: Bad Dreams');
        this.checkFaint(pokemon);
        if (pokemon.fainted) continue;
      }
      // Harvest / Cud Chew hand a consumed berry back.
      if (!pokemon.itemId && pokemon.lastItemId.endsWith('berry')
        && (hasAbility(pokemon, 'Cud Chew')
          || (hasAbility(pokemon, 'Harvest')
            && (this.weather === 'sunnyday' || this.prng.randomChance(1, 2))))) {
        pokemon.item = pokemon.lastItemId;
        pokemon.itemId = pokemon.lastItemId;
        pokemon.itemName = pokemon.lastItemId;
        pokemon.itemLost = false;
        this.add('-item', pokemon.activeIdent, pokemon.itemName, `[from] ability: ${pokemon.ability}`);
      }
      // Chesto Berry wakes its holder; Leppa Berry restores PP.
      if (pokemon.status === 'slp' && pokemon.itemId === 'chestoberry'
        && !this.berriesSuppressed(pokemon)) {
        pokemon.consumeItem();
        this.add('-enditem', pokemon.activeIdent, 'Chesto Berry');
        this.add('-curestatus', pokemon.activeIdent, 'slp', '[from] item: Chesto Berry');
        pokemon.cureStatus();
      }
      if (pokemon.itemId === 'leppaberry' && !this.berriesSuppressed(pokemon)) {
        const empty = pokemon.moveSlots.find((m) => m.pp === 0);
        if (empty) {
          pokemon.consumeItem();
          empty.pp = Math.min(empty.maxpp, 10);
          this.add('-enditem', pokemon.activeIdent, 'Leppa Berry');
        }
      }
      // Moody: one stat up sharply, another down, every turn.
      if (hasAbility(pokemon, 'Moody')) {
        const stats: BoostID[] = ['atk', 'def', 'spa', 'spd', 'spe'];
        const up = stats[this.prng.random(stats.length)]!;
        const down = stats.filter((k) => k !== up)[this.prng.random(stats.length - 1)]!;
        this.add('-ability', pokemon.activeIdent, 'Moody');
        this.applyBoosts(pokemon, { [up]: 2, [down]: -1 });
      }
      // Shed Skin: a third of the time, shrug the status off.
      if (pokemon.status && hasAbility(pokemon, 'Shed Skin') && this.prng.randomChance(1, 3)) {
        this.add('-curestatus', pokemon.activeIdent, pokemon.status, '[from] ability: Shed Skin');
        pokemon.cureStatus();
      }
      // Hydration: rain washes status away.
      if (pokemon.status && hasAbility(pokemon, 'Hydration') && this.weather === 'raindance') {
        this.add('-curestatus', pokemon.activeIdent, pokemon.status, '[from] ability: Hydration');
        pokemon.cureStatus();
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

      // Binding moves (Infestation, Whirlpool, Magma Storm, Fire Spin...).
      // These were added to the volatile map and announced, but nothing ever
      // ticked them, so the whole family did nothing at all.
      const bind = pokemon.volatiles.get('partiallytrapped');
      if (bind && !pokemon.fainted) {
        const left = (bind.turns ?? 0) - 1;
        if (left <= 0) {
          pokemon.removeVolatile('partiallytrapped');
          this.add('-end', pokemon.activeIdent, 'partiallytrapped');
        } else {
          bind.turns = left;
          if (!guardsIndirect(pokemon)) {
            // 1/6 per turn, or 1/4 for a Binding Band holder.
            const denom = bind.bindingBand ? 4 : 6;
            pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / denom)));
            this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] partiallytrapped');
            this.checkFaint(pokemon);
          }
        }
      }

      // Curse: the Ghost's parting gift, 1/4 per turn.
      if (pokemon.hasVolatile('curse') && !pokemon.fainted && !guardsIndirect(pokemon)) {
        pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / 4)));
        this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] Curse');
        this.checkFaint(pokemon);
      }
      if (pokemon.fainted) continue;

      // Salt Cure: 1/8, doubled against Water and Steel types.
      if (pokemon.hasVolatile('saltcure') && !pokemon.fainted && !guardsIndirect(pokemon)) {
        const heavy = pokemon.types.some((t) => t === 'Water' || t === 'Steel');
        pokemon.damage(Math.max(1, Math.floor(pokemon.maxhp / (heavy ? 4 : 8))));
        this.add('-damage', pokemon.activeIdent, pokemon.condition, '[from] Salt Cure');
        this.checkFaint(pokemon);
      }

      if (pokemon.fainted) continue;

      // Yawn: drowsy this turn, asleep at the end of the next one.
      const yawn = pokemon.volatiles.get('yawn');
      if (yawn) {
        const left = (yawn.turns ?? 1) - 1;
        if (left <= 0) {
          pokemon.removeVolatile('yawn');
          this.trySetStatus(pokemon, 'slp');
        } else {
          yawn.turns = left;
        }
      }

      // Timed disables tick down at end of turn.
      for (const id of ['taunt', 'encore', 'healblock', 'magnetrise', 'disable'] as const) {
        const state = pokemon.volatiles.get(id);
        if (!state) continue;
        const left = (state.turns ?? 1) - 1;
        if (left <= 0) {
          pokemon.removeVolatile(id);
          this.add('-end', pokemon.activeIdent, `move: ${id}`);
        } else {
          state.turns = left;
        }
      }
    }

    // Clear one-turn volatiles; break Protect chains that weren't extended.
    for (const side of [this.sides.p1, this.sides.p2]) {
      const pokemon = side.active;
      if (!pokemon) continue;
      pokemon.switchedInThisTurn = false;
      if (pokemon.removeVolatile('roost')) {
        pokemon.types = [...pokemon.species.types]; // Flying comes back
      }
      pokemon.removeVolatile('protect');
      pokemon.removeVolatile('flinch');
      if (!pokemon.removeVolatile('usedstall')) {
        pokemon.removeVolatile('stall');
      }
    }
  }

  /** Move `from`'s held item to `to` (Magician / Pickpocket). */
  private stealItem(to: BattlePokemon, from: BattlePokemon): void {
    const item = from.itemName;
    const id = from.itemId;
    from.consumeItem();
    to.item = item;
    to.itemId = id;
    to.itemName = item;
    to.itemLost = false;
    this.add('-item', to.activeIdent, item, `[from] ${to.activeIdent}`);
  }

  /** True while an Unnerve-style ability on the field suppresses berries. */
  private berriesSuppressed(pokemon: BattlePokemon): boolean {
    const foe = (pokemon.sideId === 'p1' ? this.sides.p2 : this.sides.p1).active;
    return !!foe && !foe.fainted
      && hasAbility(foe, 'Unnerve', 'As One (Glastrier)', 'As One (Spectrier)');
  }

  private checkFaint(pokemon: BattlePokemon, killer?: BattlePokemon): void {
    if (!pokemon.fainted || pokemon.hasVolatile('faintemitted')) return;
    pokemon.addVolatile('faintemitted');
    this.add('faint', pokemon.activeIdent);

    // Destiny Bond drags the attacker down with it.
    if (pokemon.hasVolatile('destinybond') && killer && !killer.fainted) {
      this.add('-activate', pokemon.activeIdent, 'move: Destiny Bond');
      killer.damage(killer.hp);
      killer.addVolatile('faintemitted');
      this.add('faint', killer.activeIdent);
    }

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
