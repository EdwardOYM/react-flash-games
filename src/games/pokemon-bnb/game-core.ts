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
// - Evolutions in 30C carry no `evolvesFrom` links (verified: 0 occurrences in
//   cards.json), so CP7-B matches by stage progression + a shared type, and
//   falls back to name matching when a future set does supply `evolvesFrom`.
// - `InPlayPokemon.attachedEnergy` holds Energy cards, not ids, because attack
//   costs are checked against each card's `provides`.
// - `state.log` holds structured `{ key, params }` entries, never English copy:
//   the log strip is player-facing status text, so templates are translated in
//   the UI while card names stay verbatim data.
// - Attacks resolve through `resolveAttack`: damage modifiers, Weakness and
//   Resistance (parsed from the verbatim value strings), damage, card-text
//   clauses, then the Knock Out. (Named `declareAttack`, not the plan's
//   `useAttack`, because the `use` prefix trips the repo's
//   `react/rules-of-hooks` error; it is not a hook.)
// - `applyEffect` is pattern-driven because 30C card data carries no `effectId`
//   field at all (verified: 0 occurrences in cards.json) while 154 of its
//   attacks have effect text. Unsupported text logs
//   `pokemonBnb.log.effectUnsupported` instead of guessing, so coverage gaps
//   stay visible rather than silently wrong.
// - A Knock Out blocks every other action until the KO'd side promotes a
//   benched Pokemon via `promoteActive`; an empty bench loses the match.
// - Not yet implemented: abilities (23 cards declare them, but no action can
//   trigger one), self-Knock-Out sources, and turn-locked / damage-prevention
//   clauses (they are logged as unsupported).
//
// Rulebook sources: Pokemon TCG Rulebook (pokemon.com), Bulbapedia "Rulings",
// "Pokemon Checkup", and "Setting Up to Play" articles.

import type { AttackDef, CardDef, CardType, EnergyCardDef, PokemonCardDef } from './cards'
import { cardIsEnergy, cardIsPokemon, cardIsTrainer } from './cards'
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
  /** Attached Energy cards (not ids) so attack costs can read `provides`. */
  attachedEnergy: EnergyCardDef[]
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
  /** True once a Supporter was played this turn (rulebook: one per turn). */
  supporterPlayedTurn: boolean
  /** Energy cards attached this turn (rulebook: one Energy card per turn). */
  energyAttachedThisTurn: number
  /** True once this side declared an attack this turn. */
  attackedThisTurn: boolean
  /** Turn number a Stadium was played on, or -1 when none. */
  stadiumPlayedTurn: number
  mulliganCount: number
}

/**
 * Log entries stay structured (a translation key plus raw data params) so the
 * battle-log strip can translate the template while card names stay verbatim
 * data. Keys are `pokemonBnb.log.*`, added to en/ms/zh in CP7-E.
 */
export type BattleLogEntry = { key: string; params?: Record<string, string | number> }

export type BattleState = {
  host: SideState
  guest: SideState
  activePlayer: PlayerSlot
  /** Turn counter; turn 1 is the first player's opening turn. */
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: 'prizes' | 'deck-out' | 'no-pokemon' | null
  over: boolean
  seed: number
  prizeCards: number
  timerSeconds: number
  /** Side that must choose a new Active after a KO before anything else. */
  pendingPromotion: PlayerSlot | null
  /** True once the current turn's start step (draw + flag reset) has run. */
  turnStarted: boolean
  /**
   * True for a state rebuilt from a `Snapshot` (guest render model): hidden
   * zones hold placeholders, so `processAction` refuses to run on it.
   */
  viewOnly: boolean
  log: BattleLogEntry[]
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
  pendingPromotion: PlayerSlot | null
  turnStarted: boolean
  log: BattleLogEntry[]
  host: SnapshotSide
  guest: SnapshotSide
}

export type BattleAction =
  | { type: 'attachEnergy'; handIndex: number; target: 'active' | number }
  | { type: 'playTrainer'; handIndex: number }
  | { type: 'evolve'; handIndex: number; target: 'active' | number }
  | { type: 'retreatToBench'; benchIndex: number }
  | { type: 'useAttack'; attackIndex: number }
  | { type: 'promoteActive'; benchIndex: number }
  | { type: 'endTurn' }

export type ActionResult = { state: BattleState; log: BattleLogEntry[]; error?: string }

// -- Pure helpers --

export function sideOf(state: BattleState, slot: PlayerSlot): SideState {
  return slot === 'host' ? state.host : state.guest
}

export function foeOf(slot: PlayerSlot): PlayerSlot {
  return slot === 'host' ? 'guest' : 'host'
}

/**
 * Append one structured log entry. Templates are translation keys, never
 * player-facing English, so the UI owns the copy (card names stay data).
 */
function logEvent(state: BattleState, key: string, params?: Record<string, string | number>): void {
  state.log.push(params ? { key, params } : { key })
}

/**
 * Weakness from the verbatim card-data value string ("×2", "×3").
 * Unparseable values fall back to the rulebook's common ×2; the damage step
 * emits a log note so the fallback is never silent.
 */
export function parseWeaknessValue(value: string): { multiplier: number; reduction: number } {
  const match = value.match(/(\d+)/)
  if (!match) return { multiplier: 2, reduction: 0 }
  return { multiplier: Number(match[1]), reduction: 0 }
}

/**
 * Resistance from the verbatim card-data value string ("-30", "-20").
 * Unparseable values fall back to no reduction (0).
 */
export function parseResistanceValue(value: string): { multiplier: number; reduction: number } {
  const match = value.match(/-\s*(\d+)/)
  if (!match) return { multiplier: 1, reduction: 0 }
  return { multiplier: 1, reduction: Number(match[1]) }
}

/** True when a weakness/resistance value string could not be read as a number. */
export function isUnreadableDamageValue(value: string, kind: 'weakness' | 'resistance'): boolean {
  const pattern = kind === 'weakness' ? /(\d+)/ : /-\s*(\d+)/
  return !pattern.test(value)
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
    energyAttachedThisTurn: 0,
    attackedThisTurn: false,
    stadiumPlayedTurn: -1,
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
    turn: 1,
    phase: 'main',
    winner: null,
    winReason: null,
    over: false,
    seed,
    prizeCards: settings.prizeCards,
    timerSeconds: settings.timerSeconds,
    pendingPromotion: null,
    turnStarted: false,
    viewOnly: false,
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
  logEvent(state, 'pokemonBnb.log.coinFlip', { player: first })

  // Place Active + Bench for both players (rulebook: choose 1 Basic for
  // Active, then bench Basics up to the bench limit).
  for (const slot of [first, second] as const) {
    const side = sideOf(state, slot)
    const basicIndexes = basicsIn(side.hand)
    if (basicIndexes.length === 0) {
      logEvent(state, 'pokemonBnb.log.noBasicToStart', { player: slot })
      continue
    }
    const pick = basicIndexes[randomInt(rng, basicIndexes.length)]
    const [card] = side.hand.splice(pick, 1)
    // `enteredTurn -1` marks "placed during setup": each side's first turn
    // adopts them, which is what blocks evolving them that turn (rulebook).
    side.active = makeInPlay(card as PokemonCardDef, -1)

    while (side.bench.length < Math.min(BENCH_TARGET, MAX_BENCH) && basicsIn(side.hand).length > 0) {
      const remaining = basicsIn(side.hand)
      const [benched] = side.hand.splice(remaining[0], 1)
      side.bench.push(makeInPlay(benched as PokemonCardDef, -1))
    }

    placePrizes(side, settings.prizeCards)
  }

  // Loser of the flip draws one extra card.
  drawCards(sideOf(state, second), 1)

  for (const slot of ['host', 'guest'] as const) {
    const mulligans = sideOf(state, slot).mulliganCount
    if (mulligans > 0) logEvent(state, 'pokemonBnb.log.mulligan', { player: slot, count: mulligans })
  }

  state.rngDraws = rngCalls
  return state
}

// -- CP7-B: turn sub-phases + action dispatcher --

/** Deep-copy plain battle data so an invalid action can never mutate input. */
export function cloneBattleState(state: BattleState): BattleState {
  return JSON.parse(JSON.stringify(state)) as BattleState
}

/** Stage rank from the data's stage string ('Basic' -> 0, 'Stage1' -> 1, ...). */
export function stageRank(stage: string): number {
  const match = stage.match(/^Stage\s*(\d+)$/i)
  if (match) return Number(match[1])
  return stage.trim().toLowerCase() === 'basic' ? 0 : -1
}

function inPlayOf(side: SideState, target: 'active' | number): InPlayPokemon | null {
  return target === 'active' ? side.active : (side.bench[target] ?? null)
}

/** Every Pokemon this side has in play (Active first, then Bench). */
function inPlayList(side: SideState): InPlayPokemon[] {
  return side.active ? [side.active, ...side.bench] : [...side.bench]
}

/** Rejection result: the caller keeps the untouched state and gets a code. */
function failure(state: BattleState, error: string): ActionResult {
  return { state, log: [], error }
}

/** Shared precondition: the match is live and it is `actor`'s main phase. */
function checkTurn(state: BattleState, actor: PlayerSlot): string | null {
  if (state.over) return 'match-over'
  if (state.activePlayer !== actor) return 'not-your-turn'
  if (state.phase !== 'main') return 'not-main-phase'
  return null
}

/** Log entries appended by the action just applied. */
function tailLog(state: BattleState, from: number): BattleLogEntry[] {
  return state.log.slice(from)
}

/**
 * Attack-cost payable check. `cost` comes from card data
 * (`['darkness', 'colorless']`) and colorless is wild. Typed requirements are
 * matched first, then leftover Energy covers the colorless count. Energy with
 * no `provides` (special energy) pays colorless only in v1 — a documented
 * approximation until special-energy scripts land in the effect library.
 */
export function canPayCost(attached: EnergyCardDef[], cost: CardType[]): boolean {
  const pool: CardType[] = attached.map((energy) => energy.provides ?? 'colorless')
  const used: boolean[] = pool.map(() => false)
  let colorlessNeeded = 0
  for (const requirement of cost) {
    if (requirement === 'colorless') {
      colorlessNeeded += 1
      continue
    }
    const index = pool.findIndex((type, position) => !used[position] && type === requirement)
    if (index === -1) return false
    used[index] = true
  }
  return used.filter((spent) => !spent).length >= colorlessNeeded
}

function sharesType(card: PokemonCardDef, target: PokemonCardDef): boolean {
  return card.types.some((type) => target.types.includes(type))
}

/**
 * Evolution legality. 30C card data carries no `evolvesFrom`, so the fallback
 * is stage progression (Basic -> Stage1 -> Stage2) plus a shared type. Sets
 * that do supply `evolvesFrom` are matched by name instead, so future data
 * needs no engine change.
 */
export function canEvolveOnto(evolution: PokemonCardDef, target: InPlayPokemon): boolean {
  if (stageRank(evolution.stage) <= 0) return false
  const targetCard = target.card
  if (evolution.evolvesFrom) {
    const sources = evolution.evolvesFrom.split(/[,/]/).map((name) => name.trim().toLowerCase())
    return sources.includes(targetCard.name.trim().toLowerCase())
  }
  return stageRank(evolution.stage) === stageRank(targetCard.stage) + 1 && sharesType(evolution, targetCard)
}

// -- Sub-phase: attach Energy --

/**
 * Attach one Energy card from hand to one of your Pokemon in play.
 * Rulebook: one Energy card per turn (Energy already attached to a Pokemon
 * this turn cannot take a second one).
 */
export function attachEnergy(
  state: BattleState,
  actor: PlayerSlot,
  handIndex: number,
  target: 'active' | number,
): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const card = side.hand[handIndex]
  if (!card || !cardIsEnergy(card)) return failure(state, 'not-energy')
  if (side.energyAttachedThisTurn >= ENERGY_PER_TURN) return failure(state, 'energy-limit')
  const pokemon = inPlayOf(side, target)
  if (!pokemon) return failure(state, 'no-target')
  if (pokemon.energyAttachedTurn === next.turn) return failure(state, 'already-attached')

  const logStart = next.log.length
  side.hand.splice(handIndex, 1)
  pokemon.attachedEnergy.push(card)
  pokemon.energyAttachedTurn = next.turn
  side.energyAttachedThisTurn += 1
  logEvent(next, 'pokemonBnb.log.attachEnergy', {
    player: actor,
    card: card.name,
    target: pokemon.card.name,
  })
  return { state: next, log: tailLog(next, logStart) }
}

// -- Sub-phase: play a Trainer card --

/**
 * Play a Trainer card from hand. Item is unlimited; Supporter and Stadium are
 * once per turn (the once-per-turn *name* restriction is not enforced in the
 * mini format). Reading the card text is the effect library's job (CP7-C), so
 * this sub-phase owns only the hand -> discard move and the turn restrictions.
 */
export function playTrainer(state: BattleState, actor: PlayerSlot, handIndex: number): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const card = side.hand[handIndex]
  if (!card || !cardIsTrainer(card)) return failure(state, 'not-trainer')
  const trainerType = card.trainerType.trim().toLowerCase()
  if (trainerType === 'supporter' && side.supporterPlayedTurn) return failure(state, 'supporter-limit')
  if (trainerType === 'stadium' && side.stadiumPlayedTurn === next.turn) return failure(state, 'stadium-limit')

  const logStart = next.log.length
  side.hand.splice(handIndex, 1)
  side.discard.push(card)
  if (trainerType === 'supporter') side.supporterPlayedTurn = true
  if (trainerType === 'stadium') side.stadiumPlayedTurn = next.turn
  logEvent(next, 'pokemonBnb.log.playTrainer', { player: actor, card: card.name })
  return { state: next, log: tailLog(next, logStart) }
}

// -- Sub-phase: evolve --

/**
 * Evolve a Pokemon in play. Rulebook: not the turn the Pokemon was played,
 * not twice in the same turn, and damage / attached Energy / special
 * conditions all carry over to the evolved card.
 */
export function evolve(
  state: BattleState,
  actor: PlayerSlot,
  handIndex: number,
  target: 'active' | number,
): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const card = side.hand[handIndex]
  if (!card || !cardIsPokemon(card)) return failure(state, 'not-pokemon')
  const pokemon = inPlayOf(side, target)
  if (!pokemon) return failure(state, 'no-target')
  if (!canEvolveOnto(card, pokemon)) return failure(state, 'cannot-evolve')
  if (pokemon.enteredTurn === next.turn) return failure(state, 'played-this-turn')
  if (pokemon.evolvedTurn === next.turn) return failure(state, 'evolved-this-turn')

  const logStart = next.log.length
  const previous = pokemon.card.name
  side.hand.splice(handIndex, 1)
  pokemon.card = card
  pokemon.evolvedTurn = next.turn
  logEvent(next, 'pokemonBnb.log.evolve', { player: actor, card: card.name, target: previous })
  return { state: next, log: tailLog(next, logStart) }
}

// -- Sub-phase: retreat --

/**
 * Retreat the Active Pokemon: discard Energy from it equal to its retreat
 * cost, then swap it with a benched Pokemon. Asleep and Paralyzed Pokemon
 * cannot retreat (Confused can); a Pokemon that already retreated this turn
 * cannot retreat again.
 */
export function retreatToBench(state: BattleState, actor: PlayerSlot, benchIndex: number): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const active = side.active
  const incoming = side.bench[benchIndex]
  if (!active) return failure(state, 'no-active')
  if (!incoming) return failure(state, 'no-target')
  if (active.conditions.asleep || active.conditions.paralyzed) return failure(state, 'cannot-retreat')
  if (active.retreatedTurn === next.turn) return failure(state, 'retreated-this-turn')
  if (active.attachedEnergy.length < active.card.retreat) return failure(state, 'retreat-cost')

  const logStart = next.log.length
  const paid = active.attachedEnergy.splice(0, active.card.retreat)
  side.discard.push(...paid)
  side.bench.splice(benchIndex, 1)
  side.bench.push(active)
  active.retreatedTurn = next.turn
  side.active = incoming
  logEvent(next, 'pokemonBnb.log.retreat', {
    player: actor,
    from: active.card.name,
    to: incoming.card.name,
  })
  return { state: next, log: tailLog(next, logStart) }
}

// -- Sub-phase: declare an attack --

/**
 * Declare an attack. This sub-phase owns the action-level rules: it must be
 * your main phase, the Active Pokemon cannot be Asleep or Paralyzed, only one
 * attack per turn, and the attack's Energy cost must be payable. Attacking
 * ends your turn (rulebook), so the turn closes here.
 *
 * Damage, Weakness/Resistance, card-text effects, KO, prizes and victory are
 * resolved at the marked CP7-C seam below, before the turn is closed.
 */
export function declareAttack(state: BattleState, actor: PlayerSlot, attackIndex: number): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const active = side.active
  if (!active) return failure(state, 'no-active')
  const attack = active.card.attacks[attackIndex]
  if (!attack) return failure(state, 'no-attack')
  if (active.conditions.asleep || active.conditions.paralyzed) return failure(state, 'cannot-attack')
  if (side.attackedThisTurn) return failure(state, 'already-attacked')
  if (!canPayCost(active.attachedEnergy, attack.cost)) return failure(state, 'insufficient-energy')

  const logStart = next.log.length
  side.attackedThisTurn = true
  logEvent(next, 'pokemonBnb.log.attack', { player: actor, card: active.card.name, attack: attack.name })

  // Confused (rulebook): roll first — tails means the attack does nothing and
  // the Pokemon hurts itself instead. Declaring the attack still ends the turn.
  if (active.conditions.confused && !flipCoin(next)) {
    logEvent(next, 'pokemonBnb.log.coinTails', { player: actor })
    logEvent(next, 'pokemonBnb.log.confusionSelfHit', {
      player: actor,
      card: active.card.name,
      amount: CONFUSION_SELF_DAMAGE,
    })
    active.damage += CONFUSION_SELF_DAMAGE
    if (isKnockedOut(active)) performKo(next, actor)
    const selfClosed = next.over ? next : applyEndTurn(next, actor)
    return { state: selfClosed, log: tailLog(selfClosed, logStart) }
  }

  // CP7-C: damage, Weakness/Resistance, card-text clauses, KO, Prizes, victory.
  resolveAttack(next, actor, attack, parseAttackEffects(attack.text))

  // Attacking ends the turn, unless the attack already ended the match.
  const closed = next.over ? next : applyEndTurn(next, actor)
  return { state: closed, log: tailLog(closed, logStart) }
}

// -- Sub-phase: end the turn --

/** End the turn voluntarily (the actor must own the current turn). */
export function endTurn(state: BattleState, actor: PlayerSlot): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const logStart = next.log.length
  logEvent(next, 'pokemonBnb.log.endTurn', { player: actor })
  const closed = applyEndTurn(next, actor)
  return { state: closed, log: tailLog(closed, logStart) }
}

/**
 * Hand the turn to the opponent, running the between-turns Pokemon Checkup
 * (Poison/Burn damage, Asleep wake-up, Paralyzed recovery) before the switch.
 */
function applyEndTurn(state: BattleState, actor: PlayerSlot): BattleState {
  applyCheckup(state, actor)
  if (state.over) return state
  state.activePlayer = foeOf(actor)
  state.turn += 1
  state.turnStarted = false
  state.phase = 'draw'
  return applyStartOfTurn(state)
}

/**
 * Start of turn: reset the active player's once-per-turn flags, then draw one
 * card. Guarded by `turnStarted`, so calling it twice cannot double-draw — the
 * caller runs it once after `setupBattle`, and `endTurn` runs it thereafter.
 *
 * Special-condition timing (Poison/Burn damage, Asleep/Paralyzed wake checks,
 * Confused self-hit) is added by CP7-D. Failing to draw is an immediate
 * deck-out defeat, settled by `applyDeckOutLoss`.
 */
export function applyStartOfTurn(state: BattleState): BattleState {
  if (state.over || state.turnStarted) return state
  const side = sideOf(state, state.activePlayer)
  side.supporterPlayedTurn = false
  side.energyAttachedThisTurn = 0
  side.attackedThisTurn = false
  side.stadiumPlayedTurn = -1
  // Pokemon placed during setup (enteredTurn -1) adopt this turn number, which
  // is what stops them evolving on their controller's first turn (rulebook).
  for (const pokemon of inPlayList(side)) {
    if (pokemon.enteredTurn < 0) pokemon.enteredTurn = state.turn
  }
  state.phase = 'main'
  state.turnStarted = true
  logEvent(state, 'pokemonBnb.log.turnStart', { player: state.activePlayer, turn: state.turn })
  if (drawCards(side, 1).length === 0) applyDeckOutLoss(state, state.activePlayer)
  return state
}

/**
 * Single entry point for the engine. Local hot-seat input and host-side
 * network intents both go through here, so a guest can never inject state.
 *
 * Invalid actions return the original state untouched plus an error code
 * (codes are technical identifiers; CP7-E maps them to translated copy).
 * The `default` branch guards malformed network payloads.
 */
export function processAction(state: BattleState, actor: PlayerSlot, action: BattleAction): ActionResult {
  // A state rebuilt from a Snapshot carries placeholder hidden zones: it is a
  // render model, never the source of truth.
  if (state.viewOnly) return failure(state, 'view-only')
  // A Knock Out blocks everything until the KO'd side has chosen a new Active.
  if (state.pendingPromotion) {
    if (action.type === 'promoteActive' && actor === state.pendingPromotion) {
      return promoteActive(state, actor, action.benchIndex)
    }
    return failure(state, 'must-promote')
  }
  switch (action.type) {
    case 'attachEnergy':
      return attachEnergy(state, actor, action.handIndex, action.target)
    case 'playTrainer':
      return playTrainer(state, actor, action.handIndex)
    case 'evolve':
      return evolve(state, actor, action.handIndex, action.target)
    case 'retreatToBench':
      return retreatToBench(state, actor, action.benchIndex)
    case 'useAttack':
      return declareAttack(state, actor, action.attackIndex)
    case 'promoteActive':
      return failure(state, 'no-promotion-pending')
    case 'endTurn':
      return endTurn(state, actor)
    default:
      return failure(state, 'unknown-action')
  }
}

// -- CP7-C: damage, effects, KO, prizes, victory --

/**
 * Seeded coin flip. The shared seed is mixed with the running draw counter so
 * consecutive flips differ, while both peers still derive identical results
 * from the same seed (the counter lives in `BattleState`).
 */
export function flipCoin(state: BattleState): boolean {
  const rng = createRng((state.seed + state.rngDraws + 1) | 0)
  state.rngDraws += 1
  return randomInt(rng, 2) === 0
}

/**
 * Damage after Weakness/Resistance. Weakness is read from the *defender's*
 * weakness entry whose type matches the attacking Pokemon's type (rulebook),
 * applied first; Resistance then subtracts, never below zero.
 */
export function computeAttackDamage(
  state: BattleState,
  attacker: InPlayPokemon,
  defender: InPlayPokemon,
  baseDamage: number,
): { damage: number; weakness: number; resistance: number } {
  if (baseDamage <= 0) return { damage: 0, weakness: 1, resistance: 0 }
  const attackerTypes = attacker.card.types
  const weaknessEntry = defender.card.weaknesses.find((entry) => attackerTypes.includes(entry.type))
  const resistanceEntry = defender.card.resistances.find((entry) => attackerTypes.includes(entry.type))

  let weakness = 1
  if (weaknessEntry) {
    if (isUnreadableDamageValue(weaknessEntry.value, 'weakness')) {
      logEvent(state, 'pokemonBnb.log.unreadableWeakness', { value: weaknessEntry.value })
    }
    weakness = parseWeaknessValue(weaknessEntry.value).multiplier
  }
  let resistance = 0
  if (resistanceEntry) {
    if (isUnreadableDamageValue(resistanceEntry.value, 'resistance')) {
      logEvent(state, 'pokemonBnb.log.unreadableResistance', { value: resistanceEntry.value })
    }
    resistance = parseResistanceValue(resistanceEntry.value).reduction
  }
  return { damage: Math.max(0, baseDamage * weakness - resistance), weakness, resistance }
}

/**
 * Recognised attack-effect clauses.
 *
 * 30C card data has **no** `effectId` field (verified: 0 occurrences in
 * cards.json) while 154 of its attacks carry effect text, so effects are
 * recognised from the text rather than keyed by a data id. Patterns are
 * anchored end-to-end: a conditional clause ("for each …", "If this Pokemon
 * has …") deliberately falls through to `unsupported` rather than being
 * applied unconditionally, because a wrong effect is worse than a missing one.
 */
export type ParsedEffect =
  | { kind: 'bonusDamage'; amount: number; coin: boolean }
  | { kind: 'bonusDamagePerPrize'; amount: number }
  | { kind: 'noDamageOnTails' }
  | { kind: 'draw'; amount: number }
  | { kind: 'heal'; amount: number }
  | { kind: 'discardEnergy'; amount: number | 'all' }
  | { kind: 'status'; status: StatusCondition; coin: boolean }
  | { kind: 'unsupported'; text: string }

export type EffectTiming = 'beforeDamage' | 'afterDamage'

/** Damage-modifying clauses resolve before damage; the rest afterwards. */
export function effectTiming(kind: ParsedEffect['kind']): EffectTiming {
  if (kind === 'bonusDamage' || kind === 'bonusDamagePerPrize' || kind === 'noDamageOnTails') {
    return 'beforeDamage'
  }
  return 'afterDamage'
}

/** Strip card-text markup (and collapses whitespace) so patterns match prose. */
export function plainCardText(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const STATUS_WORDS: Record<string, StatusCondition> = {
  asleep: 'asleep',
  poisoned: 'poisoned',
  burned: 'burned',
  confused: 'confused',
  paralyzed: 'paralyzed',
}

/** Parse one attack's verbatim text into ordered effect clauses. */
export function parseAttackEffects(text: string): ParsedEffect[] {
  const plain = plainCardText(text)
  if (!plain) return []
  const effects: ParsedEffect[] = []
  const sentences = plain.split(/(?<=\.)\s+/)
  let pendingCoin = false

  for (const sentence of sentences) {
    if (/^flip a coin\.?$/i.test(sentence)) {
      pendingCoin = true
      continue
    }
    const perPrize = sentence.match(/^this attack does (\d+) damage for each prize card you have taken\.?$/i)
    if (perPrize) {
      effects.push({ kind: 'bonusDamagePerPrize', amount: Number(perPrize[1]) })
      pendingCoin = false
      continue
    }
    const coinBonus = sentence.match(/^if heads, this attack does (\d+) more damage\.?$/i)
    if (coinBonus && pendingCoin) {
      effects.push({ kind: 'bonusDamage', amount: Number(coinBonus[1]), coin: true })
      pendingCoin = false
      continue
    }
    const flatBonus = sentence.match(/^this attack does (\d+) more damage\.?$/i)
    if (flatBonus && !pendingCoin) {
      effects.push({ kind: 'bonusDamage', amount: Number(flatBonus[1]), coin: false })
      continue
    }
    if (/^if tails, this attack does nothing\.?$/i.test(sentence)) {
      effects.push({ kind: 'noDamageOnTails' })
      pendingCoin = false
      continue
    }
    const heal = sentence.match(/^heal (\d+) damage from this/i)
    if (heal) {
      effects.push({ kind: 'heal', amount: Number(heal[1]) })
      pendingCoin = false
      continue
    }
    const discardCount = sentence.match(/^discard (\d+) energy from this/i)
    if (discardCount) {
      effects.push({ kind: 'discardEnergy', amount: Number(discardCount[1]) })
      pendingCoin = false
      continue
    }
    if (/^discard all energy from this/i.test(sentence)) {
      effects.push({ kind: 'discardEnergy', amount: 'all' })
      pendingCoin = false
      continue
    }
    if (/^draw a card\.?$/i.test(sentence)) {
      effects.push({ kind: 'draw', amount: 1 })
      pendingCoin = false
      continue
    }
    const status = sentence.match(/is now (asleep|poisoned|burned|confused|paralyzed)/i)
    if (status) {
      effects.push({ kind: 'status', status: STATUS_WORDS[status[1].toLowerCase()], coin: pendingCoin })
      pendingCoin = false
      continue
    }
    effects.push({ kind: 'unsupported', text: sentence })
    pendingCoin = false
  }
  return effects
}

/** Who an attack's non-damage clauses act on. */
export type EffectContext = {
  actor: PlayerSlot
  attacker: InPlayPokemon
  defender: InPlayPokemon | null
  attackName: string
}

/**
 * Apply one parsed clause.
 *
 * Named `applyEffect` per the plan, but it takes the live `state` plus an
 * `EffectContext` instead of the plan's `(effectId, targets)`: clauses mutate
 * zones, and coin-gated clauses need the seeded rng. `unsupported` clauses only
 * log, so card text the engine cannot honour degrades gracefully rather than
 * silently pretending to work.
 */
export function applyEffect(
  state: BattleState,
  effect: ParsedEffect,
  context: EffectContext,
): BattleLogEntry[] {
  const logStart = state.log.length
  const side = sideOf(state, context.actor)
  switch (effect.kind) {
    case 'draw': {
      const drawn = drawCards(side, effect.amount)
      logEvent(state, 'pokemonBnb.log.effectDraw', { player: context.actor, count: drawn.length })
      if (drawn.length < effect.amount) applyDeckOutLoss(state, context.actor)
      break
    }
    case 'heal': {
      const healed = Math.min(effect.amount, context.attacker.damage)
      context.attacker.damage -= healed
      logEvent(state, 'pokemonBnb.log.effectHeal', { player: context.actor, amount: healed })
      break
    }
    case 'discardEnergy': {
      const count = effect.amount === 'all' ? context.attacker.attachedEnergy.length : effect.amount
      const discarded = context.attacker.attachedEnergy.splice(0, count)
      side.discard.push(...discarded)
      logEvent(state, 'pokemonBnb.log.effectDiscardEnergy', {
        player: context.actor,
        count: discarded.length,
      })
      break
    }
    case 'status': {
      const defender = context.defender
      if (!defender) break
      if (effect.coin && !flipCoin(state)) {
        logEvent(state, 'pokemonBnb.log.coinTails', { player: context.actor })
        break
      }
      defender.conditions[effect.status] = true
      logEvent(state, 'pokemonBnb.log.effectStatus', {
        player: context.actor,
        target: defender.card.name,
        status: effect.status,
      })
      break
    }
    case 'unsupported': {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: effect.text })
      break
    }
    default:
      break // before-damage clauses are consumed by resolveAttack
  }
  return tailLog(state, logStart)
}

/**
 * Knock Out, Prizes and victory. Rulebook order: the KO'd Pokemon and every
 * card attached to it go to its owner's discard pile, the player who scored the
 * KO takes one Prize card, and the KO'd player must then promote a benched
 * Pokemon — or loses immediately when their bench is empty.
 */

/** Prize cards a side has taken so far. */
export function prizesTaken(state: BattleState, slot: PlayerSlot): number {
  return state.prizeCards - sideOf(state, slot).prizeCount
}

/** Deck-out defeat: a player who cannot draw a card loses the match. */
function applyDeckOutLoss(state: BattleState, slot: PlayerSlot): void {
  if (state.over) return
  logEvent(state, 'pokemonBnb.log.deckOut', { player: slot })
  state.winner = foeOf(slot)
  state.winReason = 'deck-out'
  state.over = true
  state.pendingPromotion = null
}

/** Victory checks: all Prizes taken first, then an empty board. */
export function checkVictory(state: BattleState): void {
  if (state.over) return
  for (const slot of ['host', 'guest'] as const) {
    if (sideOf(state, slot).prizeCount === 0) {
      state.winner = slot
      state.winReason = 'prizes'
      state.over = true
      return
    }
  }
  for (const slot of ['host', 'guest'] as const) {
    const side = sideOf(state, slot)
    if (!side.active && side.bench.length === 0) {
      state.winner = foeOf(slot)
      state.winReason = 'no-pokemon'
      state.over = true
      return
    }
  }
}

/** Take one Prize card into hand; taking the last one wins the match. */
export function takePrizeCard(state: BattleState, slot: PlayerSlot): void {
  const side = sideOf(state, slot)
  const prize = side.prizes.shift()
  if (!prize) return
  side.hand.push(prize)
  side.prizeCount = side.prizes.length
  logEvent(state, 'pokemonBnb.log.takePrize', { player: slot, remaining: side.prizeCount })
  checkVictory(state)
}

/** Knock Out the Active Pokemon of `koSlot`, then settle Prize and promotion. */
export function performKo(state: BattleState, koSlot: PlayerSlot): void {
  const koSide = sideOf(state, koSlot)
  const knockedOut = koSide.active
  if (!knockedOut) return
  koSide.active = null
  koSide.discard.push(knockedOut.card, ...knockedOut.attachedEnergy)
  logEvent(state, 'pokemonBnb.log.knockOut', { player: koSlot, card: knockedOut.card.name })

  const beneficiary = foeOf(koSlot)
  if (sideOf(state, beneficiary).prizeCount > 0) takePrizeCard(state, beneficiary)
  if (state.over) return

  if (koSide.bench.length > 0) {
    state.pendingPromotion = koSlot
    logEvent(state, 'pokemonBnb.log.mustPromote', { player: koSlot })
  } else {
    state.winner = beneficiary
    state.winReason = 'no-pokemon'
    state.over = true
  }
}

/**
 * Choose the new Active Pokemon after a Knock Out. Rulebook: the KO'd player
 * picks from their Bench, and nothing else may happen first — `processAction`
 * blocks every other action while `pendingPromotion` is set.
 */
export function promoteActive(state: BattleState, actor: PlayerSlot, benchIndex: number): ActionResult {
  if (state.over) return failure(state, 'match-over')
  if (state.pendingPromotion !== actor) return failure(state, 'no-promotion-pending')
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const promoted = side.bench[benchIndex]
  if (!promoted) return failure(state, 'no-target')

  const logStart = next.log.length
  side.bench.splice(benchIndex, 1)
  side.active = promoted
  next.pendingPromotion = null
  logEvent(next, 'pokemonBnb.log.promote', { player: actor, card: promoted.card.name })
  checkVictory(next)
  return { state: next, log: tailLog(next, logStart) }
}

/**
 * Resolve a declared attack against the opponent's Active Pokemon: damage
 * modifiers, Weakness/Resistance, damage, the attack's non-damage clauses, then
 * the Knock Out.
 *
 * Self-Knock-Out sources (attack recoil, Confusion self-hit, Poison/Burn at
 * Checkup) are deliberately not handled here: they can KO the attacker during
 * their own turn, which needs the promotion-timing design that arrives with
 * statuses in CP7-D. `This Pokemon also does N damage to itself` is therefore
 * reported as unsupported for now rather than KO'ing the wrong side.
 */
export function resolveAttack(
  state: BattleState,
  actor: PlayerSlot,
  attack: AttackDef,
  effects: ParsedEffect[],
): void {
  const attacker = sideOf(state, actor).active
  const defenderSlot = foeOf(actor)
  const defender = sideOf(state, defenderSlot).active
  if (!attacker || !defender) return
  const context: EffectContext = { actor, attacker, defender, attackName: attack.name }

  // 1. Damage modifiers: flat bonuses, per-Prize-taken bonuses, coin gates.
  let base = attack.damage
  for (const effect of effects) {
    if (effect.kind === 'bonusDamage') {
      if (effect.coin && !flipCoin(state)) {
        logEvent(state, 'pokemonBnb.log.coinTails', { player: actor })
        continue
      }
      base += effect.amount
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: effect.amount })
    } else if (effect.kind === 'bonusDamagePerPrize') {
      const bonus = effect.amount * prizesTaken(state, actor)
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'noDamageOnTails' && !flipCoin(state)) {
      logEvent(state, 'pokemonBnb.log.coinTails', { player: actor })
      base = 0
    }
  }

  // 2. Weakness / Resistance, then damage on the defender.
  const outcome = computeAttackDamage(state, attacker, defender, base)
  if (outcome.damage > 0) {
    defender.damage += outcome.damage
    logEvent(state, 'pokemonBnb.log.damageDealt', {
      player: actor,
      attack: context.attackName,
      target: defender.card.name,
      amount: outcome.damage,
      weakness: outcome.weakness,
      resistance: outcome.resistance,
    })
  } else {
    logEvent(state, 'pokemonBnb.log.noDamage', {
      player: actor,
      attack: context.attackName,
      target: defender.card.name,
    })
  }

  // 3. Non-damage clauses (statuses, healing, energy discard, draw).
  for (const effect of effects) {
    if (effectTiming(effect.kind) === 'afterDamage') applyEffect(state, effect, context)
  }

  // 4. Knock Out of the defender.
  if (isKnockedOut(defender)) performKo(state, defenderSlot)
}

// -- CP7-D: turn lifecycle, statuses, timer, snapshots --

/**
 * Pokemon Checkup, which happens between turns (rulebook): both Active Pokemon
 * are checked.
 * - Poisoned: 2 damage counters (20 damage) at every Checkup.
 * - Burned: 20 damage, then a coin flip; tails cures Burned.
 * - Asleep: a coin flip; heads wakes it up.
 * - Paralyzed: cured only for the player who just finished their turn, because
 *   Paralysis costs its victim the turn after it lands.
 * Confused is deliberately *not* checked here: it is rolled when that Pokemon
 * attacks (see `declareAttack`).
 */
export function applyCheckup(state: BattleState, justFinished: PlayerSlot): void {
  if (state.over) return
  for (const slot of ['host', 'guest'] as const) {
    const pokemon = sideOf(state, slot).active
    if (!pokemon) continue
    const conditions = pokemon.conditions
    if (conditions.poisoned) {
      pokemon.damage += POISON_DAMAGE
      logEvent(state, 'pokemonBnb.log.poisonDamage', {
        player: slot,
        card: pokemon.card.name,
        amount: POISON_DAMAGE,
      })
    }
    if (conditions.burned) {
      pokemon.damage += BURN_DAMAGE
      logEvent(state, 'pokemonBnb.log.burnDamage', {
        player: slot,
        card: pokemon.card.name,
        amount: BURN_DAMAGE,
      })
      if (!flipCoin(state)) {
        conditions.burned = false
        logEvent(state, 'pokemonBnb.log.burnCured', { player: slot, card: pokemon.card.name })
      }
    }
    if (conditions.asleep && flipCoin(state)) {
      conditions.asleep = false
      logEvent(state, 'pokemonBnb.log.wokeUp', { player: slot, card: pokemon.card.name })
    }
    if (conditions.paralyzed && slot === justFinished) {
      conditions.paralyzed = false
      logEvent(state, 'pokemonBnb.log.paralysisEnded', { player: slot, card: pokemon.card.name })
    }
  }
  // Checkup damage can Knock Out either Active (poison or burn).
  for (const slot of ['host', 'guest'] as const) {
    const pokemon = sideOf(state, slot).active
    if (pokemon && isKnockedOut(pokemon)) performKo(state, slot)
    if (state.over) return
  }
}

/**
 * Per-turn timer expiry. The mini format simply forfeits the expired turn
 * (no extra penalty), the rule least open to abuse. The wall clock lives in the
 * UI, which calls this when `timerSeconds` runs out; the engine stays pure.
 */
export function applyTimeout(state: BattleState): BattleState {
  if (state.over || state.timerSeconds <= 0) return state
  const actor = state.activePlayer
  const next = cloneBattleState(state)
  logEvent(next, 'pokemonBnb.log.timeout', { player: actor })
  return applyEndTurn(next, actor)
}

// -- CP7-D: host → guest render snapshots --

/**
 * Placeholder for a face-down card in a rebuilt view model. Decks, prize piles
 * and a non-viewer's hand are unknown to the receiver, so their slots carry
 * this sentinel instead of leaking real card data. It is never playable: the
 * rebuilt state is view-only.
 */
export const HIDDEN_CARD: CardDef = {
  id: 'hidden',
  set: 'hidden',
  number: '',
  name: '',
  rarity: 'common',
  supertype: 'pokemon',
  types: [],
  hp: 0,
  stage: 'Hidden',
  retreat: 0,
  weaknesses: [],
  resistances: [],
  attacks: [],
  abilities: [],
}

function fillHidden(count: number): CardDef[] {
  return Array.from({ length: count }, () => HIDDEN_CARD)
}

/** Deep-copy one in-play Pokemon (its card, energy and conditions). */
function cloneInPlay(pokemon: InPlayPokemon): InPlayPokemon {
  return JSON.parse(JSON.stringify(pokemon)) as InPlayPokemon
}

function snapshotSide(side: SideState, isViewer: boolean): SnapshotSide {
  return {
    handCount: side.hand.length,
    deckCount: side.deck.length,
    prizesTaken: side.prizeCount - side.prizes.length,
    prizeCount: side.prizeCount,
    discard: [...side.discard],
    active: side.active ? cloneInPlay(side.active) : null,
    bench: side.bench.map(cloneInPlay),
    hand: isViewer ? [...side.hand] : null,
  }
}

/**
 * Build a render-only Snapshot of the battle for `viewer`. Public zones (both
 * discard piles, every in-play Pokemon and its attached Energy) are copied
 * verbatim; face-down zones (both decks, both prize piles) become counts plus
 * `HIDDEN_CARD` placeholders; the hand is included only for the viewer
 * (`null` for the other side). In host-authoritative play (CP9) the host sends
 * each seat its own snapshot; the guest never sees the hidden zones.
 */
export function toSnapshot(state: BattleState, viewer: PlayerSlot): Snapshot {
  return {
    activePlayer: state.activePlayer,
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    winReason: state.winReason,
    over: state.over,
    prizeCards: state.prizeCards,
    timerSeconds: state.timerSeconds,
    pendingPromotion: state.pendingPromotion,
    turnStarted: state.turnStarted,
    log: [...state.log],
    host: snapshotSide(state.host, viewer === 'host'),
    guest: snapshotSide(state.guest, viewer === 'guest'),
  }
}

function snapshotSideToState(snapshot: SnapshotSide): SideState {
  return {
    deck: fillHidden(snapshot.deckCount),
    hand: snapshot.hand ? [...snapshot.hand] : fillHidden(snapshot.handCount),
    active: snapshot.active ? cloneInPlay(snapshot.active) : null,
    bench: snapshot.bench.map(cloneInPlay),
    prizes: fillHidden(snapshot.prizeCount - snapshot.prizesTaken),
    prizeCount: snapshot.prizeCount,
    discard: [...snapshot.discard],
    lostZone: [],
    supporterPlayedTurn: false,
    energyAttachedThisTurn: 0,
    attackedThisTurn: false,
    stadiumPlayedTurn: -1,
    mulliganCount: 0,
  }
}

/**
 * Rebuild a render-only BattleState from a Snapshot for display. Hidden zones
 * hold `HIDDEN_CARD` placeholders and `viewOnly` is true, so `processAction`
 * refuses to run on it: the authoritative seat's state stays the single source
 * of truth.
 */
export function applySnapshot(snapshot: Snapshot): BattleState {
  return {
    activePlayer: snapshot.activePlayer,
    turn: snapshot.turn,
    phase: snapshot.phase,
    winner: snapshot.winner,
    winReason: snapshot.winReason,
    over: snapshot.over,
    seed: 0,
    prizeCards: snapshot.prizeCards,
    timerSeconds: snapshot.timerSeconds,
    pendingPromotion: snapshot.pendingPromotion,
    turnStarted: snapshot.turnStarted,
    viewOnly: true,
    log: [...snapshot.log],
    rngDraws: 0,
    host: snapshotSideToState(snapshot.host),
    guest: snapshotSideToState(snapshot.guest),
  }
}


