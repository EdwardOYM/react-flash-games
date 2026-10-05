// Explicit match setup: shuffle, seeded opening flip, private hand/Mulligan,
// player-chosen turn order, face-down Active/Bench/Prize choices, and the
// simultaneous reveal that starts the first player's Draw Phase.

import { isBasicPokemon, type CardDef, type PokemonCardDef } from '../cards'
import { DECK_SIZE, type LobbySettings, type PlayerSlot } from '../net/protocol'
import { createRng, randomInt, shuffleCards, type Rng } from '../rng'
import { MAX_BENCH, OPENING_HAND_SIZE } from './constants'
import { drawCards, foeOf, logEvent, sideOf, tailLog } from './helpers'
import { applyStartOfTurn } from './turns'
import type { ActionResult, BattleState, InPlayPokemon, SideState, SpecialConditionState } from './types'

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
    attachedTool: null,
    conditions: empty,
    // 04.11 CP6 / 169: the rulebook default. Every Pokemon starts with a 1-counter
    // Poison, and 169 is the only card in the set that raises it.
    poisonCounters: 1,
    enteredTurn: enteredTurn,
    // 04.12 CP20: a Pokemon starts unevolved, so there is nothing to devolve TO.
    evoStack: [],
    evolvedTurn: 0,
    energyAttachedTurn: 0,
    retreatedTurn: 0,
    abilityUsedTurn: 0,
    // 04.10 CP3: no attack has landed yet, so the memory starts stamped with a turn
    // that can never equal a real `turn - 1`. -1 is used rather than 0 precisely
    // because turn 1 is a real turn: a 0 stamp would satisfy the `turn - 1` test on
    // turn 1 and invent a "last turn" that does not exist.
    lastTurnAttackedTurn: -1,
    lastTurnAttackedAmount: 0,
  }
}

/** Basics are Pokemon with stage === 'Basic'. */
export function basicsIn(hand: CardDef[]): number[] {
  return hand.flatMap((card, index) => isBasicPokemon(card) ? [index] : [])
}

/** Opening coin flip; the winner chooses who goes first. */
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
    prizeCount: 0,
    discard: [],
    lostZone: [],
    supporterPlayedTurn: false,
    energyAttachedThisTurn: 0,
    attackedThisTurn: false,
    stadiumPlayedTurn: -1,
    retreatedThisTurn: false,
    mulliganCount: 0,
    mulliganedHands: [],
    abilityUsedNames: {},
    // 04.12 CP10-B: a VSTAR Power is once per GAME, so this never resets.
    vstarPowerUsedThisGame: false,
    // 04.12 CP15: a GX attack is once per GAME, independent of the VSTAR Power.
    gxAttackUsedThisGame: false,
    // 04.12 CP10-B: "for the rest of the turn" -- starts empty and is cleared by the turn.
    energyTypeOverride: [],
    setupActive: null,
    setupBench: [],
    setupPenaltyCards: 0,
    setupReady: false,
    // 04.10 CP3: no Pokemon of this side has been Knocked Out by an attack yet. -1 can
    // never equal a real `turn - 1` (the smallest is 0), so the flag is false on turn
    // 1 without a special case — the same reason the per-Pokemon memory starts at -1.
    koByAttackTurn: -1,
  }
}

/**
 * Set the configured Prize cards from the same submitted 40-card deck.
 */
export function placeSetupPrizes(side: SideState, count: number): void {
  if (count !== 4 && count !== 6) throw new RangeError('Prize setup requires 4 or 6 cards')
  if (side.deck.length < count) throw new RangeError('Not enough cards to set Prize cards')
  side.prizes = side.deck.splice(0, count)
  side.prizeCount = count
}

/**
 * Replace one opening hand without a Basic, recording the redraw penalty.
 *
 * The hand being replaced is copied into `mulliganedHands` before it is
 * shuffled back, because the rulebook requires the failed hand to be revealed
 * to the opponent — and it has to survive being shuffled into the deck.
 */
function mulliganOnce(side: SideState, rng: Rng): void {
  if (side.deck.length === 0) return
  side.mulliganCount += 1
  side.mulliganedHands.push([...side.hand])
  side.deck.push(...side.hand.splice(0))
  shuffleCards(side.deck, rng)
  drawCards(side, OPENING_HAND_SIZE)
}

function setupFailure(state: BattleState, error: string): ActionResult {
  return { state, log: [], error }
}

function setupRng(state: BattleState): { rng: Rng; commit: () => void } {
  let calls = 0
  const rng = createRng((state.seed + state.rngDraws + 1) | 0)
  return {
    rng: { next: () => { calls += 1; return rng.next() } },
    commit: () => { state.rngDraws += calls },
  }
}

/** Coin winner chooses who goes first before either opening hand is used. */
export function chooseTurnOrder(state: BattleState, actor: PlayerSlot, firstPlayer: PlayerSlot): ActionResult {
  if (state.setup.phase !== 'turnOrder') return setupFailure(state, 'setup-wrong-phase')
  if (actor !== state.setup.coinWinner) return setupFailure(state, 'not-coin-winner')
  if (firstPlayer !== 'host' && firstPlayer !== 'guest') return setupFailure(state, 'setup-wrong-player')
  const next = structuredClone(state)
  const logStart = next.log.length
  drawCards(next.host, OPENING_HAND_SIZE)
  drawCards(next.guest, OPENING_HAND_SIZE)
  next.setup.firstPlayer = firstPlayer
  next.setup.phase = 'mulligan'
  for (const slot of ['host', 'guest'] as const) {
    const count = sideOf(next, slot).mulliganCount
    if (count > 0) logEvent(next, 'pokemonBnb.log.mulligan', { player: slot, count })
  }
  return { state: next, log: tailLog(next, logStart) }
}

/**
 * Keep the current opening hand because it already contains a Basic Pokemon.
 *
 * Kept separate from `mulliganSetup` so the action a player takes always says
 * what it does. The rulebook only allows a Mulligan when the hand has NO Basic
 * ("If you don't have one: You have a Mulligan"), so a hand that is already
 * legal is confirmed, never redrawn.
 */
export function keepSetupHand(state: BattleState, actor: PlayerSlot): ActionResult {
  if (state.setup.phase !== 'mulligan') return setupFailure(state, 'setup-wrong-phase')
  const side = state[actor]
  if (side.setupReady) return setupFailure(state, 'setup-already-ready')
  if (basicsIn(side.hand).length === 0) return setupFailure(state, 'setup-need-mulligan')
  const next = structuredClone(state)
  next.setup.mulliganDone[actor] = true
  if (next.setup.mulliganDone.host && next.setup.mulliganDone.guest) next.setup.phase = 'placement'
  return { state: next, log: [] }
}

/**
 * Redraw an opening hand that holds no Basic Pokemon, recording the penalty.
 *
 * Refused once a Basic is in hand: that hand is already legal, so it is kept
 * via `keepSetupHand` instead of being thrown away.
 */
export function mulliganSetup(state: BattleState, actor: PlayerSlot): ActionResult {
  if (state.setup.phase !== 'mulligan') return setupFailure(state, 'setup-wrong-phase')
  const side = state[actor]
  if (side.setupReady) return setupFailure(state, 'setup-already-ready')
  if (basicsIn(side.hand).length > 0) return setupFailure(state, 'setup-keep-hand')
  const next = structuredClone(state)
  const logStart = next.log.length
  const { rng, commit } = setupRng(next)
  mulliganOnce(next[actor], rng)
  commit()
  next.setup.mulliganDone[actor] = basicsIn(next[actor].hand).length > 0
  if (next.setup.mulliganDone[actor]) logEvent(next, 'pokemonBnb.log.mulligan', { player: actor, count: next[actor].mulliganCount })
  if (next.setup.mulliganDone.host && next.setup.mulliganDone.guest) next.setup.phase = 'placement'
  return { state: next, log: tailLog(next, logStart) }
}

/** Choose one Basic Active and 0–5 Basic Bench cards from the private hand. */
export function chooseSetupPokemon(
  state: BattleState,
  actor: PlayerSlot,
  activeHandIndex: number,
  benchHandIndexes: number[],
  penaltyCards: number,
): ActionResult {
  if (state.setup.phase !== 'placement') return setupFailure(state, 'setup-wrong-phase')
  const side = state[actor]
  if (side.setupReady) return setupFailure(state, 'setup-already-ready')
  const activeCard = side.hand[activeHandIndex]
  if (!activeCard || !isBasicPokemon(activeCard)) return setupFailure(state, 'setup-active-invalid')
  const uniqueBench = [...new Set(benchHandIndexes)]
  if (uniqueBench.length !== benchHandIndexes.length || uniqueBench.length > MAX_BENCH || uniqueBench.includes(activeHandIndex)) {
    return setupFailure(state, 'setup-bench-invalid')
  }
  const benchCards = uniqueBench.map((index) => side.hand[index])
  if (benchCards.some((card) => !card || !isBasicPokemon(card))) return setupFailure(state, 'setup-bench-invalid')
  const maxPenalty = sideOf(state, foeOf(actor)).mulliganCount
  if (!Number.isInteger(penaltyCards) || penaltyCards < 0 || penaltyCards > maxPenalty) return setupFailure(state, 'setup-penalty-invalid')

  const next = structuredClone(state)
  const logStart = next.log.length
  const nextSide = next[actor]
  const selected = [activeHandIndex, ...uniqueBench].sort((a, b) => b - a)
  const selectedCards = new Map<number, PokemonCardDef>()
  selectedCards.set(activeHandIndex, activeCard as PokemonCardDef)
  for (const index of uniqueBench) selectedCards.set(index, side.hand[index] as PokemonCardDef)
  for (const index of selected) nextSide.hand.splice(index, 1)
  nextSide.setupActive = selectedCards.get(activeHandIndex) ?? null
  nextSide.setupBench = uniqueBench.map((index) => selectedCards.get(index)!).filter(Boolean)
  nextSide.setupPenaltyCards = penaltyCards
  placeSetupPrizes(nextSide, next.prizeCards)
  nextSide.setupReady = true
  next.setup.ready[actor] = true
  if (next.setup.ready.host && next.setup.ready.guest) next.setup.phase = 'prizes'
  return { state: next, log: tailLog(next, logStart) }
}

/** Reveal both setups together, then start the chosen first player's Draw Phase. */
export function confirmSetupReveal(state: BattleState, _actor: PlayerSlot): ActionResult {
  if (state.setup.phase !== 'prizes') return setupFailure(state, 'setup-wrong-phase')
  if (state.setup.revealed) return setupFailure(state, 'setup-already-revealed')
  const next = structuredClone(state)
  const logStart = next.log.length
  for (const slot of ['host', 'guest'] as const) {
    const side = next[slot]
    const setupPenalty = sideOf(next, foeOf(slot)).setupPenaltyCards
    drawCards(side, setupPenalty)
    side.active = makeInPlay(side.setupActive as PokemonCardDef, -1)
    side.bench = side.setupBench.map((card) => makeInPlay(card, -1))
    logEvent(next, 'pokemonBnb.log.setupReveal', { player: slot })
  }
  next.setup.revealed = true
  next.setup.phase = 'complete'
  next.turn = 1
  next.turnStarted = false
  next.phase = 'draw'
  applyStartOfTurn(next)
  return { state: next, log: tailLog(next, logStart) }
}

/**
 * Initialize private setup: shuffle both 40-card decks and flip the opening
 * coin. Hands remain empty until the coin winner chooses first/second, so no
 * card can be inspected before the turn-order decision.
 */
export function setupBattle(
  settings: LobbySettings,
  hostDeck: CardDef[],
  guestDeck: CardDef[],
  seed: number,
): BattleState {
  if (hostDeck.length !== DECK_SIZE || guestDeck.length !== DECK_SIZE) {
    throw new RangeError(`setupBattle requires exactly ${DECK_SIZE} cards per deck`)
  }

  let rngCalls = 0
  const base = createRng(seed)
  const rng: Rng = { next: () => { rngCalls += 1; return base.next() } }
  const state: BattleState = {
    host: sideEmpty(),
    guest: sideEmpty(),
    activePlayer: 'host',
    turn: 0,
    phase: 'draw',
    // 04.12 CP16: 178's Lost Zone routing is off until an attack turns it on.
    koToLostZoneTurn: -1,
    winner: null,
    winReason: null,
    over: false,
    seed,
    prizeCards: settings.prizeCards,
    timerSeconds: settings.timerSeconds,
    pendingPromotion: null,
    promotionQueue: [],
    pendingChoice: null,
    // 04.9 CP5: no duration is live at setup; the first one is created by an
    // attack clause.
    durations: [],
    stadium: null,
    turnStarted: false,
    viewOnly: false,
    log: [],
    rngDraws: 0,
    setup: {
      phase: 'turnOrder',
      coinWinner: 'host',
      firstPlayer: null,
      mulliganDone: { host: false, guest: false },
      ready: { host: false, guest: false },
      revealed: false,
    },
  }
  state.host.deck = shuffleCards([...hostDeck], rng)
  state.guest.deck = shuffleCards([...guestDeck], rng)
  state.setup.coinWinner = openingFlip(rng)
  logEvent(state, 'pokemonBnb.log.coinFlip', { player: state.setup.coinWinner })
  state.rngDraws = rngCalls
  return state
}
