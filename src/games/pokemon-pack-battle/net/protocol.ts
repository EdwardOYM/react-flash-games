// Wire protocol fork for 04-pokemon-pack-battle. Mirrors the 03 pokemon-bnb
// lobby method (PeerJS createHost/joinHost) with pack-battle limits and
// synced reveal messages: either seat's open/reveal advances both seats.

export const PACK_BATTLE_PROTOCOL_VERSION = 1

export const PACK_BATTLE_LIMITS = {
  minPacks: 1,
  maxPacks: 36,
  cardsPerPack: 6,
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
      PACK_BATTLE_LIMITS.maxPacks,
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
    candidate.packs <= PACK_BATTLE_LIMITS.maxPacks
  )
}

export type PackBattleMessage =
  | { kind: 'hello'; name: string; protocolVersion: number }
  | { kind: 'hello-ack'; name: string; protocolVersion: number }
  | { kind: 'lobby-update'; settings: PackBattleSettings }
  | { kind: 'lobby-start'; seed: number; settings: PackBattleSettings }
  | { kind: 'pack-open'; packIndex: number }
  | { kind: 'card-reveal'; packIndex: number; cardIndex: number }
  | { kind: 'battle-done'; score: number }
  | { kind: 'leave' }
  | { kind: 'rematch' }

export type PackBattleMessageKind = PackBattleMessage['kind']

function validPackIndex(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < PACK_BATTLE_LIMITS.maxPacks
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
