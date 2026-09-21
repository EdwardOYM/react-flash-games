// 04-pokemon-pack-battle — CP2 shell + CP3 lobby flow (mirrors 03 pokemon-bnb).
// Flow: start (server field + create/join) -> host `lobby` (code row + copy,
// name, packs stepper, start battle) / guest `lobbyJoin` (name + code + server)
// that steps into the shared lobby when the host's `hello-ack` lands. The host
// broadcasts `lobby-update` on every packs change and rolls the shared seed in
// `lobby-start`, moving both seats to the opening placeholder (CP4 replaces it
// with the ceremony). Leave returns to start from every lobby view.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPreferredLocale, persistLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig } from '../../config'
import { SettingsModal, type AdditionalKeyBinding } from '../../settings'
import { HighscoreTable } from '../highscore/HighscoreTable'
import { readPackBattleHighscores } from './highscores'
import {
  PACK_BATTLE_PROTOCOL_VERSION,
  clampPackBattleSettings,
  defaultPackBattleSettings,
  type PackBattleMessage,
  type PackBattleSettings,
} from './net/protocol'
import {
  createPackBattleHost,
  joinPackBattleHost,
  parsePackBattleServerAddress,
  type PackBattlePeerStatus,
  type PackBattleSessionBase,
} from './net/peer'
import { randomPackBattleSeed } from './rng'
import { listSets } from './sets'
import { LobbyFields } from './LobbyFields'
import './PokemonPackBattleGame.css'

/**
 * Remappable ceremony keys (settings → controllers → extra bindings, persisted
 * in `AppConfig.settings.keybindings`). Confirm opens/reveals, Skip reveals a
 * whole pack at once (both consumed from CP4 onward). Labels reuse the global
 * `keyNames.*` copy.
 */
const packBattleKeyBindings: AdditionalKeyBinding[] = [
  { id: 'pokemon-pack-confirm', labelKey: 'keyNames.confirm', defaultKey: 'Enter' },
  { id: 'pokemon-pack-skip', labelKey: 'keyNames.skip', defaultKey: 'S' },
]

type View = 'start' | 'tutorial' | 'lobby' | 'lobbyJoin' | 'opening' | 'results' | 'highscore'

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

const SET_ENTRIES = listSets()
const DEFAULT_SET_ID = SET_ENTRIES[0].id

/** Fill {name} style placeholders, matching the bnb game's copy handling. */
function substituteParams(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

/** Peer failures arrive as codes; players see translated copy instead. */
function errorKeyFor(code: string): TranslationKey {
  if (code === 'peer-unavailable') return 'packBattle.errorPeerUnavailable'
  if (code === 'version') return 'packBattle.errorVersion'
  return 'packBattle.errorGeneric'
}

export function PokemonPackBattleGame({ locale, onLocaleChange, onExit, t }: PokemonPackBattleProps) {
  const [activeLocale, setActiveLocale] = useState<Locale>(() => locale ?? getPreferredLocale())
  const fallbackTranslate = useTranslations(activeLocale)
  const translate = t ?? fallbackTranslate

  const [view, setView] = useState<View>('start')
  const [tutorialStep, setTutorialStep] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [musicOn, setMusicOn] = useState(() => readConfig().settings.music)
  const [highscores, setHighscores] = useState(() => readPackBattleHighscores())

  const [role, setRole] = useState<'host' | 'guest' | null>(null)
  const [status, setStatus] = useState<PackBattlePeerStatus>('closed')
  const [settings, setSettings] = useState<PackBattleSettings>(() => defaultPackBattleSettings(DEFAULT_SET_ID))
  const [code, setCode] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [serverInput, setServerInput] = useState('')
  const [serverInvalid, setServerInvalid] = useState(false)
  const [playerName, setPlayerName] = useState('')
  const [opponentName, setOpponentName] = useState('')
  const [notice, setNotice] = useState<TranslationKey | null>(null)
  const [noticeParams, setNoticeParams] = useState<Record<string, string> | null>(null)
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  const [matchSeed, setMatchSeed] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const sessionRef = useRef<PackBattleSessionBase | null>(null)
  const roleRef = useRef<'host' | 'guest' | null>(null)
  const viewRef = useRef<View>('start')
  const settingsRef = useRef<PackBattleSettings>(settings)
  const nameRef = useRef('')
  const opponentNameRef = useRef('')
  const matchSeedRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const noticeTimerRef = useRef<number | null>(null)
  const copyTimerRef = useRef<number | null>(null)
  /** Inbound packets route through this stable ref closure (bnb's pattern). */
  const messageHandlerRef = useRef<(message: PackBattleMessage) => void>(() => undefined)

  const changeLocale = (nextLocale: Locale) => {
    setActiveLocale(nextLocale)
    onLocaleChange?.(nextLocale)
    persistLocale(nextLocale)
  }

  // Mirror of the current view for the stable session callbacks.
  useEffect(() => { viewRef.current = view }, [view])

  const displayName = playerName.trim() || translate('packBattle.defaultName')
  const isHost = role === 'host'

  /**
   * Transient notice that auto-clears, so a disconnect/leave message cannot
   * outlive the moment it describes. `{name}` defaults to the other seat's
   * display name so no call site can render a literal placeholder token.
   */
  const showNotice = (key: TranslationKey, params?: Record<string, string>) => {
    setNotice(key)
    const other = opponentNameRef.current || translate('packBattle.defaultName')
    setNoticeParams({ name: other, ...params })
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
      setNoticeParams(null)
    }, 6000)
  }

  const noticeText = notice === null ? null : substituteParams(translate(notice), noticeParams ?? {})

  const closeSession = useCallback(() => {
    sessionRef.current?.dispose()
    sessionRef.current = null
  }, [])

  /** Inbound data-channel handler; re-assigned fresh every render (ref-sync). */
  const readMessage = (message: PackBattleMessage) => {
    switch (message.kind) {
      case 'hello': {
        // Host side: record the guest, answer with our identity and the current
        // lobby settings, and replay `lobby-start` when a re-dialled guest needs
        // the seeded match back.
        setOpponentName(message.name)
        sessionRef.current?.send({ kind: 'hello-ack', name: nameRef.current, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION })
        sessionRef.current?.send({ kind: 'lobby-update', settings: clampPackBattleSettings(settingsRef.current) })
        if (matchSeedRef.current !== null) {
          sessionRef.current?.send({ kind: 'lobby-start', seed: matchSeedRef.current, settings: clampPackBattleSettings(settingsRef.current) })
        }
        return
      }
      case 'hello-ack': {
        setOpponentName(message.name)
        setNotice(null)
        // The host answered our hello: step into the shared lobby view.
        if (viewRef.current === 'lobbyJoin') setView('lobby')
        return
      }
      case 'lobby-update': {
        // Only the host edits; the guest applies the broadcast settings.
        if (roleRef.current === 'guest') setSettings(clampPackBattleSettings(message.settings))
        return
      }
      case 'lobby-start': {
        if (roleRef.current !== 'guest') return
        setSettings(clampPackBattleSettings(message.settings))
        matchSeedRef.current = message.seed
        setMatchSeed(message.seed)
        setNotice(null)
        setErrorKey(null)
        setView('opening')
        return
      }
      case 'leave': {
        // The other seat chose to leave. The host returns to waiting so a new
        // guest can dial in; the guest tears down and goes back to start.
        if (roleRef.current === 'host') {
          setOpponentName('')
          setStatus('waiting')
          showNotice('packBattle.peerLeft')
          return
        }
        closeSession()
        roleRef.current = null
        setRole(null)
        setStatus('closed')
        showNotice('packBattle.peerLeft')
        setView('start')
        return
      }
      default:
        // pack-open / card-reveal / battle-done / rematch land in CP4+.
        return
    }
  }

  /** Leave the lobby from either seat: notify, tear down, return to start. */
  const leaveLobby = () => {
    closingRef.current = true
    sessionRef.current?.send({ kind: 'leave' })
    closeSession()
    roleRef.current = null
    setRole(null)
    setStatus('closed')
    setCode('')
    setCodeInput('')
    setOpponentName('')
    setNotice(null)
    setErrorKey(null)
    matchSeedRef.current = null
    setMatchSeed(null)
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = null
    }
    setHighscores(readPackBattleHighscores())
    setView('start')
  }

  /** Host a new lobby, or dial the typed code (bnb's shared setup + callbacks). */
  const beginSession = (nextRole: 'host' | 'guest') => {
    const server = parsePackBattleServerAddress(serverInput)
    setServerInvalid(server === null && serverInput.trim().length > 0)
    const normalized = codeInput.trim().toUpperCase().replace(/\s+/g, '')
    if (nextRole === 'guest' && normalized.length < 4) {
      setStatus('error')
      setErrorKey('packBattle.errorPeerUnavailable')
      return
    }

    closeSession()
    closingRef.current = false
    roleRef.current = nextRole
    setRole(nextRole)
    setStatus('connecting')
    setErrorKey(null)
    setNotice(null)
    setOpponentName('')
    matchSeedRef.current = null
    setMatchSeed(null)

    const callbacks = {
      onMessage: (message: PackBattleMessage) => messageHandlerRef.current(message),
      onPeerConnected: () => setStatus('connected'),
      /**
       * The other seat dropped. While still in the lobby the host returns to
       * waiting (a new guest can dial in); the guest tears down and goes back
       * to start. Mid-battle behaviour arrives with the CP4/CP5 views.
       */
      onPeerDisconnected: () => {
        if (closingRef.current) return
        if (roleRef.current === 'guest') {
          closeSession()
          roleRef.current = null
          setRole(null)
          setStatus('closed')
          showNotice('packBattle.opponentDisconnected', { name: opponentNameRef.current || translate('packBattle.defaultName') })
          setView('start')
          return
        }
        setOpponentName('')
        setStatus('waiting')
        showNotice('packBattle.opponentDisconnected', { name: opponentNameRef.current || translate('packBattle.defaultName') })
      },
      // Reading the session's live code keeps the shown code correct when the
      // broker rejects a collision and the host auto-rolls a fresh one.
      onStatus: (next: PackBattlePeerStatus) => {
        setStatus(next)
        if (sessionRef.current) setCode(sessionRef.current.code)
      },
      onError: (failure: string) => setErrorKey(errorKeyFor(failure)),
    }

    if (nextRole === 'host') {
      const session = createPackBattleHost(nameRef.current || displayName, settingsRef.current, callbacks, server)
      sessionRef.current = session
      setCode(session.code)
      setView('lobby')
      return
    }

    const session = joinPackBattleHost(normalized, nameRef.current || displayName, callbacks, server)
    sessionRef.current = session
    setCode(normalized)
    setView('lobbyJoin')
  }

  // Keep the callbacks used by the live data channel pointing at fresh state.
  useEffect(() => {
    settingsRef.current = settings
    nameRef.current = displayName
    opponentNameRef.current = opponentName
    messageHandlerRef.current = readMessage
  })

  // Re-announce our display name when it changes after the channel opens, so
  // the other seat's status line stays correct (reuses the hello handshake).
  useEffect(() => {
    if (status !== 'connected') return
    if (roleRef.current === 'host') {
      sessionRef.current?.send({ kind: 'hello-ack', name: displayName, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION })
    } else if (roleRef.current === 'guest') {
      sessionRef.current?.send({ kind: 'hello', name: displayName, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION })
    }
  }, [displayName, status])

  useEffect(() => () => {
    sessionRef.current?.dispose()
    sessionRef.current = null
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
  }, [])

  /** Host-only: change a lobby setting and push it to the guest. */
  const updateSettings = (patch: Partial<PackBattleSettings>) => {
    const next = clampPackBattleSettings({ ...settingsRef.current, ...patch })
    settingsRef.current = next
    setSettings(next)
    sessionRef.current?.send({ kind: 'lobby-update', settings: next })
  }

  /** Host-only: roll the shared seed and move both seats to the opening. */
  const startMatch = () => {
    if (roleRef.current !== 'host' || status !== 'connected') return
    const seed = randomPackBattleSeed()
    const payload = clampPackBattleSettings(settingsRef.current)
    matchSeedRef.current = seed
    setMatchSeed(seed)
    sessionRef.current?.send({ kind: 'lobby-update', settings: payload })
    sessionRef.current?.send({ kind: 'lobby-start', seed, settings: payload })
    setNotice(null)
    setErrorKey(null)
    setView('opening')
  }

  const copyCode = () => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(code).then(() => {
      setCopied(true)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
    }).catch(() => undefined)
  }

  const startTutorial = () => {
    setTutorialStep(0)
    setView('tutorial')
  }

  /** Tutorial is reachable from start and the lobby; back goes to either. */
  const leaveTutorial = () => setView(roleRef.current ? 'lobby' : 'start')

  const toggleMusic = () => {
    const next = !musicOn
    setMusicOn(next)
    updateConfig((config) => ({ ...config, settings: { ...config.settings, music: next } }))
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
            <button type="button" onClick={leaveTutorial}>
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
              <button className="ppb-primary" type="button" onClick={leaveTutorial}>
                {translate('packBattle.finish')}
              </button>
            )}
          </div>
        </div>
      </main>
    )
  }

  if (view === 'lobbyJoin') {
    const joining = status === 'connecting'
    return (
      <main className="ppb-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.guestRole')}</span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={startTutorial}>{translate('packBattle.tutorial')}</button>
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
            <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
          </div>
        </header>
        <div className="ppb-shell">
          <p className="eyebrow">{translate('packBattle.guestRole')}</p>
          <h1>{translate('packBattle.joinLobby')}</h1>
          <form className="ppb-form" onSubmit={(event) => { event.preventDefault(); beginSession('guest') }}>
            <div className="ppb-field">
              <label className="ppb-field-label" htmlFor="ppb-join-name">{translate('packBattle.displayName')}</label>
              <input
                id="ppb-join-name"
                className="ppb-input"
                type="text"
                value={playerName}
                maxLength={16}
                autoComplete="off"
                placeholder={translate('packBattle.namePlaceholder')}
                onChange={(event) => setPlayerName(event.target.value)}
              />
            </div>
            <div className="ppb-field">
              <label className="ppb-field-label" htmlFor="ppb-join-code">{translate('packBattle.lobbyCode')}</label>
              <input
                id="ppb-join-code"
                className="ppb-input ppb-input-code"
                type="text"
                value={codeInput}
                maxLength={6}
                autoComplete="off"
                spellCheck={false}
                placeholder={translate('packBattle.codePlaceholder')}
                onChange={(event) => setCodeInput(event.target.value.toUpperCase())}
              />
            </div>
            <div className="ppb-field">
              <label className="ppb-field-label" htmlFor="ppb-join-server">{translate('packBattle.optionalServer')}</label>
              <input
                id="ppb-join-server"
                className="ppb-input"
                type="text"
                value={serverInput}
                autoComplete="off"
                spellCheck={false}
                placeholder={translate('packBattle.serverPlaceholder')}
                onChange={(event) => setServerInput(event.target.value)}
              />
              <p className="ppb-hint">{translate('packBattle.serverHint')}</p>
              {serverInvalid && <p className="ppb-hint ppb-hint-warn" role="status">{translate('packBattle.serverInvalid')}</p>}
            </div>
            <div className="ppb-actions">
              <button className="ppb-primary" type="submit" disabled={joining}>
                {joining ? translate('packBattle.statusConnecting') : translate('packBattle.join')}
              </button>
            </div>
          </form>
          {noticeText && <p className="ppb-notice" role="status">{noticeText}</p>}
          {errorKey && <p className="ppb-error" role="alert">{translate(errorKey)}</p>}
        </div>
      </main>
    )
  }

  if (view === 'lobby') {
    const connected = status === 'connected'
    return (
      <main className="ppb-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.lobbyTitle')}</span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={startTutorial}>{translate('packBattle.tutorial')}</button>
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
            <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
          </div>
        </header>
        <div className="ppb-shell ppb-shell-lobby">
          <p className="eyebrow">{isHost ? translate('packBattle.hostRole') : translate('packBattle.guestRole')}</p>
          <h1>{translate('packBattle.lobbyTitle')}</h1>
          <p className="ppb-status" aria-live="polite">
            <span className={`ppb-dot ppb-dot-${status}`} aria-hidden="true" />
            {connected
              ? substituteParams(translate('packBattle.statusConnected'), { name: opponentName || translate('packBattle.defaultName') })
              : translate('packBattle.statusWaiting')}
          </p>
          {isHost && (
            <div className="ppb-code-row">
              <span className="ppb-code-label">{translate('packBattle.lobbyCode')}</span>
              <span className="ppb-code">{code || '······'}</span>
              <button type="button" onClick={copyCode} disabled={!code}>
                {copied ? translate('packBattle.copied') : translate('packBattle.copyCode')}
              </button>
            </div>
          )}
          <div className="ppb-field">
            <label className="ppb-field-label" htmlFor="ppb-lobby-name">{translate('packBattle.displayName')}</label>
            <input
              id="ppb-lobby-name"
              className="ppb-input"
              type="text"
              value={playerName}
              maxLength={16}
              autoComplete="off"
              placeholder={translate('packBattle.namePlaceholder')}
              onChange={(event) => setPlayerName(event.target.value)}
            />
          </div>
          <LobbyFields settings={settings} editable={isHost} idPrefix="ppb-lobby" t={translate} onChange={updateSettings} />
          {!isHost && <p className="ppb-hint">{translate('packBattle.hostOnlyNote')}</p>}
          {noticeText && <p className="ppb-notice" role="status">{noticeText}</p>}
          {errorKey && <p className="ppb-error" role="alert">{translate(errorKey)}</p>}
          <div className="ppb-actions">
            {isHost
              ? <button className="ppb-primary" type="button" disabled={!connected} onClick={startMatch}>{translate('packBattle.startBattle')}</button>
              : <span className="ppb-waiting" aria-live="polite">{translate('packBattle.waitingForHost')}</span>}
          </div>
        </div>
      </main>
    )
  }

  // CP3 opening placeholder: both seats land here from `lobby-start` with the
  // shared seed and locked settings. CP4 replaces this with the ceremony.
  if (view === 'opening') {
    return (
      <main className="ppb-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.openingTitle')}</span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
            <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
          </div>
        </header>
        <div className="ppb-shell">
          <p className="eyebrow">{displayName}</p>
          <h1>{translate('packBattle.openingTitle')}</h1>
          <p className="ppb-copy">{translate('packBattle.comingSoon')}</p>
          <dl className="ppb-summary">
            <div>
              <dt>{translate('packBattle.setLabel')}</dt>
              <dd>{translate(SET_ENTRIES.find((entry) => entry.id === settings.set)?.labelKey ?? 'packBattle.set30c')}</dd>
            </div>
            <div>
              <dt>{translate('packBattle.packsLabel')}</dt>
              <dd>{settings.packs}</dd>
            </div>
          </dl>
          {noticeText && <p className="ppb-notice" role="status">{noticeText}</p>}
          {errorKey && <p className="ppb-error" role="alert">{translate(errorKey)}</p>}
          <p className="ppb-hint">{matchSeed === null ? '' : substituteParams(translate('packBattle.seedShared'), { seed: String(matchSeed) })}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="ppb-page">
      <header className="ppb-topbar">
        <span className="ppb-hud-label">{translate('packBattle.title')}</span>
        <div className="ppb-topbar-actions">
          <button type="button" onClick={startTutorial}>{translate('packBattle.tutorial')}</button>
          <button type="button" aria-label={translate('openSettings')} onClick={() => setSettingsOpen(true)}>⚙</button>
          <button type="button" onClick={toggleMusic} aria-pressed={musicOn}>
            {translate(musicOn ? 'musicOff' : 'musicOn')}
          </button>
          <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
        </div>
      </header>
      <div className="ppb-shell">
        <p className="eyebrow">{translate('games.pokemonPackBattle')}</p>
        <h1>{translate('packBattle.title')}</h1>
        <p className="ppb-copy">{translate('packBattle.description')}</p>
        <div className="ppb-field">
          <label className="ppb-field-label" htmlFor="ppb-start-server">{translate('packBattle.optionalServer')}</label>
          <input
            id="ppb-start-server"
            className="ppb-input"
            type="text"
            value={serverInput}
            autoComplete="off"
            spellCheck={false}
            placeholder={translate('packBattle.serverPlaceholder')}
            onChange={(event) => setServerInput(event.target.value)}
          />
          <p className="ppb-hint">{translate('packBattle.serverHint')}</p>
          {serverInvalid && <p className="ppb-hint ppb-hint-warn" role="status">{translate('packBattle.serverInvalid')}</p>}
        </div>
        <div className="ppb-actions">
          <button className="ppb-primary" type="button" onClick={() => beginSession('host')}>{translate('packBattle.createLobby')}</button>
          <button type="button" onClick={() => { setErrorKey(null); setNotice(null); setView('lobbyJoin') }}>{translate('packBattle.joinLobby')}</button>
        </div>
        {noticeText && <p className="ppb-notice" role="status">{noticeText}</p>}
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







