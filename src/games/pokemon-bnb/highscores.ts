import { readConfig, updateConfig } from '../../config'
import type { HighscoreEntry } from '../highscore/HighscoreTable'

export type { HighscoreEntry }

// The pokemon-bnb highscore bucket is a per-player win tally: one entry per
// player name with the number of matches won, sorted by wins (desc), capped
// at 10. Recorded once per match, for the winner only.
export function readHighscores(): HighscoreEntry[] {
  return readConfig().highscores['pokemon-bnb']?.slice(0, 10) ?? []
}

/** Record one match win for `name`, aggregating repeats (case-insensitive). */
export function recordMatchWin(name: string): HighscoreEntry[] {
  const player = name.trim()
  if (!player) return readHighscores()
  return updateConfig((config) => {
    const entries = config.highscores['pokemon-bnb'] ?? []
    const existing = entries.find((entry) => entry.name.toLowerCase() === player.toLowerCase())
    const next: HighscoreEntry[] = existing
      ? entries.map((entry) => (entry === existing ? { name: existing.name, score: entry.score + 1 } : entry))
      : [...entries, { name: player, score: 1 }]
    return { ...config, highscores: { ...config.highscores, 'pokemon-bnb': next.sort((left, right) => right.score - left.score).slice(0, 10) } }
  }).highscores['pokemon-bnb']
}
