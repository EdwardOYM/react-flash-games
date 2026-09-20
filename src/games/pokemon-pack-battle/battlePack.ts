// 6-card battle pack definition (session data, not persisted).
// Order: energy, common, common, unique pikachu, common-and-above,
// uncommon-and-above. The "and above" slots use weighted ladders whose
// weights live here (tune without touching code), following rarity chance.
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
      weights: { common: 62, uncommon: 8, rare: 21, ultraRare: 6, illustrationRare: 3 },
    },
    {
      id: 'uncommon-or-better',
      poolRef: 'uncommonOrBetter',
      count: 1,
      weights: { uncommon: 6, rare: 68, ultraRare: 17, illustrationRare: 9 },
    },
  ],
  pools: {
    commonOrBetter: { ladder: ['common', 'uncommon', 'rare', 'ultraRare', 'illustrationRare'] },
    uncommonOrBetter: { ladder: ['uncommon', 'rare', 'ultraRare', 'illustrationRare'] },
    basicEnergy: {
      types: ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal'],
    },
  },
}
