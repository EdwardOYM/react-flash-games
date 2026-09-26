// Player actions and the single dispatcher entry point: Main-phase card/Retreat
// actions, explicit Attack/Pass, setup intents, promotion, and processAction.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import { cardIsEnergy, cardIsPokemon, cardIsTrainer, isBasicPokemon, type PokemonCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { CONFUSION_SELF_DAMAGE, ENERGY_PER_TURN } from './constants'
import { canEvolveOnto, canPayCost, checkAttackPhase, checkTurn, cloneBattleState, failure, inPlayOf, isKnockedOut, logEvent, sideOf, tailLog } from './helpers'
import type { ActionResult, BattleAction, BattleState } from './types'
import { applyAbilityEffect, classifyAbility, flipCoin, isPlayerTriggeredAbility, parseAttackEffects, resolveAttack } from './effects'
import { confirmSetupReveal, chooseSetupPokemon, chooseTurnOrder, mulliganSetup } from './setup'
import { applyEndTurn, applyStartOfTurn, checkVictory, performKo } from './turns'

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
  if (trainerType === 'tool') return failure(state, 'not-trainer')
  if (trainerType === 'supporter' && side.supporterPlayedTurn) return failure(state, 'supporter-limit')
  if (trainerType === 'supporter' && state.turn === 1 && state.setup.firstPlayer === actor) return failure(state, 'first-turn-supporter')
  if (trainerType === 'stadium' && next.stadium?.name === card.name) return failure(state, 'same-stadium')
  if (trainerType === 'stadium' && side.stadiumPlayedTurn === next.turn) return failure(state, 'stadium-limit')

  const logStart = next.log.length
  side.hand.splice(handIndex, 1)
  if (trainerType === 'stadium') {
    if (next.stadium) next.host.discard.push(next.stadium)
    next.stadium = card
  } else side.discard.push(card)
  if (trainerType === 'supporter') side.supporterPlayedTurn = true
  if (trainerType === 'stadium') side.stadiumPlayedTurn = next.turn
  logEvent(next, 'pokemonBnb.log.playTrainer', { player: actor, card: card.name })
  return { state: next, log: tailLog(next, logStart) }
}

/** Play a Basic Pokemon from hand onto the next open Bench slot. */
export function playBasic(state: BattleState, actor: PlayerSlot, handIndex: number): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const card = side.hand[handIndex]
  if (!card || !isBasicPokemon(card)) return failure(state, 'not-basic')
  if (side.bench.length >= 5) return failure(state, 'bench-full')
  const logStart = next.log.length
  side.hand.splice(handIndex, 1)
  side.bench.push({
    uid: `${card.id}#${next.turn}`,
    card: card as PokemonCardDef,
    damage: 0,
    attachedEnergy: [],
    attachedTool: null,
    conditions: { asleep: false, paralyzed: false, confused: false, poisoned: false, burned: false },
    enteredTurn: next.turn,
    evolvedTurn: 0,
    energyAttachedTurn: 0,
    retreatedTurn: 0,
    abilityUsedTurn: 0,
  })
  logEvent(next, 'pokemonBnb.log.playBasic', { player: actor, card: card.name })
  return { state: next, log: tailLog(next, logStart) }
}

/**
 * Activate a player-triggered Ability (rulebook: "Once during your turn").
 *
 * Abilities are not attacks, cost no Energy, and work from the Active spot or
 * the Bench, so no phase or position gate applies beyond the once-per-turn
 * limit. Asleep/Confused/Paralyzed do not block them (rulebook), but a
 * condition may apply an effect the Ability itself needs, e.g. healing.
 *
 * The effect is resolved on a clone first, so a requirement that cannot be met
 * (missing partner in play, no matching card, no chosen target) rejects the
 * action and leaves the real state untouched.
 */
export function activateAbility(
  state: BattleState,
  actor: PlayerSlot,
  target: 'active' | number,
  abilityIndex: number,
  targetIndex?: 'active' | number,
): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const pokemon = inPlayOf(sideOf(next, actor), target)
  if (!pokemon) return failure(state, 'no-target')
  const ability = pokemon.card.abilities[abilityIndex]
  if (!ability) return failure(state, 'no-ability')
  if (!isPlayerTriggeredAbility(ability.text)) return failure(state, 'ability-ineligible')
  if (pokemon.abilityUsedTurn === next.turn) return failure(state, 'ability-limit')
  // "You can only use 1 [Ability] per turn" style clauses are enforced per
  // side per name; the rulebook allows each copy otherwise.
  const side = sideOf(next, actor)
  if (side.abilityUsedNames[ability.name] === next.turn) return failure(state, 'ability-limit')

  const chosen = targetIndex === undefined ? null : inPlayOf(sideOf(next, actor), targetIndex)
  if (targetIndex !== undefined && !chosen) return failure(state, 'no-target')
  // Capture before resolving so the effect's own log entries are reported.
  const logStart = next.log.length
  const error = applyAbilityEffect(next, classifyAbility(ability.text), { actor, user: pokemon, chosen })
  if (error) return failure(state, error)

  pokemon.abilityUsedTurn = next.turn
  side.abilityUsedNames = { ...side.abilityUsedNames, [ability.name]: next.turn }
  logEvent(next, 'pokemonBnb.log.useAbility', { player: actor, pokemon: pokemon.card.name, ability: ability.name })
  return { state: next, log: tailLog(next, logStart) }
}

/** Attach one Pokemon Tool to a Pokemon that does not already carry one. */
export function attachTool(state: BattleState, actor: PlayerSlot, handIndex: number, target: 'active' | number): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const card = side.hand[handIndex]
  if (!card || !cardIsTrainer(card) || card.trainerType.trim().toLowerCase() !== 'tool') return failure(state, 'not-tool')
  const pokemon = inPlayOf(side, target)
  if (!pokemon) return failure(state, 'no-target')
  if (pokemon.attachedTool) return failure(state, 'tool-limit')
  const logStart = next.log.length
  side.hand.splice(handIndex, 1)
  pokemon.attachedTool = card
  logEvent(next, 'pokemonBnb.log.attachTool', { player: actor, card: card.name, target: pokemon.card.name })
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
  if (side.retreatedThisTurn) return failure(state, 'retreat-limit')
  if (active.attachedEnergy.length < active.card.retreat) return failure(state, 'retreat-cost')

  const logStart = next.log.length
  const paid = active.attachedEnergy.splice(0, active.card.retreat)
  side.discard.push(...paid)
  side.bench.splice(benchIndex, 1)
  side.bench.push(active)
  active.retreatedTurn = next.turn
  side.retreatedThisTurn = true
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
export function beginAttack(state: BattleState, actor: PlayerSlot): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  next.phase = 'attack'
  return { state: next, log: [] }
}

export function declareAttack(state: BattleState, actor: PlayerSlot, attackIndex: number): ActionResult {
  const blocked = checkAttackPhase(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const active = side.active
  if (!active) return failure(state, 'no-active')
  const attack = active.card.attacks[attackIndex]
  if (!attack) return failure(state, 'no-attack')
  if (active.conditions.asleep || active.conditions.paralyzed) return failure(state, 'cannot-attack')
  if (state.turn === 1 && state.setup.firstPlayer === actor) return failure(state, 'first-turn-attack')
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

/** Pass ends the turn without an attack. */
export function pass(state: BattleState, actor: PlayerSlot): ActionResult {
  const blocked = checkAttackPhase(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const logStart = next.log.length
  logEvent(next, 'pokemonBnb.log.pass', { player: actor })
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
    case 'playBasic':
      return playBasic(state, actor, action.handIndex)
    case 'playTrainer':
      return playTrainer(state, actor, action.handIndex)
    case 'attachTool':
      return attachTool(state, actor, action.handIndex, action.target)
    case 'useAbility':
      return activateAbility(state, actor, action.target, action.abilityIndex, action.targetIndex)
    case 'evolve':
      return evolve(state, actor, action.handIndex, action.target)
    case 'retreatToBench':
      return retreatToBench(state, actor, action.benchIndex)
    case 'beginAttack':
      return beginAttack(state, actor)
    case 'useAttack':
      return declareAttack(state, actor, action.attackIndex)
    case 'pass':
      return pass(state, actor)
    case 'promoteActive':
      return failure(state, 'no-promotion-pending')
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
  next.promotionQueue = next.promotionQueue.filter((slot) => slot !== actor)
  next.pendingPromotion = next.promotionQueue[0] ?? null
  logEvent(next, 'pokemonBnb.log.promote', { player: actor, card: promoted.card.name })
  if (!next.pendingPromotion && next.phase === 'between') {
    next.turnStarted = false
    next.phase = 'draw'
    next.pendingPromotion = null
    next.promotionQueue = []
    const started = applyStartOfTurn(next)
    return { state: started, log: tailLog(started, logStart) }
  }
  checkVictory(next)
  return { state: next, log: tailLog(next, logStart) }
}
