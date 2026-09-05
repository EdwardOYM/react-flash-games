export type GameDefinition = { id: string; title: string; icon: string; status: 'ready' | 'coming soon' }

export const games: GameDefinition[] = [
  { id: 'orbit', title: 'Orbit Catch', icon: '◉', status: 'ready' },
  { id: 'signal', title: 'Signal Sprint', icon: '↗', status: 'coming soon' },
  { id: 'memory', title: 'Memory Bloom', icon: '✦', status: 'coming soon' },
]