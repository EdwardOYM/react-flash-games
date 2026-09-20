// 04-pokemon-pack-battle — CP2 shell header (imports, bindings, view state).
import { useState } from 'react'
import { getPreferredLocale, persistLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig } from '../../config'
import { SettingsModal, type AdditionalKeyBinding } from '../../settings'
import { HighscoreTable } from '../highscore/HighscoreTable'
import { readPackBattleHighscores } from './highscores'
import './PokemonPackBattleGame.css'

const packBattleKeyBindings: AdditionalKeyBinding[] = [
  { id: 'pokemon-pack-confirm', labelKey: 'keyNames.confirm', defaultKey: 'Enter' },
  { id: 'pokemon-pack-skip', labelKey: 'keyNames.skip', defaultKey: 'S' },
]

type View = 'start' | 'tutorial' | 'lobby'

type PokemonPackBattleProps = {
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  onExit: () => void
  t?: ReturnType<typeof useTranslations>
}

const TUTORIAL_STEPS: TranslationKey[] = [
  'packBattle.tutorialLobby',
  'packBattle.tutorialOpen',
  'packBattle.tutorialScore',
]

export function PokemonPackBattleGame({ locale, onLocaleChange, onExit, t }: PokemonPackBattleProps) {
  const [activeLocale, setActiveLocale] = useState<Locale>(() => locale ?? getPreferredLocale())
  const fallbackTranslate = useTranslations(activeLocale)
  const translate = t ?? fallbackTranslate
  const [view, setView] = useState<View>('start')
  const [tutorialStep, setTutorialStep] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [musicOn, setMusicOn] = useState(() => readConfig().settings.music)
  const [highscores, setHighscores] = useState(() => readPackBattleHighscores())

  const changeLocale = (nextLocale: Locale) => {
    setActiveLocale(nextLocale)
    onLocaleChange?.(nextLocale)
    persistLocale(nextLocale)
  }

  const startTutorial = () => {
    setTutorialStep(0)
    setView('tutorial')
  }

  const toggleMusic = () => {
    const next = !musicOn
    setMusicOn(next)
    updateConfig((config) => ({ ...config, settings: { ...config.settings, music: next } }))
  }

  const openLobby = () => {
    setHighscores(readPackBattleHighscores())
    setView('lobby')
  }

  const gameSettings = settingsOpen && (
    <SettingsModal
      locale={activeLocale}
      onClose={() => setSettingsOpen(false)}
      onLocaleChange={changeLocale}
      t={translate}
      additionalBindings={packBattleKeyBindings}
    />
  )

  if (view === 'tutorial') {
    const step = TUTORIAL_STEPS[Math.min(tutorialStep, TUTORIAL_STEPS.length - 1)]
    const done = tutorialStep >= TUTORIAL_STEPS.length
    return (
      <main className="ppb-page ppb-tutorial-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">
            {translate('packBattle.tutorialTitle')}: {done ? TUTORIAL_STEPS.length : tutorialStep + 1} / {TUTORIAL_STEPS.length}
          </span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={() => setView('start')}>
              {translate('packBattle.tutorialSkip')}
            </button>
          </div>
        </header>
        <div className="ppb-shell ppb-tutorial-card" aria-live="polite" aria-label={translate('packBattle.tutorialTitle')}>
          <div className="ppb-tutorial-steps" aria-hidden="true">
            {TUTORIAL_STEPS.map((entry, index) => (
              <span key={entry} className={index < (done ? TUTORIAL_STEPS.length : tutorialStep + 1) ? 'ppb-tutorial-step-done' : ''} />
            ))}
          </div>
          <p className="ppb-copy">{translate(done ? 'packBattle.tutorialComplete' : step)}</p>
          <div className="ppb-actions">
            <button type="button" disabled={tutorialStep <= 0} onClick={() => setTutorialStep((current) => Math.max(0, current - 1))}>
              {translate('packBattle.previous')}
            </button>
            {!done && tutorialStep < TUTORIAL_STEPS.length - 1 && (
              <button type="button" onClick={() => setTutorialStep((current) => Math.min(TUTORIAL_STEPS.length - 1, current + 1))}>
                {translate('packBattle.next')}
              </button>
            )}
            {!done && tutorialStep === TUTORIAL_STEPS.length - 1 && (
              <button className="ppb-primary" type="button" onClick={() => setTutorialStep(TUTORIAL_STEPS.length)}>
                {translate('packBattle.finish')}
              </button>
            )}
            {done && (
              <button className="ppb-primary" type="button" onClick={() => setView('start')}>
                {translate('packBattle.finish')}
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }

  if (view === 'lobby') {
    return (
      <main className="ppb-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.title')}</span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={() => setView('start')}>
              {translate('packBattle.back')}
            </button>
            <button type="button" onClick={onExit}>
              {translate('packBattle.exit')}
            </button>
          </div>
        </header>
        <div className="ppb-shell">
          <p className="eyebrow">{translate('games.pokemonPackBattle')}</p>
          <h1>{translate('packBattle.title')}</h1>
          <p className="ppb-copy">{translate('packBattle.comingSoon')}</p>
          <div className="ppb-actions">
            <button type="button" onClick={() => setView('start')}>
              {translate('packBattle.back')}
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="ppb-page">
      <header className="ppb-topbar">
        <span className="ppb-hud-label">{translate('packBattle.title')}</span>
        <div className="ppb-topbar-actions">
          <button type="button" onClick={startTutorial}>
            {translate('packBattle.tutorial')}
          </button>
          <button type="button" aria-label={translate('openSettings')} onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
          <button type="button" onClick={toggleMusic} aria-pressed={musicOn}>
            {translate(musicOn ? 'musicOff' : 'musicOn')}
          </button>
          <button type="button" onClick={onExit}>
            {translate('packBattle.exit')}
          </button>
        </div>
      </header>
      <div className="ppb-shell">
        <p className="eyebrow">{translate('games.pokemonPackBattle')}</p>
        <h1>{translate('packBattle.title')}</h1>
        <p className="ppb-copy">{translate('packBattle.description')}</p>
        <div className="ppb-actions">
          <button className="ppb-primary" type="button" onClick={openLobby}>
            {translate('packBattle.start')}
          </button>
          <button type="button" onClick={startTutorial}>
            {translate('packBattle.tutorial')}
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            {translate('settings')}
          </button>
        </div>
        <p className="ppb-copy ppb-inspired">{translate('packBattle.inspiredBy')}</p>
        <section className="ppb-highscores">
          <p className="eyebrow">{translate('packBattle.highscore')}</p>
          <HighscoreTable
            entries={highscores}
            labels={{
              rank: translate('packBattle.rank'),
              playerName: translate('packBattle.player'),
              score: translate('packBattle.wins'),
              noScores: translate('packBattle.noScores'),
            }}
          />
        </section>
      </div>
      {gameSettings}
    </main>
  )
}
