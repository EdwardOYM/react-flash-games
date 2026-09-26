// Which actions a focused card offers, and whether each is legal right now.
//
// The rule gating is NOT re-derived here: every legality answer comes from
// `controlStates` (controls.ts), the same table the action bar uses. So the
// focus panel can never disagree with the bar about what is playable — the only
// thing this module decides is *which* controls are relevant to the card the
// player is looking at.
//
// Pure: no React, no DOM, no dispatch. The component maps an `id` back to an
// engine action.

import { cardIsEnergy, cardIsTrainer, isBasicPokemon, type CardDef } from './cards'
import { controlStates, type ControlId, type ControlState, type Selection } from './controls'
import type { BattleState, InPlayPokemon, SideState } from './game-core'
import type { PlayerSlot } from './net/protocol'

/** Which card is being inspected. `index` is a hand, bench, or discard index. */
export type CardRef = {
  seat: PlayerSlot
  source: 'hand' | 'active' | 'bench' | 'discard'
  index: number
}

export type FocusActionKind = 'control' | 'attack' | 'ability'

export type FocusAction = {
  /** Stable id, also the React key. */
  id: string
  kind: FocusActionKind
  /** Control id when `kind` is 'control'; attack/ability index otherwise. */
  ref: ControlId | number
  enabled: boolean
  reason: string | null
  /** True when the action also needs an in-play target. */
  needsTarget: boolean
}

const TARGETED: ControlId[] = ['attachEnergy', 'attachTool', 'evolve', 'retreat']

function controlAction(id: ControlId, control: ControlState): FocusAction {
  return {
    id,
    kind: 'control',
    ref: id,
    enabled: control.enabled,
    reason: control.reason,
    needsTarget: TARGETED.includes(id),
  }
}

/** The hand card's own control, from its supertype/stage. */
function handControlId(card: CardDef): ControlId | null {
  if (cardIsEnergy(card)) return 'attachEnergy'
  if (cardIsTrainer(card)) {
    switch (card.trainerType.trim().toLowerCase()) {
      case 'tool': return 'attachTool'
      case 'item': return 'playItem'
      case 'supporter': return 'playSupporter'
      case 'stadium': return 'playStadium'
      default: return null
    }
  }
  return isBasicPokemon(card) ? 'playBasic' : 'evolve'
}

/** The in-play Pokemon at `ref`, or null when the card moved or the seat is hidden. */
export function focusedPokemon(side: SideState, ref: CardRef): InPlayPokemon | null {
  if (ref.source === 'active') return side.active
  if (ref.source === 'bench') return side.bench[ref.index] ?? null
  return null
}

/**
 * Every action offered for the focused card, in play order.
 *
 * A hand card offers exactly the one action that card can be played with; an
 * in-play Pokemon offers its Attacks, its Abilities, and Evolve/Retreat. An
 * opponent's card offers nothing: it can be inspected, never played.
 */
export function focusActions(
  state: BattleState,
  actor: PlayerSlot,
  ref: CardRef,
  selection: Selection,
): FocusAction[] {
  const actingSide = state[actor]
  // A focused hand card IS the hand selection. Without this the control table
  // would answer for the action bar's pick (usually null) and every action on
  // the focused card would report "choose a hand card first".
  const effective: Selection = ref.source === 'hand'
    ? { ...selection, handIndex: ref.index }
    : selection
  const controls = controlStates(state, actor, effective)
  const own = ref.seat === actor

  if (ref.source === 'hand') {
    const card = actingSide.hand[ref.index]
    if (!card || !own) return []
    const id = handControlId(card)
    return id ? [controlAction(id, controls[id])] : []
  }

  const side = own ? actingSide : state[ref.seat]
  const pokemon = focusedPokemon(side, ref)
  if (!pokemon) return []
  const actions: FocusAction[] = []

  // Only the Active Pokemon can attack, and only while it is the actor's.
  if (own && ref.source === 'active') {
    // `beginAttack` already carries every attack precondition (your turn, an
    // Active, not Asleep/Paralyzed, not the first player's Turn 1), so it is
    // the single source of truth for "may I attack". Choosing an attack from
    // the Main phase opens the Attack step and declares in one go.
    const attackable = controls.beginAttack
    pokemon.card.attacks.forEach((_attack, index) => {
      actions.push({
        id: `attack-${index}`,
        kind: 'attack',
        ref: index,
        enabled: attackable.enabled,
        reason: attackable.reason,
        needsTarget: false,
      })
    })
    actions.push(controlAction('retreat', controls.retreat))
  }

  // Abilities are read from the card text, so only the ones the engine will
  // accept are offered; the engine still refuses an unmet requirement.
  if (own) {
    pokemon.card.abilities.forEach((ability, index) => {
      actions.push({
        id: `ability-${index}`,
        kind: 'ability',
        ref: index,
        enabled: true,
        reason: null,
        needsTarget: /heal 30 damage from 1 of your/i.test(ability.text),
      })
    })
    actions.push(controlAction('evolve', controls.evolve))
  }

  return actions
}

/** Does this card need an in-play target before its action can run? */
export function focusNeedsTarget(actions: FocusAction[]): boolean {
  return actions.some((action) => action.needsTarget && action.enabled)
}
