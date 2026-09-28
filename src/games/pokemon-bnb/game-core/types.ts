// Engine types for the Pokemon TCG B&B mini battle engine. STATUS_CONDITIONS
// and StatusCondition live here (not constants.ts) because the zone, state
// and snapshot types derive from them directly.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { CardDef, EnergyCardDef, PokemonCardDef, TrainerCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'

export const STATUS_CONDITIONS = ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'] as const
export type StatusCondition = (typeof STATUS_CONDITIONS)[number]

export type ZoneKind = 'deck' | 'hand' | 'active' | 'bench' | 'prize' | 'discard' | 'lostZone' | 'energy'
export type TurnPhase = 'draw' | 'main' | 'attack' | 'between'
export type SetupPhase = 'turnOrder' | 'mulligan' | 'placement' | 'prizes' | 'complete'
export type SetupPlayerState = {
  phase: SetupPhase
  coinWinner: PlayerSlot
  firstPlayer: PlayerSlot | null
  mulliganDone: Record<PlayerSlot, boolean>
  ready: Record<PlayerSlot, boolean>
  revealed: boolean
}
export type SpecialConditionState = Record<StatusCondition, boolean>

/**
 * One legal target of a pending choice. `zone` reuses the `'active' | number`
 * convention the existing `target` actions already use for Active-vs-Bench.
 *
 * `uid` is the authority, NOT the index. 04.8 CP2-C found why: an attack can
 * Knock Out the Active AND park a choice, and `performKo` gates the promotion
 * AHEAD of the choice. Promoting splices a Pokémon out of the Bench, shifting
 * every later index — so a stored index would silently come to mean a different
 * Pokémon by the time the pick is made. Resolving by `uid` is immune to that,
 * and costs one opaque string on the wire.
 */
export type ChoiceTarget =
  | { side: PlayerSlot; zone: 'active' | number; uid: string }
  // 04.8 CP3-B: a deck card has no `uid` (uids belong to in-play Pokemon) and a
  // Deck can legally hold duplicates, so a card id would be ambiguous. A DECK
  // INDEX is stable for the whole life of the choice — nothing else can move a
  // card out of the Deck while `pendingChoice` blocks every other action — and
  // `cardId` is re-checked on resolve as a guard against any future change.
  | { side: PlayerSlot; zone: 'deck'; deckIndex: number; cardId: string }
  // 04.9 CP3: a card in a SIDE'S DISCARD PILE. Same reasoning as the deck variant —
  // a Deck may hold duplicates, so `cardId` is re-checked and the index is the
  // lookup. The discard is a PUBLIC zone, so the acting seat can already see it
  // (04.8 CP6's invariant, asserted in the harness).
  | { side: PlayerSlot; zone: 'discard'; index: number; cardId: string }

/**
 * 04.8 CP2: an effect that the printed text hands to the player to resolve.
 *
 * This is the generalisation of the Knock Out promotion gate: the same three
 * steps — the engine parks a flag, `processAction` refuses every other action,
 * and the UI offers a `role="dialog"` picker. Deliberately inert in CP2-A: no
 * card text produces one yet, because a choice with no picker would soft-lock
 * the match. CP2-B wires the dialog and the first text atomically with it.
 */
export type PendingChoice = {
  /** The seat that must choose. Only this seat may resolve it. */
  actor: PlayerSlot
  /** Legal targets, in a stable order. Stored, not recomputed, so the list a
   *  player saw cannot drift from the list the engine validates against. */
  targets: ChoiceTarget[]
  /**
   * 04.9 CP4: how many MORE picks are allowed. **1** for every choice before this
   * checkpoint, which is why none of them had to change. "up to 2" sets 2, and a
   * player may stop early with `finishChoice` — "up to" is permissive, not a quota.
   *
   * Always a FINITE number, even for the printed "any number of" (053/149). The
   * cap is resolved at park time against what the deck and the Bench can actually
   * hold, which is what keeps `Infinity` off the wire: `JSON.stringify(Infinity)`
   * is `null`, so an unbounded `remaining` would silently fail the snapshot round
   * trip that 04.8 CP6 established.
   */
  remaining: number
  /** Which zone `targets` lives in, so the list can be re-derived after a pick. */
  source: 'deck' | 'discard' | 'inPlay'
  /** What happens to the chosen target. */
  effect:
    | { kind: 'damage'; amount: number }
    // 04.8 CP2-C: "…for each damage counter on that Pokémon" — the amount is not
    // known until the target is picked, so it cannot be a flat number.
    | { kind: 'damagePerCounter'; amountPerCounter: number }
    // 04.8 CP3-B: move the chosen card out of the actor's own Deck.
    | { kind: 'searchDeck'; filter: 'pokemon' | 'trainer' | 'energy' }
    // 04.9 CP2: reduce the chosen Pokemon's damage to 0. `'all'` is the printed
    // "heal all damage", kept distinct from a number so a cap can never be
    // mistaken for a full heal.
    | { kind: 'healChosen'; amount: number | 'all' }
    // 04.9 CP3: move the chosen card from a SIDE'S DISCARD PILE somewhere else.
    // `to` is deliberately open: 'hand' and 'deck' land here, and a future 'bench'
    // needs no new effect kind, only a new target rule.
    | { kind: 'pickFromDiscard'; to: 'hand' | 'deck' }
    // 04.9 CP4: take up to N cards from a ZONE, resolving ONCE PER PICK. This is the
    // only effect kind that re-parks its own choice: `remaining` counts down and the
    // target list is rebuilt between picks, or `finishChoice` closes it early because
    // "up to" is permissive rather than a quota.
    //
    // `max` is the PRINTED cap and may be `Infinity` ("any number of"). It is never
    // the number enforced: `remaining` is resolved to a FINITE cap at park time,
    // because `JSON.stringify(Infinity)` is `null` and would break the round trip.
    //
    // 04.10 CP1 widened this from "the Deck" to "a zone, filtered". The three discard
    // families (048 energy→hand, 103 pokemon+energy→deck, 109/156 pokemon→Bench) differ
    // from 013/053/076 only in WHICH zone is read and WHICH cards qualify — a target
    // rule, not a new mechanism, which is exactly what 04.9 CP3 predicted when it left
    // `pickFromDiscard`'s `to` open for exactly this. A separate `searchDiscardUpTo`
    // would have been four near-identical kinds that can drift apart.
    | {
        kind: 'searchDeckUpTo'
        filter: 'basicPokemon' | 'stadium' | 'basicEnergy' | 'pokemon' | 'pokemonOrEnergy'
        to: 'hand' | 'bench' | 'deck'
        max: number
        /** Which zone the cards are taken FROM. 04.10 CP1; `'deck'` was the only value. */
        from: 'deck' | 'discard'
        /**
         * 04.10 CP1 / 109-156: put the picked Pokemon on the Bench. A Basic whose
         * printed type does not include the required type is not a legal target, and
         * the Bench cap (`MAX_BENCH`) still applies.
         */
        requireType?: string
      }
    | { kind: 'searchAnyToHand'; coin: boolean }
    // 04.9 CP7: swap the chosen Pokemon with the current Active of that side. The whole
    // `InPlayPokemon` object moves, so Energy, damage, conditions and the uid travel
    // with it — see `applySwitchInPlace`. `optional` is 066/152/158's printed "You may",
    // which is what lets `finishChoice` decline it; 032's mandatory swap has it false.
    | { kind: 'switchActive'; side: 'attacker' | 'defender'; optional: boolean }
  /** Printed attack that asked for the choice, for the log line. */
  attackName: string
}

export type InPlayPokemon = {
  uid: string
  card: PokemonCardDef
  damage: number
  /** Attached Energy cards (not ids) so attack costs can read `provides`. */
  attachedEnergy: EnergyCardDef[]
  /** Single Pokemon Tool attachment (CP4 action model; CP6 renders it). */
  attachedTool: TrainerCardDef | null
  conditions: SpecialConditionState
  enteredTurn: number
  evolvedTurn: number
  energyAttachedTurn: number
  retreatedTurn: number
  /** Turn number this copy last used its Ability. */
  abilityUsedTurn: number
  /**
   * 04.10 CP3: attack damage this Pokemon took, stamped with the TURN it happened on
   * (`lastTurnAttackedTurn`) and the amount for that turn. Read by 085/138 Lycanroc's
   * "if this Pokemon was damaged by an attack during your opponent's last turn, this
   * attack does that much more damage".
   *
   * Stored as a TURN NUMBER, not as a counter to clear, and that is the whole trick.
   * The read is `lastTurnAttackedTurn === state.turn - 1`, so a hit from two turns ago
   * can never be mistaken for a hit last turn and there is no "forgot to reset" bug to
   * have. Clearing a counter instead would need a correct reset on EVERY path that ends
   * a turn, and 04.9 already found `applyEndTurn` has more than one exit.
   */
  lastTurnAttackedTurn: number
  /** Attack damage dealt to this Pokemon on `lastTurnAttackedTurn`. */
  lastTurnAttackedAmount: number
}

export type SideState = {
  deck: CardDef[]
  hand: CardDef[]
  active: InPlayPokemon | null
  bench: InPlayPokemon[]
  prizes: CardDef[]
  prizeCount: number
  discard: CardDef[]
  lostZone: CardDef[]
  /** True once a Supporter was played this turn (rulebook: one per turn). */
  supporterPlayedTurn: boolean
  /** Energy cards attached this turn (rulebook: one Energy card per turn). */
  energyAttachedThisTurn: number
  /** True once this side declared an attack this turn. */
  attackedThisTurn: boolean
  /** Turn number a Stadium was played on, or -1 when none. */
  stadiumPlayedTurn: number
  /** Once-per-side Retreat marker for the current turn. */
  retreatedThisTurn: boolean
  /** Number of opening-hand Mulligans. The opponent chooses the extra-card penalty. */
  mulliganCount: number
  /**
   * Every opening hand this side had to Mulligan away, oldest first.
   *
   * Rulebook (Setting Up to Play): "Reveal your hand to your opponent to
   * prove you have no Basic Pokémon", so these are PUBLIC to both seats — they
   * are deliberately not hidden like `hand`. The history (rather than just a
   * count) is kept because the reveal happens on every Mulligan, not once.
   */
  mulliganedHands: CardDef[][]
  /** Ability names used this turn by this side, for once-per-name restrictions. */
  abilityUsedNames: Record<string, number>
  /** Face-down setup Active selected from this side's private hand. */
  setupActive: PokemonCardDef | null
  /** Face-down setup Bench selected from this side's private hand. */
  setupBench: PokemonCardDef[]
  /** Extra cards this player elected to take after the opponent Mulliganed. */
  setupPenaltyCards: number
  /** True after this side's Active/Bench/Prize selection is locked. */
  setupReady: boolean
  /**
   * 04.10 CP3: the turn on which one of THIS side's Pokemon was Knocked Out BY AN
   * ATTACK, or -1 when none has. Read by 005 Tropius / 091 Umbreon's "if any of your
   * Pokemon were Knocked Out by damage from an attack during your opponent's last
   * turn, this attack does N more damage".
   *
   * Deliberately a SIDE field, not a per-Pokemon one, for a decisive reason: a
   * knocked-out Pokemon's `InPlayPokemon` object is destroyed by `discardKnockedOut`,
   * which keeps only the `CardDef`. A flag on the Pokemon would therefore be gone
   * exactly when the clause needs it, and the clause is side-wide ("any of your
   * Pokemon") anyway, so the side is the only place the memory can live.
   *
   * Stamped with a TURN rather than cleared, for the same anti-compounding reason as
   * `InPlayPokemon.lastTurnAttackedTurn`: the read is `=== state.turn - 1`, so an old
   * KO ages out on its own. This also means `applyEndTurn` needs no reset step — which
   * matters because 04.9 found it has more than one exit, and a flag that had to be
   * cleared on each would eventually be missed.
   *
   * Recorded ONLY for damage from an attack. Poison and Burn KOs run through the same
   * `performKo`, so the flag is set at the attack sites and never inside `performKo`
   * itself — 04.10's text is specific about "by damage from an attack", and a
   * Between-Turns poison KO satisfying it would be a wrong effect.
   */
  koByAttackTurn: number
}

/**
 * Log entries stay structured (a translation key plus raw data params) so the
 * battle-log strip can translate the template while card names stay verbatim
 * data. Keys are `pokemonBnb.log.*`, added to en/ms/zh in CP7-E and
 * extended with setup events by CP3.
 */
export type BattleLogEntry = { key: string; params?: Record<string, string | number> }

export type BattleState = {
  host: SideState
  guest: SideState
  activePlayer: PlayerSlot
  /** Turn counter; turn 1 is the first player's opening turn. */
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: 'prizes' | 'deck-out' | 'no-pokemon' | null
  over: boolean
  seed: number
  prizeCards: number
  timerSeconds: number
  setup: SetupPlayerState
  /** Shared Stadium currently in play, or null. */
  stadium: TrainerCardDef | null
  /** Ordered promotion queue; simultaneous KOs enqueue next player first. */
  promotionQueue: PlayerSlot[]
  /** Side that must choose a new Active after a KO before anything else. */
  pendingPromotion: PlayerSlot | null
  /**
   * 04.8 CP2: a printed effect awaiting the actor's target pick. Inert in
   * CP2-A — no card text produces one yet, because a choice with no picker would
   * soft-lock the match. CP2-B wires the dialog and the first text together.
   */
  pendingChoice: PendingChoice | null
  /**
   * 04.9 CP5: live time-limited effects ("during your next turn…"). This is the
   * FIRST field 04.9 adds to the wire, and it names no hidden zone — a duration
   * carries a `uid`, an effect and a turn number, never a card the seat cannot see
   * — so it discloses nothing the two seats do not already both know.
   */
  durations: ActiveDuration[]
  /** True once the current turn's start step (draw + flag reset) has run. */
  turnStarted: boolean
  /**
   * True for a state rebuilt from a `Snapshot` (guest render model): hidden
   * zones hold placeholders, so `processAction` refuses to run on it.
   */
  viewOnly: boolean
  log: BattleLogEntry[]
  rngDraws: number
}

export type SnapshotSide = {
  handCount: number
  /**
   * 04.8 CP3: the VIEWER's own deck, as real cards, so a "Search your deck…"
   * effect can offer real targets. The other seat's snapshot carries
   * `HIDDEN_CARD` placeholders here instead — this is the one place the privacy
   * boundary is a per-snapshot property rather than a global one.
   */
  deck: CardDef[]
  deckCount: number
  prizesTaken: number
  prizeCount: number
  discard: CardDef[]
  active: InPlayPokemon | null
  bench: InPlayPokemon[]
  hand: CardDef[] | null
  mulliganCount: number
  /** Public to both seats: the rulebook requires a failed hand to be revealed. */
  mulliganedHands: CardDef[][]
  setupActiveCount: number
  setupBenchCount: number
  setupPenaltyCards: number
  setupReady: boolean
  /**
   * 04.10 CP3: the SIDE half of the "opponent's last turn" memory, carried verbatim
   * like `durations`. It is public information — both players watched the Knock Out
   * happen — and the rebuilt state is `viewOnly`, so it exists purely so a rebuilt
   * state reads the same 005/091 answer the host computes. It names no hidden zone,
   * so the privacy boundary is unchanged.
   */
  koByAttackTurn: number
}

export type Snapshot = {
  activePlayer: PlayerSlot
  turn: number
  phase: TurnPhase
  winner: PlayerSlot | null
  winReason: BattleState['winReason']
  over: boolean
  prizeCards: number
  timerSeconds: number
  pendingPromotion: PlayerSlot | null
  promotionQueue: PlayerSlot[]
  /** 04.8 CP2: carried verbatim so the guest renders the same picker the host
   *  sees. It names no hidden zone, so this is NO privacy change — the deck and
   *  the opponent's hand stay hidden, which is why deck search stays a separate,
   *  still-blocked decision. */
  pendingChoice: PendingChoice | null
  /**
   * 04.9 CP5: the same live durations, carried verbatim so the guest's board
   * renders the same locks and damage modifiers the host applies. Read-only for
   * the guest: a rebuilt state is `viewOnly`, so only the host ever expires one.
   */
  durations: ActiveDuration[]
  stadium: TrainerCardDef | null
  turnStarted: boolean
  setup: SetupPlayerState
  log: BattleLogEntry[]
  host: SnapshotSide
  guest: SnapshotSide
}

/**
 * 04.9 CP5: what a time-limited effect DOES while it is live.
 *
 * These are deliberately separate from `STATUS_CONDITIONS`: a Special Condition
 * lives on the Pokemon and is cleared by the engine's own Between-Turns rules,
 * whereas a duration is a *printed card clause* with an explicit expiry. Folding
 * one into the other would make "Asleep" (which ends by a coin flip) and
 * "can't attack this turn" (which ends when the named turn ends) indistinguishable.
 */
export type DurationEffect =
  /** 060/134/064/151/157 — "this Pokemon can't use attacks". */
  | { kind: 'cantAttack' }
  /**
   * 106 — the same lock narrowed to ONE named attack. `attackName` is the printed
   * attack name, matched verbatim; an unrecognised name is a no-op rather than a
   * guess, so a typo can never lock a Pokémon out of every attack.
   */
  | { kind: 'cantUseAttack'; attackName: string }
  /** 079/107 — "this Pokemon takes N less damage", applied AFTER Weakness/Resistance. */
  | { kind: 'lessDamageTaken'; amount: number }
  /**
   * 04.10 CP2 / 087 Nidoran — the MIRROR of `lessDamageTaken`, and the reason a
   * SECOND effect kind is needed rather than a flag on the first. 028 reduces what
   * the holder TAKES (read on the defender); this reduces what the holder DEALS
   * (read on the attacker). One signed field would let the two directions be
   * confused, which is a wrong effect rather than a stricter one.
   */
  | { kind: 'lessDamageDealt'; amount: number }
  /** 110 — "the Defending Pokemon takes N more damage", AFTER Weakness/Resistance. */
  | { kind: 'moreDamageTaken'; amount: number }
  /** 006/016/044 — "prevent all damage from and effects of attacks". */
  | { kind: 'preventAllDamage' }
  /** 093 — "the Defending Pokemon can't retreat". */
  | { kind: 'cantRetreat' }

/**
 * 04.9 CP5: one live time-limited effect, riding a specific in-play Pokemon.
 *
 * **`activeTurn` is an ABSOLUTE engine turn number, and that is the whole
 * expiry mechanism.** The engine's `turn` counter advances by exactly one per
 * `applyEndTurn`, and the two seats strictly alternate, so "your next turn" and
 * "your opponent's next turn" are both just a number: from turn T, the opponent's
 * next turn is T+1 and the actor's own is T+2. Storing the number rather than a
 * `(seat, relativeOffset)` pair means expiry needs no seat bookkeeping and cannot
 * drift when the two disagree.
 *
 * The Pokemon is named by `uid`, never by a zone index — 04.8 CP2-C established
 * that a promotion splices the Bench and shifts every later index, so a stored
 * index would silently come to mean a different Pokémon. A duration on a
 * Knocked-Out Pokémon simply stops applying, because its uid is no longer in play.
 */
export type ActiveDuration = {
  /**
   * Deterministic identity: `<uid>:<effectKind>[:<argument>]`. Applying the same
   * printed clause twice for the same Pokemon in the same window REPLACES rather
   * than stacks, which is what makes a re-resolved attack idempotent instead of
   * doubling a "-60 damage" modifier.
   */
  id: string
  /** The in-play Pokemon this rides, by uid. */
  uid: string
  effect: DurationEffect
  /** The engine turn this is live for; pruned once `state.turn` passes it. */
  activeTurn: number
  /** Card name that created it, so the log and the UI can name the source. */
  sourceName: string
}

export type BattleAction =
  | { type: 'chooseTurnOrder'; firstPlayer: PlayerSlot }
  | { type: 'keepSetupHand' }
  | { type: 'mulliganSetup' }
  | { type: 'chooseSetupPokemon'; activeHandIndex: number; benchHandIndexes: number[]; penaltyCards: number }
  | { type: 'confirmSetupReveal' }
  | { type: 'attachEnergy'; handIndex: number; target: 'active' | number }
  | { type: 'playBasic'; handIndex: number }
  | { type: 'playTrainer'; handIndex: number }
  | { type: 'attachTool'; handIndex: number; target: 'active' | number }
  | { type: 'useAbility'; target: 'active' | number; abilityIndex: number; targetIndex?: 'active' | number }
  | { type: 'evolve'; handIndex: number; target: 'active' | number }
  | { type: 'retreatToBench'; benchIndex: number }
  | { type: 'beginAttack' }
  | { type: 'pass' }
  | { type: 'useAttack'; attackIndex: number }
  | { type: 'promoteActive'; benchIndex: number }
  /** 04.8 CP2: resolve the pending choice by INDEX into its stored target list,
   *  never a forged zone — the engine re-validates the entry it already agreed. */
  | { type: 'chooseTarget'; targetIndex: number }
  /** 04.9 CP4: stop a multi-pick early. "Up to 2" is permissive, so declining the
   *  second pick is a legal outcome and not a way to skip the effect. */
  | { type: 'finishChoice' }

export type ActionResult = { state: BattleState; log: BattleLogEntry[]; error?: string }
