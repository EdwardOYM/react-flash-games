// 04-pokemon-pack-battle — CP2 shell header (imports, bindings, view state).
import { useRef, useState } from 'react'
import { getPreferredLocale, persistLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig } from '../../config'
import { SettingsModal, type AdditionalKeyBinding } from '../../settings'
import { HighscoreTable } from '../highscore/HighscoreTable'
import { readPackBattleHighscores } from './highscores'
import {
  PACK_BATTLE_LIMITS,
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
  type PackBattleServerChoice,
} from './net/peer'
import { listSets } from './sets'
import { LobbyView } from './LobbyView'
import './PokemonPackBattleGame.css'

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

interface LobbyState {
  packs: number
  codeInput: string
  name: string
  server: string
  status: PackBattlePeerStatus
  hostName: string | null
  guestName: string | null
}

const SET_ENTRIES = listSets()
const DEFAULT_SET_ID = SET_ENTRIES[0].id

export function PokemonPackBattleGame({ locale, onLocaleChange, onExit, t }: PokemonPackBattleProps) {
  const [activeLocale, setActiveLocale] = useState<Locale>(() => locale ?? getPreferredLocale())
  const fallbackTranslate = useTranslations(activeLocale)
  const translate = t ?? fallbackTranslate
  const [view, setView] = useState<View>('start')
  const [tutorialStep, setTutorialStep] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [musicOn, setMusicOn] = useState(() => readConfig().settings.music)
  const [highscores, setHighscores] = useState(() => readPackBattleHighscores())
  const [lobby, setLobby] = useState<LobbyState>({
    packs: defaultPackBattleSettings(DEFAULT_SET_ID).packs,
    codeInput: '',
    name: '',
    server: '',
    status: 'waiting',
    hostName: null,
    guestName: null,
  })

  const sessionRef = useRef<PackBattleSessionBase | null>(null)
  const hostNameRef = useRef<string>('')
  const guestNameRef = useRef<string>('')
  const matchSeedRef = useRef<number>(0)
  const packsRef = useRef<PackBattleSettings>(defaultPackBattleSettings(DEFAULT_SET_ID))

  const [localRole, setLocalRole] = useState<'host' | 'guest'>('host')

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

    const handlePacks = (delta: number) => {
    setLobby((current) => ({
      ...current,
      packs: Math.min(
        PACK_BATTLE_LIMITS.maxPacks,
        Math.max(PACK_BATTLE_LIMITS.minPacks, Math.round(current.packs + delta)),
      ),
    }))
  }

  const handleCodeChange = (value: string) => setLobby((current) => ({ ...current, codeInput: value }))
  const handleNameChange = (value: string) => setLobby((current) => ({ ...current, name: value }))
  const handleServerChange = (value: string) => setLobby((current) => ({ ...current, server: value }))

  // Wire the peerjs session: inbound packets route through a stable ref closure
  // so the host can replay state (seed/cursor/scores) on a guest re-hello.
  const messageHandlerRef = useRef<((message: PackBattleMessage) => void) | null>(null)

  const beginSession = (role: 'host' | 'guest') => {
    const name = lobby.name.trim() || 'Pack'
    const server: PackBattleServerChoice = lobby.server ? parsePackBattleServerAddress(lobby.server) : null
    setLocalRole(role)
    const settings = clampPackBattleSettings({ set: DEFAULT_SET_ID, packs: lobby.packs })

    messageHandlerRef.current = (message) => {
      if (message.kind === 'hello') {
        guestNameRef.current = message.name || ''
        setLobby((current) => ({ ...current, guestName: message.name || null, status: 'connected' }))
        if (localRole === 'host' && matchSeedRef.current) {
          sessionRef.current?.send({ kind: 'lobby-start', seed: matchSeedRef.current, settings: packsRef.current })
        }
      } else if (message.kind === 'hello-ack') {
        hostNameRef.current = message.name || ''
        setLobby((current) => ({ ...current, hostName: message.name || null, status: 'connected' }))
      } else if (message.kind === 'lobby-start') {
        matchSeedRef.current = message.seed
        packsRef.current = message.settings
        setView('opening')
      } else if (message.kind === 'leave') {
        sessionRef.current?.dispose()
        sessionRef.current = null
        setLobby((current) => ({ ...current, status: 'waiting', hostName: null, guestName: null }))
        setView('start')
      }
    }

    if (role === 'host') {
      const session = createPackBattleHost(
        name,
        settings,
        {
          onMessage: (message) => messageHandlerRef.current?.(message),
          onPeerConnected: () => setLobby((current) => ({ ...current, status: 'connected' })),
          onPeerDisconnected: () => setLobby((current) => ({ ...current, status: 'waiting' })),
          onStatus: (status) => setLobby((current) => ({ ...current, status })),
          onError: () => setLobby((current) => ({ ...current, status: 'error' })),
        },
        server,
      )
      sessionRef.current = session
      setLobby((current) => ({ ...current, status: 'waiting' }))
    } else {
      const session = joinPackBattleHost(
        lobby.codeInput,
        name,
        {
          onMessage: (message) => messageHandlerRef.current?.(message),
          onPeerConnected: () => setLobby((current) => ({ ...current, status: 'connected' })),
          onPeerDisconnected: () => setLobby((current) => ({ ...current, status: 'waiting' })),
          onStatus: (status) => setLobby((current) => ({ ...current, status })),
          onError: (error) => {
            void error
            setLobby((current) => ({ ...current, status: 'error' }))
          },
        },
        server,
      )
      sessionRef.current = session
    }
  }

      const startMatch = () => {
    const session = sessionRef.current
    if (!session) return
    const settings = clampPackBattleSettings({ set: DEFAULT_SET_ID, packs: lobby.packs })
    matchSeedRef.current = Math.floor(Math.random() * 0x7fffffff)
    packsRef.current = settings
    session.send({ kind: 'lobby-update', settings })
    session.send({ kind: 'lobby-start', seed: matchSeedRef.current, settings })
    setView('opening')
  }

  const leaveLobby = () => {
    if (sessionRef.current) {
      sessionRef.current.send({ kind: 'leave' })
      sessionRef.current.dispose()
    }
    sessionRef.current = null
    messageHandlerRef.current = null
    setLobby((current) => ({
      ...current,
      codeInput: '',
      name: '',
      server: '',
      status: 'waiting',
      hostName: null,
      guestName: null,
    }))
    setView('start')
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
          <LobbyView
            role={localRole}
            status={lobby.status}
            name={lobby.name}
            codeInput={lobby.codeInput}
            packs={lobby.packs}
            server={lobby.server}
            hostName={lobby.hostName}
            guestName={lobby.guestName}
            onNameChange={handleNameChange}
            onCodeChange={handleCodeChange}
            onServerChange={handleServerChange}
            onPacksChange={handlePacks}
            onCreate={() => beginSession('host')}
            onJoin={() => beginSession('guest')}
            onLeave={leaveLobby}
            onStartMatch={startMatch}
            t={translate}
          />
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
