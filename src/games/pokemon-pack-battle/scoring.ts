// Pack-battle scoring tiers for 04-pokemon-pack-battle.
// Pure logic: mapped onto the shared 30c card data (no dataset change).
// v1 ceiling is 3 pts on current rarities; tiers 4/5 are reserved for
// future holoVariant/finish tags in cards.json (never awarded yet).
//
// The one identity-aware rule: the pack-guaranteed Pikachu IR is a constant
// for both seats, so it scores 0 (and gets no tier flair).

import type { CardDef } from '../pokemon-bnb/cards'

export type BattleTier = 0 | 1 | 2 | 3 | 4 | 5

export const BATTLE_TIER_POINTS: Record<BattleTier, number> = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
}

/**
 * The 30c data tags exactly the 30 pack-guaranteed Pikachu illustration rares
 * with `irVariation` (battlePack slot `pikachu-ir`, in every battle pack, one of
 * the 30 variants at random). Every pack carries one, so it cannot separate the
 * seats: it is worth 0. The weighted ladders exclude this same pool, so a
 * scored illustration rare is always a different card.
 */
export function isGuaranteedPikachuIr(card: CardDef): boolean {
  return card.supertype === 'pokemon' && card.irVariation !== undefined
}

/**
 * Map a 30c engine rarity to a battle tier.
 * - common/uncommon/synthetic energy -> 0
 * - rare -> 1 (Ace Spec/V/EX/poke-ball proxy)
 * - ultraRare -> 2 (FA/master-ball proxy)
 * - illustrationRare -> 3 (IR/GX/MAR proxy)
 * Tiers 4 (Rainbow/Gold) and 5 (SIR) need card tags we do not have yet.
 */
export function tierForRarity(rarity: string, hasPremiumFinish?: boolean, hasSpecialArt?: boolean): BattleTier {
  if (hasSpecialArt) return 5
  if (hasPremiumFinish) return 4
  if (rarity === 'illustrationRare') return 3
  if (rarity === 'ultraRare') return 2
  if (rarity === 'rare') return 1
  return 0
}

/**
 * Tier for one concrete card: the guaranteed Pikachu is always tier 0, every
 * other card follows its rarity ladder.
 */
export function tierForCard(card: CardDef): BattleTier {
  if (isGuaranteedPikachuIr(card)) return 0
  return tierForRarity(card.rarity)
}

/** Points for one revealed card (0 for the pack-guaranteed Pikachu IR). */
export function pointsForCard(card: CardDef): number {
  return BATTLE_TIER_POINTS[tierForCard(card)]
}

/** Sum points across a pack of revealed cards (pure helper for tests/UI). */
export function scorePack(cards: CardDef[]): number {
  return cards.reduce((total, card) => total + pointsForCard(card), 0)
}

/**
 * 04.1-CP3 summary order: engine rarity rank, rarest first. Synthetic basic
 * energies are `common`, so they sink with the commons. Stable within a
 * rarity (Array sort is stable), so equal-rarity cards keep ceremony order.
 */
export function rarityRank(card: CardDef): number {
  if (card.rarity === 'illustrationRare') return 4
  if (card.rarity === 'ultraRare') return 3
  if (card.rarity === 'rare') return 2
  if (card.rarity === 'uncommon') return 1
  return 0
}

/** Rarest-first copy of `cards` (never mutates the input). */
export function sortCardsByRarity<T extends { card: CardDef }>(cards: T[]): T[] {
  return [...cards].sort((a, b) => rarityRank(b.card) - rarityRank(a.card))
}
