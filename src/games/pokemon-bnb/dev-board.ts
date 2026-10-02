// 04.12 CP9 — DEV/QA-ONLY seeded board. **Never reachable without the `?board=` URL param.**
//
// **WHY THIS EXISTS.** Everything since 04.11 CP13 was verified by reading code or by
// running headless harnesses, and 04.11 CP21 proved a button is *produced* but never saw
// one. The four deferred-damage / multi-pick dialogs (161, 174, 180, 182) have therefore
// never been seen by a human. There is no route to them: `?local=1` builds its deck by
// opening packs, so a specific card with a specific board is a matter of luck, and the
// rulebook's one-Energy-per-turn rule means reaching "3 Water attached" through real play
// takes three separate turns.
//
// **WHAT IT IS NOT.** It is not a mock and it does not touch the engine. It arranges a
// board, and the dialog that gets screenshotted is still produced by the REAL
// `processAction` -> `declareAttack` -> `resolveAttack` -> `resolveChoice` path. That is
// the whole point: a hand-built dialog would prove nothing about the shipped one.
//
// **THE ONE MUTATION, AND WHY IT IS ACCEPTABLE.** Setup is walked entirely through real
// engine actions, so the resulting state is legal by construction rather than
// hand-assembled. Only the two things real play cannot reach quickly are written
// directly: which card is Active, and what Energy is attached. Everything downstream of
// that — the clause parsing, the target list, the park, the labels — is the engine's.
//
// **`makeInPlay` is duplicated here on purpose.** `setup.ts` keeps its copy private
// because a dev harness has no business widening that module's surface. The cost is that
// a future `InPlayPokemon` field breaks this file at COMPILE time, which is exactly when
// we want to hear about it.

import type { CardDef, EnergyCardDef, PokemonCardDef } from './cards'
import { cardIsPokemon, isBasicPokemon } from './cards'
import { parseAttackEffects, processAction, setupBattle, type BattleState, type InPlayPokemon } from './game-core'
import { DECK_SIZE, type LobbySettings } from './net/protocol'
import { basicEnergyCard, type BasicEnergyType } from './pack'

/**
 * The four dialogs CP9 must see.
 *
 * **`attackClause` and `choiceKind` ARE BOTH NAMED, because they are not the same string.**
 * 182 is the case that proves it: its attack text parses to
 * `flipCoinsPerDefenderEnergyThenStatus`, and IT is that clause which parks a
 * `chooseStatusCondition` choice. Conflating the two made the board look for a clause
 * the parser never emits, so 182 silently built no board at all — a dev harness failing
 * quietly, which is the exact failure mode this whole plan keeps finding.
 *
 * **The attack is found by asking the real parser** which one carries `attackClause`,
 * rather than by a hard-coded index. An index would break on any reordering of a card's
 * attack list and would quietly screenshot the WRONG dialog — the "verified by reading"
 * failure this checkpoint exists to end.
 */
export const DEV_BOARD_TARGETS: {
  cardNumber: string
  attackClause: string
  choiceKind: string
}[] = [
  { cardNumber: '161', attackClause: 'discardAttachedEnergyThenBonusDamage', choiceKind: 'discardAttachedEnergyThenBonusDamage' },
  { cardNumber: '174', attackClause: 'discardEnergyTypeThenTimesDamage', choiceKind: 'discardEnergyTypeThenTimesDamage' },
  { cardNumber: '180', attackClause: 'moveAttachedEnergyToBench', choiceKind: 'moveAttachedEnergyToBench' },
  { cardNumber: '182', attackClause: 'flipCoinsPerDefenderEnergyThenStatus', choiceKind: 'chooseStatusCondition' },
]

/** Fixed so a QA run is reproducible; overridable with `?board=NNN&seed=N`. */
export const DEV_BOARD_SEED = 20260910

export type DevBoard = {
  state: BattleState
  /** Index into the target card's `attacks` that parks the clause. */
  attackIndex: number
  cardNumber: string
  cardName: string
  /** The choice kind the real engine is expected to park, for the harness to assert on. */
  choiceKind: string
}

function inPlay(card: PokemonCardDef, energy: EnergyCardDef[], turn: number, salt: string): InPlayPokemon {
  return {
    uid: `${card.id}#dev${salt}${turn}`,
    card,
    damage: 0,
    attachedEnergy: energy,
    attachedTool: null,
    conditions: { asleep: false, paralyzed: false, confused: false, poisoned: false, burned: false },
    poisonCounters: 1,
    enteredTurn: turn,
    evolvedTurn: 0,
    energyAttachedTurn: 0,
    retreatedTurn: 0,
    abilityUsedTurn: 0,
    lastTurnAttackedTurn: -1,
    lastTurnAttackedAmount: 0,
  }
}

/** How much Energy each card needs attached for its cost AND for its dialog to be rich. */
const ATTACHMENTS: Record<string, string[]> = {
  // 161 pays [lightning, metal]; the dialog lists every attached Energy card, so more
  // than the cost makes the list worth looking at rather than a two-row list.
  '161': ['lightning', 'metal', 'lightning', 'metal', 'lightning'],
  // 174 pays [fire, lightning] and the dialog offers one target PER TYPE ATTACHED, so
  // both types must be present or only one branch is offered.
  '174': ['fire', 'lightning', 'fire', 'lightning'],
  // 180 pays [water x3] and moves ALL of them, one destination pick per card.
  '180': ['water', 'water', 'water', 'psychic'],
  // 182 pays [grass, psychic] on the ATTACKER. The flips come from the DEFENDER's
  // Energy, so the guest's Active carries its own.
  '182': ['grass', 'psychic'],
  // What the OPPONENT's Active carries. Only 182 reads it.
  '182-defender': ['water', 'water'],
}

/**
 * Build a legal battle already positioned to open one of the four dialogs.
 *
 * Returns `null` for an unknown card number rather than throwing: this runs from a mount
 * effect, and a dev harness that crashes the page is useless for QA.
 */
export function buildDevBoard(
  cards: readonly CardDef[],
  settings: LobbySettings,
  cardNumber: string,
  seed: number = DEV_BOARD_SEED,
): DevBoard | null {
  const target = DEV_BOARD_TARGETS.find((entry) => entry.cardNumber === cardNumber)
  if (!target) return null
  const card = cards.find((entry) => cardIsPokemon(entry) && entry.number === cardNumber)
  if (!card || !cardIsPokemon(card)) return null

  const basics = cards.filter((entry): entry is PokemonCardDef => isBasicPokemon(entry))
  if (basics.length === 0) return null
  const energyOf = (type: string) => basicEnergyCard(settings.set, type as BasicEnergyType)

  // A deck of Basics plus Energy: the opening hand almost always holds a Basic, and the
  // mulligan loop below covers the rest. Legality is `setupBattle`'s to enforce, not ours.
  const deck = (): CardDef[] => {
    const out: CardDef[] = []
    for (let i = 0; out.length < DECK_SIZE; i += 1) out.push(basics[i % basics.length])
    for (let i = out.length; i < DECK_SIZE; i += 1) out.push(energyOf('water'))
    return out.slice(0, DECK_SIZE)
  }

  let state = setupBattle(settings, deck(), deck(), seed)

  // -- walk setup with REAL actions; the engine refuses anything illegal, so a state
  // reached this way is legal by construction rather than by my assertion.
  const winner = state.setup.coinWinner
  state = processAction(state, winner, { type: 'chooseTurnOrder', firstPlayer: 'guest' }).state
  // The GUEST goes first on purpose: the first player cannot attack on Turn 1
  // (`first-turn-attack`), and the host is the seat that must declare these attacks.
  for (const seat of ['host', 'guest'] as const) {
    for (let tries = 0; tries < 25; tries += 1) {
      if (state.setup.mulliganDone[seat]) break
      const hasBasic = state[seat].hand.some((entry) => isBasicPokemon(entry))
      state = processAction(state, seat, hasBasic
        ? { type: 'keepSetupHand' }
        : { type: 'mulliganSetup' }).state
    }
  }
  for (const seat of ['host', 'guest'] as const) {
    const activeHandIndex = state[seat].hand.findIndex((entry) => isBasicPokemon(entry))
    if (activeHandIndex < 0) return null
    state = processAction(state, seat, {
      type: 'chooseSetupPokemon',
      activeHandIndex,
      benchHandIndexes: [],
      penaltyCards: 0,
    }).state
  }
  state = processAction(state, winner, { type: 'confirmSetupReveal' }).state
  if (state.setup.phase !== 'complete') return null

  // Hand the turn to the host: the guest is the first player on Turn 1.
  if (state.activePlayer !== 'host') {
    const before = state.activePlayer
    state = processAction(state, before, { type: 'pass' }).state
    if (state.activePlayer === before) return null
  }

  // -- the mutation: WHICH card is Active and WHAT is attached. Everything after this
  // point is the engine's own work.
  const turn = state.turn
  const hostSide = state.host
  const guestSide = state.guest
  hostSide.active = inPlay(card, (ATTACHMENTS[cardNumber] ?? []).map(energyOf), turn, 'a')
  // 180's printed text is "to your Benched Pokemon", so the Bench must be non-empty or
  // the clause parks nothing and the dialog never appears.
  hostSide.bench = [
    inPlay(basics[0], [], turn, 'hb'),
    inPlay(basics[1 % basics.length], [], turn, 'hb2'),
  ]
  guestSide.active = inPlay(
    basics[2 % basics.length],
    (ATTACHMENTS[`${cardNumber}-defender`] ?? []).map(energyOf),
    turn,
    'g',
  )
  guestSide.bench = [inPlay(basics[3 % basics.length], [], turn, 'gb')]

  // -- which attack parks the clause? Ask the real parser, not a hard-coded index.
  const attackIndex = card.attacks.findIndex((attack) => {
    try {
      return parseAttackEffects(attack.text).some((effect) => effect.kind === target.attackClause)
    } catch {
      return false
    }
  })
  if (attackIndex < 0) return null

  return { state, attackIndex, cardNumber, cardName: card.name, choiceKind: target.choiceKind }
}
