export type GameDefinition = {
  id: string
  titleKey: 'games.orbit' | 'games.signal' | 'games.memory' | 'games.bubbleTrouble' | 'games.tron'
  icon: string
  statusKey: 'gameStatus.ready' | 'gameStatus.comingSoon'
  inspirationKey: 'gameInspiration.orbit' | 'gameInspiration.signal' | 'gameInspiration.memory' | 'gameInspiration.bubbleTrouble' | 'gameInspiration.tron'
  page?: 'bubble-trouble' | 'tron'
}

import { BubbleTroubleGame } from './bubble-trouble/BubbleTroubleGame'
import { TronGame } from './tron/TronGame'

export const games: GameDefinition[] = [
  // TODO: Remove examples
  // { id: 'orbit', titleKey: 'games.orbit', icon: '◉', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.orbit' },
  // { id: 'signal', titleKey: 'games.signal', icon: '↗', statusKey: 'gameStatus.comingSoon', inspirationKey: 'gameInspiration.signal' },
  // { id: 'memory', titleKey: 'games.memory', icon: '✦', statusKey: 'gameStatus.comingSoon', inspirationKey: 'gameInspiration.memory' },
  { id: 'bubble-trouble', titleKey: 'games.bubbleTrouble', icon: '◌', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.bubbleTrouble', page: 'bubble-trouble' },
  { id: 'tron', titleKey: 'games.tron', icon: '◮', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.tron', page: 'tron' },
]

export { BubbleTroubleGame, TronGame }