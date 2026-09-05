import en from './en.json'
import ms from './ms.json'
import zh from './zh.json'

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
  | 'remap'
  | 'pressKey'
  | 'resetKey'
  | 'languageNames.en'
  | 'languageNames.ms'
  | 'languageNames.zh'
  | 'keyNames.primary'
  | 'gameStatus.ready'
  | 'gameStatus.comingSoon'
  | 'games.orbit'
  | 'games.signal'
  | 'games.memory'

const dictionaries: Record<Locale, TranslationDictionary> = { en, ms, zh }

function readTranslation(dictionary: TranslationDictionary, key: TranslationKey): string {
  const [group, value] = key.split('.')
  if (value) {
    return dictionary[group as 'gameStatus' | 'games' | 'languageNames' | 'keyNames'][value as never]
  }
  return dictionary[key as keyof TranslationDictionary] as string
}

export function getPreferredLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const savedLocale = localStorage.getItem('flash-games-locale')
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
