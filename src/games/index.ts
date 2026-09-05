export type GameDefinition = {
  id: string
  titleKey: 'games.orbit' | 'games.signal' | 'games.memory' | 'games.bubbleTrouble'
  icon: string
  statusKey: 'gameStatus.ready' | 'gameStatus.comingSoon'
  inspirationKey: 'gameInspiration.orbit' | 'gameInspiration.signal' | 'gameInspiration.memory' | 'gameInspiration.bubbleTrouble'
  page?: 'bubble-trouble'
}

import { BubbleTroubleGame } from './bubble-trouble/BubbleTroubleGame'

export const games: GameDefinition[] = [
  { id: 'orbit', titleKey: 'games.orbit', icon: '◉', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.orbit' },
  { id: 'signal', titleKey: 'games.signal', icon: '↗', statusKey: 'gameStatus.comingSoon', inspirationKey: 'gameInspiration.signal' },
  { id: 'memory', titleKey: 'games.memory', icon: '✦', statusKey: 'gameStatus.comingSoon', inspirationKey: 'gameInspiration.memory' },
  { id: 'bubble-trouble', titleKey: 'games.bubbleTrouble', icon: '◌', statusKey: 'gameStatus.ready', inspirationKey: 'gameInspiration.bubbleTrouble', page: 'bubble-trouble' },
]

export { BubbleTroubleGame }