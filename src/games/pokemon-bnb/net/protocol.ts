// Wire protocol for the Pokemon TCG B&B mini P2P session (PeerJS data
// channels). Pure data + validation only: no peerjs import, no DOM, so the
// envelope can be unit-checked in Node.
//
// Handshake: guest opens the data channel and sends `hello`; host replies
// `hello-ack`. The host owns lobby settings and broadcasts `lobby-update` on
// every change; `lobby-start` carries the shared pack-opening seed. Battle
// payloads stay `unknown` here and are typed by the engine in CP7/CP9.

import type { SetId } from '../cards'

// 04.12 CP2: bumped from 2. A version-2 peer sends `packs` in 1..6, and the v3
// `validateLobbySettings` REJECTS that range outright — so a v2 guest's `lobby-update` and
// `lobby-start` would be silently dropped mid-lobby rather than refused outright. The
// established rule in this file is that a peer which cannot safely share the revised rules
// is refused (see the v1 -> v2 note), and a silently dropped handshake is worse than a
// clear refusal. So the version moves with the range.
export const PROTOCOL_VERSION = 3

export const DECK_SIZE = 40

export const LOBBY_LIMITS = {
  /**
   * 04.12 CP2 (user-reported): the range is 6-36, was 1-6.
   *
   * **Everything else that reads these two numbers is already correct and needed no edit** —
   * `clampLobbySettings`, `validateLobbySettings` and the lobby stepper's disabled states
   * all reference the constants rather than repeating the numbers, so raising the range
   * could not desynchronise them. The stepper's `disabled={settings.packs <= minPacks}` /
   * `>= maxPacks` bounds move with the constants for free.
   *
   * **There is deliberately NO on-wire `packIndex` in this game's protocol.** Both seats
   * derive the whole ceremony from the single broadcast `lobby-start` seed, so raising the
   * count adds no new wire field and no new validation. (`pokemon-pack-battle` DOES put
   * `packIndex` on the wire and bound it separately; that is a different game and is
   * untouched by this change.)
   *
   * 36 packs x 6 cards = **216 opened cards per seat**, up from 36. That is the number to
   * watch in the deck builder, and CP9's browser pass is what confirms it is usable.
   */
  minPacks: 6,
  maxPacks: 36,
  /** Build & Battle setup supports exactly these Prize counts. */
  prizeChoices: [4, 6],
  defaultPrizeCards: 4,
  /** Seconds per turn; 0 disables the timer. */
  timerChoices: [0, 45, 60, 90],
} as const

export type PlayerSlot = 'host' | 'guest'

export type LobbySettings = {
  set: SetId
  packs: number
  prizeCards: number
  timerSeconds: number
}

export function defaultLobbySettings(set: SetId): LobbySettings {
  // 04.12 CP2: the default moved with the floor. It must not sit BELOW `minPacks`, or the
  // first render would produce a setting that `validateLobbySettings` immediately refuses —
  // a default that fails its own validator is a lobby that cannot start.
  return { set, packs: LOBBY_LIMITS.minPacks, prizeCards: LOBBY_LIMITS.defaultPrizeCards, timerSeconds: 0 }
}

export function isPrizeCardCount(value: number): value is 4 | 6 {
  return (LOBBY_LIMITS.prizeChoices as readonly number[]).includes(value)
}

export function clampLobbySettings(settings: LobbySettings): LobbySettings {
  // 04.12 CP2: the pack count is made finite BEFORE rounding. `Math.round(undefined)` is
  // NaN and `Math.min`/`Math.max` PROPAGATE NaN rather than falling back to their other
  // argument, so the original expression turned a missing or non-numeric `packs` into a
  // NaN that then renders as "NaN" in the stepper and fails `validateLobbySettings`. The
  // old 1-6 range had the same hole; raising the range did not create it, but this
  // checkpoint touches the line, so it is closed here rather than left to be found again.
  const rawPacks = Number(settings.packs)
  const packs = Number.isFinite(rawPacks) ? Math.round(rawPacks) : LOBBY_LIMITS.minPacks
  return {
    set: settings.set,
    packs: Math.min(LOBBY_LIMITS.maxPacks, Math.max(LOBBY_LIMITS.minPacks, packs)),
    prizeCards: isPrizeCardCount(settings.prizeCards) ? settings.prizeCards : LOBBY_LIMITS.defaultPrizeCards,
    timerSeconds: (LOBBY_LIMITS.timerChoices as readonly number[]).includes(settings.timerSeconds) ? settings.timerSeconds : 0,
  }
}

export function validateLobbySettings(value: unknown): value is LobbySettings {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LobbySettings>
  return (
    typeof candidate.set === 'string' && candidate.set.length > 0 &&
    typeof candidate.packs === 'number' && Number.isInteger(candidate.packs) &&
    candidate.packs >= LOBBY_LIMITS.minPacks && candidate.packs <= LOBBY_LIMITS.maxPacks &&
    typeof candidate.prizeCards === 'number' && Number.isInteger(candidate.prizeCards) && isPrizeCardCount(candidate.prizeCards) &&
    typeof candidate.timerSeconds === 'number' && (LOBBY_LIMITS.timerChoices as readonly number[]).includes(candidate.timerSeconds)
  )
}

/**
 * Deck ids repeat once per copy. Both sides exchange deck lists at
 * `deck-ready` so the host can set up the shared battle engine; deck
 * contents remain invisible in the UI (snapshots hide face-down zones) and
 * privacy relies on friendly play, not on traffic inspection.
 */
export type BattleActionPayload = { player: PlayerSlot; action: unknown }
export type BattleSnapshotPayload = { snapshot: unknown }

export type NetMessage =
  | { kind: 'hello'; name: string; protocolVersion: number }
  | { kind: 'hello-ack'; name: string; protocolVersion: number }
  | { kind: 'lobby-update'; settings: LobbySettings }
  | { kind: 'lobby-start'; seed: number; settings: LobbySettings }
  | { kind: 'opening-ready' }
  | { kind: 'deck-ready'; deckIds: string[] }
  | { kind: 'battle-action'; action: BattleActionPayload }
  | { kind: 'battle-snapshot'; snapshot: BattleSnapshotPayload }
  | { kind: 'leave' }
  | { kind: 'rematch' }

export type NetMessageKind = NetMessage['kind']

/** Type guard applied to every inbound data-channel payload. */
export function isNetMessage(value: unknown): value is NetMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { kind?: unknown }
  switch (message.kind) {
    case 'hello':
    case 'hello-ack': {
      const candidate = value as { name?: unknown; protocolVersion?: unknown }
      return typeof candidate.name === 'string' && candidate.protocolVersion === PROTOCOL_VERSION
    }
    case 'lobby-update': {
      const candidate = value as { settings?: unknown }
      return validateLobbySettings(candidate.settings)
    }
    case 'lobby-start': {
      const candidate = value as { seed?: unknown; settings?: unknown }
      return typeof candidate.seed === 'number' && Number.isInteger(candidate.seed) && validateLobbySettings(candidate.settings)
    }
    case 'opening-ready':
      return true
    case 'deck-ready': {
      const candidate = value as { deckIds?: unknown }
      return Array.isArray(candidate.deckIds) && candidate.deckIds.length === DECK_SIZE && candidate.deckIds.every((id) => typeof id === 'string' && id.length > 0)
    }
    case 'battle-action': {
      const candidate = value as { action?: { player?: unknown; action?: unknown } }
      const action = candidate.action
      return typeof action === 'object' && action !== null && (action.player === 'host' || action.player === 'guest') && 'action' in action
    }
    case 'battle-snapshot': {
      const candidate = value as { snapshot?: unknown }
      return typeof candidate.snapshot === 'object' && candidate.snapshot !== null
    }
    case 'leave':
    case 'rematch':
      return true
    default:
      return false
  }
}
