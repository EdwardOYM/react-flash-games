import { readConfig, updateConfig } from '../../config'
import type { HighscoreEntry } from '../highscore/HighscoreTable'

export type { HighscoreEntry }

export function readHighscores(): HighscoreEntry[] {
  return readConfig().highscores['tron']?.slice(0, 10) ?? []
}

export function saveHighscore(entry: HighscoreEntry) {
  return updateConfig((config) => {
    const entries = [...(config.highscores['tron'] ?? []), entry].sort((left, right) => right.score - left.score).slice(0, 10)
    return { ...config, highscores: { ...config.highscores, tron: entries } }
  }).highscores['tron']
}
