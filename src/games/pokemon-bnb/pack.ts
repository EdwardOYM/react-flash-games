// Pack-opening engine for Pokemon TCG B&B mini. Pure logic: takes the set's
// card list + PackDef (src/assets/pokemon-bnb/sets/<id>/pack.json) and a
// seeded Rng, returns the ordered card sequence for the opening ceremony.
// The same seed + pack config always yields the identical pool on every peer.

import type { CardDef, CardRarity, EnergyCardDef } from './cards'
import { cardIsEnergy, cardIsPokemon } from './cards'
import { pickUniform, randomInt, type Rng } from './rng'
import type { PackDef, PackSlotDef } from './sets'

export type OpenedCard = { card: CardDef; slotId: string }

export type OpenedPool = {
  /** Ordered unique non-Energy definitions in the opened pool. */
  cards: CardDef[]
  /** cardId -> total copies opened. */
  byId: Map<string, number>
}

export const BASIC_ENERGY_TYPES = ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal'] as const
export type BasicEnergyType = (typeof BASIC_ENERGY_TYPES)[number]

/** Synthesize a basic energy card (physical packs include one; set data does not). */
export function basicEnergyCard(setId: string, type: BasicEnergyType): EnergyCardDef {
  const label = type.charAt(0).toUpperCase() + type.slice(1)
  return { id: `${setId}-energy-${type}`, set: setId, number: `E-${type}`, name: `${label} Energy`, rarity: 'common', supertype: 'energy', types: [], energyType: 'normal', provides: type }
}

/** Stable construction catalog: every standard basic type, in ruleset order. */
export function basicEnergyCatalog(setId: string): EnergyCardDef[] {
  return BASIC_ENERGY_TYPES.map((type) => basicEnergyCard(setId, type))
}

function isGuaranteedIr(card: CardDef): boolean {
  return cardIsPokemon(card) && card.irVariation !== undefined
}

function poolOfRarity(cards: CardDef[], rarity: CardRarity, excludeGuaranteedIr: boolean): CardDef[] {
  return cards.filter((card) => card.rarity === rarity && (!excludeGuaranteedIr || !isGuaranteedIr(card)))
}

/** Pick a rarity bucket from a weighted ladder, redistributing weight over empty buckets. */
function pickLadderRarity(ladder: CardRarity[], weights: Record<string, number>, availability: Map<CardRarity, number>, rng: Rng): CardRarity {
  const live = ladder.filter((rarity) => (availability.get(rarity) ?? 0) > 0)
  const entries = live.map((rarity) => ({ rarity, weight: weights[rarity] ?? 1 }))
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (total <= 0 || entries.length === 0) return pickUniform(ladder, rng)
  let roll = randomInt(rng, total)
  for (const entry of entries) {
    roll -= entry.weight
    if (roll < 0) return entry.rarity
  }
  return entries[entries.length - 1].rarity
}

function drawSlot(cards: CardDef[], slot: PackSlotDef, pack: PackDef, rng: Rng): CardDef[] {
  if (slot.poolRef === 'basicEnergy') {
    const types = (pack.pools.basicEnergy?.types ?? [...BASIC_ENERGY_TYPES]) as BasicEnergyType[]
    return Array.from({ length: slot.count }, () => basicEnergyCard(pack.set, pickUniform(types, rng)))
  }
  if (slot.poolRef === 'guaranteedPikachuIr') {
    const pool = cards.filter((card) => isGuaranteedIr(card))
    return Array.from({ length: slot.count }, () => pickUniform(pool, rng))
  }
  if (slot.poolRef === 'uncommonOrBetter') {
    const ladder = pack.pools.uncommonOrBetter?.ladder ?? ['rare', 'double rare', 'illustration rare', 'special illustration rare', 'futuristic rare']
    const availability = new Map<CardRarity, number>()
    for (const rarity of ladder) availability.set(rarity, poolOfRarity(cards, rarity, true).length)
    return Array.from({ length: slot.count }, () => {
      const rarity = pickLadderRarity(ladder, slot.weights ?? {}, availability, rng)
      return pickUniform(poolOfRarity(cards, rarity, true), rng)
    })
  }
  // 'common' and any future plain-rarity pool: uniform within the bucket.
  return Array.from({ length: slot.count }, () => pickUniform(poolOfRarity(cards, slot.poolRef as CardRarity, true), rng))
}

/**
 * Open `packCount` packs. Returns the card sequence in ceremony order
 * (pack by pack, slot by slot) so the UI can reveal one card at a time.
 */
export function openPacks(cards: CardDef[], pack: PackDef, packCount: number, rng: Rng): OpenedCard[] {
  const opened: OpenedCard[] = []
  for (let index = 0; index < packCount; index++) {
    for (const slot of pack.slots) {
      for (const card of drawSlot(cards, slot, pack, rng)) {
        opened.push({ card, slotId: slot.id })
      }
    }
  }
  return opened
}

/** Aggregate opened non-Energy cards into the copy-limited deck pool. */
export function buildPool(opened: OpenedCard[]): OpenedPool {
  const cards: CardDef[] = []
  const byId = new Map<string, number>()
  for (const { card } of opened) {
    if (cardIsEnergy(card)) continue
    if (!byId.has(card.id)) cards.push(card)
    byId.set(card.id, (byId.get(card.id) ?? 0) + 1)
  }
  return { cards, byId }
}
