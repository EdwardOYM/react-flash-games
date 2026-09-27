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
export type ChoiceTarget = { side: PlayerSlot; zone: 'active' | number; uid: string }

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
  /** What happens to the chosen target. */
  effect:
    | { kind: 'damage'; amount: number }
    // 04.8 CP2-C: "…for each damage counter on that Pokémon" — the amount is not
    // known until the target is picked, so it cannot be a flat number.
    | { kind: 'damagePerCounter'; amountPerCounter: number }
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
  stadium: TrainerCardDef | null
  turnStarted: boolean
  setup: SetupPlayerState
  log: BattleLogEntry[]
  host: SnapshotSide
  guest: SnapshotSide
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

export type ActionResult = { state: BattleState; log: BattleLogEntry[]; error?: string }
