// Set registry for Pokemon Pack Battle (04). Keeps only the pack-battle-relevant
// metadata (id + label key) so the lobby stepper can list available sets without
// importing the full B&B card/pack data model. The actual 30C card pool is derived
// in battlePack.ts from the shared 30C card data.

import type { TranslationKey } from '../../assets/languages'

export type PackBattleSetEntry = {
  id: string
  labelKey: TranslationKey
}

const PACK_BATTLE_SETS: PackBattleSetEntry[] = [
  { id: '30c', labelKey: 'packBattle.set30c' },
]

export function listSets(): PackBattleSetEntry[] {
  return PACK_BATTLE_SETS
}
