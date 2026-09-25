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
  stadium: TrainerCardDef | null
  turnStarted: boolean
  setup: SetupPlayerState
  log: BattleLogEntry[]
  host: SnapshotSide
  guest: SnapshotSide
}

export type BattleAction =
  | { type: 'chooseTurnOrder'; firstPlayer: PlayerSlot }
  | { type: 'mulliganSetup' }
  | { type: 'chooseSetupPokemon'; activeHandIndex: number; benchHandIndexes: number[]; penaltyCards: number }
  | { type: 'confirmSetupReveal' }
  | { type: 'attachEnergy'; handIndex: number; target: 'active' | number }
  | { type: 'playBasic'; handIndex: number }
  | { type: 'playTrainer'; handIndex: number }
  | { type: 'attachTool'; handIndex: number; target: 'active' | number }
  | { type: 'useAbility'; target: 'active' | number; abilityIndex: number }
  | { type: 'evolve'; handIndex: number; target: 'active' | number }
  | { type: 'retreatToBench'; benchIndex: number }
  | { type: 'beginAttack' }
  | { type: 'pass' }
  | { type: 'useAttack'; attackIndex: number }
  | { type: 'promoteActive'; benchIndex: number }

export type ActionResult = { state: BattleState; log: BattleLogEntry[]; error?: string }
