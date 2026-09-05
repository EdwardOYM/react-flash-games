export type HighscoreEntry = { name: string; score: number }

const STORAGE_KEY = 'bubble-trouble-highscores'

export function readHighscores(): HighscoreEntry[] {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return []
  try {
    const parsed = JSON.parse(stored) as HighscoreEntry[]
    if (Array.isArray(parsed)) return parsed.filter((entry) => typeof entry.name === 'string' && typeof entry.score === 'number').slice(0, 10)
  } catch {
    return stored.split('\n').map((line) => {
      const [name, score] = line.split('\t')
      return { name, score: Number(score) }
    }).filter((entry) => entry.name && Number.isFinite(entry.score)).slice(0, 10)
  }
  return []
}

export function saveHighscore(entry: HighscoreEntry) {
  const entries = [...readHighscores(), entry].sort((left, right) => right.score - left.score).slice(0, 10)
  localStorage.setItem(STORAGE_KEY, entries.map((current) => `${current.name}\t${current.score}`).join('\n'))
  return entries
}

export function formatHighscores(entries: HighscoreEntry[]) {
  return entries.map((entry) => `${entry.name}\t${entry.score}`).join('\n')
}
