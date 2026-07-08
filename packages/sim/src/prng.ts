/**
 * Deterministic, seedable pseudo-random number generator.
 *
 * Uses the `sfc32` algorithm (128-bit state) seeded from a string via `cyrb128`.
 * The full internal state is serializable, so a battle's RNG can be snapshotted
 * and restored exactly. This determinism is what makes replays byte-identical:
 * same seed + same choices => same crits, damage rolls, accuracy, and speed ties.
 *
 * Mirrors the surface of Pokemon Showdown's `sim/prng.ts` (random/randomChance/
 * sample/shuffle) but with a simpler, dependency-free core.
 */

export type PRNGState = [number, number, number, number];
export type PRNGSeed = string | PRNGState;

/** Hash a string into four 32-bit seed words (cyrb128 by bryc, public domain). */
function cyrb128(str: string): PRNGState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

export class PRNG {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /** The seed this generator was originally constructed from (for logging/replay). */
  readonly initialSeed: PRNGSeed;

  constructor(seed?: PRNGSeed) {
    if (seed === undefined) seed = `${1}-fixed-default-seed`;
    this.initialSeed = seed;
    const state = typeof seed === 'string' ? cyrb128(seed) : seed;
    [this.a, this.b, this.c, this.d] = state;
    // Warm up so low-entropy string seeds diffuse before first use.
    // (State arrays are exact snapshots and must NOT be advanced.)
    if (typeof seed === 'string') {
      for (let i = 0; i < 15; i++) this.next32();
    }
  }

  /** Current internal state; pass back to the constructor to resume exactly. */
  getState(): PRNGState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  clone(): PRNG {
    return new PRNG(this.getState());
  }

  /** Raw sfc32 step -> unsigned 32-bit integer. */
  private next32(): number {
    const a = this.a | 0;
    const b = this.b | 0;
    const c = this.c | 0;
    const d = this.d | 0;
    const t = (((a + b) | 0) + d) | 0;
    this.d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    this.c = (c << 21) | (c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Float in [0, 1). */
  nextFloat(): number {
    return this.next32() / 4294967296;
  }

  /**
   * Random integer.
   *  - random(n)      -> integer in [0, n)
   *  - random(m, n)   -> integer in [m, n)
   *  - random()       -> integer in [0, 2^32)
   */
  random(from?: number, to?: number): number {
    if (from === undefined) return this.next32();
    if (to === undefined) {
      to = from;
      from = 0;
    }
    return from + Math.floor(this.nextFloat() * (to - from));
  }

  /** True with probability numerator/denominator. */
  randomChance(numerator: number, denominator: number): boolean {
    return this.random(denominator) < numerator;
  }

  /** Uniformly pick one element (returns undefined for an empty array). */
  sample<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot sample from an empty array');
    }
    return items[this.random(items.length)] as T;
  }

  /** In-place Fisher-Yates shuffle over [start, end). Used for speed ties. */
  shuffle<T>(items: T[], start = 0, end = items.length): void {
    while (start < end - 1) {
      const nextIndex = this.random(start, end);
      if (start !== nextIndex) {
        [items[start], items[nextIndex]] = [items[nextIndex] as T, items[start] as T];
      }
      start++;
    }
  }
}
