import en from './en.json'
import ms from './ms.json'
import zh from './zh.json'
import { readConfig, updateConfig } from '../../config'

export type Locale = 'en' | 'ms' | 'zh'
type TranslationDictionary = typeof en
export type TranslationKey =
  | 'brand'
  | 'status'
  | 'eyebrow'
  | 'headlineStart'
  | 'headlineEmphasis'
  | 'description'
  | 'previewLabel'
  | 'previewAlt'
  | 'openSettings'
  | 'settingsTitle'
  | 'closeSettings'
  | 'volume'
  | 'language'
  | 'keybinds'
  | 'mobileControls'
  | 'remapController'
  | 'saveController'
  | 'exitController'
  | 'remap'
  | 'pressKey'
  | 'resetKey'
  | 'credits'
  | 'creditsTitle'
  | 'creditsEyebrow'
  | 'creditsDescription'
  | 'backToHome'
  | 'developer'
  | 'developerName'
  | 'technology'
  | 'gameInspiredBy'
  | 'technologyNames.react'
  | 'technologyNames.three'
  | 'technologyNames.vite'
  | 'technologyNames.typescript'
  | 'technologyNames.oxlint'
  | 'gameInspiration.orbit'
  | 'gameInspiration.signal'
  | 'gameInspiration.memory'
  | 'languageNames.en'
  | 'languageNames.ms'
  | 'languageNames.zh'
  | 'keyNames.primary'
  | 'gameStatus.ready'
  | 'gameStatus.comingSoon'
  | 'games.orbit'
  | 'games.signal'
  | 'games.memory'
  | 'games.bubbleTrouble'
  | 'keyNames.moveLeft'
  | 'keyNames.moveRight'
  | 'keyNames.shoot'
  | 'gameInspiration.bubbleTrouble'
  | `bubble.${BubbleTranslationKey}`
type BubbleTranslationKey =
  | 'title'
  | 'description'
  | 'startGame'
  | 'tutorial'
  | 'tutorialTitle'
  | 'tutorialOne'
  | 'tutorialTwo'
  | 'tutorialThree'
  | 'previous'
  | 'next'
  | 'finish'
  | 'settings'
  | 'musicOn'
  | 'musicOff'
  | 'exit'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'pause'
  | 'resume'
  | 'gameOver'
  | 'victory'
  | 'highscore'
  | 'score'
  | 'rank'
  | 'noScores'
  | 'health'
  | 'gameBoardLabel'
  | 'mobileLeft'
  | 'mobileRight'
  | 'mobileShoot'
  | 'playerName'
  | 'defaultPlayerName'
  | 'namePlaceholder'
  | 'submitScore'
  | 'scoreSaved'
  | 'retry'
  | 'backToStart'
  | 'points'
  | 'inspiredBy'

const dictionaries: Record<Locale, TranslationDictionary> = { en, ms, zh }

function readTranslation(dictionary: TranslationDictionary, key: TranslationKey): string {
  const [group, value] = key.split('.')
  if (value) {
    return dictionary[group as 'gameStatus' | 'games' | 'languageNames' | 'keyNames' | 'gameInspiration' | 'bubble'][value as never]
  }
  return dictionary[key as keyof TranslationDictionary] as string
}

export function getPreferredLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const savedLocale = readConfig().settings.locale
  if (savedLocale === 'en' || savedLocale === 'ms' || savedLocale === 'zh') return savedLocale
  const language = navigator.language.toLowerCase()
  if (language.startsWith('ms')) return 'ms'
  if (language.startsWith('zh')) return 'zh'
  return 'en'
}

export function useTranslations(locale: Locale): (key: TranslationKey) => string {
  const dictionary = dictionaries[locale]
  return (key) => readTranslation(dictionary, key)
}

export function persistLocale(locale: Locale) {
  updateConfig((config) => ({ ...config, settings: { ...config.settings, locale } }))
}
