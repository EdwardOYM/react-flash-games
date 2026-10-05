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
import { cardIsPokemon, cardIsTrainer, isBasicPokemon } from './cards'
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
  // 04.12 CP23 — the flows added after CP9, which had NO route to the screen at all.
  // Each parks its dialog from a REAL action: 069/168 from `useAttack`, and 128 from
  // `playTrainer`, which parks its PLAY COST before the card has even left hand.
  { cardNumber: '069', attackClause: 'devolveOpponent', choiceKind: 'payDiscardCost' },
  { cardNumber: '168', attackClause: 'returnSelfAndAttachmentsToDeckBottom', choiceKind: 'returnSelfAndAttachmentsToDeckBottom' },
  // 128 is a TRAINER: the clause is found by asking the TRAINER parser, not the attack
  // parser. Asking the attack parser was the original bug here — `cards.find(...)` looks
  // for a Pokemon, a Trainer is not one, so the board silently built NOTHING and the
  // screen fell back to the lobby. A dev harness failing quietly is the exact failure this
  // file's header exists to prevent, so it is worth naming rather than just fixing.
  { cardNumber: '128', attackClause: 'searchDeckToHand', choiceKind: 'payDiscardCost' },
  // 163 Misty and 179 N, both Supporters, both added by CP24 to close the last two flows
  // that had never been LOOKED at.
  //
  // 163 opens the same `payDiscardCost` picker as 128 — its clause also prints "discard 2 of
  // the other cards" — and then arms a turn-scoped bonus. **The bonus itself can never
  // fire** (no Pokemon here is named "Misty"), so the board proves the COST and the ARM,
  // not the damage, and the plan says so rather than implying the card works fully.
  { cardNumber: '163', attackClause: 'bonusDamageIfAttackerNameContains', choiceKind: 'payDiscardCost' },
  // 179 N is the one Trainer that parks NOTHING: it shuffles both hands and both players
  // draw immediately. What gets photographed is therefore the resulting BOARD, not a
  // dialog — the empty hands and the grown decks are the evidence.
  { cardNumber: '179', attackClause: 'bothPlayersShuffleHandIntoDeckThenDrawPerRemainingPrize', choiceKind: 'none' },
]

/**
 * 04.12 CP23: card numbers whose dialog is opened by PLAYING A TRAINER, not attacking.
 *
 * **A SEPARATE LIST RATHER THAN A FLAG ON THE ENTRY, because the two need different
 * work.** An attack board has to seat a Pokemon and attach Energy to it; a Trainer board
 * has to put the card in HAND and give the player other cards to pay with, and the
 * opening action is a different one entirely (`playTrainer`, not `useAttack`). Encoding
 * that as a boolean would put two different code paths in one entry and make the attack
 * boards the special case.
 */
export const DEV_BOARD_TRAINER_TARGETS = new Set(['128', '163', '179'])

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
  /**
   * 04.12 CP23: where the Trainer sits in the host's hand, so the mount effect can PLAY it.
   * `-1` on an attack board, where the card is seated on the board instead.
   */
  trainerHandIndex: number
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
    // 04.12 CP20: the dev harness builds Pokemon directly, so it sets the stack empty
    // exactly as `makeInPlay` does. Any future dev case that needs an evolved Pokemon
    // pushes onto this itself rather than relying on a lookup, because no card in the
    // set carries `evolvesFrom`.
    evoStack: [],
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
  // 04.12 CP23: 069 needs an EVOLVED Pokemon on the GUEST's board to devolve, and 128 is a
  // Trainer that lives in HAND rather than on the board — neither exists in the four
  // original entries' shapes.
  '182-defender': ['water', 'water'],
  // 069 devolves the OPPONENT's Pokemon, so the GUEST's Active must be evolved. The stage
  // is built from the pool's own Stage 2, and `evoStack` carries the Stage 1 underneath,
  // because no card in this set has `evolvesFrom` — the stack is the only record of what it
  // was. This is the one mutation CP20 made load-bearing rather than cosmetic.
  // 069's "Miraculous Shine" costs [psychic, colorless], so ONE psychic is not enough —
  // the board built and the attack was then refused by `canPayCost` ("Not enough Energy"),
  // which is the engine being right and the board being wrong.
  //
  // **TWO PSYCHIC, NOT A "COLORLESS" ENTRY.** There is no colorless Energy card; a
  // colorless requirement is paid by ANY attached Energy, so a second psychic satisfies
  // both slots. Writing 'colorless' here would have asked `basicEnergyCard` for a card
  // that does not exist.
  '069': ['psychic', 'psychic'],
  // 168's "Psychic Restore" costs [colorless] — one slot, paid by ANY Energy, so a single
  // psychic card satisfies it. Undefined here meant zero attached, and the attack was
  // refused for the same reason as 069's.
  '168': ['psychic'],
  // 128's cost needs two OTHER cards in hand, plus a Pokemon in the deck for its search.
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
  // 04.12 CP23: a TRAINER target is not a Pokemon, so it cannot be found by the Pokemon
  // lookup below, and it has no `attacks` array to search for a clause.
  const isTrainerBoard = DEV_BOARD_TRAINER_TARGETS.has(cardNumber)
  const card = isTrainerBoard
    ? cards.find((entry) => cardIsTrainer(entry) && entry.number === cardNumber)
    : cards.find((entry) => cardIsPokemon(entry) && entry.number === cardNumber)
  if (!card) return null

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
  // 04.12 CP23: a Trainer board has no Pokemon to seat as Active, so the host keeps
  // whatever real setup put there rather than being overwritten with a Trainer-shaped
  // card. The two are different kinds and the old mutation line is Pokemon-typed.
  if (isTrainerBoard) {
    const basic = inPlay(basics[0], [], turn, 'ta')
    hostSide.active = basic
  } else {
    hostSide.active = inPlay(card as PokemonCardDef, (ATTACHMENTS[cardNumber] ?? []).map(energyOf), turn, 'a')
  }
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

  // 04.12 CP23: the two new board shapes, each built the way the RULE needs and not the
  // way that is convenient.
  let trainerId = ''
  if (cardNumber === '069') {
    // The clause reads "each of your OPPONENT'S evolved Pokemon", so the evolved Pokemon
    // belongs to the GUEST. Seated on the host by accident it would devolve the attacking
    // side and prove nothing.
    const stage1 = cards.find((entry): entry is PokemonCardDef => cardIsPokemon(entry) && entry.stage === 'Stage1')
    const stage2 = cards.find((entry): entry is PokemonCardDef => cardIsPokemon(entry) && entry.stage === 'Stage2')
    if (!stage1 || !stage2) return null
    const evolved = inPlay(stage2, [], turn, 'g2')
    // **THE STACK IS THE POINT.** No card here carries `evolvesFrom`, so without this the
    // devolved Pokemon would have nothing underneath it and the clause would correctly
    // do nothing — a board that looks right and screenshots an empty board.
    evolved.evoStack = [stage1]
    guestSide.active = evolved
    guestSide.bench = [
      (() => { const b = inPlay(stage2, [], turn, 'gb2'); b.evoStack = [stage1]; return b })(),
      inPlay(basics[3 % basics.length], [], turn, 'gb'),
    ]
  }
  if (DEV_BOARD_TRAINER_TARGETS.has(cardNumber)) {
    // 128 lives in HAND, and its printed cost is "discard 2 OTHER cards", so the hand
    // needs the Trainer AND two unrelated cards to pay with. Without those the cost gate
    // refuses the play outright (`cost-unpayable`) and the dialog never appears — which is
    // the correct rule, and would look like a broken board.
    const trainer = cards.find((entry) => cardIsTrainer(entry) && entry.number === cardNumber)
    if (!trainer) return null
    hostSide.hand = [trainer, basics[0], energyOf('water'), ...hostSide.hand.slice(0, 4)]
    // 128 searches its deck for a Pokemon; the deck is Basics, so the search always has a
    // legal target and the second dialog is reachable too.
    trainerId = trainer.id
  }

  // -- which attack parks the clause? Ask the real parser, not a hard-coded index.
  // A TRAINER board has no `attacks` array at all: its clause comes from the TRAINER
  // parser via the `playTrainer` action, so the index is meaningless and stays -1.
  // The `cardIsPokemon` re-test is the narrowing — `card` is a union, and without it
  // `card.attacks` does not exist on `TrainerCardDef`.
  const attackIndex = isTrainerBoard || !cardIsPokemon(card)
    ? -1
    : card.attacks.findIndex((attack) => {
        try {
          return parseAttackEffects(attack.text).some((effect) => effect.kind === target.attackClause)
        } catch {
          return false
        }
      })
  // The guard below is deliberately NOT applied to a trainer board: `attackIndex` is -1
  // by design there, and returning null on it would make every Trainer board unbuildable —
  // which is how this one first failed, quietly.
  if (!isTrainerBoard && attackIndex < 0) return null

  return {
    state,
    attackIndex,
    cardNumber,
    cardName: card.name,
    choiceKind: target.choiceKind,
    // Read from the live hand rather than hard-coded, so reordering the seeding cannot
    // silently play a different card than the one the entry names.
    trainerHandIndex: DEV_BOARD_TRAINER_TARGETS.has(cardNumber)
      ? state.host.hand.findIndex((entry) => entry.id === trainerId)
      : -1,
  }
}
