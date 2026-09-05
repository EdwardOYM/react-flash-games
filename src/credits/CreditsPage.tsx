import type { useTranslations } from '../assets/languages'
import { games } from '../games'

type CreditsPageProps = {
  onBack: () => void
  t: ReturnType<typeof useTranslations>
}

const technologies = ['react', 'three', 'vite', 'typescript', 'oxlint'] as const

export function CreditsPage({ onBack, t }: CreditsPageProps) {
  return <main className="credits-page"><header className="credits-header"><button className="text-button" type="button" onClick={onBack}>{t('backToHome')}</button><span className="brand-mark">EG</span></header><section className="credits-content"><p className="eyebrow">{t('creditsEyebrow')}</p><h1>{t('creditsTitle')}</h1><p className="credits-description">{t('creditsDescription')}</p><div className="credits-list"><div className="credit-row"><span>{t('developer')}</span><strong>{t('developerName')}</strong></div><div className="credit-row credit-stack"><span>{t('technology')}</span><div>{technologies.map((technology) => <strong key={technology}>{t(`technologyNames.${technology}`)}</strong>)}</div></div><div className="credit-row credit-stack"><span>{t('gameInspiredBy')}</span><div>{games.map((game) => <strong key={game.id}>{t(game.titleKey)}: {t(game.inspirationKey)}</strong>)}</div></div></div></section></main>
}