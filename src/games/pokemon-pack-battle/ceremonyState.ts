// Per-pack ceremony state for protocol v3 (04.2 CP2). Pure session state:
// network actions and the React consumer use the same transitions so local and
// mirrored updates cannot drift. Nothing in this module is persisted.

import { PACK_BATTLE_LIMITS } from './net/protocol'
import { seatForPack, type BattleSeat } from './packOwnership'

export type CeremonyPackState = {
  opened: boolean
  revealed: boolean[]
  expanded: boolean
}

export type CeremonyState = {
  packs: Record<number, CeremonyPackState>
  /** Opening order is retained so each seat's focus is the latest owned action. */
  openedOrder: number[]
}

export type CeremonySyncState = {
  opened: number[]
  revealed: Record<number, number[]>
  expanded: number[]
}

function revealedFlags(): boolean[] {
  return Array.from({ length: PACK_BATTLE_LIMITS.cardsPerPack }, () => false)
}

function validPackIndex(packIndex: number, totalPacks: number): boolean {
  return Number.isInteger(packIndex) && packIndex >= 0 && packIndex < totalPacks
}

function copyPack(pack: CeremonyPackState): CeremonyPackState {
  return { opened: pack.opened, revealed: [...pack.revealed], expanded: pack.expanded }
}

function copyState(state: CeremonyState): CeremonyState {
  return {
    packs: Object.fromEntries(
      Object.entries(state.packs).map(([packIndex, pack]) => [packIndex, copyPack(pack)]),
    ),
    openedOrder: [...state.openedOrder],
  }
}

export function createCeremonyState(totalPacks: number): CeremonyState {
  return {
    packs: Object.fromEntries(
      Array.from({ length: totalPacks }, (_, packIndex) => [
        packIndex,
        { opened: false, revealed: revealedFlags(), expanded: false },
      ]),
    ),
    openedOrder: [],
  }
}

/** Open one pack and make it the latest focused pack for every owning seat. */
export function openCeremonyPack(state: CeremonyState, packIndex: number, totalPacks: number): CeremonyState {
  if (!validPackIndex(packIndex, totalPacks) || state.packs[packIndex]?.opened) return state
  const next = copyState(state)
  next.packs[packIndex] = { opened: true, revealed: revealedFlags(), expanded: false }
  next.openedOrder.push(packIndex)
  return next
}

/** The fixed seeded order accepts only the lowest-index hidden card. */
export function revealCeremonyCard(
  state: CeremonyState,
  packIndex: number,
  cardIndex: number,
  totalPacks: number,
): CeremonyState {
  if (!validPackIndex(packIndex, totalPacks)) return state
  const current = state.packs[packIndex]
  if (!current?.opened || current.expanded) return state
  const expectedIndex = current.revealed.findIndex((revealed) => !revealed)
  if (expectedIndex !== cardIndex) return state
  const next = copyState(state)
  next.packs[packIndex].revealed[cardIndex] = true
  return next
}

/** Receiver merge: duplicate or out-of-order individual reveals are harmless. */
export function mergeCeremonyCardReveal(
  state: CeremonyState,
  packIndex: number,
  cardIndex: number,
  totalPacks: number,
): CeremonyState {
  if (!validPackIndex(packIndex, totalPacks)) return state
  const current = state.packs[packIndex]
  if (!current?.opened || current.expanded) return state
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= PACK_BATTLE_LIMITS.cardsPerPack) return state
  if (current.revealed[cardIndex]) return state
  const next = copyState(state)
  next.packs[packIndex].revealed[cardIndex] = true
  return next
}

/** Reveal every hidden card and mark the pack for the expanded 04.3-style review. */
export function revealAllCeremonyPack(
  state: CeremonyState,
  packIndex: number,
  totalPacks: number,
): CeremonyState {
  if (!validPackIndex(packIndex, totalPacks)) return state
  const current = state.packs[packIndex]
  if (!current?.opened || (current.revealed.every(Boolean) && current.expanded)) return state
  const next = copyState(state)
  next.packs[packIndex] = {
    opened: true,
    revealed: Array.from({ length: PACK_BATTLE_LIMITS.cardsPerPack }, () => true),
    expanded: true,
  }
  return next
}

/**
 * Union a host snapshot into the current map. Duplicate and out-of-order
 * packets are harmless; expanded packs always imply all six cards revealed.
 */
export function mergeCeremonySync(
  state: CeremonyState,
  sync: CeremonySyncState,
  totalPacks: number,
): CeremonyState {
  const next = copyState(state)
  for (const packIndex of sync.opened) {
    if (!validPackIndex(packIndex, totalPacks) || next.packs[packIndex]?.opened) continue
    next.packs[packIndex] = { opened: true, revealed: revealedFlags(), expanded: false }
    next.openedOrder.push(packIndex)
  }
  for (const [packKey, cardIndexes] of Object.entries(sync.revealed)) {
    const packIndex = Number(packKey)
    if (!validPackIndex(packIndex, totalPacks) || !next.packs[packIndex]?.opened) continue
    for (const cardIndex of cardIndexes) {
      if (Number.isInteger(cardIndex)
        && cardIndex >= 0
        && cardIndex < PACK_BATTLE_LIMITS.cardsPerPack) {
        next.packs[packIndex].revealed[cardIndex] = true
      }
    }
  }
  for (const packIndex of sync.expanded) {
    if (!validPackIndex(packIndex, totalPacks) || !next.packs[packIndex]?.opened) continue
    next.packs[packIndex] = {
      opened: true,
      revealed: Array.from({ length: PACK_BATTLE_LIMITS.cardsPerPack }, () => true),
      expanded: true,
    }
  }
  return next
}

export function ceremonySyncFromState(state: CeremonyState): CeremonySyncState {
  const revealed: Record<number, number[]> = {}
  const expanded: number[] = []
  for (const packIndex of state.openedOrder) {
    const pack = state.packs[packIndex]
    if (!pack?.opened) continue
    revealed[packIndex] = pack.revealed.flatMap((isRevealed, cardIndex) => isRevealed ? [cardIndex] : [])
    if (pack.expanded) expanded.push(packIndex)
  }
  return { opened: [...state.openedOrder], revealed, expanded }
}

export function ceremonyTotals(
  state: CeremonyState,
  totalPacks: number,
  packCardPoints: readonly (readonly number[])[],
): { host: number; guest: number } {
  let host = 0
  let guest = 0
  for (let packIndex = 0; packIndex < totalPacks; packIndex += 1) {
    const pack = state.packs[packIndex]
    const owner = seatForPack(packIndex, totalPacks)
    for (let cardIndex = 0; cardIndex < PACK_BATTLE_LIMITS.cardsPerPack; cardIndex += 1) {
      if (!pack?.opened || !pack.revealed[cardIndex]) continue
      const points = packCardPoints[packIndex]?.[cardIndex] ?? 0
      if (owner === 'host' || owner === 'both') host += points
      if (owner === 'guest' || owner === 'both') guest += points
    }
  }
  return { host, guest }
}

export function isCeremonyComplete(state: CeremonyState, totalPacks: number): boolean {
  if (totalPacks <= 0 || state.openedOrder.length < totalPacks) return false
  return Array.from({ length: totalPacks }, (_, packIndex) => state.packs[packIndex]).every(
    (pack) => pack?.opened === true && pack.revealed.every(Boolean),
  )
}

export function seatCanControlPack(
  packIndex: number,
  totalPacks: number,
  seat: 'host' | 'guest',
): boolean {
  if (!validPackIndex(packIndex, totalPacks)) return false
  const owner: BattleSeat = seatForPack(packIndex, totalPacks)
  return owner === seat || owner === 'both'
}

/** Latest opened pack owned by the seat; completed packs remain focused. */
export function focusedPackForSeat(
  state: CeremonyState,
  totalPacks: number,
  seat: 'host' | 'guest',
): number | null {
  for (let index = state.openedOrder.length - 1; index >= 0; index -= 1) {
    const packIndex = state.openedOrder[index]
    if (seatCanControlPack(packIndex, totalPacks, seat)) return packIndex
  }
  return null
}

