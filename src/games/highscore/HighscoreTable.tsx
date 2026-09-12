import './HighscoreTable.css'

export type HighscoreEntry = { name: string; score: number }

export type HighscoreLabels = { rank: string; playerName: string; score: string; noScores: string }

type HighscoreTableProps = {
  entries: HighscoreEntry[]
  labels: HighscoreLabels
}

export function HighscoreTable({ entries, labels }: HighscoreTableProps) {
  return <div className="highscore-table" aria-live="polite"><div className="highscore-table-head"><span>{labels.rank}</span><span>{labels.playerName}</span><span>{labels.score}</span></div>{entries.length === 0 ? <p className="no-scores">{labels.noScores}</p> : entries.slice(0, 10).map((entry, index) => <div className="highscore-row" key={`${entry.name}-${entry.score}-${index}`}><span>{index + 1}</span><strong>{entry.name}</strong><span>{entry.score}</span></div>)}</div>
}
