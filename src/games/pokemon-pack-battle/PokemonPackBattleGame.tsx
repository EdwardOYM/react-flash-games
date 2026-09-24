// 04-pokemon-pack-battle — CP2 shell + CP3 lobby flow (mirrors 03 pokemon-bnb).
// Flow: start (server field + create/join) -> host `lobby` (code row + copy,
// name, packs stepper, start battle) / guest `lobbyJoin` (name + code + server)
// that steps into the shared lobby when the host's `hello-ack` lands. The host
// broadcasts `lobby-update` on every packs change and rolls the shared seed in
// `lobby-start`, moving both seats to the opening placeholder (CP4 replaces it
// with the ceremony). Leave returns to start from every lobby view.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPreferredLocale, persistLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig } from '../../config'
import { SettingsModal, type AdditionalKeyBinding } from '../../settings'
import { HighscoreTable } from '../highscore/HighscoreTable'
import { readPackBattleHighscores, recordPackBattleWin } from './highscores'
import {
  PACK_BATTLE_30C,
  battleSetCards,
  openBattlePacks,
  seatForPack,
  type BattleOpenedCard,
} from './battlePack'
import { pointsForCard, sortCardsByRarity, tierForCard } from './scoring'
import { createPackBattleRng } from './rng'
import { PokemonCard } from '../pokemon-bnb/PokemonCard'
import {
  PACK_BATTLE_LIMITS,
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
import { PackStack } from './PackStack'
import './PokemonPackBattleGame.css'
import { PokemonPackRip } from './PokemonPackRip'

import { cardIdsForSeat, recordOpenedCards } from './collection'
import {
  ceremonySyncFromState,
  createCeremonyState,
  focusedPackForSeat,
  ceremonyTotals,
  isCeremonyComplete,
  mergeCeremonyCardReveal,
  mergeCeremonySync,
  openCeremonyPack,
  resolveCeremonyKeyAction,
  resolveCeremonyKeyIntent,
  revealAllCeremonyPack,
  revealCeremonyCard,
  seatCanControlPack,
  shouldResetCeremony,
  type CeremonyState,
} from './ceremonyState'

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

type View = 'start' | 'tutorial' | 'lobby' | 'lobbyJoin' | 'opening' | 'summary' | 'highscore' | 'rip' | 'unlocked'

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

/** Live binding for an id, falling back to the declared default. */
function readBinding(id: string, fallback: string): string {
  return readConfig().settings.keybindings[id] ?? fallback
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
  const [connectionLost, setConnectionLost] = useState(false)
  const [copied, setCopied] = useState(false)

  /**
   * 04.3 RIP-packs form state: held here so the rip page keeps the entered name
   * and set when the player steps to the unlocked collection and
   * back (PokemonPackRip reports every change through its callbacks).
   * Each "Open packs" click opens exactly one pack (no packs-per-player).
   */
  const [ripPlayerName, setRipPlayerName] = useState('')
  const [ripSetIndex, setRipSetIndex] = useState(0)

  /** 04.2 CP2: independent per-pack state mirrored on both screens. */
  const [ceremony, setCeremony] = useState<CeremonyState>(() => createCeremonyState(settings.packs * 2))
  /** Stable re-hello mirror, updated synchronously with every ceremony transition. */
  const ceremonyRef = useRef(ceremony)
  const commitCeremony = useCallback((update: (current: CeremonyState) => CeremonyState) => {
    const next = update(ceremonyRef.current)
    ceremonyRef.current = next
    setCeremony(next)
  }, [])
  /** One-shot guard so the completed battle reports its score exactly once. */
  const battleDoneSentRef = useRef(false)
  /** CP5 rematch handshake: the guest offers, the host grants (fresh seed). */
  const [rematchSent, setRematchSent] = useState(false)
  const [rematchOffered, setRematchOffered] = useState(false)
  /** CP5 one-shot guard so the winner's tally records exactly once per device. */
  const resultRecordedRef = useRef(false)
  const rematchSentRef = useRef(false)
  /** 04.3 one-shot guard so one ceremony records its own-seat cards once. */
  const recordedCeremonyRef = useRef(false)

  const resetCeremony = useCallback((packCount: number) => {
    const next = createCeremonyState(packCount)
    ceremonyRef.current = next
    setCeremony(next)
    battleDoneSentRef.current = false
    resultRecordedRef.current = false
    rematchSentRef.current = false
    recordedCeremonyRef.current = false
    setRematchSent(false)
    setRematchOffered(false)
  }, [])

  const sessionRef = useRef<PackBattleSessionBase | null>(null)
  const roleRef = useRef<'host' | 'guest' | null>(null)
  const viewRef = useRef<View>('start')
  const settingsPacksRef = useRef(settings.packs)
  const nameRef = useRef('')
  const opponentNameRef = useRef('')
  const matchSeedRef = useRef<number | null>(null)
  const connectionLostRef = useRef(false)
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
   * Memoised on the active translator so the 04.3 collection effect can depend
   * on it without re-running on every render.
   */
  const showNotice = useCallback((key: TranslationKey, params?: Record<string, string>) => {
    setNotice(key)
    const other = opponentNameRef.current || translate('packBattle.defaultName')
    setNoticeParams({ name: other, ...params })
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
      setNoticeParams(null)
    }, 6000)
  }, [translate])

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
        // lobby settings, and replay the seeded match for a re-dialled guest:
        // lobby-start re-arms the pool (a fresh seed means a new match), then
        // one union-safe ceremony snapshot catches the guest up exactly.
        setOpponentName(message.name)
        if (connectionLostRef.current) {
          connectionLostRef.current = false
          setConnectionLost(false)
        }
        sessionRef.current?.send({ kind: 'hello-ack', name: nameRef.current, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION })
        sessionRef.current?.send({ kind: 'lobby-update', settings: clampPackBattleSettings(settings) })
        if (matchSeedRef.current !== null) {
          sessionRef.current?.send({ kind: 'lobby-start', seed: matchSeedRef.current, settings: clampPackBattleSettings(settings) })
          const replay = ceremonyRef.current
          sessionRef.current?.send({ kind: 'ceremony-sync', ...ceremonySyncFromState(replay) })
        }
        return
      }
      case 'hello-ack': {
        setOpponentName(message.name)
        if (!connectionLostRef.current) setNotice(null)
        // The host answered our hello: step into the shared lobby view.
        if (viewRef.current === 'lobbyJoin') setView('lobby')
        return
      }
      case 'lobby-update': {
        // Only the host edits; the guest applies the broadcast settings.
        if (roleRef.current === 'guest') {
          const next = clampPackBattleSettings(message.settings)
          settingsPacksRef.current = next.packs
          setSettings(next)
        }
        return
      }
      case 'lobby-start': {
        if (roleRef.current !== 'guest') return
        // A fresh seed starts a new match. A replayed same-seed lobby-start
        // (after a guest re-dial) keeps this map; the host's ceremony-sync
        // union catches this seat up without resetting focused packs.
        const isNewMatch = shouldResetCeremony(matchSeedRef.current, message.seed)
        const nextSettings = clampPackBattleSettings(message.settings)
        settingsPacksRef.current = nextSettings.packs
        setSettings(nextSettings)
        matchSeedRef.current = message.seed
        setMatchSeed(message.seed)
        if (isNewMatch) resetCeremony(message.settings.packs * 2)
        if (!connectionLostRef.current) setNotice(null)
        setErrorKey(null)
        setView('opening')
        return
      }
      case 'pack-open': {
        const totalPacks = settingsPacksRef.current * 2
        if (message.packIndex >= totalPacks) return
        commitCeremony((current) => openCeremonyPack(current, message.packIndex, totalPacks))
        return
      }
      case 'card-reveal': {
        const totalPacks = settingsPacksRef.current * 2
        if (message.packIndex >= totalPacks) return
        commitCeremony((current) => mergeCeremonyCardReveal(current, message.packIndex, message.cardIndex, totalPacks))
        return
      }
      case 'pack-reveal-all': {
        const totalPacks = settingsPacksRef.current * 2
        if (message.packIndex >= totalPacks) return
        commitCeremony((current) => revealAllCeremonyPack(current, message.packIndex, totalPacks))
        return
      }
      case 'ceremony-sync': {
        const totalPacks = settingsPacksRef.current * 2
        commitCeremony((current) => mergeCeremonySync(current, message, totalPacks))
        if (connectionLostRef.current) {
          connectionLostRef.current = false
          setConnectionLost(false)
        }
        setNotice(null)
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
      case 'rematch': {
        // CP5: the guest asks for a rematch; only the host can grant one (it
        // owns the seed and settings), so record the offer and show the accept
        // button. Offers outside a finished battle are ignored.
        if (roleRef.current !== 'host' || !battleDoneSentRef.current) return
        setRematchOffered(true)
        return
      }
      default:
        // battle-done totals are derived locally on both seats, so no
        // cross-check message handling is needed on this seat.
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
    connectionLostRef.current = false
    setConnectionLost(false)
    setMatchSeed(null)
    resetCeremony(settings.packs * 2)
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
    connectionLostRef.current = false
    setConnectionLost(false)
    setRole(nextRole)
    setStatus('connecting')
    setErrorKey(null)
    setNotice(null)
    setOpponentName('')
    matchSeedRef.current = null
    setMatchSeed(null)
    resetCeremony(settings.packs * 2)

    const callbacks = {
      onMessage: (message: PackBattleMessage) => messageHandlerRef.current(message),
      onPeerConnected: () => setStatus('connected'),
      /**
       * A channel drop during a seeded match preserves the session and ceremony:
       * the guest's bounded redial sends `hello`, the host replays the same seed
       * plus `ceremony-sync`, and local controls stay disabled until that merge.
       */
      onPeerDisconnected: () => {
        if (closingRef.current) return
        if (matchSeedRef.current !== null) {
          connectionLostRef.current = true
          setConnectionLost(true)
          setStatus('waiting')
          showNotice('packBattle.opponentDisconnected', { name: opponentNameRef.current || translate('packBattle.defaultName') })
          return
        }
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
      const session = createPackBattleHost(nameRef.current || displayName, settings, callbacks, server)
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
    settingsPacksRef.current = settings.packs
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
    const next = clampPackBattleSettings({ ...settings, ...patch })
    settingsPacksRef.current = next.packs
    setSettings(next)
    sessionRef.current?.send({ kind: 'lobby-update', settings: next })
  }

  /** Host-only: roll the shared seed and move both seats to the opening. */
  const startMatch = () => {
    if (roleRef.current !== 'host' || status !== 'connected') return
    const seed = randomPackBattleSeed()
    const payload = clampPackBattleSettings(settings)
    matchSeedRef.current = seed
    setMatchSeed(seed)
    resetCeremony(payload.packs * 2)
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

  // ---- 04.2 CP2: per-pack ceremony state and per-seat totals ----

  /** Seeded pool: identical on both seats (same seed + settings + set data). */
  const totalPacks = settings.packs * 2
  const battlePacks = useMemo<BattleOpenedCard[]>(() => {
    if (matchSeed === null) return []
    return openBattlePacks(battleSetCards(), PACK_BATTLE_30C, totalPacks, createPackBattleRng(matchSeed))
  }, [matchSeed, totalPacks])

  /** Points for every card, indexed by pack then fixed seeded slot. */
  const packCardPoints = useMemo<number[][]>(() => {
    const rows: number[][] = []
    for (let start = 0; start < battlePacks.length; start += PACK_BATTLE_LIMITS.cardsPerPack) {
      rows.push(battlePacks.slice(start, start + PACK_BATTLE_LIMITS.cardsPerPack).map((opened) => pointsForCard(opened.card)))
    }
    return rows
  }, [battlePacks])

  /** Running totals per seat, derived from revealed flags (no wire round-trip). */
  const totals = useMemo(
    () => ceremonyTotals(ceremony, totalPacks, packCardPoints),
    [ceremony, totalPacks, packCardPoints],
  )

  const ceremonyComplete = battlePacks.length > 0 && isCeremonyComplete(ceremony, totalPacks)
  const hostFocusedPack = focusedPackForSeat(ceremony, totalPacks, 'host')
  const guestFocusedPack = focusedPackForSeat(ceremony, totalPacks, 'guest')
  const packsLeft = Math.max(0, totalPacks - ceremony.openedOrder.length)

  /** Seat display name: own name, the peer's name, or the role label. */
  const seatName = (slot: 'host' | 'guest'): string => {
    if (role === slot) return displayName
    return opponentName || translate(slot === 'host' ? 'packBattle.hostRole' : 'packBattle.guestRole')
  }

  /** Engine rarity -> translated chip label. */
  const rarityLabel = (rarity: string): string => {
    switch (rarity) {
      case 'uncommon': return translate('packBattle.rarityUncommon')
      case 'rare': return translate('packBattle.rarityRare')
      case 'double rare': return translate('packBattle.rarityUltraRare')
      case 'illustration rare': return translate('packBattle.rarityIllustrationRare')
      case 'pikachu rare': return 'Pikachu Rare'
      case 'special illustration rare': return 'Special illustration rare'
      case 'futuristic rare': return 'Futuristic Rare'
      default: return translate('packBattle.rarityCommon')
    }
  }

  const localSeat = role ?? 'host'

  /** Open one owned pack; the mirrored state makes the same pack active on both screens. */
  const openPack = (packIndex: number) => {
    if (connectionLostRef.current) return
    const currentCeremony = ceremonyRef.current
    if (ceremonyComplete || currentCeremony.packs[packIndex]?.opened) return
    if (!seatCanControlPack(packIndex, totalPacks, localSeat)) return
    const focused = focusedPackForSeat(currentCeremony, totalPacks, localSeat)
    if (focused !== null && currentCeremony.packs[focused]?.revealed.some((revealed) => !revealed)) return
    sessionRef.current?.send({ kind: 'pack-open', packIndex })
    commitCeremony((current) => openCeremonyPack(current, packIndex, totalPacks))
  }

  /** Reveal only the next fixed-order card of one owned focused pack. */
  const revealNext = (packIndex: number) => {
    if (connectionLostRef.current) return
    const pack = ceremonyRef.current.packs[packIndex]
    if (!pack?.opened || !seatCanControlPack(packIndex, totalPacks, localSeat)) return
    const cardIndex = pack.revealed.findIndex((revealed) => !revealed)
    if (cardIndex < 0) return
    sessionRef.current?.send({ kind: 'card-reveal', packIndex, cardIndex })
    commitCeremony((current) => revealCeremonyCard(current, packIndex, cardIndex, totalPacks))
  }

  /** Reveal all remaining cards of one owned focused pack and expand it for review. */
  const revealAllPack = (packIndex: number) => {
    if (connectionLostRef.current) return
    const pack = ceremonyRef.current.packs[packIndex]
    if (!pack?.opened || pack.revealed.every(Boolean)) return
    if (!seatCanControlPack(packIndex, totalPacks, localSeat)) return
    sessionRef.current?.send({ kind: 'pack-reveal-all', packIndex })
    commitCeremony((current) => revealAllCeremonyPack(current, packIndex, totalPacks))
  }

  /**
   * 04.1-CP3 click gate: the last round holds fully revealed until the player
   * chooses to leave it for the summary (no wire message needed — every card
   * is shared data and both seats' totals are derived locally).
   */
  const seeAllSummary = () => {
    if (!ceremonyComplete) return
    setView('summary')
  }

  // 04.1-CP3 completion: report this seat's own total exactly once, record the
  // winner's tally once per device (a draw records nothing; both seats compute
  // the same totals, so both record consistently). The ceremony then holds on
  // the completed last round behind the click gate (`actionSeeAll`) — it no
  // longer routes away on its own.
  useEffect(() => {
    if (view !== 'opening' || !ceremonyComplete || battleDoneSentRef.current) return
    battleDoneSentRef.current = true
    sessionRef.current?.send({ kind: 'battle-done', score: role === 'guest' ? totals.guest : totals.host })
    if (!resultRecordedRef.current) {
      resultRecordedRef.current = true
      const winner: 'host' | 'guest' | null = totals.host > totals.guest ? 'host' : totals.guest > totals.host ? 'guest' : null
      if (winner !== null) {
        const mine = role === 'guest' ? 'guest' : 'host'
        const winnerName = winner === mine
          ? nameRef.current
          : opponentNameRef.current || translate(winner === 'host' ? 'packBattle.hostRole' : 'packBattle.guestRole')
        recordPackBattleWin(winnerName)
      }
    }
    // The one-shot guard makes re-runs no-ops; refs hold the freshest names.
  }, [view, ceremonyComplete, role, totals, translate])

  // 04.3 collection integration: when the ceremony completes on this device,
  // record the local seat's OWN packs into the persisted collection bucket. The
  // host owns the even-indexed packs and the guest the odd-indexed ones, and an
  // odd tail pack is owned by `both`, so the opponent's packs never reach this
  // device's collection. `resetCeremony` re-arms the one-shot guard, so a rematch
  // records its own packs too.
  useEffect(() => {
    if (view !== 'opening' || !ceremonyComplete || recordedCeremonyRef.current) return
    recordedCeremonyRef.current = true
    const localSeat = role === 'guest' ? 'guest' : 'host'
    recordOpenedCards(displayName, cardIdsForSeat(battlePacks, seatForPack, totalPacks, localSeat))
    showNotice('packBattle.collectionSaved', { player: displayName })
    // The one-shot guard makes re-runs no-ops; refs hold the freshest names.
  }, [view, ceremonyComplete, role, battlePacks, totalPacks, displayName, showNotice])

  /** Guest: ask the host for a rematch (the host re-seeds via lobby-start). */
  const requestRematch = () => {
    if (roleRef.current !== 'guest' || rematchSentRef.current) return
    rematchSentRef.current = true
    setRematchSent(true)
    sessionRef.current?.send({ kind: 'rematch' })
  }

  /** Host: grant a rematch — a fresh seed through the normal lobby-start handshake. */
  const acceptRematch = () => {
    if (roleRef.current !== 'host') return
    startMatch()
  }

  /** Remappable Confirm/Skip keys are reveal-only; pack opening stays pointer/touch. */
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})

  useEffect(() => {
    keyHandlerRef.current = (event: KeyboardEvent) => {
      if (event.repeat) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return
      if (viewRef.current !== 'opening' || ceremonyComplete) return
      const intent = resolveCeremonyKeyIntent(
        event.key,
        readBinding('pokemon-pack-confirm', 'Enter'),
        readBinding('pokemon-pack-skip', 'S'),
      )
      if (intent === null) return
      const seat = roleRef.current
      if (seat === null) return
      const totalPacksNow = settingsPacksRef.current * 2
      const action = resolveCeremonyKeyAction(
        ceremonyRef.current,
        totalPacksNow,
        seat,
        intent,
      )
      if (action?.type === 'reveal-all') revealAllPack(action.packIndex)
      else if (action?.type === 'reveal') revealNext(action.packIndex)
    }
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])



  const startTutorial = () => {
    setTutorialStep(0)
    setView('tutorial')
  }

  /** Tutorial is reachable from start and the lobby; back goes to either. */
  const leaveTutorial = () => setView(roleRef.current ? 'lobby' : 'start')

  /** Leave RIP/unlocked views back to start. */
  const leaveRip = () => setView('start')

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

  // CP4: two independent seat lanes. Each lane renders every owned pack but
  // only the most recently opened pack gets the shared six-card stack.
  if (view === 'opening') {
    const packsForSeat = (seat: 'host' | 'guest') => Array.from(
      { length: totalPacks },
      (_, packIndex) => packIndex,
    ).filter((packIndex) => seatCanControlPack(packIndex, totalPacks, seat))

    const renderSeatLane = (seat: 'host' | 'guest', shared = false) => {
      const focusedPack = seat === 'host' ? hostFocusedPack : guestFocusedPack
      const selectorSeat = shared ? localSeat : seat
      const seatPackIndexes = packsForSeat(selectorSeat)
      const isLocalLane = shared ? role !== null : role === seat
      const laneName = shared ? translate('packBattle.bothRole') : seatName(seat)
      const focusedPosition = focusedPack === null ? 0 : seatPackIndexes.indexOf(focusedPack) + 1
      const focusedState = focusedPack === null ? null : ceremony.packs[focusedPack]
      const focusedCards = focusedPack === null ? [] : battlePacks.slice(
        focusedPack * PACK_BATTLE_LIMITS.cardsPerPack,
        (focusedPack + 1) * PACK_BATTLE_LIMITS.cardsPerPack,
      )
      const revealedCount = focusedState?.revealed.filter(Boolean).length ?? 0
      const nextHidden = focusedState?.revealed.findIndex((entry) => !entry) ?? -1
      const canReveal = isLocalLane && !connectionLost && focusedPack !== null && nextHidden >= 0 && !focusedState?.expanded
      const focusIncomplete = focusedState?.revealed.some((entry) => !entry) === true
      const laneTotal = shared ? totals.host + totals.guest : seat === 'host' ? totals.host : totals.guest

      return (
        <section className={`ppb-seat-lane${isLocalLane ? ' ppb-seat-lane-local' : ''}${shared ? ' ppb-seat-lane-shared' : ''}`} aria-label={laneName}>
          <header className="ppb-seat-lane-head">
            <span className="ppb-seat-lane-name">{laneName}</span>
            <span className="ppb-seat-lane-score">
              {substituteParams(translate('packBattle.packPoints'), { points: String(laneTotal) })}
            </span>
          </header>
          <div className="ppb-owned-packs" role="group" aria-label={translate('packBattle.actionChoosePack')}>
            {seatPackIndexes.map((packIndex) => {
              const packState = ceremony.packs[packIndex]
              const isFocused = packIndex === focusedPack
              const complete = packState.opened && packState.revealed.every(Boolean)
              const className = [
                'ppb-owned-pack',
                packState.opened ? 'ppb-owned-pack-open' : 'ppb-owned-pack-sealed',
                isFocused ? 'ppb-owned-pack-focused' : '',
                complete ? 'ppb-owned-pack-complete' : '',
                packState.expanded ? 'ppb-owned-pack-expanded' : '',
              ].filter(Boolean).join(' ')
              const position = seatPackIndexes.indexOf(packIndex) + 1
              return (
                <button
                  key={packIndex}
                  className={className}
                  type="button"
                  disabled={!isLocalLane || connectionLost || packState.opened || (focusIncomplete && !isFocused)}
                  aria-pressed={isFocused}
                  aria-label={packState.opened
                    ? substituteParams(translate('packBattle.packOwner'), { name: `${laneName} ${position}` })
                    : substituteParams(translate('packBattle.openPackLabel'), { name: `${laneName} ${position}` })}
                  onClick={() => openPack(packIndex)}
                >
                  {position}
                </button>
              )
            })}
          </div>
          {focusedPack !== null && focusedState && (
            <>
              <div className="ppb-seat-progress" aria-live="polite">
                <span>{substituteParams(translate('packBattle.focusedPack'), { current: String(focusedPosition), total: String(seatPackIndexes.length) })}</span>
                <span>{substituteParams(translate('packBattle.cardProgress'), { current: String(Math.min(revealedCount + 1, PACK_BATTLE_LIMITS.cardsPerPack)), total: String(PACK_BATTLE_LIMITS.cardsPerPack) })}</span>
              </div>
              {nextHidden >= 0 && (
                <div className="ppb-seat-controls">
                  <p className="ppb-hint">{translate('packBattle.ceremonyRevealHint')}</p>
                  {isLocalLane && (
                    <button type="button" disabled={connectionLost} onClick={() => revealAllPack(focusedPack)}>
                      {translate('packBattle.actionRevealPack')}
                    </button>
                  )}
                </div>
              )}
              <PackStack
                cards={focusedCards}
                revealed={focusedState.revealed}
                expanded={focusedState.expanded}
                stackLabel={substituteParams(translate('packBattle.focusedPack'), { current: String(focusedPosition), total: String(seatPackIndexes.length) })}
                faceDownLabel={translate('packBattle.cardFaceDown')}
                actionLabel={substituteParams(translate('packBattle.revealCardLabel'), {
                  index: String(nextHidden + 1),
                  total: String(PACK_BATTLE_LIMITS.cardsPerPack),
                  name: laneName,
                })}
                rarityLabel={rarityLabel}
                onReveal={canReveal ? () => revealNext(focusedPack) : undefined}
                cardClassName={(opened, _index, revealed) => revealed ? `ppb-tier-${tierForCard(opened.card)}` : ''}
                renderCardOverlay={(opened, _index, revealed) => {
                  const points = pointsForCard(opened.card)
                  if (!revealed || points <= 0) return null
                  return (
                    <span className="ppb-stack-points" aria-label={substituteParams(translate('packBattle.cardPoints'), { points: String(points) })}>
                      +{points}
                    </span>
                  )
                }}
              />
            </>
          )}
        </section>
      )
    }

    return (
      <main className="ppb-page ppb-opening-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.openingTitle')}</span>
          <div className="ppb-topbar-actions">
            <span className="ppb-packs-left" aria-live="polite">
              {substituteParams(translate('packBattle.packsLeft'), { count: String(packsLeft) })}
            </span>
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
            <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
          </div>
        </header>
        <div className="ppb-shell ppb-shell-lobby">
          <p className="eyebrow">{displayName}</p>
          <h1>{translate('packBattle.openingTitle')}</h1>
          <p className="ppb-status" aria-live="polite">
            {ceremonyComplete
              ? translate('packBattle.ceremonyDone')
              : substituteParams(translate('packBattle.packProgress'), { current: String(ceremony.openedOrder.length), total: String(totalPacks) })}
          </p>
          <div className="ppb-totals" role="group" aria-label={translate('packBattle.scoreLabel')}>
            <div className="ppb-total">
              <span className="ppb-total-name">{seatName('host')}</span>
              <span className="ppb-total-value">{totals.host}</span>
            </div>
            <div className="ppb-total">
              <span className="ppb-total-name">{seatName('guest')}</span>
              <span className="ppb-total-value">{totals.guest}</span>
            </div>
          </div>
          {/* Completion remains behind the click gate; rematch/leave stay global. */}
          {ceremonyComplete && (
            <div className="ppb-actions ppb-ceremony-actions">
              <p className="ppb-hint ppb-ceremony-hint">{translate('packBattle.ceremonyDone')}</p>
              <button className="ppb-primary" type="button" onClick={seeAllSummary}>{translate('packBattle.actionSeeAll')}</button>
            </div>
          )}
          {ceremonyComplete && (
            <>
              {isHost && rematchOffered && (
                <div className="ppb-rematch">
                  <p className="ppb-hint">{substituteParams(translate('packBattle.rematchReceived'), { name: seatName('guest') })}</p>
                  <button className="ppb-primary" type="button" onClick={acceptRematch}>{translate('packBattle.rematchAccept')}</button>
                </div>
              )}
              <div className="ppb-actions">
                {isHost
                  ? (
                    <button className="ppb-primary" type="button" disabled={status !== 'connected'} onClick={acceptRematch}>
                      {translate('packBattle.actionNewPacks')}
                    </button>
                  )
                  : (
                    rematchSent
                      ? <span className="ppb-waiting" aria-live="polite">{substituteParams(translate('packBattle.rematchWaiting'), { name: seatName('host') })}</span>
                      : <button className="ppb-primary" type="button" disabled={status !== 'connected'} onClick={requestRematch}>{translate('packBattle.rematchOffer')}</button>
                  )}
              </div>
            </>
          )}
          <div
            className="ppb-seat-lanes"
            role="group"
            aria-label={substituteParams(translate('packBattle.packProgress'), {
              current: String(ceremony.openedOrder.length),
              total: String(totalPacks),
            })}
          >
            {hostFocusedPack !== null
              && hostFocusedPack === guestFocusedPack
              && seatForPack(hostFocusedPack, totalPacks) === 'both'
              ? renderSeatLane('host', true)
              : <>
                  {renderSeatLane('host')}
                  {renderSeatLane('guest')}
                </>}
          </div>
          {noticeText && <p className="ppb-notice" role="status">{noticeText}</p>}
          {errorKey && <p className="ppb-error" role="alert">{translate(errorKey)}</p>}
          <p className="ppb-hint">{matchSeed === null ? '' : substituteParams(translate('packBattle.seedShared'), { seed: String(matchSeed) })}</p>
        </div>
      </main>
    )
  }

  // 04.1-CP3 summary: victory / defeat / draw from the shared totals, then each
  // seat's opened cards sorted rarest-first (the odd-count tail pack's cards
  // appear in both columns). Every path out is offered: rematch (guest offer /
  // host accept, or the host's direct new-packs reseed — both run a fresh seed
  // through the lobby-start handshake), the shared highscore table, and leave.
  // Rematch is actionable from here; the completed ceremony stays behind the
  // click gate so either seat can move the match forward.
  if (view === 'summary') {
    const winner: 'host' | 'guest' | null = totals.host > totals.guest ? 'host' : totals.guest > totals.host ? 'guest' : null
    const won = winner !== null && winner === (role === 'guest' ? 'guest' : 'host')
    const seatCards: Record<'host' | 'guest', BattleOpenedCard[]> = { host: [], guest: [] }
    for (let packIndex = 0; packIndex < totalPacks; packIndex++) {
      const seat = seatForPack(packIndex, totalPacks)
      const cards = battlePacks.slice(packIndex * PACK_BATTLE_LIMITS.cardsPerPack, packIndex * PACK_BATTLE_LIMITS.cardsPerPack + PACK_BATTLE_LIMITS.cardsPerPack)
      if (seat === 'host' || seat === 'both') seatCards.host.push(...cards)
      if (seat === 'guest' || seat === 'both') seatCards.guest.push(...cards)
    }
    const ranked: Record<'host' | 'guest', BattleOpenedCard[]> = {
      host: sortCardsByRarity(seatCards.host),
      guest: sortCardsByRarity(seatCards.guest),
    }
    const renderSummaryCard = (opened: BattleOpenedCard, index: number) => {
      const points = pointsForCard(opened.card)
      return (
        <li key={`${opened.card.id}-${index}`} className={`ppb-card-cell ppb-tier-${tierForCard(opened.card)}`}>
          <PokemonCard card={opened.card} rarityLabel={rarityLabel(opened.card.rarity)} />
          {points > 0 && (
            <span
              className="ppb-card-points"
              aria-label={substituteParams(translate('packBattle.cardPoints'), { points: String(points) })}
            >
              +{points}
            </span>
          )}
        </li>
      )
    }
    return (
      <main className="ppb-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.title')}</span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
            <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
          </div>
        </header>
        <div className="ppb-shell ppb-summary">
          <p className="eyebrow">{translate('games.pokemonPackBattle')}</p>
          <h1>
            {winner === null
              ? translate('packBattle.resultDraw')
              : won
                ? translate('packBattle.resultVictory')
                : substituteParams(translate('packBattle.resultDefeat'), { name: seatName(winner) })}
          </h1>
          <p className="ppb-final-score">{translate('packBattle.finalScore')}</p>
          <div className="ppb-totals" role="group" aria-label={translate('packBattle.scoreLabel')}>
            <div className="ppb-total">
              <span className="ppb-total-name">{seatName('host')}</span>
              <span className="ppb-total-value">{totals.host}</span>
            </div>
            <div className="ppb-total">
              <span className="ppb-total-name">{seatName('guest')}</span>
              <span className="ppb-total-value">{totals.guest}</span>
            </div>
          </div>
          <h2 className="ppb-summary-title">{translate('packBattle.summaryTitle')}</h2>
          <p className="ppb-hint">{translate('packBattle.summaryHint')}</p>
          <div className="ppb-summary-seats">
            {(['host', 'guest'] as const).map((slot) => (
              <section className="ppb-summary-seat" key={slot} aria-label={seatName(slot)}>
                <header className="ppb-pack-head">
                  <span className="ppb-pack-owner">{seatName(slot)}</span>
                  <span className="ppb-pack-points">
                    {substituteParams(translate('packBattle.packPoints'), { points: String(slot === 'host' ? totals.host : totals.guest) })}
                  </span>
                </header>
                <ol className="ppb-card-row ppb-summary-row">
                  {ranked[slot].map((opened, index) => renderSummaryCard(opened, index))}
                </ol>
              </section>
            ))}
          </div>
          {isHost && rematchOffered && (
            <div className="ppb-rematch">
              <p className="ppb-hint">{substituteParams(translate('packBattle.rematchReceived'), { name: seatName('guest') })}</p>
              <button className="ppb-primary" type="button" onClick={acceptRematch}>{translate('packBattle.rematchAccept')}</button>
            </div>
          )}
          <div className="ppb-actions">
            {isHost
              ? (
                <button className="ppb-primary" type="button" disabled={status !== 'connected'} onClick={acceptRematch}>
                  {translate('packBattle.actionNewPacks')}
                </button>
              )
              : (
                rematchSent
                  ? <span className="ppb-waiting" aria-live="polite">{substituteParams(translate('packBattle.rematchWaiting'), { name: seatName('host') })}</span>
                  : <button className="ppb-primary" type="button" disabled={status !== 'connected'} onClick={requestRematch}>{translate('packBattle.rematchOffer')}</button>
              )}
            <button type="button" onClick={() => setView('highscore')}>{translate('packBattle.highscore')}</button>
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
          </div>
          {noticeText && <p className="ppb-notice" role="status">{noticeText}</p>}
          {errorKey && <p className="ppb-error" role="alert">{translate(errorKey)}</p>}
          <p className="ppb-hint">{matchSeed === null ? '' : substituteParams(translate('packBattle.seedShared'), { seed: String(matchSeed) })}</p>
        </div>
      </main>
    )
  }

  // CP5 highscores: the shared table over this device's pokemon-pack-battle
  // bucket (lifetime wins per player), reachable from the summary and
  // leaveable back to it.
  if (view === 'highscore') {
    return (
      <main className="ppb-page">
        <header className="ppb-topbar">
          <span className="ppb-hud-label">{translate('packBattle.title')}</span>
          <div className="ppb-topbar-actions">
            <button type="button" onClick={leaveLobby}>{translate('packBattle.leave')}</button>
            <button type="button" onClick={onExit}>{translate('packBattle.exit')}</button>
          </div>
        </header>
        <div className="ppb-shell ppb-highscore">
          <p className="eyebrow">{translate('games.pokemonPackBattle')}</p>
          <h1>{translate('packBattle.highscore')}</h1>
          <HighscoreTable
            entries={readPackBattleHighscores()}
            labels={{
              rank: translate('packBattle.rank'),
              playerName: translate('packBattle.player'),
              score: translate('packBattle.wins'),
              noScores: translate('packBattle.noScores'),
            }}
          />
          <div className="ppb-actions">
            <button type="button" onClick={() => setView(matchSeed !== null ? 'summary' : 'start')}>{translate('packBattle.back')}</button>
          </div>
        </div>
      </main>
    )
  }

  // 04.3 RIP packs / unlocked collection (see the plan's view machine):
  // start -> rip -> unlocked -> rip -> start, and both new views leave back to
  // start (`leaveRip`). The form state lives in this component, so a remount
  // after leaving restores the last name and set.
  if (view === 'rip' || view === 'unlocked') {
    return (
      <PokemonPackRip
        view={view}
        playerName={ripPlayerName}
        setIndex={ripSetIndex}
        onViewChange={setView}
        onExit={leaveRip}
        onRipPlayerName={setRipPlayerName}
        onRipSetIndex={setRipSetIndex}
      />
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
        <div className="ppb-actions ppb-actions-rip">
          <button type="button" onClick={() => setView('rip')}>{translate('packBattle.rip')}</button>
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







