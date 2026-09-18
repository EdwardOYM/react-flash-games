// Turn lifecycle (CP7-B/D): start-of-turn draw and flag reset, end-of-turn
// handover, the between-turns Pokemon Checkup, the per-turn timeout, and the
// Knock Out / Prize / victory settlement shared by attacks and Checkup damage.
// (The effects <-> turns cross-import is function-declaration-only; see
// ./effects.ts.)
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { PlayerSlot } from '../net/protocol'
import { BURN_DAMAGE, POISON_DAMAGE } from './constants'
import { cloneBattleState, drawCards, foeOf, inPlayList, isKnockedOut, logEvent, sideOf } from './helpers'
import type { BattleState } from './types'
import { flipCoin } from './effects'

/**
 * Hand the turn to the opponent, running the between-turns Pokemon Checkup
 * (Poison/Burn damage, Asleep wake-up, Paralyzed recovery) before the switch.
 */
export function applyEndTurn(state: BattleState, actor: PlayerSlot): BattleState {
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
