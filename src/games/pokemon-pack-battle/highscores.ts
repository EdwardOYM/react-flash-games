import { readConfig, updateConfig } from '../../config'
import type { HighscoreEntry } from '../highscore/HighscoreTable'

export type { HighscoreEntry }

// The pokemon-pack-battle bucket is a per-player win tally: one entry per
// player name with lifetime battle wins, sorted desc, capped at 10.
export function readPackBattleHighscores(): HighscoreEntry[] {
  return readConfig().highscores['pokemon-pack-battle']?.slice(0, 10) ?? []
}

/** Record one battle win for `name`, aggregating repeats (case-insensitive). */
export function recordPackBattleWin(name: string): HighscoreEntry[] {
  const player = name.trim()
  if (!player) return readPackBattleHighscores()
  return updateConfig((config) => {
    const entries = config.highscores['pokemon-pack-battle'] ?? []
    const existing = entries.find((entry) => entry.name.toLowerCase() === player.toLowerCase())
    const next: HighscoreEntry[] = existing
      ? entries.map((entry) => (entry === existing ? { name: existing.name, score: entry.score + 1 } : entry))
      : [...entries, { name: player, score: 1 }]
    return {
      ...config,
      highscores: {
        ...config.highscores,
        'pokemon-pack-battle': next.sort((left, right) => right.score - left.score).slice(0, 10),
      },
    }
  }).highscores['pokemon-pack-battle']
}
