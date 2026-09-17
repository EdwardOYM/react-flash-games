// Pokemon TCG B&B mini — peer-to-peer Build & Battle limited format.
// CP2 skeleton: full view state machine with placeholder pages; the lobby,
// pack opening, deck builder, and battle flow land in later checkpoints.
import { useState } from 'react'
import { getPreferredLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import './PokemonBnbGame.css'

type View =
  | 'start'
  | 'tutorial'
  | 'lobby'
  | 'lobbyJoin'
  | 'opening'
  | 'deck'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'gameover'
  | 'victory'
  | 'highscore'

type PokemonBnbProps = {
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  onExit: () => void
  t?: ReturnType<typeof useTranslations>
}

export function PokemonBnbGame({ locale: providedLocale, onExit, t: providedTranslations }: PokemonBnbProps) {
  const locale = providedLocale ?? getPreferredLocale()
  const translations = useTranslations(locale)
  const t = providedTranslations ?? translations
  const [view, setView] = useState<View>('start')
  const [tutorialStep, setTutorialStep] = useState(0)

  const tutorialSteps: { goal: string; copyKey: TranslationKey }[] = [
    { goal: 'pack', copyKey: 'pokemonBnb.tutorialPack' },
    { goal: 'deck', copyKey: 'pokemonBnb.tutorialDeck' },
    { goal: 'battle', copyKey: 'pokemonBnb.tutorialBattle' },
  ]

  const startTutorial = () => { setTutorialStep(0); setView('tutorial') }
  const exitTutorial = () => setView('start')
  const advanceTutorial = () => { if (tutorialStep < tutorialSteps.length - 1) setTutorialStep(tutorialStep + 1); else setView('start') }

  if (view === 'tutorial') {
    const step = tutorialSteps[tutorialStep]
    return (
      <main className="bnb-page">
        <div className="bnb-shell">
          <p className="eyebrow">{t('pokemonBnb.tutorialTitle')}</p>
          <h1>{t('pokemonBnb.tutorialTitle')}</h1>
          <p className="bnb-copy">{t(step.copyKey)}</p>
          <div className="bnb-actions">
            <button className="bnb-primary" type="button" onClick={advanceTutorial}>{tutorialStep < tutorialSteps.length - 1 ? t('pokemonBnb.back') : t('pokemonBnb.finish')}</button>
            <button type="button" onClick={exitTutorial}>{t('pokemonBnb.tutorialSkip')}</button>
          </div>
        </div>
      </main>
    )
  }

  if (view === 'lobby' || view === 'lobbyJoin' || view === 'opening' || view === 'deck' || view === 'loading' || view === 'playing' || view === 'paused' || view === 'gameover' || view === 'victory' || view === 'highscore') {
    return (
      <main className="bnb-page">
        <div className="bnb-shell">
          <p className="eyebrow">{t('pokemonBnb.title')}</p>
          <h1>{t('pokemonBnb.title')}</h1>
          <p className="bnb-copy">{t('pokemonBnb.wip')}</p>
          <div className="bnb-actions">
            <button className="bnb-primary" type="button" onClick={() => setView('start')}>{t('pokemonBnb.back')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="bnb-page">
      <header className="bnb-topbar">
        <span className="bnb-hud-label">{t('pokemonBnb.title')}</span>
        <div className="bnb-topbar-actions">
          <button type="button" onClick={startTutorial}>{t('pokemonBnb.tutorial')}</button>
          <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
        </div>
      </header>
      <div className="bnb-shell">
        <p className="eyebrow">{t('games.pokemonBnbMini')}</p>
        <h1>{t('pokemonBnb.title')}</h1>
        <p className="bnb-copy">{t('pokemonBnb.description')}</p>
        <div className="bnb-actions">
          <button className="bnb-primary" type="button" onClick={() => setView('lobby')}>{t('pokemonBnb.start')}</button>
        </div>
      </div>
    </main>
  )
}
