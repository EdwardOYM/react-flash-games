// Player actions and the single dispatcher entry point (CP7-B): attachEnergy,
// playTrainer, evolve, retreatToBench, declareAttack, endTurn, promoteActive,
// and processAction. Every local or network intent funnels through
// processAction; invalid actions never mutate state.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import { cardIsEnergy, cardIsPokemon, cardIsTrainer } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { CONFUSION_SELF_DAMAGE, ENERGY_PER_TURN } from './constants'
import { canEvolveOnto, canPayCost, checkTurn, cloneBattleState, failure, inPlayOf, isKnockedOut, logEvent, sideOf, tailLog } from './helpers'
import type { ActionResult, BattleAction, BattleState } from './types'
import { flipCoin, parseAttackEffects, resolveAttack } from './effects'
import { confirmSetupReveal, chooseSetupPokemon, chooseTurnOrder, mulliganSetup } from './setup'
import { applyEndTurn, checkVictory, performKo } from './turns'

// -- CP7-B: turn sub-phases + action dispatcher --

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
  if (state.setup.phase !== 'complete') {
    switch (action.type) {
      case 'chooseTurnOrder':
        return chooseTurnOrder(state, actor, action.firstPlayer)
      case 'mulliganSetup':
        return mulliganSetup(state, actor)
      case 'chooseSetupPokemon':
        return chooseSetupPokemon(state, actor, action.activeHandIndex, action.benchHandIndexes, action.penaltyCards)
      case 'confirmSetupReveal':
        return confirmSetupReveal(state, actor)
      default:
        return failure(state, 'setup-incomplete')
    }
  }
  // A Knock Out blocks everything until the KO'd side has chosen a new Active.
  if (state.pendingPromotion) {
    if (action.type === 'promoteActive' && actor === state.pendingPromotion) {
      return promoteActive(state, actor, action.benchIndex)
    }
    return failure(state, 'must-promote')
  }
  switch (action.type) {
    case 'confirmSetupReveal':
    case 'chooseTurnOrder':
    case 'mulliganSetup':
    case 'chooseSetupPokemon':
      return failure(state, 'setup-wrong-phase')
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
