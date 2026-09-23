// Persistence helpers for the RIP / unlocked collection feature (04.3).
// Single storage key `flash-games.config`; `openedCards` is a per-player
// record of opened card ids (lowercased trimmed player name -> sorted unique ids).
// Opponent cards are never written here — only the local device's own-seat cards
// reach these helpers (see PokemonPackBattleGame.tsx + PokemonBnbGame.tsx).

import { readConfig, updateConfig } from '../../config'

/** Sorted unique card ids the named player has opened, or [] when none. */
export function readOpenedCards(name: string): string[] {
  const key = name.trim().toLowerCase()
  if (!key) return []
  return readConfig().openedCards[key] ?? []
}

/** Players (lowercased trimmed names) that have at least one opened card. */
export function listPlayers(): string[] {
  return Object.keys(readConfig().openedCards)
}

/** Whether the named player has opened the given card id. */
export function hasCard(name: string, cardId: string): boolean {
  return readOpenedCards(name).includes(cardId)
}

/**
 * Union `ids` into the named player's opened-card list, dedupe, sort, and
 * persist. Opening the same card again does not duplicate it.
 */
export function recordOpenedCards(name: string, ids: readonly string[]): void {
  const key = name.trim().toLowerCase()
  if (!key || ids.length === 0) return
  updateConfig((config) => {
    const existing = config.openedCards[key] ?? []
    const next = Array.from(new Set([...existing, ...ids])).sort()
    return {
      ...config,
      openedCards: { ...config.openedCards, [key]: next },
    }
  })
}

/**
 * For a pack-battle ceremony's seeded `battlePacks` array (in pack-by-pack,
 * slot-by-slot order), return the card ids from the packs owned by `seat`
 * (or owned by `both` when the seat is either player).
 */
export function cardIdsForSeat(
  battlePacks: readonly { card: { id: string } }[],
  seatForPack: (packIndex: number, packCount: number) => 'host' | 'guest' | 'both',
  totalPacks: number,
  seat: 'host' | 'guest',
): string[] {
  const ids: string[] = []
  for (let packIndex = 0; packIndex < totalPacks; packIndex++) {
    const owner = seatForPack(packIndex, totalPacks)
    if (owner === seat || owner === 'both') {
      // Each pack in battlePacks corresponds to one pack index in ceremony order.
      // battlePacks is already in pack-by-pack order, so the pack boundary is
      // PACK_BATTLE_LIMITS.cardsPerPack cards per pack.
      const start = packIndex * 6
      const pack = battlePacks.slice(start, start + 6)
      for (const opened of pack) ids.push(opened.card.id)
    }
  }
  return ids
}
