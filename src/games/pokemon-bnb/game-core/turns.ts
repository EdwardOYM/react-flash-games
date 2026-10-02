// Turn lifecycle: Draw reset/draw/deck-out, Main→Attack→Between-Turns flow,
// ordered Special Conditions/KOs/Prizes, timer, and promotion handover.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import { prizesForKnockOut } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { BURN_DAMAGE, DAMAGE_PER_COUNTER } from './constants'
import { cloneBattleState, drawCards, foeOf, hasPassive, inPlayList, isKnockedOut, logEvent, pruneDurations, sideOf } from './helpers'
import type { BattleState, InPlayPokemon } from './types'
import { flipCoin } from './effects'

/**
 * Hand the turn to the opponent, running Between-Turns before the switch.
 */
export function applyEndTurn(state: BattleState, actor: PlayerSlot): BattleState {
  state.phase = 'between'
  // 04.12 CP10-B: "Energy Burn ... FOR THE REST OF THE TURN" expires HERE, and only here.
  //
  // Cleared on BOTH sides, not just the actor's: the printed text is scoped to the ability's
  // own Pokemon, but the override is stored per SIDE, and leaving the opponent's stale
  // entries behind would let a later switch make a dead override apply to whatever Pokemon
  // inherited the position. `toSnapshot` ALSO filters by turn, so this is belt and braces —
  // the engine state is authoritative and the filter is what protects a rebuilt guest view.
  state.host.energyTypeOverride = []
  state.guest.energyTypeOverride = []
  applyCheckup(state, actor)
  if (state.over) return state
  const next = foeOf(actor)
  state.promotionQueue.sort((a, b) => Number(b === next) - Number(a === next))
  state.pendingPromotion = state.promotionQueue[0] ?? null
  // 04.9 CP5: durations expire HERE and nowhere else.
  //
  // The ORDER is load-bearing and was wrong at first: this ran BEFORE `turn += 1`,
  // so it filtered against the turn that was just ending and a clause naming that
  // turn was still `activeTurn >= state.turn` — nothing ever expired, and the
  // harness caught it as "the duration outlives its window". Pruning AFTER the
  // increment is what makes "during your next turn" mean exactly that turn: a
  // clause naming turn N is dropped the moment the counter reaches N+1.
  //
  // It sits above the branch because BOTH paths end the attacker's turn, and the
  // promotion gate only defers `applyStartOfTurn` — the turn has still advanced.
  state.activePlayer = next
  state.turn += 1
  state.turnStarted = false
  pruneDurations(state)
  if (state.pendingPromotion) {
    return state
  }
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

/** Move a knocked-out Pokemon and everything attached to it into the discard. */
function discardKnockedOut(side: ReturnType<typeof sideOf>, knockedOut: InPlayPokemon): void {
  side.discard.push(
    knockedOut.card,
    ...knockedOut.attachedEnergy,
    ...(knockedOut.attachedTool ? [knockedOut.attachedTool] : []),
  )
}

/**
 * The Prize payout for one knocked-out Pokemon, shared by the Active and Bench
 * Knock-Out paths (04.6, extracted 04.8 CP1).
 *
 * A Pokemon with an EX rule box is worth TWO Prize cards. The take is bounded by
 * what is actually left in the pile, so an ex knocked out with one prize
 * remaining takes that one card and wins, rather than reaching into an empty
 * pile. `takePrizeCard` calls `checkVictory`, so a pile emptied mid-loop ends
 * the match — hence the `state.over` break.
 *
 * One line per multi-prize knockout, and only then: a plain 1-prize knockout is
 * already fully explained by the generic `takePrize` line. The count is what was
 * ACTUALLY taken, not what the rule box was worth, so an ex knocked out with one
 * prize left reports 1 rather than claiming 2.
 */
function settleKnockOutPrizes(
  state: BattleState,
  beneficiary: PlayerSlot,
  knockedOut: InPlayPokemon,
): void {
  const prizesOwed = prizesForKnockOut(knockedOut.card)
  let prizesTaken = 0
  for (let taken = 0; taken < prizesOwed; taken += 1) {
    if (sideOf(state, beneficiary).prizeCount === 0) break
    takePrizeCard(state, beneficiary)
    prizesTaken += 1
    if (state.over) break
  }
  if (prizesOwed > 1) {
    logEvent(state, prizesTaken === 1 ? 'pokemonBnb.log.ruleBoxPrizesOne' : 'pokemonBnb.log.ruleBoxPrizes', {
      card: knockedOut.card.name,
      player: beneficiary,
      count: prizesTaken,
    })
  }
}

/** Knock Out the Active Pokemon of `koSlot`, then settle Prize and promotion. */
export function performKo(state: BattleState, koSlot: PlayerSlot): void {
  const koSide = sideOf(state, koSlot)
  const knockedOut = koSide.active
  if (!knockedOut) return
  koSide.active = null
  discardKnockedOut(koSide, knockedOut)
  logEvent(state, 'pokemonBnb.log.knockOut', { player: koSlot, card: knockedOut.card.name })

  const beneficiary = foeOf(koSlot)
  settleKnockOutPrizes(state, beneficiary, knockedOut)
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

/**
 * Knock Out a BENCHED Pokemon (04.8 CP1, for spread damage).
 *
 * Deliberately different from `performKo` in two ways, both rulebook: a benched
 * knockout leaves the Active alone, so there is no promotion gate; and the
 * opponent still takes the Prize cards the rule box is worth — benching an ex is
 * exactly how a player risks two prizes, so the EX payout applies here too.
 * `checkVictory` then ends the match if that emptied the pile, or if the side has
 * no Pokemon left in play at all.
 */
export function performBenchKo(
  state: BattleState,
  koSlot: PlayerSlot,
  knockedOut: InPlayPokemon,
): void {
  const koSide = sideOf(state, koSlot)
  const index = koSide.bench.indexOf(knockedOut)
  if (index < 0) return
  koSide.bench.splice(index, 1)
  discardKnockedOut(koSide, knockedOut)
  logEvent(state, 'pokemonBnb.log.knockOut', { player: koSlot, card: knockedOut.card.name })
  settleKnockOutPrizes(state, foeOf(koSlot), knockedOut)
  if (state.over) return
  checkVictory(state)
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
    // 04.11 CP6 / 169: the tick is a COUNTER COUNT, not a flat amount. It reads
    // `poisonCounters` (default 1, set by 169) and multiplies by the counter size, so a
    // Pokemon that somehow has no field set still ticks for the rulebook's 1 counter
    // rather than for `undefined` damage.
    const poisonDamage = (pokemon.poisonCounters ?? 1) * DAMAGE_PER_COUNTER
    pokemon.damage += poisonDamage
    logEvent(state, 'pokemonBnb.log.poisonDamage', { player: slot, card: pokemon.card.name, amount: poisonDamage })
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

  // 04.10 CP7 / 119 Snorlax: "If this Pokemon REMAINS Asleep during Pokemon Checkup,
  // heal all damage from this Pokemon."
  //
  // It MUST sit after the Asleep loop above. "Remains asleep" is a claim about the
  // OUTCOME of the wake-up coin, so reading `asleep` any earlier would heal on exactly
  // the turn the Pokemon wakes — the precise inverse of what the card prints. A Pokemon
  // that WOKE is not healed, and that single test is the whole Ability.
  for (const { pokemon } of actives) {
    if (!pokemon.conditions.asleep) continue
    if (!hasPassive(pokemon, 'healAllIfRemainsAsleepAtCheckup')) continue
    if (pokemon.damage === 0) continue
    const healed = pokemon.damage
    pokemon.damage = 0
    logEvent(state, 'pokemonBnb.log.abilityHeal', { target: pokemon.card.name, amount: healed })
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
