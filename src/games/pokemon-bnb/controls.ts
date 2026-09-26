// CP7: pure control availability. One table decides, for every battle control,
// whether it is playable and — when it is not — the translated reason key.
//
// This is deliberately NOT inside the React component: the action bar must not
// re-derive rules, because the engine already owns them (`processAction` returns
// the same codes). Two consequences the UI alone got wrong before:
//   - a disabled button gave the player no reason at all, so "why can't I play
//     this?" was unanswerable; the reason is now data the bar renders;
//   - the table is testable without a DOM, so a rule change fails an assertion
//     instead of silently stranding a player.
//
// Reason codes are the engine's own, so the bar never invents a rule: it only
// surfaces, ahead of time, what the engine would have said on submit.

import type { BattleState, SideState } from './game-core'
import type { PlayerSlot } from './net/protocol'
import { cardIsEnergy, cardIsPokemon, cardIsTrainer, isBasicPokemon } from './cards'
import { MAX_BENCH, canEvolveOnto, inPlayOf } from './game-core'

export type ControlId =
  | 'attachEnergy'
  | 'playBasic'
  | 'playItem'
  | 'playSupporter'
  | 'playStadium'
  | 'attachTool'
  | 'evolve'
  | 'retreat'
  | 'beginAttack'
  | 'pass'
  | 'promote'

export type ControlState = { enabled: boolean; reason: string | null }

/** What the player currently has picked on the board. */
export type Selection = { handIndex: number | null; benchIndex: number | null }

type InPlayLike = NonNullable<SideState['active']>

const OK: ControlState = { enabled: true, reason: null }
const blocked = (reason: string): ControlState => ({ enabled: false, reason })

/** Trainer subtype of the picked hand card, or null when none is picked. */
function trainerType(side: SideState, index: number | null): string | null {
  if (index === null) return null
  const card = side.hand[index]
  if (!card || !cardIsTrainer(card)) return null
  return card.trainerType.trim().toLowerCase()
}

function selectedCard(side: SideState, index: number | null) {
  return index === null ? null : (side.hand[index] ?? null)
}

/**
 * Availability of every control for `actor` given the live state and the
 * current selection. Reasons are engine error codes, which the UI renders
 * through its existing `pokemonBnb.error.*` copy.
 */
export function controlStates(
  state: BattleState,
  actor: PlayerSlot,
  selection: Selection,
): Record<ControlId, ControlState> {
  const side = state[actor]
  const { handIndex, benchIndex } = selection
  const picked = selectedCard(side, handIndex)
  const target = benchIndex === null ? null : inPlayOf(side, benchIndex)
  const isMain = state.phase === 'main' && state.activePlayer === actor && !state.over
  const isAttack = state.phase === 'attack' && state.activePlayer === actor && !state.over

  // A pending Knock Out blocks every ordinary action until that side promotes.
  // `promote` is the one exception: it is exactly the action the gate is for.
  if (state.pendingPromotion !== null) {
    const waiting: ControlState = state.pendingPromotion === actor ? blocked('must-promote') : blocked('not-your-turn')
    const promoteFor: ControlState = state.pendingPromotion === actor
      ? (side.bench.length === 0
          ? blocked('no-promotion-pending')
          : benchIndex === null
            ? blocked('select-bench-target')
            : OK)
      : blocked('no-promotion-pending')
    return {
      attachEnergy: waiting, playBasic: waiting, playItem: waiting, playSupporter: waiting,
      playStadium: waiting, attachTool: waiting, evolve: waiting, retreat: waiting,
      beginAttack: waiting, pass: waiting, promote: promoteFor,
    }
  }

  const notMain: ControlState = blocked(state.over ? 'match-over' : isAttack ? 'not-main-phase' : 'not-your-turn')
  const targetOrActive: InPlayLike | null = benchIndex === null ? side.active : target

  const energy = picked && cardIsEnergy(picked)
    ? (side.energyAttachedThisTurn >= 1 ? blocked('energy-limit') : targetOrActive ? OK : blocked('no-target'))
    : blocked(handIndex === null ? 'select-hand-card' : 'not-energy')

  const basic = picked && isBasicPokemon(picked)
    ? (side.bench.length >= MAX_BENCH ? blocked('bench-full') : OK)
    : blocked(handIndex === null ? 'select-hand-card' : 'not-basic')

  // Item is unlimited; Supporter and Stadium are once per turn.
  const item = trainerType(side, handIndex) === 'item'
    ? OK
    : blocked(handIndex === null ? 'select-hand-card' : 'not-item')

  const supporter = trainerType(side, handIndex) !== 'supporter'
    ? blocked(handIndex === null ? 'select-hand-card' : 'not-supporter')
    : side.supporterPlayedTurn
      ? blocked('supporter-limit')
      : state.turn === 1 && state.setup.firstPlayer === actor
        ? blocked('first-turn-supporter')
        : OK

  const stadium = trainerType(side, handIndex) !== 'stadium'
    ? blocked(handIndex === null ? 'select-hand-card' : 'not-stadium')
    : state.stadium?.name === picked?.name
      ? blocked('same-stadium')
      : side.stadiumPlayedTurn === state.turn
        ? blocked('stadium-limit')
        : OK

  const tool = trainerType(side, handIndex) !== 'tool'
    ? blocked(handIndex === null ? 'select-hand-card' : 'not-tool')
    : !targetOrActive
      ? blocked('no-target')
      : targetOrActive.attachedTool
        ? blocked('tool-limit')
        : OK

  const evolve = !picked || !cardIsPokemon(picked)
    ? blocked(handIndex === null ? 'select-hand-card' : 'cannot-evolve')
    : !targetOrActive
      ? blocked('no-target')
      : !canEvolveOnto(picked, targetOrActive)
        ? blocked('cannot-evolve')
        : targetOrActive.enteredTurn === state.turn
          ? blocked('played-this-turn')
          : targetOrActive.evolvedTurn === state.turn
            ? blocked('evolved-this-turn')
            : OK


  const active = side.active
  const retreat = !active
    ? blocked('no-active')
    : active.conditions.asleep || active.conditions.paralyzed
      ? blocked('cannot-retreat')
      : side.retreatedThisTurn
        ? blocked('retreat-limit')
        : active.attachedEnergy.length < active.card.retreat
          ? blocked('retreat-cost')
          : benchIndex === null
            ? blocked('select-bench-target')
            : OK

  const beginAttack = !isMain
    ? notMain
    : !active
      ? blocked('no-active')
      : state.turn === 1 && state.setup.firstPlayer === actor
        ? blocked('first-turn-attack')
        : active.conditions.asleep || active.conditions.paralyzed
          ? blocked('cannot-attack')
          : active.card.attacks.length === 0
            ? blocked('no-attack')
            : OK

  const promote = state.pendingPromotion === actor
    ? side.bench.length === 0
      ? blocked('no-promotion-pending')
      : benchIndex === null
        ? blocked('select-bench-target')
        : OK
    : blocked('no-promotion-pending')

  return {
    attachEnergy: isMain ? energy : notMain,
    playBasic: isMain ? basic : notMain,
    playItem: isMain ? item : notMain,
    playSupporter: isMain ? supporter : notMain,
    playStadium: isMain ? stadium : notMain,
    attachTool: isMain ? tool : notMain,
    evolve: isMain ? evolve : notMain,
    retreat: isMain ? retreat : notMain,
    beginAttack,
    pass: isAttack ? OK : notMain,
    promote,
  }
}

/** Engine error code -> the `pokemonBnb.error.*` key that explains it. */
export function reasonKey(reason: string): string {
  const camel = reason.split('-').map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1))).join('')
  return `pokemonBnb.error.${camel}`
}

