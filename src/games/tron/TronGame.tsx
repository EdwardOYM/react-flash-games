import { useState } from 'react'
import { getPreferredLocale, type Locale, useTranslations } from '../../assets/languages'
import { readConfig } from '../../config'
import { useInputMode } from '../../settings'
import './TronGame.css'

type TronProps = { locale?: Locale; onLocaleChange?: (locale: Locale) => void; onExit: () => void; t?: ReturnType<typeof useTranslations> }

function readKey(id: string) {
  const defaults: Record<string, string> = {
    'tron-p1-up': 'w',
    'tron-p1-down': 's',
    'tron-p1-left': 'a',
    'tron-p1-right': 'd',
    'tron-p2-up': 'ArrowUp',
    'tron-p2-down': 'ArrowDown',
    'tron-p2-left': 'ArrowLeft',
    'tron-p2-right': 'ArrowRight',
  }
  return readConfig().settings.keybindings[id] ?? defaults[id] ?? ''
}

export function TronGame({ locale: providedLocale, onExit, t: providedTranslations }: TronProps) {
  const [locale] = useState<Locale>(providedLocale ?? getPreferredLocale())
  const translations = useTranslations(locale)
  const t = providedTranslations ?? translations
  const inputMode = useInputMode()

  // Skeleton step: the menu is rendered through t(); players navigate with the
  // Exit button. Gameplay (Step 5), match setup (Step 6), mobile remap (Step 7),
  // tutorial (Step 8), and settings wiring (Step 10) land in later steps.
  const startMatch = () => {}
  const startTutorial = () => {}
  const openControls = () => {}
  const openSettings = () => {}

  return (
    <main className="tron-page">
      <div className="tron-shell">
        <p className="eyebrow">{t('tron.title')}</p>
        <h1>{t('tron.title')}</h1>
        <p className="tron-description">{t('tron.description')}</p>
        {inputMode === 'keyboard' && (
          <div className="tron-keybinds" aria-label={t('keybinds')}>
            <span className="tron-keybind">
              <span className="tron-keybind-label">{t('keyNames.p1Left')} / {t('keyNames.p1Up')} / {t('keyNames.p1Down')} / {t('keyNames.p1Right')}</span>
              <kbd>{readKey('tron-p1-left')}</kbd><span aria-hidden="true">+</span><kbd>{readKey('tron-p1-up')}</kbd><span aria-hidden="true">+</span><kbd>{readKey('tron-p1-down')}</kbd><span aria-hidden="true">+</span><kbd>{readKey('tron-p1-right')}</kbd>
            </span>
            <span className="tron-keybind">
              <span className="tron-keybind-label">{t('keyNames.p2Left')} / {t('keyNames.p2Up')} / {t('keyNames.p2Down')} / {t('keyNames.p2Right')}</span>
              <kbd>{readKey('tron-p2-left')}</kbd><span aria-hidden="true">+</span><kbd>{readKey('tron-p2-up')}</kbd><span aria-hidden="true">+</span><kbd>{readKey('tron-p2-down')}</kbd><span aria-hidden="true">+</span><kbd>{readKey('tron-p2-right')}</kbd>
            </span>
          </div>
        )}
        <div className="tron-menu">
          <button className="tron-primary" type="button" onClick={startMatch}>{t('tron.startMatch')}</button>
          <button type="button" onClick={startTutorial}>{t('tron.tutorial')}</button>
          <button type="button" onClick={openControls}>{t('tron.controls')}</button>
          <button type="button" onClick={openSettings}>{t('tron.settings')}</button>
          <button type="button" onClick={onExit}>{t('tron.exit')}</button>
        </div>
      </div>
    </main>
  )
}