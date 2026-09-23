import defaultConfigJson from './default.config.json'

export type ConfigLocale = 'en' | 'ms' | 'zh'
export type ConfigHighscore = { name: string; score: number }
export type MobileControlPosition = { x: number; y: number; scale: number }
export type AppConfig = {
  version: number
  settings: {
    music: boolean
    musicVolume: number
    sfx: boolean
    sfxVolume: number
    muted: boolean
    locale: ConfigLocale
    primaryKey: string
    keybindings: Record<string, string>
    mobileControls: { movement: MobileControlPosition; shoot: MobileControlPosition }
  }
  highscores: Record<string, ConfigHighscore[]>
  openedCards: Record<string, string[]>
}

const STORAGE_KEY = 'flash-games.config'
const defaultConfig: AppConfig = {
  version: defaultConfigJson.version,
  settings: { ...defaultConfigJson.settings, locale: defaultConfigJson.settings.locale as ConfigLocale, keybindings: { ...defaultConfigJson.settings.keybindings } },
  highscores: defaultConfigJson.highscores as Record<string, ConfigHighscore[]>,
  openedCards: defaultConfigJson.openedCards as Record<string, string[]>,
}

function mergeConfig(value: Partial<AppConfig>): AppConfig {
  const defaults = defaultConfig.settings.mobileControls
  const storedControls = value.settings?.mobileControls
  // Legacy stored configs may still carry the old single `volume` setting.
  const { volume: legacyVolume, ...storedSettings } = (value.settings ?? {}) as Partial<AppConfig['settings']> & { volume?: number }
  const fallbackVolume = typeof legacyVolume === 'number' ? legacyVolume : defaultConfig.settings.musicVolume
  return {
    ...defaultConfig,
    ...value,
    settings: {
      ...defaultConfig.settings,
      ...storedSettings,
      musicVolume: value.settings?.musicVolume ?? fallbackVolume,
      sfxVolume: value.settings?.sfxVolume ?? fallbackVolume,
      keybindings: { ...defaultConfig.settings.keybindings, ...value.settings?.keybindings },
      mobileControls: {
        movement: { ...defaults.movement, ...(storedControls?.movement ?? {}) },
        shoot: { ...defaults.shoot, ...(storedControls?.shoot ?? {}) },
      },
    },
    highscores: { ...defaultConfig.highscores, ...value.highscores },
    openedCards: { ...defaultConfig.openedCards, ...value.openedCards },
  }
}

export function readConfig(): AppConfig {
  if (typeof localStorage === 'undefined') return defaultConfig
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return defaultConfig
  try {
    return mergeConfig(JSON.parse(stored) as Partial<AppConfig>)
  } catch {
    return defaultConfig
  }
}

export function writeConfig(config: AppConfig) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(config, null, 2))
}

export function updateConfig(update: (config: AppConfig) => AppConfig) {
  const nextConfig = update(readConfig())
  writeConfig(nextConfig)
  configListeners.forEach((listener) => listener(nextConfig))
  return nextConfig
}

type ConfigListener = (config: AppConfig) => void
const configListeners = new Set<ConfigListener>()

/** Subscribe to config changes made through `updateConfig`. Returns an unsubscribe function. */
export function subscribeConfig(listener: ConfigListener) {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}
