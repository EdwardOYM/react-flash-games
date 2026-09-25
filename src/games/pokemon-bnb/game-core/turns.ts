// Turn lifecycle: Draw reset/draw/deck-out, Main→Attack→Between-Turns flow,
// ordered Special Conditions/KOs/Prizes, timer, and promotion handover.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { PlayerSlot } from '../net/protocol'
import { BURN_DAMAGE, POISON_DAMAGE } from './constants'
import { cloneBattleState, drawCards, foeOf, inPlayList, isKnockedOut, logEvent, sideOf } from './helpers'
import type { BattleState } from './types'
import { flipCoin } from './effects'

/**
 * Hand the turn to the opponent, running Between-Turns before the switch.
 */
export function applyEndTurn(state: BattleState, actor: PlayerSlot): BattleState {
  state.phase = 'between'
  applyCheckup(state, actor)
  if (state.over) return state
  const next = foeOf(actor)
  state.promotionQueue.sort((a, b) => Number(b === next) - Number(a === next))
  state.pendingPromotion = state.promotionQueue[0] ?? null
  if (state.pendingPromotion) {
    state.activePlayer = next
    state.turn += 1
    state.turnStarted = false
    return state
  }
  state.activePlayer = next
  state.turn += 1
  state.turnStarted = false
  state.phase = 'draw'
  return applyStartOfTurn(state)
}

/**
 * Start of turn: reset the active player's once-per-turn flags, then draw one
 * card. Guarded by `turnStarted`, so calling it twice cannot double-draw — the
 * caller runs it once after setup, and Between-Turns runs it thereafter.
 *
 * Special-condition timing is ordered in `applyCheckup`; failing to draw is an
 * immediate deck-out defeat.
 */
export function applyStartOfTurn(state: BattleState): BattleState {
  if (state.over || state.turnStarted) return state
  const side = sideOf(state, state.activePlayer)
  side.supporterPlayedTurn = false
  side.energyAttachedThisTurn = 0
  side.attackedThisTurn = false
  side.stadiumPlayedTurn = -1
  side.retreatedThisTurn = false
  // Pokemon placed during setup (enteredTurn -1) adopt this turn number, which
  // is what stops them evolving on their controller's first turn (rulebook).
  for (const pokemon of inPlayList(side)) {
    if (pokemon.enteredTurn < 0) pokemon.enteredTurn = state.turn
  }
  // Draw draws one card and resets per-turn limits. Keep phase draw until the
  // existing draw succeeds, then enter Main; failing to draw is an immediate loss.
  logEvent(state, 'pokemonBnb.log.turnStart', { player: state.activePlayer, turn: state.turn })
  if (drawCards(side, 1).length === 0) {
    applyDeckOutLoss(state, state.activePlayer)
    return state
  }
  state.phase = 'main'
  state.turnStarted = true
  return state
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
export function applyDeckOutLoss(state: BattleState, slot: PlayerSlot): void {
  if (state.over) return
  logEvent(state, 'pokemonBnb.log.deckOut', { player: slot })
  state.winner = foeOf(slot)
  state.winReason = 'deck-out'
  state.over = true
  state.pendingPromotion = null
  state.promotionQueue = []
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
  koSide.discard.push(knockedOut.card, ...knockedOut.attachedEnergy, ...(knockedOut.attachedTool ? [knockedOut.attachedTool] : []))
  logEvent(state, 'pokemonBnb.log.knockOut', { player: koSlot, card: knockedOut.card.name })

  const beneficiary = foeOf(koSlot)
  if (sideOf(state, beneficiary).prizeCount > 0) takePrizeCard(state, beneficiary)
  if (state.over) return

  if (koSide.bench.length > 0) {
    if (!state.promotionQueue.includes(koSlot)) state.promotionQueue.push(koSlot)
    state.pendingPromotion = state.promotionQueue[0] ?? null
    logEvent(state, 'pokemonBnb.log.mustPromote', { player: koSlot })
  } else {
    state.winner = beneficiary
    state.winReason = 'no-pokemon'
    state.over = true
  }
}

// -- CP7-D: turn lifecycle, statuses, timer, snapshots --

/** Between-Turns Special Conditions in global Poison→Burn→Asleep→Paralysis order. */
export function applyCheckup(state: BattleState, justFinished: PlayerSlot): void {
  if (state.over) return
  const actives = (['host', 'guest'] as const)
    .map((slot) => ({ slot, pokemon: sideOf(state, slot).active }))
    .filter((entry): entry is { slot: PlayerSlot; pokemon: NonNullable<ReturnType<typeof sideOf>['active']> } => entry.pokemon !== null)

  for (const { slot, pokemon } of actives) {
    if (!pokemon.conditions.poisoned) continue
    pokemon.damage += POISON_DAMAGE
    logEvent(state, 'pokemonBnb.log.poisonDamage', { player: slot, card: pokemon.card.name, amount: POISON_DAMAGE })
  }
  for (const { slot, pokemon } of actives) {
    if (!pokemon.conditions.burned) continue
    pokemon.damage += BURN_DAMAGE
    logEvent(state, 'pokemonBnb.log.burnDamage', { player: slot, card: pokemon.card.name, amount: BURN_DAMAGE })
    if (flipCoin(state)) {
      pokemon.conditions.burned = false
      logEvent(state, 'pokemonBnb.log.burnCured', { player: slot, card: pokemon.card.name })
    }
  }
  for (const { slot, pokemon } of actives) {
    if (pokemon.conditions.asleep && flipCoin(state)) {
      pokemon.conditions.asleep = false
      logEvent(state, 'pokemonBnb.log.wokeUp', { player: slot, card: pokemon.card.name })
    }
  }
  for (const { slot, pokemon } of actives) {
    if (pokemon.conditions.paralyzed && slot === justFinished) {
      pokemon.conditions.paralyzed = false
      logEvent(state, 'pokemonBnb.log.paralysisEnded', { player: slot, card: pokemon.card.name })
    }
  }

  // No between-turn card effects are registered yet (CP5 owns Ability effects).
  const nextPlayer = foeOf(justFinished)
  for (const slot of [nextPlayer, foeOf(nextPlayer)] as const) {
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
