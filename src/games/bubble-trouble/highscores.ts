import { readConfig, updateConfig } from '../../config'

export type HighscoreEntry = { name: string; score: number }

export function readHighscores(): HighscoreEntry[] {
  return readConfig().highscores['bubble-trouble']?.slice(0, 10) ?? []
}

export function saveHighscore(entry: HighscoreEntry) {
  return updateConfig((config) => {
    const entries = [...(config.highscores['bubble-trouble'] ?? []), entry].sort((left, right) => right.score - left.score).slice(0, 10)
    return { ...config, highscores: { ...config.highscores, 'bubble-trouble': entries } }
  }).highscores['bubble-trouble']
}

