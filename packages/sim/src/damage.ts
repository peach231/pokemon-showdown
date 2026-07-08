import type { TypeName, MoveCategory, WeatherID } from './types.js';
import { singleTypeEffectiveness, typeEffectiveness } from './typechart.js';
import type { PRNG } from './prng.js';

export interface DamageInput {
  level: number;
  basePower: number;
  category: Exclude<MoveCategory, 'Status'>;
  moveType: TypeName;
  /** Effective (already boost-adjusted) attacking stat: atk for Physical, spa for Special. */
  attackStat: number;
  /** Effective (already boost-adjusted) defending stat: def for Physical, spd for Special. */
  defenseStat: number;
  attackerTypes: readonly TypeName[];
  defenderTypes: readonly TypeName[];
  isCrit: boolean;
  /** Attacker has a burn, move is physical, and no burn-negating ability. */
  isBurned: boolean;
  /** STAB multiplier (1.5 normal, 2 with Adaptability). Defaults to 1.5. */
  stabMultiplier?: number;
  /** Crit damage multiplier. Defaults to 1.5 (Gen 6+). */
  critMultiplier?: number;
  /** Fixed 0..15 damage roll for deterministic tests; otherwise drawn from `prng`. */
  randomRoll?: number;
  prng?: PRNG;
  /** Active weather: rain boosts Water/halves Fire; sun boosts Fire/halves Water. */
  weather?: WeatherID;
}

export interface DamageResult {
  damage: number;
  /** 0, 0.25, 0.5, 1, 2, or 4. */
  effectiveness: number;
  crit: boolean;
}

/**
 * The main-series damage formula with the simplified modifier order from the plan:
 * base -> crit -> random(0.85-1.00) -> STAB -> type effectiveness -> burn -> floor at 1.
 * (EVs/IVs/natures are absent; stats are passed in already computed and boosted.)
 */
export function calculateDamage(input: DamageInput): DamageResult {
  const {
    level,
    basePower,
    moveType,
    attackStat,
    defenseStat,
    attackerTypes,
    defenderTypes,
    isCrit,
    isBurned,
  } = input;

  const stabMultiplier = input.stabMultiplier ?? 1.5;
  const critMultiplier = input.critMultiplier ?? 1.5;

  const eff = typeEffectiveness(moveType, defenderTypes);
  if (eff === 0 || basePower <= 0) {
    return { damage: 0, effectiveness: eff, crit: isCrit };
  }

  // Base damage.
  let damage = Math.floor(
    Math.floor((Math.floor((2 * level) / 5 + 2) * basePower * attackStat) / defenseStat) / 50,
  ) + 2;

  // Weather (applied before crit, as in the games).
  if (input.weather === 'raindance') {
    if (moveType === 'Water') damage = Math.floor(damage * 1.5);
    else if (moveType === 'Fire') damage = Math.floor(damage * 0.5);
  } else if (input.weather === 'sunnyday') {
    if (moveType === 'Fire') damage = Math.floor(damage * 1.5);
    else if (moveType === 'Water') damage = Math.floor(damage * 0.5);
  }

  // Critical hit.
  if (isCrit) damage = Math.floor(damage * critMultiplier);

  // Random factor: multiply by (100 - roll)/100 for roll in [0, 15] => 0.85x .. 1.00x.
  const roll = input.randomRoll ?? input.prng?.random(16) ?? 0;
  damage = Math.floor((damage * (100 - roll)) / 100);

  // STAB.
  if (attackerTypes.includes(moveType)) {
    damage = Math.floor(damage * stabMultiplier);
  }

  // Type effectiveness, applied stepwise with truncation (mirrors the cartridge).
  for (const t of defenderTypes) {
    const m = singleTypeEffectiveness(moveType, t);
    if (m === 2) damage *= 2;
    else if (m === 0.5) damage = Math.floor(damage * 0.5);
    // m === 1: no change; m === 0 already returned above.
  }

  // Burn halves physical damage.
  if (isBurned && input.category === 'Physical') {
    damage = Math.floor(damage * 0.5);
  }

  if (damage < 1) damage = 1;

  return { damage, effectiveness: eff, crit: isCrit };
}
