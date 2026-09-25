// Pure deck construction/legality for the revised 40-card B&B format.
// Opened non-Energy cards are copy-limited; basic Energy comes from a stable
// unlimited catalog and is serialized separately in deterministic catalog order.

import type { CardDef, EnergyCardDef } from './cards'
import { cardIsEnergy, isBasicPokemon } from './cards'
import { DECK_SIZE } from './net/protocol'
import type { OpenedPool } from './pack'

export { DECK_SIZE }

export type DeckLegalityReason =
  | 'wrong-size'
  | 'no-basic'
  | 'unknown-id'
  | 'over-pool'
  | 'invalid-energy'

export type DeckSummary = {
  total: number
  pokemon: number
  trainer: number
  energy: number
  basics: number
}

export type EnergySelection = Record<string, number>

export function countBySupertype(deckIds: string[], byDef: Map<string, CardDef>): DeckSummary {
  let pokemon = 0
  let trainer = 0
  let energy = 0
  let basics = 0
  for (const id of deckIds) {
    const def = byDef.get(id)
    if (!def) continue
    if (def.supertype === 'pokemon') {
      pokemon += 1
      if (isBasicPokemon(def)) basics += 1
    } else if (def.supertype === 'trainer') {
      trainer += 1
    } else if (cardIsEnergy(def)) {
      energy += 1
    }
  }
  return { total: deckIds.length, pokemon, trainer, energy, basics }
}

export function deckSummary(deckIds: string[], pool: OpenedPool, energyCatalog: EnergyCardDef[]): DeckSummary {
  const byDef = new Map<string, CardDef>()
  for (const card of pool.cards) byDef.set(card.id, card)
  for (const card of energyCatalog) byDef.set(card.id, card)
  return countBySupertype(deckIds, byDef)
}

/** Serialize opened-card selections first, then catalog Energy in stable order. */
export function serializeDeck(nonEnergyIds: string[], energyCounts: EnergySelection, energyCatalog: EnergyCardDef[]): string[] {
  const ids = [...nonEnergyIds]
  for (const card of energyCatalog) {
    const count = energyCounts[card.id] ?? 0
    for (let copy = 0; copy < count; copy++) ids.push(card.id)
  }
  return ids
}

export function buildPoolIsValid(
  deckIds: string[],
  pool: OpenedPool,
  energyCatalog: EnergyCardDef[],
): { ok: boolean; reasons: DeckLegalityReason[]; summary: DeckSummary } {
  const summary = deckSummary(deckIds, pool, energyCatalog)
  const reasons: DeckLegalityReason[] = []
  if (summary.total !== DECK_SIZE) reasons.push('wrong-size')
  if (summary.basics < 1) reasons.push('no-basic')

  const poolById = new Map(pool.cards.map((card) => [card.id, card]))
  const energyById = new Map(energyCatalog.map((card) => [card.id, card]))
  const counts = new Map<string, number>()
  for (const id of deckIds) {
    counts.set(id, (counts.get(id) ?? 0) + 1)
    if (energyById.has(id) || poolById.has(id)) continue
    reasons.push(id.includes('-energy-') ? 'invalid-energy' : 'unknown-id')
  }

  for (const [id, count] of counts) {
    if (energyById.has(id)) continue
    if (count > (pool.byId.get(id) ?? 0)) {
      reasons.push('over-pool')
      break
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], summary }
}
