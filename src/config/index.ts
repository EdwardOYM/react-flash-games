import defaultConfigJson from './default.config.json'

export type ConfigLocale = 'en' | 'ms' | 'zh'
export type ConfigHighscore = { name: string; score: number }
export type AppConfig = {
  version: number
  settings: {
    volume: number
    locale: ConfigLocale
    music: boolean
    primaryKey: string
    keybindings: Record<string, string>
  }
  highscores: Record<string, ConfigHighscore[]>
}

const STORAGE_KEY = 'flash-games.config'
const defaultConfig: AppConfig = {
  version: defaultConfigJson.version,
  settings: { ...defaultConfigJson.settings, locale: defaultConfigJson.settings.locale as ConfigLocale, keybindings: { ...defaultConfigJson.settings.keybindings } },
  highscores: defaultConfigJson.highscores as Record<string, ConfigHighscore[]>,
}

function mergeConfig(value: Partial<AppConfig>): AppConfig {
  return {
    ...defaultConfig,
    ...value,
    settings: { ...defaultConfig.settings, ...value.settings, keybindings: { ...defaultConfig.settings.keybindings, ...value.settings?.keybindings } },
    highscores: { ...defaultConfig.highscores, ...value.highscores },
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
  return nextConfig
}
