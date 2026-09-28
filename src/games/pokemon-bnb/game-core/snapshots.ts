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

/**
 * `prizeTotal` is the configured Prize count for the whole match, and
 * `prizeCount` is what is still face-down. This used to read
 * `side.prizeCount - side.prizes.length`, which is always 0: the engine keeps
 * those two in step (takePrizeCard re-assigns `prizeCount = prizes.length`), so
 * the field reported "0 taken" for the entire match. The real count is the
 * configured total minus what remains, exactly `turns.prizesTaken`.
 */
function snapshotSide(side: SideState, isViewer: boolean, prizeTotal: number): SnapshotSide {
  return {
    handCount: side.hand.length,
    deckCount: side.deck.length,
    // 04.8 CP3: the VIEWER's own deck is disclosed, so a "Search your deck…"
    // effect can offer real targets. The OPPONENT's deck stays `HIDDEN_CARD`
    // placeholders — one seat's snapshot never carries the other seat's deck.
    // Deep-cloned (not `[...]` like `hand` below) because this is a newly
    // disclosed zone: a shared CardDef object could otherwise be mutated on the
    // render side and corrupt the authoritative deck behind the host's back.
    deck: isViewer ? structuredClone(side.deck) : fillHidden(side.deck.length),
    prizesTaken: Math.max(0, prizeTotal - side.prizeCount),
    prizeCount: side.prizeCount,
    discard: [...side.discard],
    active: side.active ? cloneInPlay(side.active) : null,
    bench: side.bench.map(cloneInPlay),
    hand: isViewer ? [...side.hand] : null,
    mulliganCount: side.mulliganCount,
    // Public to both seats: the rulebook requires a Mulliganed hand to be shown
    // to the opponent, so this is never a hidden zone.
    mulliganedHands: side.mulliganedHands.map((hand) => [...hand]),
    setupActiveCount: side.setupActive ? 1 : 0,
    setupBenchCount: side.setupBench.length,
    setupPenaltyCards: side.setupPenaltyCards,
    setupReady: side.setupReady,
  }
}

/**
 * Build a render-only Snapshot of the battle for `viewer`. Public zones (both
 * discard piles, every in-play Pokemon and its attached Energy) are copied
 * verbatim; the OPPONENT's face-down zones (their deck and prize pile) become
 * counts plus `HIDDEN_CARD` placeholders; the hand and the viewer's OWN deck are
 * included only for the viewer (`null`/placeholders for the other side). In
 * host-authoritative play (CP9) the host sends each seat its own snapshot, so the
 * guest never sees the host's hidden zones. **04.8 CP3:** the viewer's own deck
 * was added for "Search your deck…" effects; the invariant that matters is that a
 * seat's snapshot never contains the OTHER seat's deck.
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
    promotionQueue: [...state.promotionQueue],
    // 04.8 CP2: copied deeply so a render-side mutation cannot reach the
    // authoritative state. It names no hidden zone, so nothing is disclosed.
    pendingChoice: state.pendingChoice
      ? { ...state.pendingChoice, targets: state.pendingChoice.targets.map((t) => ({ ...t })) }
      : null,
    stadium: state.stadium ? structuredClone(state.stadium) : null,
    turnStarted: state.turnStarted,
    setup: structuredClone(state.setup),
    log: [...state.log],
    host: snapshotSide(state.host, viewer === 'host', state.prizeCards),
    guest: snapshotSide(state.guest, viewer === 'guest', state.prizeCards),
  }
}

function snapshotSideToState(snapshot: SnapshotSide): SideState {
  return {
    // 04.8 CP3: the viewer's own deck rides the snapshot and is restored as real
    // cards; the other side's is still placeholders, so a rebuilt state can only
    // ever see its own deck. It stays `viewOnly`, so it is display-only either way.
    deck: snapshot.deck ? structuredClone(snapshot.deck) : fillHidden(snapshot.deckCount),
    hand: snapshot.hand ? [...snapshot.hand] : fillHidden(snapshot.handCount),
    active: snapshot.active ? cloneInPlay(snapshot.active) : null,
    bench: snapshot.bench.map(cloneInPlay),
    // `prizeCount` IS the number still face-down, so it alone sizes the hidden
    // pile. This previously read `prizeCount - prizesTaken`, which was correct
    // only because `prizesTaken` was wrongly always 0 — two bugs cancelling.
    // With `prizesTaken` now honest, subtracting it would UNDER-count the
    // rebuilt pile. PROVEN, not assumed: reverting only this line makes the
    // CP5 harness fail three assertions (a mid-match 3-remaining pile rebuilds
    // as 2 placeholders) — see the plan's CP5 entry.
    prizes: fillHidden(snapshot.prizeCount),
    prizeCount: snapshot.prizeCount,
    discard: [...snapshot.discard],
    lostZone: [],
    supporterPlayedTurn: false,
    energyAttachedThisTurn: 0,
    attackedThisTurn: false,
    stadiumPlayedTurn: -1,
    retreatedThisTurn: false,
    mulliganCount: snapshot.mulliganCount,
    mulliganedHands: (snapshot.mulliganedHands ?? []).map((hand) => [...hand]),
    abilityUsedNames: {},
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
    promotionQueue: [...snapshot.promotionQueue],
    // The picker must render identically for the guest, so the choice rides the
    // snapshot. The rebuilt state is `viewOnly`, so this copy can never be acted
    // on — only the authoritative seat resolves a choice.
    pendingChoice: snapshot.pendingChoice
      ? { ...snapshot.pendingChoice, targets: snapshot.pendingChoice.targets.map((t) => ({ ...t })) }
      : null,
    stadium: snapshot.stadium ? structuredClone(snapshot.stadium) : null,
    turnStarted: snapshot.turnStarted,
    setup: structuredClone(snapshot.setup),
    viewOnly: true,
    log: [...snapshot.log],
    rngDraws: 0,
    host: snapshotSideToState(snapshot.host),
    guest: snapshotSideToState(snapshot.guest),
  }
}
