export type GameDefinition = {
  id: string
  titleKey: 'games.orbit' | 'games.signal' | 'games.memory' | 'games.bubbleTrouble' | 'games.tron' | 'games.pokemonBnbMini' | 'games.pokemonPackBattle'
  icon: string
  statusKey: 'gameStatus.ready' | 'gameStatus.comingSoon'
  inspirationKey: 'gameInspiration.orbit' | 'gameInspiration.signal' | 'gameInspiration.memory' | 'gameInspiration.bubbleTrouble' | 'gameInspiration.tron' | 'gameInspiration.pokemonBnbMini' | 'gameInspiration.pokemonPackBattle'
  page?: 'bubble-trouble' | 'tron' | 'pokemon-bnb' | 'pokemon-pack-battle'
}

import { BubbleTroubleGame } from './bubble-trouble/BubbleTroubleGame'
import { TronGame } from './tron/TronGame'
import { PokemonBnbGame } from './pokemon-bnb/PokemonBnbGame'
import { PokemonPackBattleGame } from './pokemon-pack-battle/PokemonPackBattleGame'

export const games: GameDefinition[] = [
  // TODO: Remove examples
  // { id: 'orbit', titleKey: 'games.orbit', icon: '◉', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.orbit' },
  // { id: 'signal', titleKey: 'games.signal', icon: '↗', statusKey: 'gameStatus.comingSoon', inspirationKey: 'gameInspiration.signal' },
  // { id: 'memory', titleKey: 'games.memory', icon: '✦', statusKey: 'gameStatus.comingSoon', inspirationKey: 'gameInspiration.memory' },
  { id: 'bubble-trouble', titleKey: 'games.bubbleTrouble', icon: '◌', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.bubbleTrouble', page: 'bubble-trouble' },
  { id: 'tron', titleKey: 'games.tron', icon: '◮', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.tron', page: 'tron' },
  { id: 'pokemon-bnb', titleKey: 'games.pokemonBnbMini', icon: '⬢', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.pokemonBnbMini', page: 'pokemon-bnb' },
  { id: 'pokemon-pack-battle', titleKey: 'games.pokemonPackBattle', icon: '◈', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.pokemonPackBattle', page: 'pokemon-pack-battle' },
]

export { BubbleTroubleGame, TronGame, PokemonBnbGame, PokemonPackBattleGame }