// Player actions and the single dispatcher entry point: Main-phase card/Retreat
// actions, explicit Attack/Pass, setup intents, promotion, and processAction.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import { cardIsEnergy, cardIsPokemon, cardIsTrainer, isBasicPokemon, type CardDef, type EnergyCardDef, type PokemonCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { CONFUSION_SELF_DAMAGE, ENERGY_PER_TURN, MAX_BENCH } from './constants'
import { activeIsUnhealable, applySwitchInPlace, canEvolveOnto, canPayCost, checkAttackPhase, checkTurn, cloneBattleState, damageCounters, effectiveRetreatCost, failure, findDuration, foeOf, inPlayList, inPlayOf, isAttackLocked, isKnockedOut, logEvent, sideOf, tailLog } from './helpers'
import type { ActionResult, BattleAction, BattleState, ChoiceTarget, PendingChoice, SideState } from './types'
import { applyAbilityEffect, classifyAbility, computeAttackDamage, flipCoin, isPlayerTriggeredAbility, parseAttackEffects, recordAttackDamageOn, refreshChoiceTargets, resolveAttack } from './effects'
import { confirmSetupReveal, chooseSetupPokemon, chooseTurnOrder, keepSetupHand, mulliganSetup } from './setup'
import { applyEndTurn, applyStartOfTurn, checkVictory, performBenchKo, performKo } from './turns'

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
/**
 * 04.10 CP8 / 084: is a live `interceptTrainer` riding the OPPOSITOR's Pokemon?
 *
 * The duration rides the Seismitoad, so this walks the OPPONENT's board rather than
 * looking at the acting seat's — the two are deliberately different, and a version
 * that read the actor's own Pokemon would be permanently false and look harmless.
 */
function trainerIntercepted(state: BattleState, actor: PlayerSlot): boolean {
  for (const pokemon of inPlayList(sideOf(state, foeOf(actor)))) {
    if (findDuration(state, pokemon.uid, 'interceptTrainer')) return true
  }
  return false
}

export function playTrainer(state: BattleState, actor: PlayerSlot, handIndex: number): ActionResult {
  const blocked = checkTurn(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  const side = sideOf(next, actor)
  const card = side.hand[handIndex]
  if (!card || !cardIsTrainer(card)) return failure(state, 'not-trainer')
  const trainerType = card.trainerType.trim().toLowerCase()
  if (trainerType === 'tool') return failure(state, 'not-trainer')
  // 04.10 CP8 / 084 Seismitoad: the opponent's Trainer play is gated for one turn. The
  // flip happens HERE, on the play, and tails DISCARDS the card instead of using it —
  // so the card is spent either way and the turn is not consumed, which is what makes
  // this a gate rather than a replacement effect. `findDuration` matches by uid, and the
  // uid is the Seismitoad's, not the acting seat's, so the two can never be confused.
  if (trainerIntercepted(next, actor)) {
    const interceptLogStart = next.log.length
    if (flipCoin(next)) {
      side.hand.splice(handIndex, 1)
      side.discard.push(card)
      logEvent(next, 'pokemonBnb.log.trainerIntercepted', { player: actor, card: card.name })
      return { state: next, log: tailLog(next, interceptLogStart) }
    }
    logEvent(next, 'pokemonBnb.log.trainerInterceptHeads', { player: actor, card: card.name })
  }
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
    // 04.10 CP3: a Pokemon entering play has taken no attack damage, so its memory
    // starts stamped -1 and reads as 0 forever until an attack actually lands.
    lastTurnAttackedTurn: -1,
    lastTurnAttackedAmount: 0,
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
  // 04.9 CP5: 093's "the Defending Pokemon can't retreat" is a duration, not a
  // condition, and rides the Active by uid. `controls.ts` asks the same question,
  // so the Retreat button and the engine cannot disagree.
  if (findDuration(next, active.uid, 'cantRetreat')) return failure(state, 'duration-cant-retreat')
  if (side.retreatedThisTurn) return failure(state, 'retreat-limit')
  // 04.9 CP6 / 096: Zoroark's "-2" applies only while the Zoroark is on the Bench,
  // so the payable cost comes from `effectiveRetreatCost` rather than the printed
  // `card.retreat`. `controls.ts` reads the same helper, so the button's `retreat-cost`
  // reason and this refusal can never disagree.
  const retreatCost = effectiveRetreatCost(next, actor)
  if (active.attachedEnergy.length < retreatCost) return failure(state, 'retreat-cost')

  const logStart = next.log.length
  // 04.9 CP6 / 096: pay the REDUCED cost, not the printed one — the two are equal
  // whenever no passive is in play, so this is a no-op on an ordinary retreat.
  const paid = active.attachedEnergy.splice(0, retreatCost)
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
 * Preconditions for declaring an attack, accepting BOTH entry points.
 *
 * CP2-A: the rulebook's "Attack step" and the UI's one-click attack button are
 * the same decision, so an attack may be declared from the Main phase (one
 * click, one P2P intent) as well as from the Attack step that `beginAttack`
 * opens. `checkAttackPhase` stays STRICT on purpose: it still describes "you
 * are in the attack step", which is what `pass` needs to tell apart, so the two
 * guards cannot be silently conflated.
 *
 * Every other rule (your turn, not Asleep/Paralyzed, one attack per turn, the
 * Energy cost) is checked once, in `declareAttack`, so this only decides
 * *which phase* may declare.
 */
function checkAttackDeclaration(state: BattleState, actor: PlayerSlot): string | null {
  if (state.setup.phase !== 'complete') return 'setup-incomplete'
  if (state.over) return 'match-over'
  if (state.activePlayer !== actor) return 'not-your-turn'
  if (state.phase !== 'main' && state.phase !== 'attack') return 'not-attack-phase'
  return null
}

/**
 * Declare an attack. This sub-phase owns the action-level rules: it must be
 * your turn in the Main phase or the Attack step, the Active Pokemon cannot be
 * Asleep or Paralyzed, only one attack per turn, and the attack's Energy cost
 * must be payable. Attacking ends your turn (rulebook), so the turn closes here.
 *
 * CP2-A: declaring from the Main phase enters the Attack step first, so the
 * phase header and the log report the step the attack was actually taken from
 * rather than jumping straight from Main to Between-Turns.
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
  const blocked = checkAttackDeclaration(state, actor)
  if (blocked) return failure(state, blocked)
  const next = cloneBattleState(state)
  // Enter the Attack step before anything is resolved. Every rejection below
  // returns `failure(state, ...)`, i.e. the ORIGINAL state, so a refused attack
  // can never leave the phase advanced.
  next.phase = 'attack'
  const side = sideOf(next, actor)
  const active = side.active
  if (!active) return failure(state, 'no-active')
  const attack = active.card.attacks[attackIndex]
  if (!attack) return failure(state, 'no-attack')
  if (active.conditions.asleep || active.conditions.paralyzed) return failure(state, 'cannot-attack')
  // 04.9 CP5: a live `cantAttack` / `cantUseAttack` duration (060/106/134/151/157)
  // is an ACTION gate, not a Special Condition, so it is checked here rather than
  // folded into `conditions` — the two end differently (this expires with its turn,
  // Paralysis expires at Between-Turns). `controls.ts` asks the same question via
  // `isAttackLocked`, so the button and the engine can never disagree.
  if (isAttackLocked(next, active.uid, attack.name)) return failure(state, 'duration-cant-attack')
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

  // 04.8 CP2-B: a parked choice holds the turn OPEN — the attack is not finished
  // until the player has picked a target, so `applyEndTurn` must not run yet.
  // `resolveChoice` closes it once the pick lands.
  if (next.pendingChoice) return { state: next, log: tailLog(next, logStart) }

  // Attacking ends the turn, unless the attack already ended the match.
  const closed = next.over ? next : applyEndTurn(next, actor)
  return { state: closed, log: tailLog(closed, logStart) }
}

// -- Sub-phase: end the turn --

/**
 * Pass ends the turn without an attack.
 *
 * Pass is legal from BOTH the Main Turn and the Attack step. The rulebook puts
 * "Attack or Pass" at the end of the turn, and only declares the *attack* final
 * — a player who is told they cannot attack (the first player on Turn 1, or
 * any turn with no Energy) must still be able to end their turn. Gating Pass
 * behind the Attack step alone deadlocked the opening turn outright: the first
 * player could not attack, so could not reach Pass, so the match never advanced.
 */
export function pass(state: BattleState, actor: PlayerSlot): ActionResult {
  // checkAttackPhase always returns a code, so test the phase explicitly: Pass is
  // legal in the main phase as well as the attack step.
  const blocked = state.phase === 'main' ? checkTurn(state, actor) : checkAttackPhase(state, actor)
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
      case 'keepSetupHand':
        return keepSetupHand(state, actor)
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
  // 04.8 CP2: a pending choice blocks everything but its own resolution, on the
  // same discipline as a Knock Out. Checked AFTER promotion deliberately: a KO is
  // a hard game-state requirement that must never be pre-empted by an effect
  // clause, and a Bench knockout can open a promotion while a choice is open.
  if (state.pendingChoice) {
    if (action.type === 'chooseTarget' && actor === state.pendingChoice.actor) {
      return resolveChoice(state, actor, action.targetIndex)
    }
    // 04.9 CP4: "up to N" is permissive, so declining the remaining picks is a legal
    // outcome and not a way to dodge the effect. Gated on `remaining > 1` below in
    // `finishChoice` — a choice with one pick left is mandatory, and allowing an
    // early exit there would let a player skip a printed effect entirely.
    if (action.type === 'finishChoice' && actor === state.pendingChoice.actor) {
      return finishChoice(state, actor)
    }
    return failure(state, 'must-choose-target')
  }
  switch (action.type) {
    case 'confirmSetupReveal':
    case 'chooseTurnOrder':
    case 'keepSetupHand':
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
    case 'chooseTarget':
      return failure(state, 'no-choice-pending')
    // 04.9 CP4: nothing is parked, so there is nothing to finish.
    case 'finishChoice':
      return failure(state, 'no-choice-pending')
    default:
      return failure(state, 'unknown-action')
  }
}

/**
 * Resolve a pending choice (04.8 CP2) by INDEX into the target list the engine
 * already agreed to expose. An index rather than a zone reference, so a client
 * cannot name a target the engine never offered — the list is the contract.
 *
 * The Active takes the effect through the ordinary Weakness/Resistance path;
 * a Benched target takes the flat amount, honouring the "(Don't apply Weakness
 * and Resistance for Benched Pokémon.)" rider those cards print. Either knockout
 * then settles on its own path (`performKo` / `performBenchKo`), and the turn
 * closes, since the attack that opened the choice is now finished.
 */
/**
 * 04.10 CP4: the actor's own in-play Pokemon, as choice targets — Active first, then
 * the Bench, which is the order the board reads in and therefore the order the picker
 * offers. Every one of them is legal: 063 says "1 of your Pokemon" and 007 says "your
 * Pokemon in any way you like", with no condition on the target, so no entry is
 * filtered out here.
 */
function inPlayTargets(state: BattleState, actor: PlayerSlot): ChoiceTarget[] {
  return inPlayList(sideOf(state, actor)).map((pokemon) => ({
    side: actor,
    zone: (pokemon === sideOf(state, actor).active ? 'active' : sideOf(state, actor).bench.indexOf(pokemon)) as 'active' | number,
    uid: pokemon.uid,
  }))
}

export function resolveChoice(state: BattleState, actor: PlayerSlot, targetIndex: number): ActionResult {
  if (state.over) return failure(state, 'match-over')
  const choice = state.pendingChoice
  if (!choice) return failure(state, 'no-choice-pending')
  if (choice.actor !== actor) return failure(state, 'not-your-turn')
  const target = choice.targets[targetIndex]
  if (!target) return failure(state, 'no-target')

  const next = cloneBattleState(state)
  const logStart = next.log.length

  // 04.9 CP3: move the chosen card out of a side's DISCARD PILE. Resolved before
  // the deck search, because both are card movements and only the source differs.
  // The index is re-validated against the card id — a discard pile can hold
  // duplicates, so an id alone would not identify a card.
  if (choice.effect.kind === 'pickFromDiscard') {
    if (target.zone !== 'discard') return failure(state, 'no-target')
    const pile = sideOf(next, target.side).discard
    const found = pile[target.index]
    if (!found || found.id !== target.cardId) return failure(state, 'no-target')
    pile.splice(target.index, 1)
    if (choice.effect.to === 'hand') sideOf(next, target.side).hand.push(found)
    else sideOf(next, target.side).deck.push(found)
    next.pendingChoice = null
    logEvent(next, 'pokemonBnb.log.effectSearchDeck', { player: actor, card: found.name })
    const closedPick = next.over ? next : applyEndTurn(next, actor)
    return { state: closedPick, log: tailLog(closedPick, logStart) }
  }

  // 04.9 CP2: a heal is resolved BEFORE the deck search and the damage paths,
  // because it is its own effect kind rather than a variant of them. The cap is
  // applied against the damage actually on the target, so "heal 80" on a
  // 30-damaged Pokemon removes 30 and never pushes it below 0. Looked up by uid,
  // like every other in-play target, so a promotion cannot make it mean a
  // different Pokemon.
  if (choice.effect.kind === 'healChosen') {
    // Explicit narrowing: a deck or discard target is not an in-play Pokemon.
    if (target.zone === 'deck' || target.zone === 'discard' || target.zone === 'hand') return failure(state, 'no-target')
    const patient = inPlayList(sideOf(next, target.side)).find((pokemon) => pokemon.uid === target.uid)
    if (!patient) return failure(state, 'no-target')
    // 04.9 CP6 / 100: Yveltal's "your opponent's Active Pokemon can't be healed". The
    // printed scope is the ACTIVE specifically, so a Benched patient is still healable
    // — gating every Pokemon would be a wrong effect, not a stricter one.
    if (activeIsUnhealable(next, target.side) && sideOf(next, target.side).active === patient) {
      return failure(state, 'target-cannot-be-healed')
    }
    const healed = Math.min(choice.effect.amount === 'all' ? patient.damage : choice.effect.amount, patient.damage)
    patient.damage -= healed
    next.pendingChoice = null
    logEvent(next, 'pokemonBnb.log.effectHeal', { player: actor, target: patient.card.name, amount: healed })
    const closedHeal = next.over ? next : applyEndTurn(next, actor)
    return { state: closedHeal, log: tailLog(closedHeal, logStart) }
  }

  // 04.10 CP4: STAGE TWO of a two-stage pick — "in any way you like" (007) / "to 1 of
  // your Pokemon" (063). The cards are already out of their pile in `staged`; this
  // picks the DESTINATION and commits them.
  //
  // It runs before the `searchDeckUpTo` arm because a `searchAttachEnergy` pick is
  // handled by the arm below, which re-parks rather than closing.
  if (choice.effect.kind === 'attachStaged') {
    // Narrow to the in-play variant explicitly: a ternary does not carry narrowing
    // past the expression, and the deck/discard arms below already return on their own
    // zones, so this arm must prove the target is a Pokemon before reading `uid`.
    if (target.zone === 'deck' || target.zone === 'discard' || target.zone === 'hand') return failure(state, 'no-target')
    const ownSide = sideOf(next, actor)
    const pokemon = inPlayList(ownSide).find((entry) => entry.uid === target.uid)
    if (!pokemon) return failure(state, 'no-target')
    const staged = choice.staged ?? []
    if (staged.length === 0) return failure(state, 'no-target')
    for (const card of staged) {
      pokemon.attachedEnergy.push(card as EnergyCardDef)
      logEvent(next, 'pokemonBnb.log.attachEnergy', { player: actor, card: card.name, target: pokemon.card.name })
    }
    logEvent(next, 'pokemonBnb.log.effectSearchDeck', { player: actor, count: staged.length })
    // 04.10 CP4: 'perCard' (007) still has cards left to lift, so stage two must RE-PARK
    // the pile rather than close. `parent` is what makes that possible: without it this
    // arm cannot tell "one more card to choose" from "finished", and it closed the turn
    // after the first card — 007 attaching exactly one Energy instead of two.
    if (choice.effect.parent.target === 'perCard' && choice.remaining > 0) {
      const resume: PendingChoice = {
        ...choice, staged: [], remaining: choice.remaining, source: choice.effect.parent.from,
        effect: choice.effect.parent, targets: [],
      }
      const more = refreshChoiceTargets(next, resume)
      if (more.length > 0) {
        resume.targets = more
        next.pendingChoice = resume
        logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: more.length })
        return { state: next, log: tailLog(next, logStart) }
      }
    }
    // The choice MUST be cleared here. `next` is a clone of a state that had
    // `pendingChoice` set, and `applyEndTurn` does not clear it — so without this the
    // turn ended with a finished choice still parked, and `processAction` refused every
    // subsequent action with `must-choose-target`. Every other closing arm in this
    // function does the same; the first run of the harness caught the omission as
    // "a hand attach is still available" failing.
    next.pendingChoice = null
    const closedAttach = next.over ? next : applyEndTurn(next, actor)
    return { state: closedAttach, log: tailLog(closedAttach, logStart) }
  }

  // 04.10 CP5 / 073-136: the self-shuffle. "THIS Pokemon" means the target must be the
  // actor's own ACTIVE — a forged target naming a Benched Pokemon would move the wrong
  // card, and one naming the opponent's would be absurd. The uid is re-checked rather
  // than the stored zone, for the promotion reason every other in-play pick here uses.
  if (choice.effect.kind === 'shuffleSelfIntoDeck') {
    if (target.zone === 'deck' || target.zone === 'discard' || target.zone === 'hand') {
      return failure(state, 'no-target')
    }
    const side = sideOf(next, actor)
    const active = side.active
    if (!active || active.uid !== target.uid) return failure(state, 'no-target')
    // The Pokemon AND every attached card go back. `attachedTool` is included because
    // "all attached cards" covers a Tool exactly as it covers Energy; leaving the Tool
    // behind would orphan a card that is in no zone at all.
    side.deck.push(active.card, ...active.attachedEnergy, ...(active.attachedTool ? [active.attachedTool] : []))
    side.active = null
    logEvent(next, 'pokemonBnb.log.effectSearchDeck', { player: actor, card: active.card.name })
    // The Active spot is now EMPTY, so the actor must promote — exactly the gate
    // `performKo` sets. Reusing the same queue is what lets one promotion action serve
    // both, and keeps a Drifloon that shuffles itself away from soft-locking the match.
    if (side.bench.length > 0) {
      if (!next.promotionQueue.includes(actor)) next.promotionQueue.push(actor)
      next.pendingPromotion = next.promotionQueue[0] ?? null
      logEvent(next, 'pokemonBnb.log.mustPromote', { player: actor })
    } else {
      // No Pokemon in play at all. The card IS in the deck, so this is not the same as a
      // knockout, but the engine's existing `no-pokemon` loss is the only outcome that
      // fits, and inventing a new one here would be a rules change.
      next.winner = foeOf(actor)
      next.winReason = 'no-pokemon'
      next.over = true
      next.pendingPromotion = null
      next.promotionQueue = []
    }
    if (next.over) {
      next.pendingChoice = null
      return { state: next, log: tailLog(next, logStart) }
    }
    // With a promotion pending, `applyEndTurn` is deferred: the turn is still over, but
    // the actor must choose the replacement first — the same order `performKo` sets up.
    next.pendingChoice = null
    const closedShuffle = applyEndTurn(next, actor)
    return { state: closedShuffle, log: tailLog(closedShuffle, logStart) }
  }

  // 04.10 CP4: STAGE ONE — lift a Basic Energy card out of its zone. Where it GOES is
  // not decided here, because the three printed destination rules differ:
  //  - 'attacker'  042 attaches immediately and never parks a second picker.
  //  - 'perCard'   007 parks a destination for this one card, then re-parks the pile.
  //  - 'oneForAll' 063 keeps collecting cards, then parks ONE destination for them all.
  if (choice.effect.kind === 'searchAttachEnergy') {
    const fromDiscard = choice.effect.from === 'discard'
    const fromHand = choice.effect.from === 'hand'
    const ownSide = sideOf(next, actor)
    // The zone is chosen by the CLAUSE, and the target must actually be an entry of it.
    // Checking the clause rather than trusting the target stops a forged `zone` from
    // naming a card in a zone this effect never reads — the 04.10 CP1 guard, now also
    // covering the hand, which is the zone a forged target is most likely to reach for.
    if (fromDiscard !== (target.zone === 'discard')) return failure(state, 'no-target')
    if (fromHand !== (target.zone === 'hand')) return failure(state, 'no-target')
    const pile = fromDiscard ? ownSide.discard : fromHand ? ownSide.hand : ownSide.deck
    const index = fromDiscard
      ? (target.zone === 'discard' ? target.index : -1)
      : fromHand
        ? (target.zone === 'hand' ? target.index : -1)
        : (target.zone === 'deck' ? target.deckIndex : -1)
    if (index < 0) return failure(state, 'no-target')
    const cardId = 'cardId' in target ? target.cardId : null
    const found = cardId ? pile[index] : undefined
    if (!found || found.id !== cardId) return failure(state, 'no-target')
    // Re-validate the FILTER at resolve time as well as at park time: a card can only
    // have been removed from this pile while the choice was open, but a forged index
    // could name a non-Energy card, and attaching a Pokemon would be a wrong effect.
    if (!cardIsEnergy(found) || found.provides === undefined) return failure(state, 'not-energy')
    if (choice.effect.energyType && found.provides !== choice.effect.energyType) {
      return failure(state, 'no-target')
    }
    pile.splice(index, 1)

    const remaining = choice.remaining - 1
    const staged = [...(choice.staged ?? []), found]
    const destination = choice.effect.target === 'attacker'
      ? sideOf(next, actor).active
      : null

    if (destination) {
      // 042: "attach it to THIS Pokemon" — no second pick, so commit and move on.
      destination.attachedEnergy.push(found as EnergyCardDef)
      logEvent(next, 'pokemonBnb.log.attachEnergy', {
        player: actor, card: found.name, target: destination.card.name,
      })
      const after: PendingChoice = { ...choice, remaining, staged: [], targets: [] }
      const more = refreshChoiceTargets(next, after)
      if (after.remaining > 0 && more.length > 0) {
        after.targets = more
        next.pendingChoice = after
        logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: after.targets.length })
        return { state: next, log: tailLog(next, logStart) }
      }
      const closedAttacker = next.over ? next : applyEndTurn(next, actor)
      return { state: closedAttacker, log: tailLog(closedAttacker, logStart) }
    }

    if (choice.effect.target === 'perCard') {
      // 007: this card alone needs a destination, so park it NOW and keep the pile
      // pick for afterwards. The staged list is exactly one card deep here.
      next.pendingChoice = {
        ...choice, staged, remaining,
        source: 'inPlay', effect: { kind: 'attachStaged', parent: choice.effect },
        targets: inPlayTargets(next, actor),
      }
      logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: next.pendingChoice.targets.length })
      return { state: next, log: tailLog(next, logStart) }
    }

    // 063: keep collecting until the cap is reached, then choose ONE destination for
    // all of them. `staged` is what makes "up to 2" mean "1 or 2, same Pokemon".
    const more: PendingChoice = { ...choice, remaining, staged, targets: [] }
    const available = refreshChoiceTargets(next, more)
    if (more.remaining > 0 && available.length > 0) {
      more.targets = available
      next.pendingChoice = more
      logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: more.targets.length })
      return { state: next, log: tailLog(next, logStart) }
    }
    next.pendingChoice = {
      ...choice, staged, remaining: 0,
      source: 'inPlay', effect: { kind: 'attachStaged', parent: choice.effect },
      targets: inPlayTargets(next, actor),
    }
    logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: next.pendingChoice.targets.length })
    return { state: next, log: tailLog(next, logStart) }
  }

  // 04.9 CP4: the "up to N" ZONE search is the ONE effect that resolves more than
  // once. It runs BEFORE the single-card search below, because both move a card out
  // of a zone and only the cap differs. After a pick it re-parks itself with a
  // REBUILT target list rather than closing the turn, and only the last pick (or an
  // explicit `finishChoice`) closes it.
  if (choice.effect.kind === 'searchDeckUpTo') {
    // 04.10 CP1: the SOURCE ZONE is part of the clause, so the pile is chosen here
    // rather than assumed. The index is re-validated against the live pile on every
    // pick — an id alone would not identify a card, because both a Deck and a discard
    // pile hold DUPLICATES.
    const fromDiscard = choice.effect.from === 'discard'
    const ownSide = sideOf(next, actor)
    // The pile is chosen by the CLAUSE's source, and the target must actually be an
    // entry of that pile. Checking the clause rather than trusting the target is what
    // stops a forged `zone` from naming a card in the other pile.
    if (fromDiscard !== (target.zone === 'discard')) return failure(state, 'no-target')
    const pile = fromDiscard ? ownSide.discard : ownSide.deck
    const index = fromDiscard
      ? (target.zone === 'discard' ? target.index : -1)
      : (target.zone === 'deck' ? target.deckIndex : -1)
    if (index < 0) return failure(state, 'no-target')
    const cardId = 'cardId' in target ? target.cardId : null
    const found = cardId ? pile[index] : undefined
    if (!found || found.id !== cardId) return failure(state, 'no-target')
    pile.splice(index, 1)
    if (choice.effect.to === 'hand') {
      ownSide.hand.push(found)
    } else if (choice.effect.to === 'deck') {
      // 103: "Shuffle up to 3 … from your discard pile into your deck." The card returns
      // to the TOP. The printed shuffle is a known fidelity gap (04.8 CP3-B): the order
      // is deterministic rather than random, which both peers agree on because they run
      // identical code over an identical state.
      ownSide.deck.unshift(found)
    } else {
      // 'bench': the picked card was already filtered to Basic-only at park time, so
      // this is the same object shape `playBasic` builds. The uid must be UNIQUE
      // within the side: it is the authority for every later target pick, and the
      // `${id}#${turn}` form `playBasic` uses collides when two copies of one card
      // arrive on the same turn — which is exactly what "up to 2 Basic Pokemon" does.
      ownSide.bench.push({
        uid: uniqueBenchUid(ownSide, found, next.turn),
        card: found as PokemonCardDef,
        damage: 0,
        attachedEnergy: [],
        attachedTool: null,
        conditions: { asleep: false, paralyzed: false, confused: false, poisoned: false, burned: false },
        enteredTurn: next.turn,
        evolvedTurn: 0,
        energyAttachedTurn: 0,
        retreatedTurn: 0,
        abilityUsedTurn: 0,
        // 04.10 CP3: as in `playBasic` — a searched-in Pokemon has no attack memory.
        lastTurnAttackedTurn: -1,
        lastTurnAttackedAmount: 0,
      })
    }
    logEvent(next, 'pokemonBnb.log.effectSearchDeck', { player: actor, card: found.name })

    // Re-derive the list from the LIVE deck. A stored index cannot be reused: the
    // pick above spliced a card out, so every later index shifted. Nothing else has
    // to be subtracted — the splice IS the record of what was taken, which is what
    // keeps a second copy of the same card pickable.
    // `toBench` is read out of the narrowed effect ONCE and kept as a plain boolean:
    // spreading `choice` into a new object widens `effect` back to the whole union,
    // and TS does not carry the narrowing across that spread.
    const toBench = choice.effect.to === 'bench'
    const after: PendingChoice = { ...choice, remaining: choice.remaining - 1, targets: [] }
    // The Bench may have just filled up, which can end an "up to 2" search early
    // even though picks remain — the printed cap is an upper bound, not a quota.
    const roomLeft = toBench ? Math.max(0, MAX_BENCH - ownSide.bench.length) : Number.POSITIVE_INFINITY
    const targets = refreshChoiceTargets(next, after)
    if (after.remaining > 0 && roomLeft > 0 && targets.length > 0) {
      after.targets = targets
      next.pendingChoice = after
      logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: targets.length })
      return { state: next, log: tailLog(next, logStart) }
    }
    // Nothing more can be taken, so the search is over and the turn closes.
    next.pendingChoice = null
    const closedUpTo = next.over ? next : applyEndTurn(next, actor)
    return { state: closedUpTo, log: tailLog(closedUpTo, logStart) }
  }

  // 04.9 CP7: a board switch. Resolved BEFORE the damage paths, because it changes
  // which Pokemon is where and nothing after it may assume the old Active.
  if (choice.effect.kind === 'switchActive') {
    if (target.zone === 'deck' || target.zone === 'discard' || target.zone === 'hand') return failure(state, 'no-target')
    const side = sideOf(next, target.side)
    // Look the Pokemon up by `uid` (04.8 CP2-C: a promotion splices the Bench, so a
    // stored index can name a different Pokemon by the time it is resolved), then take
    // the CURRENT index of that object — the stored one is informational only.
    const incoming = side.bench.find((pokemon) => pokemon.uid === target.uid)
    if (!incoming) return failure(state, 'no-target')
    const benchIndex = side.bench.indexOf(incoming)
    const outgoing = side.active
    // `applySwitchInPlace` moves the whole object, so Energy, damage, conditions, the
    // Tool and the uid all travel with it — nothing here copies a field.
    const moved = applySwitchInPlace(side, benchIndex)
    if (!moved || !outgoing) return failure(state, 'no-target')
    next.pendingChoice = null
    logEvent(next, 'pokemonBnb.log.switch', {
      player: target.side,
      in: incoming.card.name,
      out: outgoing.card.name,
    })
    const closedSwitch = next.over ? next : applyEndTurn(next, actor)
    return { state: closedSwitch, log: tailLog(closedSwitch, logStart) }
  }

  // 04.10 CP1 / 081: the coin-gated "search for a CARD". Any card in the actor's own
  // deck qualifies, so there is no filter to apply — which is the whole difference
  // from `searchDeck`, and why it is a separate kind.
  if (choice.effect.kind === 'searchAnyToHand') {
    if (target.zone !== 'deck') return failure(state, 'no-target')
    const ownDeck = sideOf(next, target.side).deck
    const found = ownDeck[target.deckIndex]
    if (!found || found.id !== target.cardId) return failure(state, 'no-target')
    ownDeck.splice(target.deckIndex, 1)
    sideOf(next, target.side).hand.push(found)
    next.pendingChoice = null
    logEvent(next, 'pokemonBnb.log.effectSearchDeck', { player: actor, card: found.name })
    const closedAny = next.over ? next : applyEndTurn(next, actor)
    return { state: closedAny, log: tailLog(closedAny, logStart) }
  }

  // 04.8 CP3-B: a deck search moves the chosen card out of the actor's own Deck
  // and into hand. It is NOT a damage effect, so it short-circuits before any
  // Weakness/Resistance or Knock-Out maths. The deck index is re-validated
  // against the card id, because a Deck may hold duplicates and an id alone
  // would not identify a card.
  if (choice.effect.kind === 'searchDeck') {
    // Narrow the target union explicitly. A ternary does NOT keep its narrowing
    // past the expression, so the deck fields are read only after this guard.
    if (target.zone !== 'deck') return failure(state, 'no-target')
    const ownDeck = sideOf(next, target.side).deck
    const found = ownDeck[target.deckIndex]
    if (!found || found.id !== target.cardId) return failure(state, 'no-target')
    ownDeck.splice(target.deckIndex, 1)
    sideOf(next, target.side).hand.push(found)
    next.pendingChoice = null
    logEvent(next, 'pokemonBnb.log.effectSearchDeck', { player: actor, card: found.name })
    const closedDeck = next.over ? next : applyEndTurn(next, actor)
    return { state: closedDeck, log: tailLog(closedDeck, logStart) }
  }
  // Everything below works on an in-play Pokemon, so a deck or discard target is
  // invalid here.
  if (target.zone === 'deck' || target.zone === 'discard' || target.zone === 'hand') return failure(state, 'no-target')

  const targetSide = sideOf(next, target.side)
  // Looked up by `uid` across the whole side, NOT by the stored `zone` index. A KO
  // outranks a choice, so the player can promote BETWEEN the choice being offered
  // and it being resolved — and promoting splices the Bench, which both shifts the
  // later indices and can leave the stored index pointing past the end. The uid
  // is the only thing that survives that, so it is the sole authority here; the
  // stored `zone` is informational (the picker label) only.
  const victim = inPlayList(targetSide).find((pokemon) => pokemon.uid === target.uid)
  if (!victim) return failure(state, 'no-target')
  // Whether the KO settles on the Active or the Bench path is decided from the
  // board as it stands, not from the stale stored zone.
  const hitsActive = victim === targetSide.active
  const attacker = sideOf(next, actor).active

  const amount = choice.effect.kind === 'damagePerCounter'
    // 04.5's counter unit, read off the target's damage at pick time.
    ? choice.effect.amountPerCounter * damageCounters(victim.damage)
    : (hitsActive && attacker
        ? computeAttackDamage(next, attacker, victim, choice.effect.amount).damage
        : choice.effect.amount)
  if (amount > 0) {
    victim.damage += amount
    // 04.10 CP3: damage dealt by an ATTACK's effect is still "damage from an
    // attack", so 085/138 remembers it, and a KO here sets 005/091's side flag. Both
    // are recorded at the effect site rather than in `performKo`, so a Between-Turns
    // poison KO — which never reaches this code — cannot satisfy either card.
    recordAttackDamageOn(victim, next.turn, amount)
    logEvent(next, 'pokemonBnb.log.damageDealt', {
      player: actor,
      attack: choice.attackName,
      target: victim.card.name,
      amount,
    })
  }
  next.pendingChoice = null

  if (isKnockedOut(victim)) {
    // 04.10 CP3: as above — the flag is set here, at the attack's own damage effect,
    // and not inside `performKo`, so a poison or Burn KO stays excluded.
    sideOf(next, target.side).koByAttackTurn = next.turn
    if (hitsActive) performKo(next, target.side)
    else performBenchKo(next, target.side, victim)
  }
  const closed = next.over ? next : applyEndTurn(next, actor)
  return { state: closed, log: tailLog(closed, logStart) }
}

/**
 * 04.9 CP4: decline the remaining picks of a multi-pick and close the turn.
 *
 * Legal only for the `searchDeckUpTo` effect, which is the one whose printed cap
 * is a permission. "Search your deck for up to 2 Basic Pokemon" allows 0, 1 or 2,
 * so a player who wants just one must be able to stop here — gating this on
 * `remaining > 1` would have quietly turned "up to 2" into "0 or 2", which is a
 * WRONG effect rather than a stricter one.
 *
 * Every other choice effect is a single mandatory pick ("Heal 80 damage from 1 of
 * your Benched Pokemon"), and this refuses it outright: an early exit there would
 * be a way to skip a printed effect, the engine's forbidden failure.
 */
export function finishChoice(state: BattleState, actor: PlayerSlot): ActionResult {
  if (state.over) return failure(state, 'match-over')
  const choice = state.pendingChoice
  if (!choice) return failure(state, 'no-choice-pending')
  if (choice.actor !== actor) return failure(state, 'not-your-turn')
  // 04.9 CP7: a switch is optional exactly when its clause printed "You may"
  // (066/152/158). 032 prints no "may", so declining it would be skipping a printed
  // effect. The flag rides the EFFECT rather than being matched on the attack name, so
  // the two cannot drift apart.
  const optional = choice.effect.kind === 'switchActive' && choice.effect.optional
  // 04.10 CP5: 054/150 and 073/136 both print "You may", so both are declinable — and
  // the permission rides the EFFECT rather than the attack name, so it cannot drift.
  const mayClause = (choice.effect.kind === 'searchAttachEnergy' || choice.effect.kind === 'shuffleSelfIntoDeck')
    && choice.effect.optional
  // 04.10 CP4: `searchAttachEnergy` is declinable for the same reason `searchDeckUpTo`
  // is — "up to 2 Basic Energy" permits 0, 1 or 2. 042 ('attacker') is exempt in
  // practice because its cap can be 0 heads, in which case nothing is ever parked.
  if (choice.effect.kind !== 'searchDeckUpTo' && !mayClause && !optional) {
    return failure(state, 'choice-not-optional')
  }

  const next = cloneBattleState(state)
  const logStart = next.log.length
  // 04.10 CP4: 063's "up to 2 … to 1 of your Pokemon" can have cards ALREADY lifted
  // out of the discard when the player declines the rest. Closing the turn outright
  // would DESTROY them — they are spliced out of the pile and live only in `staged`,
  // so they would be in no zone at all. Declining must therefore still finish the
  // attach: park the destination pick instead. The "up to 0" case is already handled
  // earlier (an empty eligible pile parks nothing), so `staged` here is never empty.
  if (choice.effect.kind === 'searchAttachEnergy' && (choice.staged?.length ?? 0) > 0) {
    next.pendingChoice = {
      ...choice, remaining: 0,
      source: 'inPlay', effect: { kind: 'attachStaged', parent: choice.effect },
      targets: inPlayTargets(next, actor),
    }
    logEvent(next, 'pokemonBnb.log.chooseTarget', { player: actor, count: next.pendingChoice.targets.length })
    return { state: next, log: tailLog(next, logStart) }
  }
  // Whatever was already taken STAYS taken; only the chance to take more is declined.
  next.pendingChoice = null
  const closed = next.over ? next : applyEndTurn(next, actor)
  return { state: closed, log: tailLog(closed, logStart) }
}

/**
 * 04.9 CP4: a Bench uid that is unique within the side.
 *
 * `playBasic` builds `${card.id}#${turn}`, which collides when two copies of the
 * same card enter play on the same turn. That is not hypothetical here: "Search your
 * deck for up to 2 Basic Pokemon and put them onto your Bench" can put two Victini
 * on the Bench in one resolution, and a `uid` is the authority every later target
 * pick resolves by — two Pokémon sharing one would make a pick ambiguous.
 *
 * A numeric suffix is appended only on collision, so the common case keeps the
 * existing readable form and nothing that persisted changes shape.
 */
function uniqueBenchUid(side: SideState, card: CardDef, turn: number): string {
  const taken = new Set(inPlayList(side).map((pokemon) => pokemon.uid))
  const base = `${card.id}#${turn}`
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}#${suffix}`
    if (!taken.has(candidate)) return candidate
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
