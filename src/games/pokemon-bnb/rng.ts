// Deterministic, browser-identical PRNG (xorshift32) + seeded Fisher-Yates.
// Integer-only math: no floating point anywhere, so host and guest derive the
// exact same pack pools and shuffles from a single shared lobby seed.

export type Rng = { next(): number }

/** Create an xorshift32 generator from a 32-bit seed. */
export function createRng(seed: number): Rng {
  // Scramble weak seeds (e.g. small integers) so nearby seeds diverge.
  let state = (seed | 0) ^ 0x9e3779b9
  if (state === 0) state = 0x6d2b79f5
  return {
    next() {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state >>> 0
    },
  }
}

/**
 * Fresh lobby seed for the host. The value is broadcast in `lobby-start`, so
 * both players derive the same packs from it; it is never shared before that.
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff)
}

/** Random integer in [0, max). */
export function randomInt(rng: Rng, max: number): number {
  return rng.next() % max
}

/** In-place Fisher-Yates shuffle driven by the seeded rng. */
export function shuffleCards<T>(items: T[], rng: Rng): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const swap = randomInt(rng, index + 1)
    const temp = items[index]
    items[index] = items[swap]
    items[swap] = temp
  }
  return items
}

/** Pick one element uniformly. */
export function pickUniform<T>(items: readonly T[], rng: Rng): T {
  return items[randomInt(rng, items.length)]
}
