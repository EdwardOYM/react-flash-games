// 6-card battle pack definition (session data, not persisted).
// Order: energy, common, common, unique pikachu, common-and-above,
// uncommon-and-above. The "and above" slots use weighted ladders whose
// weights live here (tune without touching code), following rarity chance.

import type { CardDef, CardRarity } from '../pokemon-bnb/cards'
import cards30cJson from '../../assets/pokemon-bnb/sets/30c/cards.json'
import { packBattlePick, packBattleRandomInt, type PackBattleRng } from './rng'

export { seatForPack, type BattleSeat } from './packOwnership'
// Shared predicate: the same cards that score 0 are the ones excluded from the
// weighted ladders, so the "guaranteed Pikachu" rule lives in exactly one place.
import { isGuaranteedPikachuIr } from './scoring'

export type BattlePackSlotDef = {
  id: string
  poolRef: string
  count: number
  weights?: Record<string, number>
}

export type BattlePackDef = {
  set: string
  size: 6
  slots: BattlePackSlotDef[]
  pools: {
    commonOrBetter: { ladder: string[] }
    uncommonOrBetter: { ladder: string[] }
    basicEnergy: { types: string[] }
  }
}

export const PACK_BATTLE_30C: BattlePackDef = {
  set: '30c',
  size: 6,
  slots: [
    { id: 'basic-energy', poolRef: 'basicEnergy', count: 1 },
    { id: 'common-1', poolRef: 'common', count: 1 },
    { id: 'common-2', poolRef: 'common', count: 1 },
    { id: 'pikachu-ir', poolRef: 'guaranteedPikachuIr', count: 1 },
    {
      id: 'common-or-better',
      poolRef: 'commonOrBetter',
      count: 1,
      weights: { common: 62, rare: 21, 'double rare': 6, 'illustration rare': 3, 'special illustration rare': 1, 'futuristic rare': 1 },
    },
    {
      id: 'uncommon-or-better',
      poolRef: 'uncommonOrBetter',
      count: 1,
      weights: { rare: 68, 'double rare': 17, 'illustration rare': 9, 'special illustration rare': 3, 'futuristic rare': 1 },
    },
  ],
  pools: {
    commonOrBetter: { ladder: ['common', 'rare', 'double rare', 'illustration rare', 'special illustration rare', 'futuristic rare'] },
    uncommonOrBetter: { ladder: ['rare', 'double rare', 'illustration rare', 'special illustration rare', 'futuristic rare'] },
    basicEnergy: {
      types: ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal'],
    },
  },
}

/**
 * Shared 30c card pool. The same JSON asset the 03 B&B mini imports; only the
 * data is shared (type-only reuse of CardDef), never the bnb engine modules.
 */
export function battleSetCards(): CardDef[] {
  return (cards30cJson as { cards: CardDef[] }).cards
}

/** One revealed ceremony card, in pack-by-pack slot-by-slot order. */
export type BattleOpenedCard = { card: CardDef; slotId: string }

const BASIC_ENERGY_TYPES = ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal'] as const

/** Synthetic basic energy (physical packs include one; set data does not). */
function battleBasicEnergyCard(set: string, type: (typeof BASIC_ENERGY_TYPES)[number]): CardDef {
  const label = type.charAt(0).toUpperCase() + type.slice(1)
  return {
    id: `${set}-energy-${type}`,
    set,
    number: `E-${type}`,
    name: `${label} Energy`,
    rarity: 'common',
    supertype: 'energy',
    types: [],
    energyType: 'normal',
    provides: type,
  }
}

function poolOfRarity(cards: CardDef[], rarity: CardRarity, excludeGuaranteedPikachu: boolean): CardDef[] {
  return cards.filter((card) => card.rarity === rarity && (!excludeGuaranteedPikachu || !isGuaranteedPikachuIr(card)))
}

/** Pick a rarity bucket from a weighted ladder, redistributing over empty buckets. */
function pickLadderRarity(ladder: CardRarity[], weights: Record<string, number>, availability: Map<CardRarity, number>, rng: PackBattleRng): CardRarity {
  const live = ladder.filter((rarity) => (availability.get(rarity) ?? 0) > 0)
  const entries = live.map((rarity) => ({ rarity, weight: weights[rarity] ?? 1 }))
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
  if (total <= 0 || entries.length === 0) return packBattlePick(ladder, rng)
  let roll = packBattleRandomInt(rng, total)
  for (const entry of entries) {
    roll -= entry.weight
    if (roll < 0) return entry.rarity
  }
  return entries[entries.length - 1].rarity
}

function drawLadderSlot(cards: CardDef[], slot: BattlePackSlotDef, ladder: CardRarity[], rng: PackBattleRng): CardDef[] {
  const availability = new Map<CardRarity, number>()
  for (const rarity of ladder) availability.set(rarity, poolOfRarity(cards, rarity, true).length)
  return Array.from({ length: slot.count }, () => {
    const rarity = pickLadderRarity(ladder, slot.weights ?? {}, availability, rng)
    return packBattlePick(poolOfRarity(cards, rarity, true), rng)
  })
}

function drawSlot(cards: CardDef[], slot: BattlePackSlotDef, pack: BattlePackDef, rng: PackBattleRng): CardDef[] {
  if (slot.poolRef === 'basicEnergy') {
    const types = (pack.pools.basicEnergy.types ?? [...BASIC_ENERGY_TYPES]) as (typeof BASIC_ENERGY_TYPES)[number][]
    return Array.from({ length: slot.count }, () => battleBasicEnergyCard(pack.set, packBattlePick(types, rng)))
  }
  if (slot.poolRef === 'guaranteedPikachuIr') {
    const pool = cards.filter((card) => isGuaranteedPikachuIr(card))
    return Array.from({ length: slot.count }, () => packBattlePick(pool, rng))
  }
  if (slot.poolRef === 'commonOrBetter') return drawLadderSlot(cards, slot, pack.pools.commonOrBetter.ladder as CardRarity[], rng)
  if (slot.poolRef === 'uncommonOrBetter') return drawLadderSlot(cards, slot, pack.pools.uncommonOrBetter.ladder as CardRarity[], rng)
  // Plain rarity pools: uniform within the bucket (Pikachu excluded).
  return Array.from({ length: slot.count }, () => packBattlePick(poolOfRarity(cards, slot.poolRef as CardRarity, true), rng))
}

/**
 * Open `packCount` battle packs from the shared seed's rng. Returns the card
 * sequence in ceremony order (pack by pack, slot by slot) so both peers derive
 * the identical pool and the UI reveals one card at a time.
 */
export function openBattlePacks(cards: CardDef[], pack: BattlePackDef, packCount: number, rng: PackBattleRng): BattleOpenedCard[] {
  const opened: BattleOpenedCard[] = []
  for (let index = 0; index < packCount; index++) {
    for (const slot of pack.slots) {
      for (const card of drawSlot(cards, slot, pack, rng)) {
        opened.push({ card, slotId: slot.id })
      }
    }
  }
  return opened
}
