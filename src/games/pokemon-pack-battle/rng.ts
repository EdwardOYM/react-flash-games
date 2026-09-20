// Deterministic, browser-identical PRNG (xorshift32) + seeded Fisher-Yates
// for 04-pokemon-pack-battle. Re-implements the 03 pokemon-bnb rng as a
// self-contained module so the pack-battle namespace never imports engine
// internals it does not own. Integer-only math: host and guest derive the
// exact same pack pools from a single shared lobby seed.
export type PackBattleRng = { next(): number }

/** Create an xorshift32 generator from a 32-bit seed. */
export function createPackBattleRng(seed: number): PackBattleRng {
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

/** Fresh lobby seed for the host, broadcast in `lobby-start`. */
export function randomPackBattleSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff)
}

/** Random integer in [0, max). */
export function packBattleRandomInt(rng: PackBattleRng, max: number): number {
  return rng.next() % max
}

/** In-place Fisher-Yates shuffle driven by the seeded rng. */
export function packBattleShuffle<T>(items: T[], rng: PackBattleRng): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const swap = packBattleRandomInt(rng, index + 1)
    const temp = items[index]
    items[index] = items[swap]
    items[swap] = temp
  }
  return items
}

/** Pick one element uniformly. */
export function packBattlePick<T>(items: readonly T[], rng: PackBattleRng): T {
  return items[packBattleRandomInt(rng, items.length)]
}
