export type GameDefinition = {
  id: string
  titleKey: 'games.orbit' | 'games.signal' | 'games.memory'
  icon: string
  statusKey: 'gameStatus.ready' | 'gameStatus.comingSoon'
}

export const games: GameDefinition[] = [
  { id: 'orbit', titleKey: 'games.orbit', icon: '◉', statusKey: 'gameStatus.ready' },
  { id: 'signal', titleKey: 'games.signal', icon: '↗', statusKey: 'gameStatus.comingSoon' },
  { id: 'memory', titleKey: 'games.memory', icon: '✦', statusKey: 'gameStatus.comingSoon' },
]