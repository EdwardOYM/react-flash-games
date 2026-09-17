// Deck-building legality for Pokemon TCG B&B mini. Pure logic: no React,
// no DOM. Limited "mini" format: because 1 pack = 5 cards, the minimum deck
// scales down to the pool — you must keep at least prizeCards + 1 cards
// (prizes are set aside from the deck), or your whole pool when it is
// smaller. Copies are limited only by what you opened (no 4-copy rule in
// limited), plus at least one Basic Pokemon (you need an Active) and one
// Energy (you need to attack).

import type { CardDef } from './cards'
import { cardIsEnergy, isBasicPokemon } from './cards'
import type { OpenedPool } from './pack'

export type DeckLegalityReason = 'too-small' | 'no-basic' | 'no-energy' | 'over-pool'

export type DeckSummary = {
  total: number
  pokemon: number
  trainer: number
  energy: number
  basics: number
}

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
    } else if (def.supertype === 'energy' || cardIsEnergy(def)) {
      energy += 1
    }
  }
  return { total: deckIds.length, pokemon, trainer, energy, basics }
}

export function deckSummary(deckIds: string[], pool: OpenedPool): DeckSummary {
  const byDef = new Map<string, CardDef>()
  for (const card of pool.cards) byDef.set(card.id, card)
  return countBySupertype(deckIds, byDef)
}

/** Minimum keeps: prizes are set aside, so the deck must outnumber them. */
export function minDeckSize(poolTotal: number, prizeCards: number): number {
  return Math.min(poolTotal, prizeCards + 1)
}

export function buildPoolIsValid(
  deckIds: string[],
  pool: OpenedPool,
  prizeCards: number,
): { ok: boolean; reasons: DeckLegalityReason[]; summary: DeckSummary; minimum: number } {
  const summary = deckSummary(deckIds, pool)
  const minimum = minDeckSize(pool.cards.reduce((sum, card) => sum + (pool.byId.get(card.id) ?? 0), 0), prizeCards)
  const reasons: DeckLegalityReason[] = []
  if (summary.total < minimum) reasons.push('too-small')
  if (summary.basics < 1) reasons.push('no-basic')
  if (summary.energy < 1) reasons.push('no-energy')
  const counts = new Map<string, number>()
  for (const id of deckIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  for (const [id, count] of counts) {
    if (count > (pool.byId.get(id) ?? 0)) {
      reasons.push('over-pool')
      break
    }
  }
  return { ok: reasons.length === 0, reasons, summary, minimum }
}
