// Pokemon TCG B&B mini — peer-to-peer Build & Battle limited format.
// CP6: deck builder. The opened pool (same seeded sequence as the ceremony)
// renders as an include/exclude grid; legality comes from deck.ts, and the
// deck-ready handshake (deckIds, one entry per copy) advances both seats to
// the battle placeholder (engine lands in CP7).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPreferredLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { SettingsModal } from '../../settings'
import type { CardDef, CardRarity, SetId } from './cards'
import { buildPoolIsValid, type DeckLegalityReason } from './deck'
import { LOBBY_LIMITS, PROTOCOL_VERSION, clampLobbySettings, defaultLobbySettings, type LobbySettings, type NetMessage } from './net/protocol'
import { createHost, joinHost, parseServerAddress, type PeerStatus, type SessionBase } from './net/peer'
import { openPacks, buildPool, type OpenedCard, type OpenedPool } from './pack'
import { createRng, randomSeed } from './rng'
import { getSet, listSets } from './sets'
import { PokemonCard } from './PokemonCard'
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
  /** Cards revealed so far in the pack-opening ceremony. Reset on reseeding. */
  const [revealedCount, setRevealedCount] = useState(0)
  const [openingReady, setOpeningReady] = useState(false)
  const [opponentReady, setOpponentReady] = useState(false)
  const opponentReadyRef = useRef(false)
  /** Deck-builder inclusion counts by card id (0..opened copies). */
  const [deckCounts, setDeckCounts] = useState<Record<string, number>>({})
  const [deckReady, setDeckReady] = useState(false)
  const [opponentDeckReady, setOpponentDeckReady] = useState(false)
  const opponentDeckReadyRef = useRef(false)
  const deckReadyRef = useRef(false)
  const sessionRef = useRef<SessionBase | null>(null)
  const roleRef = useRef<Role | null>(null)
  const settingsRef = useRef<LobbySettings>(settings)
  const nameRef = useRef('')
  const openingReadyRef = useRef(false)
  const closingRef = useRef(false)
  const copyTimerRef = useRef<number | null>(null)
  const messageHandlerRef = useRef<(message: NetMessage) => void>(() => undefined)

  const displayName = playerName.trim() || t('pokemonBnb.defaultName')
  const isHost = role === 'host'

  /**
   * The seeded opening pool, shared by both seats. Same seed + settings +
   * set data yields the identical card sequence on every peer, so the pools
   * cannot diverge (and no opened cards ever cross the wire).
   */
  const openedCards = useMemo<OpenedCard[]>(() => {
    if (matchSeed === null) return []
    const entry = getSet(settings.set)
    if (!entry) return []
    return openPacks(entry.data.cards, entry.pack, settings.packs, createRng(matchSeed))
  }, [matchSeed, settings.set, settings.packs])

  const packSize = useMemo(() => getSet(settings.set)?.pack.size ?? 0, [settings.set])

  /** Unique-card pool with opened copy counts (deck-builder source). */
  const openedPool = useMemo<OpenedPool>(() => buildPool(openedCards), [openedCards])
  const poolTotal = useMemo(
    () => openedPool.cards.reduce((sum, card) => sum + (openedPool.byId.get(card.id) ?? 0), 0),
    [openedPool],
  )

  /** Deck id list: one entry per included copy, in pool order. */
  const deckIds = useMemo<string[]>(() => {
    const ids: string[] = []
    for (const card of openedPool.cards) {
      const count = Math.min(deckCounts[card.id] ?? 0, openedPool.byId.get(card.id) ?? 0)
      for (let copy = 0; copy < count; copy++) ids.push(card.id)
    }
    return ids
  }, [deckCounts, openedPool])

  const deckCheck = useMemo(() => buildPoolIsValid(deckIds, openedPool, settings.prizeCards), [deckIds, openedPool, settings.prizeCards])
  const deckErrorKey = (reason: DeckLegalityReason): TranslationKey => {
    switch (reason) {
      case 'too-small': return 'pokemonBnb.deckErrorTooSmall'
      case 'no-basic': return 'pokemonBnb.deckErrorNoBasic'
      case 'no-energy': return 'pokemonBnb.deckErrorNoEnergy'
      case 'over-pool': return 'pokemonBnb.deckErrorOverPool'
    }
  }
  const rarityLabel = (rarity: CardRarity): string => {
    switch (rarity) {
      case 'common': return t('pokemonBnb.rarityCommon')
      case 'uncommon': return t('pokemonBnb.rarityUncommon')
      case 'rare': return t('pokemonBnb.rarityRare')
      case 'ultraRare': return t('pokemonBnb.rarityUltraRare')
      case 'illustrationRare': return t('pokemonBnb.rarityIllustrationRare')
    }
  }

  const tutorialSteps: { goal: string; copyKey: TranslationKey }[] = [
    { goal: 'pack', copyKey: 'pokemonBnb.tutorialPack' },
    { goal: 'deck', copyKey: 'pokemonBnb.tutorialDeck' },
    { goal: 'battle', copyKey: 'pokemonBnb.tutorialBattle' },
  ]

  const startTutorial = () => { setTutorialStep(0); setView('tutorial') }
  const leaveTutorial = () => setView(role ? 'lobby' : 'start')
  const advanceTutorial = () => { if (tutorialStep < tutorialSteps.length - 1) setTutorialStep(tutorialStep + 1); else leaveTutorial() }

  // Ref-called implementations live in the ref-sync effect below (assigned
  // post-render, never during render) so the stable data-channel handler
  // always runs the fresh closure without being recreated itself.
  const enterDeckBuilderRef = useRef<() => void>(() => {})
  const resetMatchStateRef = useRef<() => void>(() => {})
  const openedPoolRef = useRef<OpenedPool | null>(null)
  /** Both seats enter deck building with every copy included by default. */
  const enterDeckBuilder = useCallback(() => {
    enterDeckBuilderRef.current?.()
  }, [])

  const resetMatchState = useCallback(() => {
    resetMatchStateRef.current?.()
  }, [])

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
        resetMatchState()
        setNotice(null)
        setErrorKey(null)
        setView('opening')
        return
      }
      case 'opening-ready': {
        // Both-ready handshake: whoever receives the peer's ready after having
        // marked themselves ready advances both to deck building. The view
        // switch lives here (in the event that caused the change) rather than
        // in an effect, so no setState-in-effect is needed.
        setOpponentReady(true)
        opponentReadyRef.current = true
        setNotice(null)
        if (openingReadyRef.current) enterDeckBuilder()
        return
      }
      case 'deck-ready': {
        // Deck lists are private in the UI; the ids travel only so the CP7
        // engine can set up the shared battle. Advance when both are ready.
        setOpponentDeckReady(true)
        opponentDeckReadyRef.current = true
        setNotice(null)
        if (deckReadyRef.current) setView('loading')
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
        // Battle payloads land in later checkpoints.
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

  // Ref mirrors + ref-called implementations for the stable data-channel
  // handler (assigned post-render, never during render).
  useEffect(() => {
    openingReadyRef.current = openingReady
    opponentReadyRef.current = opponentReady
    deckReadyRef.current = deckReady
    opponentDeckReadyRef.current = opponentDeckReady
    openedPoolRef.current = openedPool
    enterDeckBuilderRef.current = () => {
      setDeckCounts(Object.fromEntries(openedPool.cards.map((card) => [card.id, openedPool.byId.get(card.id) ?? 0])))
      setDeckReady(false)
      deckReadyRef.current = false
      setOpponentDeckReady(false)
      opponentDeckReadyRef.current = false
      setView('deck')
    }
    resetMatchStateRef.current = () => {
      setRevealedCount(0)
      setOpeningReady(false)
      openingReadyRef.current = false
      setOpponentReady(false)
      opponentReadyRef.current = false
      setDeckCounts({})
      setDeckReady(false)
      deckReadyRef.current = false
      setOpponentDeckReady(false)
      opponentDeckReadyRef.current = false
    }
  }, [openingReady, opponentReady, deckReady, opponentDeckReady, openedPool])

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
    resetMatchState()
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

  const startPackOpening = () => {
    const seed = randomSeed()
    const payload = clampLobbySettings(settingsRef.current)
    setMatchSeed(seed)
    resetMatchState()
    sessionRef.current?.send({ kind: 'lobby-start', seed, settings: payload })
    setView('opening')
  }

  /** Reveal the next card, or everything at once. */
  const revealNext = () => setRevealedCount((count) => Math.min(count + 1, openedCards.length))
  const revealAll = () => setRevealedCount(openedCards.length)

  /** Mark ourselves ready; with both ready, both seats advance to deck building. */
  const markOpeningReady = () => {
    setOpeningReady(true)
    openingReadyRef.current = true
    sessionRef.current?.send({ kind: 'opening-ready' })
    if (opponentReadyRef.current) enterDeckBuilder()
  }

  /** Include or remove one copy of an opened card, clamped to opened copies. */
  const adjustDeckCount = (cardId: string, delta: number) => {
    const opened = openedPool.byId.get(cardId) ?? 0
    setDeckCounts((counts) => {
      const next = Math.min(opened, Math.max(0, (counts[cardId] ?? 0) + delta))
      if (next === 0) {
        const { [cardId]: _removed, ...rest } = counts
        return rest
      }
      return { ...counts, [cardId]: next }
    })
  }

  /** Mark our deck ready and send the id list (one entry per copy). */
  const markDeckReady = () => {
    if (!deckCheck.ok || deckReady) return
    setDeckReady(true)
    deckReadyRef.current = true
    sessionRef.current?.send({ kind: 'deck-ready', deckIds })
    if (opponentDeckReadyRef.current) setView('loading')
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
    resetMatchState()
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

  if (view === 'opening') {
    const total = openedCards.length
    const revealed = Math.min(revealedCount, total)
    const fullyRevealed = total > 0 && revealed >= total
    const packIndex = packSize > 0 ? Math.min(settings.packs, Math.floor(revealed / packSize) + 1) : settings.packs
    return (
      <main className="bnb-page">
        <header className="bnb-topbar">
          <span className="bnb-hud-label">{t('pokemonBnb.openingTitle')}</span>
          <div className="bnb-topbar-actions">
            <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </header>
        <div className="bnb-shell bnb-shell-lobby">
          <p className="eyebrow">{displayName}</p>
          <h1>{t('pokemonBnb.openingTitle')}</h1>
          <p className="bnb-status" aria-live="polite">
            {total > 0
              ? substituteParams(t('pokemonBnb.openingProgress'), { current: String(Math.max(revealed, 1)), total: String(total) })
              : t('pokemonBnb.openingEmpty')}
          </p>
          {packSize > 0 && total > 0 && (
            <p className="bnb-hint">{substituteParams(t('pokemonBnb.openingPackLabel'), { current: String(fullyRevealed ? settings.packs : packIndex), total: String(settings.packs) })}</p>
          )}
          <ol className="bnb-card-grid">
            {openedCards.map((opened, index) => {
              const faceDown = index >= revealed
              const card: CardDef = opened.card
              return (
                <li key={`${card.id}-${index}`}>
                  <PokemonCard card={card} faceDown={faceDown} rarityLabel={rarityLabel(card.rarity)} faceDownLabel={t('pokemonBnb.cardFaceDown')} />
                </li>
              )
            })}
          </ol>
          {notice && <p className="bnb-notice" role="status">{t(notice)}</p>}
          {opponentReady && <p className="bnb-notice" role="status">{substituteParams(t('pokemonBnb.opponentReady'), { name: opponentName || t('pokemonBnb.defaultName') })}</p>}
          {errorKey && <p className="bnb-error" role="alert">{t(errorKey)}</p>}
          <div className="bnb-actions">
            {!fullyRevealed && <button className="bnb-primary" type="button" onClick={revealNext}>{t('pokemonBnb.revealNext')}</button>}
            {!fullyRevealed && <button type="button" onClick={revealAll}>{t('pokemonBnb.skipAll')}</button>}
            {fullyRevealed && !openingReady && <button className="bnb-primary" type="button" onClick={markOpeningReady}>{t('pokemonBnb.openingReady')}</button>}
            {fullyRevealed && openingReady && !opponentReady && <span className="bnb-waiting" aria-live="polite">{t('pokemonBnb.startWaiting')}</span>}
          </div>
          <p className="bnb-hint">{matchSeed === null ? '' : substituteParams(t('pokemonBnb.seedShared'), { seed: String(matchSeed) })}</p>
        </div>
      </main>
    )
  }

  // Placeholder seat for the flow after deck building (CP7 onward).
  if (view === 'deck') {
    return (
      <main className="bnb-page">
        <header className="bnb-topbar">
          <span className="bnb-hud-label">{t('pokemonBnb.deckTitle')}</span>
          <div className="bnb-topbar-actions">
            <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </header>
        <div className="bnb-shell bnb-shell-lobby">
          <p className="eyebrow">{displayName}</p>
          <h1>{t('pokemonBnb.deckTitle')}</h1>
          <p className="bnb-status" aria-live="polite">
            {substituteParams(t('pokemonBnb.deckCount'), { count: String(deckCheck.summary.total), total: String(poolTotal) })}
            <span className="bnb-status-sep" aria-hidden="true">·</span>
            <span>{t('pokemonBnb.prizeCardsLabel')}: {settings.prizeCards}</span>
          </p>
          {openedPool.cards.length === 0 && <p className="bnb-error" role="alert">{t('pokemonBnb.deckEmpty')}</p>}
          <h2 className="bnb-field-label">{t('pokemonBnb.deckSelectedLabel')}</h2>
          <ol className="bnb-card-grid">
            {openedPool.cards.map((card) => {
              const opened = openedPool.byId.get(card.id) ?? 0
              const included = Math.min(deckCounts[card.id] ?? 0, opened)
              if (included === 0) return null
              return (
                <li key={card.id}>
                  <PokemonCard card={card} rarityLabel={rarityLabel(card.rarity)} faceDownLabel={t('pokemonBnb.cardFaceDown')} />
                  <p className="bnb-hint">{substituteParams(t('pokemonBnb.deckCopies'), { count: String(included) })}</p>
                  <div className="bnb-actions">
                    <button type="button" disabled={deckReady || included >= opened} onClick={() => adjustDeckCount(card.id, 1)} aria-label={substituteParams(t('pokemonBnb.deckInclude'), { name: card.name })}>+</button>
                    <button type="button" disabled={deckReady || included <= 0} onClick={() => adjustDeckCount(card.id, -1)} aria-label={substituteParams(t('pokemonBnb.deckExclude'), { name: card.name })}>−</button>
                  </div>
                </li>
              )
            })}
          </ol>
          <h2 className="bnb-field-label">{t('pokemonBnb.deckPoolLabel')}</h2>
          <ol className="bnb-card-grid">
            {openedPool.cards.map((card) => {
              const opened = openedPool.byId.get(card.id) ?? 0
              const included = Math.min(deckCounts[card.id] ?? 0, opened)
              if (included >= opened) return null
              return (
                <li key={card.id}>
                  <PokemonCard card={card} rarityLabel={rarityLabel(card.rarity)} faceDownLabel={t('pokemonBnb.cardFaceDown')} />
                  <div className="bnb-actions">
                    <button type="button" disabled={deckReady} onClick={() => adjustDeckCount(card.id, 1)} aria-label={substituteParams(t('pokemonBnb.deckInclude'), { name: card.name })}>+</button>
                  </div>
                </li>
              )
            })}
          </ol>
          {deckCheck.reasons.map((reason) => (
            <p key={reason} className="bnb-error" role="alert">
              {reason === 'too-small'
                ? substituteParams(t(deckErrorKey(reason)), { minimum: String(deckCheck.minimum) })
                : t(deckErrorKey(reason))}
            </p>
          ))}
          {opponentDeckReady && <p className="bnb-notice" role="status">{substituteParams(t('pokemonBnb.opponentReady'), { name: opponentName || t('pokemonBnb.defaultName') })}</p>}
          {notice && <p className="bnb-notice" role="status">{t(notice)}</p>}
          {errorKey && <p className="bnb-error" role="alert">{t(errorKey)}</p>}
          <div className="bnb-actions">
            {!deckReady && <button className="bnb-primary" type="button" disabled={!deckCheck.ok} onClick={markDeckReady}>{t('pokemonBnb.deckSubmit')}</button>}
            {deckReady && !opponentDeckReady && <span className="bnb-waiting" aria-live="polite">{t('pokemonBnb.deckWaiting')}</span>}
          </div>
        </div>
      </main>
    )
  }

  // Placeholder seat for the flow after deck building (CP7 onward). It shows
  // the locked-in match settings so both clients can verify they agree.
  if (view === 'loading' || view === 'playing' || view === 'paused' || view === 'gameover' || view === 'victory' || view === 'highscore') {
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

