// Wire protocol for the Pokemon TCG B&B mini P2P session (PeerJS data
// channels). Pure data + validation only: no peerjs import, no DOM, so the
// envelope can be unit-checked in Node.
//
// Handshake: guest opens the data channel and sends `hello`; host replies
// `hello-ack`. The host owns lobby settings and broadcasts `lobby-update` on
// every change; `lobby-start` carries the shared pack-opening seed. Battle
// payloads stay `unknown` here and are typed by the engine in CP7/CP9.

import type { SetId } from '../cards'

export const PROTOCOL_VERSION = 1

export const LOBBY_LIMITS = {
  minPacks: 1,
  maxPacks: 6,
  minPrizeCards: 2,
  maxPrizeCards: 6,
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
  return { set, packs: 1, prizeCards: 4, timerSeconds: 0 }
}

export function clampLobbySettings(settings: LobbySettings): LobbySettings {
  return {
    set: settings.set,
    packs: Math.min(LOBBY_LIMITS.maxPacks, Math.max(LOBBY_LIMITS.minPacks, Math.round(settings.packs))),
    prizeCards: Math.min(LOBBY_LIMITS.maxPrizeCards, Math.max(LOBBY_LIMITS.minPrizeCards, Math.round(settings.prizeCards))),
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
    typeof candidate.prizeCards === 'number' && Number.isInteger(candidate.prizeCards) &&
    candidate.prizeCards >= LOBBY_LIMITS.minPrizeCards && candidate.prizeCards <= LOBBY_LIMITS.maxPrizeCards &&
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
      return Array.isArray(candidate.deckIds) && candidate.deckIds.every((id) => typeof id === 'string' && id.length > 0)
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
