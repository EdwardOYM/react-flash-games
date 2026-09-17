// Set registry for Pokemon TCG B&B mini. Adding a future set = drop a data
// folder under src/assets/pokemon-bnb/sets/<id>/ (cards.json + pack.json) and
// add one entry here. No other code changes.

import type { CardDef, CardRarity, SetData } from './cards'
import pack30c from '../../assets/pokemon-bnb/sets/30c/pack.json'
import cards30c from '../../assets/pokemon-bnb/sets/30c/cards.json'

export type PackSlotDef = {
  id: string
  poolRef: string
  count: number
  /** Relative weights per rarity bucket for weighted ladder slots. */
  weights?: Record<string, number>
}

export type PackDef = {
  set: string
  size: number
  slots: PackSlotDef[]
  pools: {
    uncommonOrBetter?: { ladder: CardRarity[] }
    basicEnergy?: { types: string[] }
  }
}

export type SetEntry = {
  id: string
  data: SetData
  pack: PackDef
}

const SET_ENTRIES: SetEntry[] = [
  { id: '30c', data: cards30c as unknown as SetData, pack: pack30c as unknown as PackDef },
]

export function listSets(): SetEntry[] {
  return SET_ENTRIES
}

export function getSet(id: string): SetEntry | undefined {
  return SET_ENTRIES.find((entry) => entry.id === id)
}

/** All cards of a set, in collection-number order. */
export function setCards(entry: SetEntry): CardDef[] {
  return [...entry.data.cards]
}
