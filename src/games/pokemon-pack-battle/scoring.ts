// Pack-battle scoring tiers for 04-pokemon-pack-battle.
// Pure logic: mapped onto the shared 30c card data (no dataset change).
// v1 ceiling is 3 pts on current rarities; tiers 4/5 are reserved for
// future holoVariant/finish tags in cards.json (never awarded yet).
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
 * Map a 30c engine rarity to a battle tier.
 * - common/uncommon/synthetic energy -> 0
 * - rare -> 1 (Ace Spec/V/EX/poke-ball proxy)
 * - ultraRare -> 2 (FA/master-ball proxy)
 * - illustrationRare -> 3 (IR/GX/MAR proxy, incl. guaranteed Pikachu)
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

/** Points for one card given its engine rarity + optional future tags. */
export function pointsForCard(rarity: string, hasPremiumFinish?: boolean, hasSpecialArt?: boolean): number {
  return BATTLE_TIER_POINTS[tierForRarity(rarity, hasPremiumFinish, hasSpecialArt)]
}

/** Sum points across a pack of card rarities (pure helper for tests/UI). */
export function scorePack(rarities: string[]): number {
  return rarities.reduce((total, rarity) => total + pointsForCard(rarity), 0)
}
