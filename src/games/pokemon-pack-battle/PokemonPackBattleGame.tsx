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
  PACKS_PER_PAIR,
  PACK_BATTLE_30C,
  battleSetCards,
  openBattlePacks,
  packIndexesInPair,
  pairCountForPacks,
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
import './PokemonPackBattleGame.css'
import { PokemonPackRip } from './PokemonPackRip'

import { cardIdsForSeat, recordOpenedCards } from './collection'

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
  const [copied, setCopied] = useState(false)

  /**
   * 04.3 RIP-packs form state: held here so the rip page keeps the entered name
   * and set when the player steps to the unlocked collection and
   * back (PokemonPackRip reports every change through its callbacks).
   * Each "Open packs" click opens exactly one pack (no packs-per-player).
   */
  const [ripPlayerName, setRipPlayerName] = useState('')
  const [ripSetIndex, setRipSetIndex] = useState(0)

  /**
   * CP4/CP7 shared ceremony cursor: both seats render from this one cursor and
   * either seat's open/reveal advances both (max-merge on receive). One cursor
   * step is a PAIR (the round's pack for each seat, side by side): `opened`
   * marks that round's packs unsealed and `cardIndex` counts the card slots
   * revealed so far, applied to both packs of the pair at once.
   */
  const [cursor, setCursor] = useState({ pairIndex: 0, cardIndex: 0, opened: false })
  /**
   * 04.1-CP2 reveal cascade: `revealedAnim` ramps to the shared
   * `cursor.cardIndex` at ~120 ms per card, so "Reveal both packs" flips in
   * sequence instead of six at once. Per-card visuals read
   * `min(cursor.cardIndex, revealedAnim)`; totals stay on the shared cursor so
   * scoring never lags the wire. Snaps (no ramp) on pair change, while sealed,
   * and under `prefers-reduced-motion`.
   */
  const [revealedAnim, setRevealedAnim] = useState(0)
  const cascadePairRef = useRef(0)
  const cascadeTimerRef = useRef<number | null>(null)
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

  const resetCeremony = useCallback(() => {
    setCursor({ pairIndex: 0, cardIndex: 0, opened: false })
    battleDoneSentRef.current = false
    resultRecordedRef.current = false
    rematchSentRef.current = false
    recordedCeremonyRef.current = false
    setRematchSent(false)
    setRematchOffered(false)
    // 04.1-CP2: the cascade ramp belongs to one round — drop it so a rematch
    // or a re-seed starts sealed with no leftover timers.
    cascadePairRef.current = 0
    if (cascadeTimerRef.current !== null) {
      window.clearTimeout(cascadeTimerRef.current)
      cascadeTimerRef.current = null
    }
    setRevealedAnim(0)
  }, [])

  const sessionRef = useRef<PackBattleSessionBase | null>(null)
  const roleRef = useRef<'host' | 'guest' | null>(null)
  const viewRef = useRef<View>('start')
  const settingsRef = useRef<PackBattleSettings>(settings)
  const nameRef = useRef('')
  const opponentNameRef = useRef('')
  const matchSeedRef = useRef<number | null>(null)
  /** CP4/CP7 mirror of the shared cursor for the stable re-hello replay. */
  const cursorRef = useRef(cursor)
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
        // lobby-start re-arms the pool (a fresh seed means a new match) and the
        // cursor replay (current pair + revealed card count) catches a guest up
        // through idempotent max-merge.
        setOpponentName(message.name)
        sessionRef.current?.send({ kind: 'hello-ack', name: nameRef.current, protocolVersion: PACK_BATTLE_PROTOCOL_VERSION })
        sessionRef.current?.send({ kind: 'lobby-update', settings: clampPackBattleSettings(settingsRef.current) })
        if (matchSeedRef.current !== null) {
          sessionRef.current?.send({ kind: 'lobby-start', seed: matchSeedRef.current, settings: clampPackBattleSettings(settingsRef.current) })
          const replay = cursorRef.current
          sessionRef.current?.send({ kind: 'pair-open', pairIndex: replay.pairIndex })
          if (replay.opened && replay.cardIndex > 0) {
            sessionRef.current?.send({ kind: 'card-reveal-pair', pairIndex: replay.pairIndex, cardIndex: replay.cardIndex - 1 })
          }
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
        // A fresh seed starts a new match (reset the ceremony); a replayed
        // lobby-start (same seed, e.g. after a guest re-dial) must NOT reset
        // the shared cursor — the host's pair-open/card-reveal replay catches
        // this seat up through max-merge instead.
        const isNewMatch = matchSeedRef.current === null || matchSeedRef.current !== message.seed
        setSettings(clampPackBattleSettings(message.settings))
        matchSeedRef.current = message.seed
        setMatchSeed(message.seed)
        if (isNewMatch) resetCeremony()
        setNotice(null)
        setErrorKey(null)
        setView('opening')
        return
      }
      case 'pair-open': {
        // Either seat unseals a round's packs for both (max-merge: never move
        // backwards, never beyond the locked round count). With per-player pack
        // counts the round count equals the per-player pack count directly.
        if (message.pairIndex >= settingsRef.current.packs) return
        setCursor((prev) => {
          if (prev.pairIndex > message.pairIndex) return prev
          if (prev.pairIndex === message.pairIndex && prev.opened) return prev
          return { pairIndex: message.pairIndex, cardIndex: 0, opened: true }
        })
        return
      }
      case 'card-reveal-pair': {
        if (message.pairIndex >= settingsRef.current.packs) return
        setCursor((prev) => {
          if (message.pairIndex > prev.pairIndex) {
            return { pairIndex: message.pairIndex, cardIndex: Math.min(message.cardIndex + 1, PACK_BATTLE_LIMITS.cardsPerPack), opened: true }
          }
          if (message.pairIndex === prev.pairIndex) {
            const next = Math.max(prev.cardIndex, Math.min(message.cardIndex + 1, PACK_BATTLE_LIMITS.cardsPerPack))
            if (next === prev.cardIndex && prev.opened) return prev
            return { ...prev, cardIndex: next, opened: true }
          }
          return prev
        })
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
    setMatchSeed(null)
    resetCeremony()
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
    resetCeremony()

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
    cursorRef.current = cursor
    messageHandlerRef.current = readMessage
  })

  /**
   * 04.1-CP2 reveal cascade. The shared `cursor.cardIndex` is source of
   * truth for scoring and the wire; `revealedAnim` trails it one card per
   * ~120 ms so a mass reveal reads as a sequence (CSS stagger is static —
   * delay per cell — and cannot trail shared state, hence a timer ramp).
   * Snap (no ramp) when: the round changes, the packs are (re)sealed, the
   * gap is > 1 (a re-dial catch-up jumping ahead), or the OS asks for
   * reduced motion. Cleanup clears the pending step so an unmounted or
   * re-rendered ceremony never flips a stale card.
   */
  useEffect(() => {
    if (cascadeTimerRef.current !== null) {
      window.clearTimeout(cascadeTimerRef.current)
      cascadeTimerRef.current = null
    }
    const reduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const snap = !cursor.opened
      || cursor.pairIndex !== cascadePairRef.current
      || cursor.cardIndex - revealedAnim > 1
      || cursor.cardIndex < revealedAnim
      || reduceMotion
    cascadePairRef.current = cursor.pairIndex
    if (snap) {
      // Snap path: cascadePairRef tracks the round, and the queued microtask
      // applies the jump outside this effect (lint-clean, no sync setState).
      if (revealedAnim === cursor.cardIndex) return
      const target = cursor.cardIndex
      queueMicrotask(() => setRevealedAnim(target))
      return
    }
    if (revealedAnim >= cursor.cardIndex) return
    cascadeTimerRef.current = window.setTimeout(() => {
      cascadeTimerRef.current = null
      setRevealedAnim((prev) => Math.min(prev + 1, cursor.cardIndex))
    }, 120)
    return () => {
      if (cascadeTimerRef.current !== null) {
        window.clearTimeout(cascadeTimerRef.current)
        cascadeTimerRef.current = null
      }
    }
  }, [cursor, revealedAnim])

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
    resetCeremony()
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

  // ---- CP4 opening ceremony: shared pool, shared cursor, per-seat score ----

  /** Seeded pool: identical on both seats (same seed + settings + set data). */
  const totalPacks = settings.packs * 2
  const battlePacks = useMemo<BattleOpenedCard[]>(() => {
    if (matchSeed === null) return []
    return openBattlePacks(battleSetCards(), PACK_BATTLE_30C, totalPacks, createPackBattleRng(matchSeed))
  }, [matchSeed, totalPacks])

  /** Ceremony rounds: one pack per seat per round (see battlePack pairing). */
  const totalPairs = pairCountForPacks(totalPacks)

  /**
   * Points per card per pack (score accrues per reveal, not per pack). Cards are
   * scored by identity, so the pack-guaranteed Pikachu IR contributes 0.
   */
  const packCardPoints = useMemo<number[][]>(() => {
    const rows: number[][] = []
    for (let start = 0; start < battlePacks.length; start += PACK_BATTLE_LIMITS.cardsPerPack) {
      rows.push(battlePacks.slice(start, start + PACK_BATTLE_LIMITS.cardsPerPack).map((opened) => pointsForCard(opened.card)))
    }
    return rows
  }, [battlePacks])

  /**
   * Points banked by one pack so far. A pair reveals the same card slot in both
   * of its packs, so both packs of the current round share `cursor.cardIndex`
   * and every earlier round is fully revealed.
   */
  const packPointsRevealed = useCallback((packIndex: number): number => {
    const pairIndex = Math.floor(packIndex / PACKS_PER_PAIR)
    const revealedInPack = pairIndex < cursor.pairIndex
      ? PACK_BATTLE_LIMITS.cardsPerPack
      : pairIndex === cursor.pairIndex && cursor.opened ? cursor.cardIndex : 0
    let points = 0
    for (let cardIndex = 0; cardIndex < revealedInPack; cardIndex++) points += packCardPoints[packIndex][cardIndex]
    return points
  }, [cursor, packCardPoints])

  /** Running totals per seat, derived from the shared cursor (no wire round-trip). */
  const totals = useMemo(() => {
    let host = 0
    let guest = 0
    for (let packIndex = 0; packIndex < totalPacks; packIndex++) {
      const seat = seatForPack(packIndex, totalPacks)
      const points = packPointsRevealed(packIndex)
      if (seat === 'host' || seat === 'both') host += points
      if (seat === 'guest' || seat === 'both') guest += points
    }
    return { host, guest }
  }, [packPointsRevealed, totalPacks])

  const ceremonyComplete = battlePacks.length > 0
    && cursor.opened
    && cursor.pairIndex === totalPairs - 1
    && cursor.cardIndex >= PACK_BATTLE_LIMITS.cardsPerPack

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

  /** Unseal the round's two packs for both seats (shared cursor, wire-synced). */
  const openPack = () => {
    if (cursor.opened || ceremonyComplete) return
    sessionRef.current?.send({ kind: 'pair-open', pairIndex: cursor.pairIndex })
    setCursor({ pairIndex: cursor.pairIndex, cardIndex: 0, opened: true })
  }

  /** Reveal the next card slot of the round's two packs for both seats. */
  const revealNext = () => {
    if (!cursor.opened || cursor.cardIndex >= PACK_BATTLE_LIMITS.cardsPerPack) return
    sessionRef.current?.send({ kind: 'card-reveal-pair', pairIndex: cursor.pairIndex, cardIndex: cursor.cardIndex })
    setCursor({ ...cursor, cardIndex: cursor.cardIndex + 1 })
  }

  /** Skip: reveal every card of the round's two packs at once. */
  const revealAllPack = () => {
    if (!cursor.opened || cursor.cardIndex >= PACK_BATTLE_LIMITS.cardsPerPack) return
    sessionRef.current?.send({ kind: 'card-reveal-pair', pairIndex: cursor.pairIndex, cardIndex: PACK_BATTLE_LIMITS.cardsPerPack - 1 })
    setCursor({ ...cursor, cardIndex: PACK_BATTLE_LIMITS.cardsPerPack })
  }

  /** Advance to the next round of packs (or finish the ceremony on the last one). */
  const nextPair = () => {
    if (!cursor.opened || cursor.cardIndex < PACK_BATTLE_LIMITS.cardsPerPack) return
    if (cursor.pairIndex >= totalPairs - 1) return
    const next = cursor.pairIndex + 1
    sessionRef.current?.send({ kind: 'pair-open', pairIndex: next })
    setCursor({ pairIndex: next, cardIndex: 0, opened: true })
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

  /**
   * Remappable Confirm/Skip keys drive the shared ceremony beats (bnb's ref
   * pattern): the handler is re-assigned every render, events from interactive
   * elements are ignored, and both keys unseal the round's sealed packs (Skip
   * also reveals every card of both packs at once).
   */
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})

  useEffect(() => {
    keyHandlerRef.current = (event: KeyboardEvent) => {
      if (event.repeat) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return
      if (viewRef.current !== 'opening' || ceremonyComplete) return
      const isConfirm = event.key === readBinding('pokemon-pack-confirm', 'Enter')
      const skipKey = readBinding('pokemon-pack-skip', 'S').toLowerCase()
      const isSkip = skipKey.length > 0 && event.key.toLowerCase() === skipKey
      if (!isConfirm && !isSkip) return
      if (!cursor.opened) {
        openPack()
        return
      }
      if (cursor.cardIndex < PACK_BATTLE_LIMITS.cardsPerPack) {
        if (isSkip) revealAllPack()
        else if (isConfirm) revealNext()
        return
      }
      if (isConfirm) nextPair()
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

  // CP4/CP7 opening ceremony: each round unseals one pack per seat side by side
  // (host's pack left, guest's right) and reveals the matching card slot in both
  // packs at once — either seat's reveal counts for both. The packs-left counter
  // sits top-right in the top bar, the running seat totals update per reveal,
  // and tier-0..5 flair rides the revealed card cell.
  if (view === 'opening') {
    const pairIndexes = packIndexesInPair(cursor.pairIndex, totalPacks)
    const packsLeft = Math.max(0, settings.packs - (cursor.pairIndex + 1))
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
              : substituteParams(translate('packBattle.packProgress'), { current: String(cursor.pairIndex + 1), total: String(totalPairs) })}
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
          {!ceremonyComplete && (
            <div className="ppb-actions ppb-ceremony-actions">
              {!cursor.opened && <p className="ppb-hint ppb-ceremony-hint">{translate('packBattle.ceremonyOpenHint')}</p>}
              {cursor.opened && cursor.cardIndex < PACK_BATTLE_LIMITS.cardsPerPack && (
                <>
                  <p className="ppb-hint ppb-ceremony-hint">{translate('packBattle.ceremonyRevealHint')}</p>
                  <button type="button" onClick={revealAllPack}>{translate('packBattle.actionRevealPack')}</button>
                </>
              )}
              {cursor.opened && cursor.cardIndex >= PACK_BATTLE_LIMITS.cardsPerPack && (
                <button className="ppb-primary" type="button" onClick={nextPair}>{translate('packBattle.actionNextPack')}</button>
              )}
            </div>
          )}
          {/* The last round holds fully revealed behind the click gate: only then
              does the summary become reachable. */}
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
            className="ppb-pair"
            role="group"
            aria-label={substituteParams(translate('packBattle.packProgress'), { current: String(cursor.pairIndex + 1), total: String(totalPairs) })}
          >
            {pairIndexes.map((packIndex) => {
              const seat = seatForPack(packIndex, totalPacks)
              const owner = seat === 'both' ? translate('packBattle.bothRole') : seatName(seat)
              const packCards = cursor.opened
                ? battlePacks.slice(packIndex * PACK_BATTLE_LIMITS.cardsPerPack, packIndex * PACK_BATTLE_LIMITS.cardsPerPack + PACK_BATTLE_LIMITS.cardsPerPack)
                : []
              const packPoints = packPointsRevealed(packIndex)
              return (
                <section
                  className="ppb-pack"
                  key={packIndex}
                  aria-label={substituteParams(translate('packBattle.packOwner'), { name: owner })}
                >
                  <header className="ppb-pack-head">
                    <span className="ppb-pack-owner">{owner}</span>
                    {packPoints > 0 && (
                      <span className="ppb-pack-points">
                        {substituteParams(translate('packBattle.packPoints'), { points: String(packPoints) })}
                      </span>
                    )}
                  </header>
                  <ol className={`ppb-card-row${cursor.opened ? ' ppb-row-open' : ''}`}>
                    {!cursor.opened && (
                      <li className="ppb-sealed-cell">
                        <button
                          className="ppb-sealed"
                          type="button"
                          title={translate('packBattle.sealedPackLabel')}
                          aria-label={substituteParams(translate('packBattle.openPackLabel'), { name: owner })}
                          onClick={openPack}
                        >
                          <span aria-hidden="true">⬢</span>
                        </button>
                      </li>
                    )}
                    {packCards.map((opened, index) => {
                      // 04.1-CP2: visuals trail the shared cursor through the
                      // cascade (`revealedAnim` ramps at ~120 ms/card); totals
                      // and the wire read `cursor.cardIndex` directly.
                      const revealed = index < Math.min(cursor.cardIndex, revealedAnim)
                      const points = pointsForCard(opened.card)
                      return (
                        <li
                          key={`${packIndex}-${opened.card.id}-${index}`}
                          className={`ppb-card-cell ppb-tier-${revealed ? tierForCard(opened.card) : 0} ppb-slot-${index}`}
                        >
                          {revealed ? (
                            <PokemonCard card={opened.card} rarityLabel={rarityLabel(opened.card.rarity)} />
                          ) : (
                            <button
                              className="ppb-card-button"
                              type="button"
                              aria-label={substituteParams(translate('packBattle.revealCardLabel'), { index: String(index + 1), total: String(PACK_BATTLE_LIMITS.cardsPerPack), name: owner })}
                              onClick={revealNext}
                            >
                              <PokemonCard card={opened.card} faceDown faceDownLabel={translate('packBattle.cardFaceDown')} />
                            </button>
                          )}
                          {revealed && points > 0 && (
                            <span
                              className="ppb-card-points"
                              aria-label={substituteParams(translate('packBattle.cardPoints'), { points: String(points) })}
                            >
                              +{points}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                </section>
              )
            })}
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







