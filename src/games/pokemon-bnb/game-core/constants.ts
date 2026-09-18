// Rulebook constants for the Pokemon TCG B&B mini battle engine (transcribed
// from the Pokemon TCG rulebook, not guessed).
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

// -- Rulebook constants (transcribed, not guessed) --

/** Official opening hand size. */
export const OPENING_HAND_SIZE = 7
/** Prize cards taken at setup. */
export const PRIZE_COUNT = 6
/** Bench slot cap per side. */
export const MAX_BENCH = 5
/** Auto-bench target on setup. */
export const BENCH_TARGET = 3
/** One energy attachment per Pokemon per turn. */
export const ENERGY_PER_TURN = 1
/** One retreat per Pokemon per turn. */
export const RETREATS_PER_TURN = 1
/** Poison damage at Checkup. */
export const POISON_DAMAGE = 20
/** Burn damage at Checkup. */
export const BURN_DAMAGE = 20
/** Confusion self-hit damage. The 50% chance itself is modelled in CP7-D as
 * `randomInt(rng, 2) === 0` so it stays integer-only and seed-replayable. */
export const CONFUSION_SELF_DAMAGE = 30
/** Timer options (seconds); 0 = timer disabled. */
export const TURN_TIMER_DEFAULTS: number[] = [45, 60, 90]
/** B&B mini: no first-turn attack restriction. */
export const FIRST_TURN_ATTACK_OK = true
