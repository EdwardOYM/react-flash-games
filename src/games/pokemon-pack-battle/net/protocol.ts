// Wire protocol fork for 04-pokemon-pack-battle. Mirrors the 03 pokemon-bnb
// lobby method (PeerJS createHost/joinHost) with pack-battle limits and
// synced reveal messages: either seat's pack-open/card-reveal mirrors to both.
//
// Version 3 is free-order own-pack opening (04.2): each pack is addressed by
// `packIndex` (not a round `pairIndex`), each seat clicks only its own packs
// (`seatForPack`), and every action renders on both screens. Card reveal
// mirrors the solo rip page: any card clickable in any order + reveal-all.

export const PACK_BATTLE_PROTOCOL_VERSION = 3

export const PACK_BATTLE_LIMITS = {
  minPacks: 1,
  /** Packs per player (the lobby stepper counts per seat, not the shared total). */
  maxPacksPerPlayer: 18,
  cardsPerPack: 6,
  /** Retired in v3 (kept so CP1 builds): rounds no longer exist; packs are
      addressed individually by `packIndex`. Removed in CP2 with the cursor. */
  packsPerPair: 2,
  /** Exclusive bound for `packIndex` on the wire (maxPacksPerPlayer * 2). */
  maxPacks: 36,
  /** Retired in v3 (kept so CP1 builds): rounds no longer exist. Removed in CP2. */
  maxPairs: 18,
} as const

export type PackBattleSlot = 'host' | 'guest'

export type PackBattleSettings = {
  set: string
  packs: number
}

export function defaultPackBattleSettings(set: string): PackBattleSettings {
  return { set, packs: 6 }
}

export function clampPackBattleSettings(settings: PackBattleSettings): PackBattleSettings {
  return {
    set: settings.set,
    packs: Math.min(
      PACK_BATTLE_LIMITS.maxPacksPerPlayer,
      Math.max(PACK_BATTLE_LIMITS.minPacks, Math.round(settings.packs)),
    ),
  }
}

export function validatePackBattleSettings(value: unknown): value is PackBattleSettings {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PackBattleSettings>
  return (
    typeof candidate.set === 'string' &&
    candidate.set.length > 0 &&
    typeof candidate.packs === 'number' &&
    Number.isInteger(candidate.packs) &&
    candidate.packs >= PACK_BATTLE_LIMITS.minPacks &&
    candidate.packs <= PACK_BATTLE_LIMITS.maxPacksPerPlayer
  )
}

export type PackBattleMessage =
  | { kind: 'hello'; name: string; protocolVersion: number }
  | { kind: 'hello-ack'; name: string; protocolVersion: number }
  | { kind: 'lobby-update'; settings: PackBattleSettings }
  | { kind: 'lobby-start'; seed: number; settings: PackBattleSettings }
  | { kind: 'pack-open'; packIndex: number }
  | { kind: 'card-reveal'; packIndex: number; cardIndex: number }
  | { kind: 'ceremony-sync'; opened: number[]; revealed: Record<number, number[]> }
  | { kind: 'battle-done'; score: number }
  | { kind: 'leave' }
  | { kind: 'rematch' }
  /** Retired in v3 (kept so CP1 builds): the round cursor sends these until CP2
      replaces it with per-pack state. Removed in CP2. */
  | { kind: 'pair-open'; pairIndex: number }
  | { kind: 'card-reveal-pair'; pairIndex: number; cardIndex: number }

export type PackBattleMessageKind = PackBattleMessage['kind']

function validPackIndex(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < PACK_BATTLE_LIMITS.maxPacks
  )
}

function validCardIndex(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < PACK_BATTLE_LIMITS.cardsPerPack
  )
}

/** Type guard applied to every inbound pack-battle data-channel payload. */
export function isPackBattleMessage(value: unknown): value is PackBattleMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { kind?: unknown }
  switch (message.kind) {
    case 'hello':
    case 'hello-ack': {
      const candidate = value as { name?: unknown; protocolVersion?: unknown }
      return typeof candidate.name === 'string' && candidate.protocolVersion === PACK_BATTLE_PROTOCOL_VERSION
    }
    case 'lobby-update': {
      const candidate = value as { settings?: unknown }
      return validatePackBattleSettings(candidate.settings)
    }
    case 'lobby-start': {
      const candidate = value as { seed?: unknown; settings?: unknown }
      return (
        typeof candidate.seed === 'number' &&
        Number.isInteger(candidate.seed) &&
        validatePackBattleSettings(candidate.settings)
      )
    }
    case 'pack-open': {
      const candidate = value as { packIndex?: unknown }
      return validPackIndex(candidate.packIndex)
    }
    case 'card-reveal': {
      const candidate = value as { packIndex?: unknown; cardIndex?: unknown }
      return validPackIndex(candidate.packIndex) && validCardIndex(candidate.cardIndex)
    }
    // Temporary v3 build bridge for the still-linear CP1 consumer. CP2 removes
    // these round messages when the cursor is replaced by per-pack state.
    case 'pair-open': {
      const candidate = value as { pairIndex?: unknown }
      return (
        typeof candidate.pairIndex === 'number' &&
        Number.isInteger(candidate.pairIndex) &&
        candidate.pairIndex >= 0 &&
        candidate.pairIndex < PACK_BATTLE_LIMITS.maxPairs
      )
    }
    case 'card-reveal-pair': {
      const candidate = value as { pairIndex?: unknown; cardIndex?: unknown }
      return (
        typeof candidate.pairIndex === 'number' &&
        Number.isInteger(candidate.pairIndex) &&
        candidate.pairIndex >= 0 &&
        candidate.pairIndex < PACK_BATTLE_LIMITS.maxPairs &&
        validCardIndex(candidate.cardIndex)
      )
    }
    case 'ceremony-sync': {
      const candidate = value as { opened?: unknown; revealed?: unknown }
      if (!Array.isArray(candidate.opened) || !candidate.opened.every(validPackIndex)) return false
      if (typeof candidate.revealed !== 'object' || candidate.revealed === null) return false
      return Object.entries(candidate.revealed).every(([packKey, slots]) => {
        if (!validPackIndex(Number(packKey))) return false
        return Array.isArray(slots) && slots.every(validCardIndex)
      })
    }
    case 'battle-done': {
      const candidate = value as { score?: unknown }
      return typeof candidate.score === 'number' && Number.isInteger(candidate.score) && candidate.score >= 0
    }
    case 'leave':
    case 'rematch':
      return true
    default:
      return false
  }
}
