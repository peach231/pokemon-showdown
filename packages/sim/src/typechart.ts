import type { TypeName } from './types.js';

/**
 * Gen 6+ type effectiveness chart: TYPE_CHART[attacking][defending] = multiplier.
 * Only non-neutral matchups are listed; anything omitted is 1x (neutral).
 * This is deliberately embedded (it is tiny and stable) rather than pulled from
 * the data package, so the core damage math has no external dependency.
 */
export const TYPE_CHART: Record<TypeName, Partial<Record<TypeName, number>>> = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fighting: { Normal: 2, Rock: 2, Steel: 2, Ice: 2, Dark: 2, Flying: 0.5, Poison: 0.5, Bug: 0.5, Psychic: 0.5, Fairy: 0.5, Ghost: 0 },
  Flying: { Fighting: 2, Bug: 2, Grass: 2, Rock: 0.5, Steel: 0.5, Electric: 0.5 },
  Poison: { Grass: 2, Fairy: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0 },
  Ground: { Poison: 2, Rock: 2, Steel: 2, Fire: 2, Electric: 2, Bug: 0.5, Grass: 0.5, Flying: 0 },
  Rock: { Flying: 2, Bug: 2, Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Steel: 0.5 },
  Bug: { Grass: 2, Psychic: 2, Dark: 2, Fighting: 0.5, Flying: 0.5, Poison: 0.5, Ghost: 0.5, Steel: 0.5, Fire: 0.5, Fairy: 0.5 },
  Ghost: { Ghost: 2, Psychic: 2, Dark: 0.5, Normal: 0 },
  Steel: { Rock: 2, Ice: 2, Fairy: 2, Steel: 0.5, Fire: 0.5, Water: 0.5, Electric: 0.5 },
  Fire: { Bug: 2, Steel: 2, Grass: 2, Ice: 2, Rock: 0.5, Fire: 0.5, Water: 0.5, Dragon: 0.5 },
  Water: { Ground: 2, Rock: 2, Fire: 2, Water: 0.5, Grass: 0.5, Dragon: 0.5 },
  Grass: { Ground: 2, Rock: 2, Water: 2, Flying: 0.5, Poison: 0.5, Bug: 0.5, Steel: 0.5, Fire: 0.5, Grass: 0.5, Dragon: 0.5 },
  Electric: { Flying: 2, Water: 2, Grass: 0.5, Electric: 0.5, Dragon: 0.5, Ground: 0 },
  Psychic: { Fighting: 2, Poison: 2, Steel: 0.5, Psychic: 0.5, Dark: 0 },
  Ice: { Flying: 2, Ground: 2, Grass: 2, Dragon: 2, Steel: 0.5, Fire: 0.5, Water: 0.5, Ice: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Ghost: 2, Psychic: 2, Fighting: 0.5, Dark: 0.5, Fairy: 0.5 },
  Fairy: { Fighting: 2, Dragon: 2, Dark: 2, Poison: 0.5, Steel: 0.5, Fire: 0.5 },
};

/** Effectiveness of a single attacking type against a single defending type. */
export function singleTypeEffectiveness(attacking: TypeName, defending: TypeName): number {
  return TYPE_CHART[attacking][defending] ?? 1;
}

/**
 * Total effectiveness of a move type against a (possibly dual-typed) defender.
 * Returns 0 (immune), 0.25, 0.5, 1, 2, or 4.
 */
export function typeEffectiveness(moveType: TypeName, defenderTypes: readonly TypeName[]): number {
  let mult = 1;
  for (const t of defenderTypes) {
    mult *= singleTypeEffectiveness(moveType, t);
  }
  return mult;
}
