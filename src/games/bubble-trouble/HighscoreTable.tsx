import type { useTranslations } from '../../assets/languages'
import type { HighscoreEntry } from './highscores'

type HighscoreTableProps = {
  entries: HighscoreEntry[]
  t: ReturnType<typeof useTranslations>
}

export function HighscoreTable({ entries, t }: HighscoreTableProps) {
  return <div className="highscore-table" aria-live="polite"><div className="highscore-table-head"><span>{t('bubble.rank')}</span><span>{t('bubble.playerName')}</span><span>{t('bubble.score')}</span></div>{entries.length === 0 ? <p className="no-scores">{t('bubble.noScores')}</p> : entries.slice(0, 10).map((entry, index) => <div className="highscore-row" key={`${entry.name}-${entry.score}-${index}`}><span>{index + 1}</span><strong>{entry.name}</strong><span>{entry.score}</span></div>)}</div>
}
