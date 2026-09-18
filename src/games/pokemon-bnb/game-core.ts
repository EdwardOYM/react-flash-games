// Pure rulebook battle engine for Pokemon TCG B&B mini. No React, no DOM,
// no network: setupBattle + processAction + toSnapshot/applySnapshot drive
// both the local hot-seat harness (CP7) and the host-authoritative P2P sync
// (CP9). All randomness is the seeded xorshift32 Rng so both seats can replay
// the same match from the same seed.
//
// Mini-format adaptations (documented, deliberate — see B&B plan):
// - OPENING_HAND_SIZE = 7 per the real rulebook. The "4" value from the
//   pre-checkpoint draft is deliberately discarded here.
// - BENCH_TARGET = 3 (rulebook: auto-bench as many Basics as fit, up to 5).
// - prizeCards comes from LobbySettings; decks smaller than prizeCards just
//   have a thinner prize area (placePrizes clamps to deck size).
// - Evolutions in 30C have no `evolvesFrom` links in TCGdex data — CP7-B uses
//   name-chain + stage matching.
//
// Rulebook sources: Pokemon TCG Rulebook (pokemon.com), Bulbapedia "Rulings",
// "Pokemon Checkup", and "Setting Up to Play" articles.

import type { CardDef, PokemonCardDef } from './cards'
import type { LobbySettings, PlayerSlot } from './net/protocol'
import { createRng, shuffleCards, type Rng, randomInt } from './rng'

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

export const STATUS_CONDITIONS = ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'] as const
export type StatusCondition = (typeof STATUS_CONDITIONS)[number]

export type ZoneKind = 'deck' | 'hand' | 'active' | 'bench' | 'prize' | 'discard' | 'lostZone' | 'energy'
export type TurnPhase = 'draw' | 'main' | 'end'
export type SpecialConditionState = Record<StatusCondition, boolean>

export type InPlayPokemon = {
  uid: string
  card: PokemonCardDef
  damage: number
  attachedEnergy: string[]
  conditions: SpecialConditionState
  enteredTurn: number
  evolvedTurn: number
  energyAttachedTurn: number
  retreatedTurn: number
  abilityUsedTurn: number
}

export type SideState = {
  deck: CardDef[]
  hand: CardDef[]
  active: InPlayPokemon | null
  bench: InPlayPokemon[]
  prizes: CardDef[]
  prizeCount: number
  discard: CardDef[]
  lostZone: CardDef[]
  supporterPlayedTurn: boolean
  mulliganCount: number
}

export type BattleState = {
  host: SideState
  guest: SideState
  activePlayer: PlayerSlot
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: 'prizes' | 'deck-out' | 'no-pokemon' | null
  over: boolean
  seed: number
  prizeCards: number
  timerSeconds: number
  log: string[]
  rngDraws: number
}

export type SnapshotSide = {
  handCount: number
  deckCount: number
  prizesTaken: number
  prizeCount: number
  discard: CardDef[]
  active: InPlayPokemon | null
  bench: InPlayPokemon[]
  hand: CardDef[] | null
}

export type Snapshot = {
  activePlayer: PlayerSlot
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: BattleState['winReason']
  over: boolean
  prizeCards: number
  timerSeconds: number
  log: string[]
  host: SnapshotSide
  guest: SnapshotSide
}

export type BattleAction =
  | { type: 'attachEnergy'; handIndex: number; target: 'active' | number }
  | { type: 'playTrainer'; handIndex: number }
  | { type: 'evolve'; handIndex: number; target: 'active' | number }
  | { type: 'retreatToBench'; benchIndex: number }
  | { type: 'useAttack'; attackIndex: number }
  | { type: 'endTurn' }

export type ActionResult = { state: BattleState; log: string[]; error?: string }

// -- Pure helpers --

export function sideOf(state: BattleState, slot: PlayerSlot): SideState {
  return slot === 'host' ? state.host : state.guest
}

export function foeOf(slot: PlayerSlot): PlayerSlot {
  return slot === 'host' ? 'guest' : 'host'
}

function pushLog(state: BattleState, line: string): void {
  state.log.push(line)
}

/**
 * Weakness multiplier from the verbatim card-data value string.
 * "×2" -> 2, "×3" -> 3, anything else -> 1 (no weakness).
 * Future sets use the same shape and need no engine changes.
 */
export function weaknessMultiplier(value: string): number {
  if (value.includes('×3')) return 3
  if (value.includes('×')) return 2
  return 1
}

/**
 * Resistance reduction from the verbatim card-data value string.
 * "-30" -> 30, "-20" -> 20, anything else -> 0.
 */
export function resistanceReduction(value: string): number {
  const match = value.match(/-(\d+)/)
  return match ? Number(match[1]) : 0
}

function makeInPlay(card: PokemonCardDef, enteredTurn: number): InPlayPokemon {
  const empty: SpecialConditionState = {
    asleep: false,
    paralyzed: false,
    confused: false,
    poisoned: false,
    burned: false,
  }
  return {
    uid: `${card.id}#${enteredTurn}`,
    card,
    damage: 0,
    attachedEnergy: [],
    conditions: empty,
    enteredTurn,
    evolvedTurn: 0,
    energyAttachedTurn: 0,
    retreatedTurn: 0,
    abilityUsedTurn: 0,
  }
}

export function effectiveHp(pokemon: InPlayPokemon): number {
  return pokemon.card.hp
}

export function isKnockedOut(pokemon: InPlayPokemon): boolean {
  return pokemon.damage >= effectiveHp(pokemon)
}

/** Basics are Pokemon with stage === 'Basic'. */
function basicsIn(hand: CardDef[]): number[] {
  const indexes: number[] = []
  hand.forEach((card, index) => {
    if (card.supertype === 'pokemon' && (card as PokemonCardDef).stage === 'Basic') {
      indexes.push(index)
    }
  })
  return indexes
}

/** Opening coin flip, seeded: winner of the flip goes first. */
export function openingFlip(rng: Rng): PlayerSlot {
  return randomInt(rng, 2) === 0 ? 'host' : 'guest'
}

export function sideEmpty(): SideState {
  return {
    deck: [],
    hand: [],
    active: null,
    bench: [],
    prizes: [],
    prizeCount: PRIZE_COUNT,
    discard: [],
    lostZone: [],
    supporterPlayedTurn: false,
    mulliganCount: 0,
  }
}

/** Draw up to `count` from the top of the deck into hand. */
function drawCards(side: SideState, count: number): CardDef[] {
  const drawn: CardDef[] = []
  for (let index = 0; index < count; index++) {
    const card = side.deck.shift()
    if (!card) break
    side.hand.push(card)
    drawn.push(card)
  }
  return drawn
}

/**
 * Place prize cards from the top of the deck. Clamps to deck size so
 * thin mini-format pools never start with negative prizes.
 */
function placePrizes(side: SideState, count: number): void {
  const prizes = Math.min(count, side.deck.length)
  for (let index = 0; index < prizes; index++) {
    const card = side.deck.shift()
    if (card) side.prizes.push(card)
  }
  side.prizeCount = prizes
}

/**
 * Mulligan: no Basic in hand — shuffle, draw again, opponent draws 1 extra.
 * Per rulebook, repeated until a Basic is present or the deck runs out.
 */
function resolveMulligans(state: BattleState, rng: Rng): void {
  for (const slot of ['host', 'guest'] as const) {
    const side = sideOf(state, slot)
    const foe = sideOf(state, foeOf(slot))
    let guard = 0
    while (basicsIn(side.hand).length === 0 && side.deck.length > 0 && guard < 10) {
      guard += 1
      side.mulliganCount += 1
      side.deck.push(...side.hand.splice(0))
      shuffleCards(side.deck, rng)
      drawCards(side, OPENING_HAND_SIZE)
      drawCards(foe, 1)
    }
  }
}

/**
 * Rulebook setup: deck zones, opening hand, face-down Active/Bench/Prize
 * (counts from rulebook), shuffle, mulligan, and the opening flip.
 *
 * Deterministic: same seed + decks -> identical BattleState, so host and
 * guest always agree.
 */
export function setupBattle(
  settings: LobbySettings,
  hostDeck: CardDef[],
  guestDeck: CardDef[],
  seed: number,
): BattleState {
  // Count every rng.next() through one wrapper so both seats (and the CP7-G
  // determinism check) can assert an identical draw count for a shared seed.
  let rngCalls = 0
  const base = createRng(seed)
  const rng: Rng = {
    next() {
      rngCalls += 1
      return base.next()
    },
  }
  const state: BattleState = {
    host: sideEmpty(),
    guest: sideEmpty(),
    activePlayer: 'host',
    turn: 0,
    phase: 'main',
    winner: null,
    winReason: null,
    over: false,
    seed,
    prizeCards: settings.prizeCards,
    timerSeconds: settings.timerSeconds,
    log: [],
    rngDraws: 0,
  }

  state.host.deck = shuffleCards([...hostDeck], rng)
  state.guest.deck = shuffleCards([...guestDeck], rng)

  drawCards(state.host, OPENING_HAND_SIZE)
  drawCards(state.guest, OPENING_HAND_SIZE)

  resolveMulligans(state, rng)

  const first = openingFlip(rng)
  const second = foeOf(first)
  state.activePlayer = first
  pushLog(state, `coin: ${first} wins the opening flip and goes first`)

  // Place Active + Bench for both players (rulebook: choose 1 Basic for
  // Active, then bench Basics up to the bench limit).
  for (const slot of [first, second] as const) {
    const side = sideOf(state, slot)
    const basicIndexes = basicsIn(side.hand)
    if (basicIndexes.length === 0) {
      pushLog(state, `${slot} has no basic pokemon to start`)
      continue
    }
    const pick = basicIndexes[randomInt(rng, basicIndexes.length)]
    const [card] = side.hand.splice(pick, 1)
    side.active = makeInPlay(card as PokemonCardDef, 0)

    while (side.bench.length < Math.min(BENCH_TARGET, MAX_BENCH) && basicsIn(side.hand).length > 0) {
      const remaining = basicsIn(side.hand)
      const [benched] = side.hand.splice(remaining[0], 1)
      side.bench.push(makeInPlay(benched as PokemonCardDef, 0))
    }

    placePrizes(side, settings.prizeCards)
  }

  // Loser of the flip draws one extra card.
  drawCards(sideOf(state, second), 1)

  if (state.host.mulliganCount > 0) pushLog(state, `host mulligans x${state.host.mulliganCount}`)
  if (state.guest.mulliganCount > 0) pushLog(state, `guest mulligans x${state.guest.mulliganCount}`)

  state.rngDraws = rngCalls
  return state
}


