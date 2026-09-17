// Pokemon TCG B&B mini — peer-to-peer Build & Battle limited format.
// CP4: lobby flow. The host owns the lobby settings, broadcasts them on every
// change, and starts the match by sending the shared pack-opening seed. Guests
// join by short code through the free PeerJS Cloud, or both players can point
// at a self-hosted peerjs-server for local-wifi play. Pack opening, deck
// building, and the battle land in later checkpoints.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPreferredLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { SettingsModal } from '../../settings'
import type { SetId } from './cards'
import { LOBBY_LIMITS, PROTOCOL_VERSION, clampLobbySettings, defaultLobbySettings, type LobbySettings, type NetMessage } from './net/protocol'
import { createHost, joinHost, parseServerAddress, type PeerStatus, type SessionBase } from './net/peer'
import { randomSeed } from './rng'
import { listSets } from './sets'
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

/** Set display names are copy, so each set id maps to one translation key. */
const SET_LABEL_KEYS: Record<string, TranslationKey> = { '30c': 'pokemonBnb.set30c' }
const SET_ENTRIES = listSets()
const DEFAULT_SET_ID = SET_ENTRIES[0].id as SetId

function setLabel(setId: string, t: (key: TranslationKey) => string): string {
  const key = SET_LABEL_KEYS[setId] as TranslationKey | undefined
  return key ? t(key) : setId
}

/** Fill {name} style placeholders, matching the Tron game's copy handling. */
function substituteParams(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

/** Peer failures arrive as codes; players see translated copy instead. */
function errorKeyFor(code: string): TranslationKey {
  if (code === 'peer-unavailable') return 'pokemonBnb.errorPeerUnavailable'
  if (code === 'protocol-mismatch') return 'pokemonBnb.errorProtocolMismatch'
  return 'pokemonBnb.errorConnection'
}

type LobbyFieldsProps = {
  settings: LobbySettings
  /** Only the host edits; guests see the same fields read-only. */
  editable: boolean
  idPrefix: string
  t: (key: TranslationKey) => string
  onChange?: (patch: Partial<LobbySettings>) => void
}

/** Set / packs / prize cards / turn timer — shared by host and guest views. */
function LobbyFields({ settings, editable, idPrefix, t, onChange }: LobbyFieldsProps) {
  const ids = { set: `${idPrefix}-set`, packs: `${idPrefix}-packs`, prizes: `${idPrefix}-prizes`, timer: `${idPrefix}-timer` }
  const patch = (next: Partial<LobbySettings>) => onChange?.(next)
  const timerText = (seconds: number) => (seconds === 0
    ? t('pokemonBnb.timerOff')
    : substituteParams(t('pokemonBnb.timerSeconds'), { count: String(seconds) }))

  return (
    <div className="bnb-fields">
      <div className="bnb-field">
        <span className="bnb-field-label" id={ids.set}>{t('pokemonBnb.setLabel')}</span>
        {editable
          ? <div className="bnb-segmented" role="group" aria-labelledby={ids.set}>{SET_ENTRIES.map((entry) => <button key={entry.id} type="button" aria-pressed={settings.set === entry.id} onClick={() => patch({ set: entry.id })}>{setLabel(entry.id, t)}</button>)}</div>
          : <span className="bnb-field-value">{setLabel(settings.set, t)}</span>}
      </div>
      <div className="bnb-field">
        <span className="bnb-field-label" id={ids.packs}>{t('pokemonBnb.packsLabel')}</span>
        {editable
          ? <div className="bnb-stepper" role="group" aria-labelledby={ids.packs}><button type="button" aria-label={t('pokemonBnb.decrease')} disabled={settings.packs <= LOBBY_LIMITS.minPacks} onClick={() => patch({ packs: settings.packs - 1 })}>−</button><span className="bnb-stepper-value" aria-live="polite">{settings.packs}</span><button type="button" aria-label={t('pokemonBnb.increase')} disabled={settings.packs >= LOBBY_LIMITS.maxPacks} onClick={() => patch({ packs: settings.packs + 1 })}>+</button></div>
          : <span className="bnb-field-value">{settings.packs}</span>}
      </div>
      <div className="bnb-field">
        <span className="bnb-field-label" id={ids.prizes}>{t('pokemonBnb.prizeCardsLabel')}</span>
        {editable
          ? <div className="bnb-stepper" role="group" aria-labelledby={ids.prizes}><button type="button" aria-label={t('pokemonBnb.decrease')} disabled={settings.prizeCards <= LOBBY_LIMITS.minPrizeCards} onClick={() => patch({ prizeCards: settings.prizeCards - 1 })}>−</button><span className="bnb-stepper-value" aria-live="polite">{settings.prizeCards}</span><button type="button" aria-label={t('pokemonBnb.increase')} disabled={settings.prizeCards >= LOBBY_LIMITS.maxPrizeCards} onClick={() => patch({ prizeCards: settings.prizeCards + 1 })}>+</button></div>
          : <span className="bnb-field-value">{settings.prizeCards}</span>}
      </div>
      <div className="bnb-field">
        <span className="bnb-field-label" id={ids.timer}>{t('pokemonBnb.timerLabel')}</span>
        {editable
          ? <div className="bnb-segmented" role="group" aria-labelledby={ids.timer}>{LOBBY_LIMITS.timerChoices.map((seconds) => <button key={seconds} type="button" aria-pressed={settings.timerSeconds === seconds} onClick={() => patch({ timerSeconds: seconds })}>{timerText(seconds)}</button>)}</div>
          : <span className="bnb-field-value">{timerText(settings.timerSeconds)}</span>}
      </div>
    </div>
  )
}

type Role = 'host' | 'guest'

export function PokemonBnbGame({ locale: providedLocale, onLocaleChange, onExit, t: providedTranslations }: PokemonBnbProps) {
  const locale = providedLocale ?? getPreferredLocale()
  const translations = useTranslations(locale)
  const t = providedTranslations ?? translations

  const [view, setView] = useState<View>('start')
  const [tutorialStep, setTutorialStep] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const changeLocale = onLocaleChange ?? (() => undefined)

  const [role, setRole] = useState<Role | null>(null)
  const [status, setStatus] = useState<PeerStatus>('closed')
  const [settings, setSettings] = useState<LobbySettings>(() => defaultLobbySettings(DEFAULT_SET_ID as SetId))
  const [code, setCode] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [serverInput, setServerInput] = useState('')
  const [serverInvalid, setServerInvalid] = useState(false)
  const [playerName, setPlayerName] = useState('')
  const [opponentName, setOpponentName] = useState('')
  const [notice, setNotice] = useState<TranslationKey | null>(null)
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  const [matchSeed, setMatchSeed] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const sessionRef = useRef<SessionBase | null>(null)
  const roleRef = useRef<Role | null>(null)
  const settingsRef = useRef<LobbySettings>(settings)
  const nameRef = useRef('')
  const closingRef = useRef(false)
  const copyTimerRef = useRef<number | null>(null)
  const messageHandlerRef = useRef<(message: NetMessage) => void>(() => undefined)

  const displayName = playerName.trim() || t('pokemonBnb.defaultName')
  const isHost = role === 'host'

  const tutorialSteps: { goal: string; copyKey: TranslationKey }[] = [
    { goal: 'pack', copyKey: 'pokemonBnb.tutorialPack' },
    { goal: 'deck', copyKey: 'pokemonBnb.tutorialDeck' },
    { goal: 'battle', copyKey: 'pokemonBnb.tutorialBattle' },
  ]

  const startTutorial = () => { setTutorialStep(0); setView('tutorial') }
  const leaveTutorial = () => setView(role ? 'lobby' : 'start')
  const advanceTutorial = () => { if (tutorialStep < tutorialSteps.length - 1) setTutorialStep(tutorialStep + 1); else leaveTutorial() }

  const closeSession = useCallback(() => {
    sessionRef.current?.dispose()
    sessionRef.current = null
  }, [])

  const readMessage = (message: NetMessage) => {
    switch (message.kind) {
      case 'hello': {
        setOpponentName(message.name)
        setNotice(null)
        // The host answers with its identity and the current lobby settings.
        sessionRef.current?.send({ kind: 'hello-ack', name: nameRef.current, protocolVersion: PROTOCOL_VERSION })
        sessionRef.current?.send({ kind: 'lobby-update', settings: clampLobbySettings(settingsRef.current) })
        return
      }
      case 'hello-ack': {
        setOpponentName(message.name)
        setNotice(null)
        return
      }
      case 'lobby-update': {
        if (roleRef.current === 'guest') setSettings(clampLobbySettings(message.settings))
        return
      }
      case 'lobby-start': {
        if (roleRef.current !== 'guest') return
        setSettings(clampLobbySettings(message.settings))
        setMatchSeed(message.seed)
        setNotice(null)
        setErrorKey(null)
        setView('opening')
        return
      }
      case 'leave': {
        if (roleRef.current === 'host') {
          setOpponentName('')
          setStatus('waiting')
          setNotice('pokemonBnb.peerLeft')
          return
        }
        closeSession()
        roleRef.current = null
        setRole(null)
        setStatus('closed')
        setNotice('pokemonBnb.peerLeft')
        setView('start')
        return
      }
      default:
        // Pack-opening, deck, and battle payloads land in later checkpoints.
        return
    }
  }

  // Keep the callbacks used by the live data channel pointing at fresh state.
  useEffect(() => {
    settingsRef.current = settings
    nameRef.current = displayName
    messageHandlerRef.current = readMessage
  })

  // Re-announce our display name when it changes after the channel opens, so
  // the other seat's status line stays correct. Reuses the hello handshake;
  // no protocol change needed.
  useEffect(() => {
    if (status !== 'connected') return
    if (roleRef.current === 'host') {
      sessionRef.current?.send({ kind: 'hello-ack', name: displayName, protocolVersion: PROTOCOL_VERSION })
    } else if (roleRef.current === 'guest') {
      sessionRef.current?.send({ kind: 'hello', name: displayName, protocolVersion: PROTOCOL_VERSION })
    }
  }, [displayName, status])

  useEffect(() => () => {
    sessionRef.current?.dispose()
    sessionRef.current = null
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
  }, [])

  /** Host a new lobby, or dial the typed code. Shared setup + callbacks. */
  const beginSession = (nextRole: Role) => {
    const server = parseServerAddress(serverInput)
    setServerInvalid(server === null && serverInput.trim().length > 0)
    const normalized = codeInput.trim().toUpperCase().replace(/\s+/g, '')
    if (nextRole === 'guest' && normalized.length < 4) {
      setStatus('error')
      setErrorKey('pokemonBnb.errorPeerUnavailable')
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
    setMatchSeed(null)
    setCopied(false)

    const callbacks = {
      onMessage: (message: NetMessage) => messageHandlerRef.current(message),
      // A guest steps into the shared lobby view the moment the channel opens.
      onPeerConnected: () => {
        setStatus('connected')
        if (roleRef.current === 'guest') setView('lobby')
      },
      onPeerDisconnected: () => {
        if (closingRef.current) return
        if (roleRef.current === 'guest') {
          closeSession()
          roleRef.current = null
          setRole(null)
          setStatus('closed')
          setNotice('pokemonBnb.peerLeft')
          setView('start')
          return
        }
        setOpponentName('')
        setStatus('waiting')
        setNotice('pokemonBnb.peerLeft')
      },
      // Reading the session's live code keeps the shown code correct when the
      // broker rejects a collision and the host auto-rolls a fresh one.
      onStatus: (next: PeerStatus) => {
        setStatus(next)
        if (sessionRef.current) setCode(sessionRef.current.code)
      },
      onError: (failure: string) => setErrorKey(errorKeyFor(failure)),
    }

    if (nextRole === 'host') {
      const session = createHost(callbacks, server)
      sessionRef.current = session
      setCode(session.code)
      setView('lobby')
      return
    }

    const session = joinHost(normalized, nameRef.current || displayName, callbacks, server)
    sessionRef.current = session
    setCode(normalized)
    setView('lobbyJoin')
  }

  /** Host-only: change a lobby setting and push it to the guest. */
  const updateSettings = (patch: Partial<LobbySettings>) => {
    const next = clampLobbySettings({ ...settingsRef.current, ...patch })
    settingsRef.current = next
    setSettings(next)
    sessionRef.current?.send({ kind: 'lobby-update', settings: next })
  }

  /** Host-only: roll the shared pack seed and send both players to opening. */
  const startPackOpening = () => {
    const seed = randomSeed()
    const payload = clampLobbySettings(settingsRef.current)
    setMatchSeed(seed)
    sessionRef.current?.send({ kind: 'lobby-start', seed, settings: payload })
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
    setMatchSeed(null)
    setView('start')
  }

  if (view === 'tutorial') {
    const step = tutorialSteps[tutorialStep]
    return (
      <main className="bnb-page">
        <div className="bnb-shell">
          <p className="eyebrow">{t('pokemonBnb.tutorialTitle')}</p>
          <h1>{t('pokemonBnb.tutorialTitle')}</h1>
          <p className="bnb-copy">{t(step.copyKey)}</p>
          <div className="bnb-actions">
            <button className="bnb-primary" type="button" onClick={advanceTutorial}>{tutorialStep < tutorialSteps.length - 1 ? t('pokemonBnb.next') : t('pokemonBnb.finish')}</button>
            <button type="button" onClick={leaveTutorial}>{t('pokemonBnb.tutorialSkip')}</button>
          </div>
        </div>
      </main>
    )
  }

  if (view === 'lobbyJoin') {
    const joining = status === 'connecting'
    return (
      <main className="bnb-page">
        <header className="bnb-topbar">
          <span className="bnb-hud-label">{t('pokemonBnb.guestRole')}</span>
          <div className="bnb-topbar-actions">
            <button type="button" onClick={startTutorial}>{t('pokemonBnb.tutorial')}</button>
            <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </header>
        <div className="bnb-shell">
          <p className="eyebrow">{t('pokemonBnb.guestRole')}</p>
          <h1>{t('pokemonBnb.joinLobby')}</h1>
          <form className="bnb-form" onSubmit={(event) => { event.preventDefault(); beginSession('guest') }}>
            <div className="bnb-field">
              <label className="bnb-field-label" htmlFor="bnb-join-name">{t('pokemonBnb.nameLabel')}</label>
              <input id="bnb-join-name" className="bnb-input" type="text" value={playerName} maxLength={16} autoComplete="off" placeholder={t('pokemonBnb.namePlaceholder')} onChange={(event) => setPlayerName(event.target.value)} />
            </div>
            <div className="bnb-field">
              <label className="bnb-field-label" htmlFor="bnb-join-code">{t('pokemonBnb.codeLabel')}</label>
              <input id="bnb-join-code" className="bnb-input bnb-input-code" type="text" value={codeInput} maxLength={6} autoComplete="off" spellCheck={false} placeholder={t('pokemonBnb.codePlaceholder')} onChange={(event) => setCodeInput(event.target.value.toUpperCase())} />
            </div>
            <div className="bnb-field">
              <label className="bnb-field-label" htmlFor="bnb-join-server">{t('pokemonBnb.serverLabel')}</label>
              <input id="bnb-join-server" className="bnb-input" type="text" value={serverInput} autoComplete="off" spellCheck={false} placeholder={t('pokemonBnb.serverPlaceholder')} onChange={(event) => setServerInput(event.target.value)} />
              <p className="bnb-hint">{t('pokemonBnb.serverHint')}</p>
              {serverInvalid && <p className="bnb-hint bnb-hint-warn" role="status">{t('pokemonBnb.serverInvalid')}</p>}
            </div>
            <div className="bnb-actions">
              <button className="bnb-primary" type="submit" disabled={joining}>{joining ? t('pokemonBnb.statusConnecting') : t('pokemonBnb.joinLobby')}</button>
            </div>
          </form>
          {errorKey && <p className="bnb-error" role="alert">{t(errorKey)}</p>}
        </div>
      </main>
    )
  }

  if (view === 'lobby') {
    const connected = status === 'connected'
    return (
      <main className="bnb-page">
        <header className="bnb-topbar">
          <span className="bnb-hud-label">{t('pokemonBnb.lobbyTitle')}</span>
          <div className="bnb-topbar-actions">
            <button type="button" onClick={startTutorial}>{t('pokemonBnb.tutorial')}</button>
            <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </header>
        <div className="bnb-shell bnb-shell-lobby">
          <p className="eyebrow">{isHost ? t('pokemonBnb.hostRole') : t('pokemonBnb.guestRole')}</p>
          <h1>{t('pokemonBnb.lobbyTitle')}</h1>
          <p className="bnb-status" aria-live="polite">
            <span className={`bnb-dot bnb-dot-${status}`} aria-hidden="true" />
            {status === 'connected'
              ? substituteParams(t('pokemonBnb.statusConnected'), { name: opponentName || t('pokemonBnb.defaultName') })
              : t('pokemonBnb.statusWaiting')}
          </p>
          {isHost && (
            <div className="bnb-code-row">
              <span className="bnb-code-label">{t('pokemonBnb.lobbyCode')}</span>
              <span className="bnb-code">{code || '······'}</span>
              <button type="button" onClick={copyCode} disabled={!code}>{copied ? t('pokemonBnb.copied') : t('pokemonBnb.copyCode')}</button>
            </div>
          )}
          <div className="bnb-field">
            <label className="bnb-field-label" htmlFor="bnb-lobby-name">{t('pokemonBnb.nameLabel')}</label>
            <input id="bnb-lobby-name" className="bnb-input" type="text" value={playerName} maxLength={16} autoComplete="off" placeholder={t('pokemonBnb.namePlaceholder')} onChange={(event) => setPlayerName(event.target.value)} />
          </div>
          <LobbyFields settings={settings} editable={isHost} idPrefix="bnb-lobby" t={t} onChange={updateSettings} />
          {!isHost && <p className="bnb-hint">{t('pokemonBnb.hostOnlyNote')}</p>}
          {notice && <p className="bnb-notice" role="status">{t(notice)}</p>}
          {errorKey && <p className="bnb-error" role="alert">{t(errorKey)}</p>}
          <div className="bnb-actions">
            {isHost
              ? <button className="bnb-primary" type="button" disabled={!connected} onClick={startPackOpening}>{t('pokemonBnb.startMatch')}</button>
              : <span className="bnb-waiting" aria-live="polite">{t('pokemonBnb.waitingForHost')}</span>}
          </div>
        </div>
      </main>
    )
  }

  // Placeholder seat for the flow after the lobby (CP5 onward). It shows the
  // locked-in match settings so both clients can verify they agree.
  if (view === 'opening' || view === 'deck' || view === 'loading' || view === 'playing' || view === 'paused' || view === 'gameover' || view === 'victory' || view === 'highscore') {
    return (
      <main className="bnb-page">
        <header className="bnb-topbar">
          <span className="bnb-hud-label">{t('pokemonBnb.title')}</span>
          <div className="bnb-topbar-actions">
            <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </header>
        <div className="bnb-shell">
          <p className="eyebrow">{displayName}</p>
          <h1>{t('pokemonBnb.openingTitle')}</h1>
          <p className="bnb-copy">{t('pokemonBnb.openingWip')}</p>
          <dl className="bnb-summary">
            <div><dt>{t('pokemonBnb.setLabel')}</dt><dd>{setLabel(settings.set, t)}</dd></div>
            <div><dt>{t('pokemonBnb.packsLabel')}</dt><dd>{settings.packs}</dd></div>
            <div><dt>{t('pokemonBnb.prizeCardsLabel')}</dt><dd>{settings.prizeCards}</dd></div>
            <div><dt>{t('pokemonBnb.timerLabel')}</dt><dd>{settings.timerSeconds === 0 ? t('pokemonBnb.timerOff') : substituteParams(t('pokemonBnb.timerSeconds'), { count: String(settings.timerSeconds) })}</dd></div>
          </dl>
          {notice && <p className="bnb-notice" role="status">{t(notice)}</p>}
          {errorKey && <p className="bnb-error" role="alert">{t(errorKey)}</p>}
          <p className="bnb-hint">{matchSeed === null ? '' : substituteParams(t('pokemonBnb.seedShared'), { seed: String(matchSeed) })}</p>
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
          <button type="button" aria-label={t('openSettings')} onClick={() => setSettingsOpen(true)}>⚙</button>
          <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
        </div>
      </header>
      <div className="bnb-shell">
        <p className="eyebrow">{t('games.pokemonBnbMini')}</p>
        <h1>{t('pokemonBnb.title')}</h1>
        <p className="bnb-copy">{t('pokemonBnb.description')}</p>
        <div className="bnb-field">
          <label className="bnb-field-label" htmlFor="bnb-start-server">{t('pokemonBnb.serverLabel')}</label>
          <input id="bnb-start-server" className="bnb-input" type="text" value={serverInput} autoComplete="off" spellCheck={false} placeholder={t('pokemonBnb.serverPlaceholder')} onChange={(event) => setServerInput(event.target.value)} />
          <p className="bnb-hint">{t('pokemonBnb.serverHint')}</p>
          {serverInvalid && <p className="bnb-hint bnb-hint-warn" role="status">{t('pokemonBnb.serverInvalid')}</p>}
        </div>
        <div className="bnb-actions">
          <button className="bnb-primary" type="button" onClick={() => beginSession('host')}>{t('pokemonBnb.createLobby')}</button>
          <button type="button" onClick={() => { setErrorKey(null); setNotice(null); setView('lobbyJoin') }}>{t('pokemonBnb.joinLobby')}</button>
        </div>
        {notice && <p className="bnb-notice" role="status">{t(notice)}</p>}
      </div>
      {settingsOpen && <SettingsModal locale={locale} onClose={() => setSettingsOpen(false)} onLocaleChange={changeLocale} t={t} />}
    </main>
  )
}

