// Host-to-guest render snapshots (CP7-D): public zones copied verbatim,
// face-down zones reduced to counts behind HIDDEN_CARD placeholders, and the
// hand included only for the viewer.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { CardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import type { BattleState, InPlayPokemon, SideState, Snapshot, SnapshotSide } from './types'

// -- CP7-D: host → guest render snapshots --

/**
 * Placeholder for a face-down card in a rebuilt view model. Decks, prize piles
 * and a non-viewer's hand are unknown to the receiver, so their slots carry
 * this sentinel instead of leaking real card data. It is never playable: the
 * rebuilt state is view-only.
 */
export const HIDDEN_CARD: CardDef = {
  id: 'hidden',
  set: 'hidden',
  number: '',
  name: '',
  rarity: 'common',
  supertype: 'pokemon',
  types: [],
  hp: 0,
  stage: 'Hidden',
  retreat: 0,
  weaknesses: [],
  resistances: [],
  attacks: [],
  abilities: [],
}

function fillHidden(count: number): CardDef[] {
  return Array.from({ length: count }, () => HIDDEN_CARD)
}

/** Deep-copy one in-play Pokemon (its card, energy and conditions). */
function cloneInPlay(pokemon: InPlayPokemon): InPlayPokemon {
  return JSON.parse(JSON.stringify(pokemon)) as InPlayPokemon
}

function snapshotSide(side: SideState, isViewer: boolean): SnapshotSide {
  return {
    handCount: side.hand.length,
    deckCount: side.deck.length,
    prizesTaken: side.prizeCount - side.prizes.length,
    prizeCount: side.prizeCount,
    discard: [...side.discard],
    active: side.active ? cloneInPlay(side.active) : null,
    bench: side.bench.map(cloneInPlay),
    hand: isViewer ? [...side.hand] : null,
    mulliganCount: side.mulliganCount,
    setupActiveCount: side.setupActive ? 1 : 0,
    setupBenchCount: side.setupBench.length,
    setupPenaltyCards: side.setupPenaltyCards,
    setupReady: side.setupReady,
  }
}

/**
 * Build a render-only Snapshot of the battle for `viewer`. Public zones (both
 * discard piles, every in-play Pokemon and its attached Energy) are copied
 * verbatim; face-down zones (both decks, both prize piles) become counts plus
 * `HIDDEN_CARD` placeholders; the hand is included only for the viewer
 * (`null` for the other side). In host-authoritative play (CP9) the host sends
 * each seat its own snapshot; the guest never sees the hidden zones.
 */
export function toSnapshot(state: BattleState, viewer: PlayerSlot): Snapshot {
  return {
    activePlayer: state.activePlayer,
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    winReason: state.winReason,
    over: state.over,
    prizeCards: state.prizeCards,
    timerSeconds: state.timerSeconds,
    pendingPromotion: state.pendingPromotion,
    turnStarted: state.turnStarted,
    setup: structuredClone(state.setup),
    log: [...state.log],
    host: snapshotSide(state.host, viewer === 'host'),
    guest: snapshotSide(state.guest, viewer === 'guest'),
  }
}

function snapshotSideToState(snapshot: SnapshotSide): SideState {
  return {
    deck: fillHidden(snapshot.deckCount),
    hand: snapshot.hand ? [...snapshot.hand] : fillHidden(snapshot.handCount),
    active: snapshot.active ? cloneInPlay(snapshot.active) : null,
    bench: snapshot.bench.map(cloneInPlay),
    prizes: fillHidden(snapshot.prizeCount - snapshot.prizesTaken),
    prizeCount: snapshot.prizeCount,
    discard: [...snapshot.discard],
    lostZone: [],
    supporterPlayedTurn: false,
    energyAttachedThisTurn: 0,
    attackedThisTurn: false,
    stadiumPlayedTurn: -1,
    mulliganCount: snapshot.mulliganCount,
    setupActive: snapshot.setupActiveCount > 0 ? HIDDEN_CARD as unknown as SideState['setupActive'] : null,
    setupBench: fillHidden(snapshot.setupBenchCount) as SideState['setupBench'],
    setupPenaltyCards: snapshot.setupPenaltyCards,
    setupReady: snapshot.setupReady,
  }
}

/**
 * Rebuild a render-only BattleState from a Snapshot for display. Hidden zones
 * hold `HIDDEN_CARD` placeholders and `viewOnly` is true, so `processAction`
 * refuses to run on it: the authoritative seat's state stays the single source
 * of truth.
 */
export function applySnapshot(snapshot: Snapshot): BattleState {
  return {
    activePlayer: snapshot.activePlayer,
    turn: snapshot.turn,
    phase: snapshot.phase,
    winner: snapshot.winner,
    winReason: snapshot.winReason,
    over: snapshot.over,
    seed: 0,
    prizeCards: snapshot.prizeCards,
    timerSeconds: snapshot.timerSeconds,
    pendingPromotion: snapshot.pendingPromotion,
    turnStarted: snapshot.turnStarted,
    setup: structuredClone(snapshot.setup),
    viewOnly: true,
    log: [...snapshot.log],
    rngDraws: 0,
    host: snapshotSideToState(snapshot.host),
    guest: snapshotSideToState(snapshot.guest),
  }
}
