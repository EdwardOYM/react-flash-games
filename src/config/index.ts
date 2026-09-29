import defaultConfigJson from './default.config.json'

export type ConfigLocale = 'en' | 'ms' | 'zh'
export type ConfigHighscore = { name: string; score: number }
export type MobileControlPosition = { x: number; y: number; scale: number }
/**
 * 04.11 CP20: the lobby this device is currently sitting in, so a page reload rejoins
 * instead of dumping the player back on the start view. `role` picks which of the two
 * `net/peer` constructors the restore uses; `code` is the shared short code the guest
 * dials and the host RE-REGISTERS (reusing the old id — otherwise the guest's saved code
 * is orphaned and the two seats never meet). `null` means "not in a lobby", which is the
 * default and the only value a fresh install or a deliberate leave ever stores.
 */
export type ConfigLobby = { role: 'host' | 'guest'; code: string; name: string; server: string | null } | null
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
  lobby: ConfigLobby
}

const STORAGE_KEY = 'flash-games.config'
const defaultConfig: AppConfig = {
  version: defaultConfigJson.version,
  settings: { ...defaultConfigJson.settings, locale: defaultConfigJson.settings.locale as ConfigLocale, keybindings: { ...defaultConfigJson.settings.keybindings } },
  highscores: defaultConfigJson.highscores as Record<string, ConfigHighscore[]>,
  openedCards: defaultConfigJson.openedCards as Record<string, string[]>,
  lobby: null,
}

/**
 * 04.11 CP20. localStorage is user-writable and survives across app versions, so a stored
 * lobby is untrusted input: a hand-edited or half-written value must degrade to "not in a
 * lobby" rather than reach `net/peer` and dial a nonsense code. Every field is checked,
 * not just the role — a `code` of `''` would restore a broken session that looks live.
 */
function normalizeLobby(value: unknown): ConfigLobby {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ConfigLobby> & { server?: unknown }
  if (candidate.role !== 'host' && candidate.role !== 'guest') return null
  if (typeof candidate.code !== 'string' || candidate.code.trim() === '') return null
  return {
    role: candidate.role,
    code: candidate.code,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    server: typeof candidate.server === 'string' && candidate.server !== '' ? candidate.server : null,
  }
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
    // Explicit rather than relying on the `...value` spread above, so a malformed
    // stored lobby cannot pass through unchecked.
    lobby: normalizeLobby(value.lobby),
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
