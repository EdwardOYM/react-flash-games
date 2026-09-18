// Match setup: deck zones, opening hands, mulligans, the seeded opening flip,
// Active/Bench placement, and prize placement.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { CardDef, PokemonCardDef } from '../cards'
import type { LobbySettings, PlayerSlot } from '../net/protocol'
import { createRng, randomInt, shuffleCards, type Rng } from '../rng'
import { BENCH_TARGET, MAX_BENCH, OPENING_HAND_SIZE, PRIZE_COUNT } from './constants'
import { drawCards, foeOf, logEvent, sideOf } from './helpers'
import type { BattleState, InPlayPokemon, SideState, SpecialConditionState } from './types'

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
