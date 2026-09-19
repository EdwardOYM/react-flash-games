// Pokemon TCG B&B mini — peer-to-peer Build & Battle limited format.
// CP7-E-c: the deck-ready handshake (deckIds, one entry per copy) feeds
// beginBattle(), which runs setupBattle from the shared seed with both decks
// resolved against the identical opened pool; the loading view holds for a
// short beat (Tron's 500 ms pattern) before the battle view (E-d renders it).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPreferredLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { SettingsModal } from '../../settings'
import type { CardDef, CardRarity, SetId } from './cards'
import { buildPoolIsValid, type DeckLegalityReason } from './deck'
import { STATUS_CONDITIONS, applySnapshot, applyTimeout, processAction, setupBattle, toSnapshot, type BattleAction, type BattleLogEntry, type BattleState, type SideState, type Snapshot } from './game-core'
import { LOBBY_LIMITS, PROTOCOL_VERSION, clampLobbySettings, defaultLobbySettings, type LobbySettings, type NetMessage, type PlayerSlot } from './net/protocol'
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

/** Condition id -> translated label (battle panels and log params). */
const CONDITION_LABEL_KEYS: Record<string, TranslationKey> = {
  asleep: 'pokemonBnb.conditionAsleep',
  paralyzed: 'pokemonBnb.conditionParalyzed',
  confused: 'pokemonBnb.conditionConfused',
  poisoned: 'pokemonBnb.conditionPoisoned',
  burned: 'pokemonBnb.conditionBurned',
}

/** Engine win reason -> translated label (match-over banner). */
const WIN_REASON_KEYS: Record<string, TranslationKey> = {
  prizes: 'pokemonBnb.winReasonPrizes',
  'deck-out': 'pokemonBnb.winReasonDeckOut',
  'no-pokemon': 'pokemonBnb.winReasonNoPokemon',
}

type BattlePanelProps = {
  heading: string
  side: SideState
  prizeTotal: number
  /** The viewer's own panel lists its hand names; the foe's stays count-only. */
  isSelf: boolean
  t: (key: TranslationKey) => string
  conditionLabel: (status: string) => string
  /** CP8-C: translated rarity chip for PokemonCard faces. */
  rarityLabelFor: (rarity: CardRarity) => string
  /** CP8-C: translated face-down back label for PokemonCard. */
  faceDownLabel: string
  /** CP8-C: only the viewer's own bench is selectable. */
  isSelectableBench: boolean
  selectedBench: number | null
  onSelectBench?: (index: number | null) => void
  /** CP8-C: own-hand pick; the foe's hand stays count-only. */
  selectedHand: number | null
  onSelectHand?: (index: number | null) => void
}

/** One battle side panel: zone counters, Active face, bench, own hand. */
function BattlePanel({ heading, side, prizeTotal, isSelf, t, conditionLabel, rarityLabelFor, faceDownLabel, isSelectableBench, selectedBench, onSelectBench, selectedHand, onSelectHand }: BattlePanelProps) {
  const active = side.active
  const activeConditions: string[] = []
  const activeStatuses: string[] = []
  if (active) {
    for (const status of STATUS_CONDITIONS) {
      if (active.conditions[status]) {
        activeConditions.push(conditionLabel(status))
        activeStatuses.push(status)
      }
    }
  }
  return (
    <section className={`bnb-side${isSelf ? ' bnb-side-self' : ' bnb-side-foe'}`}>
      <header className="bnb-side-head">
        <span className="bnb-side-name">{heading}</span>
        <span className="bnb-side-zones">
          {t('pokemonBnb.zoneHand')} {side.hand.length}
          <span className="bnb-status-sep" aria-hidden="true">·</span>
          {t('pokemonBnb.zoneDeck')} {side.deck.length}
          <span className="bnb-status-sep" aria-hidden="true">·</span>
          {t('pokemonBnb.zonePrizes')} {side.prizeCount}/{prizeTotal}
          <span className="bnb-status-sep" aria-hidden="true">·</span>
          {t('pokemonBnb.zoneDiscard')} {side.discard.length}
        </span>
      </header>
      <div className="bnb-side-active">
        {active
          ? (
            <div className="bnb-active-face">
              <PokemonCard
                card={active.card}
                rarityLabel={rarityLabelFor(active.card.rarity)}
                faceDownLabel={faceDownLabel}
                damage={active.damage}
                statuses={activeStatuses}
              />
              <p className="bnb-side-energy-line">
                <span className="bnb-side-energy">⚡{active.attachedEnergy.length}</span>
                {activeConditions.length > 0 && <span className="bnb-side-conditions">{activeConditions.join(' / ')}</span>}
              </p>
            </div>
          )
          : <span className="bnb-side-card">{t('pokemonBnb.zoneActive')}: —</span>}
      </div>
      <div className="bnb-side-bench">
        <span className="bnb-side-bench-label">{t('pokemonBnb.zoneBench')}</span>
        {side.bench.length > 0
          ? (
            <ol className="bnb-bench-list">
              {side.bench.map((pokemon, index) => {
                const benchStatuses: string[] = []
                for (const status of STATUS_CONDITIONS) {
                  if (pokemon.conditions[status]) benchStatuses.push(status)
                }
                const selected = isSelectableBench && selectedBench === index
                const targetHint = substituteParams(t('pokemonBnb.selectTarget'), { index: String(index + 1) })
                const face = (
                  <span className="bnb-bench-face">
                    <PokemonCard
                      card={pokemon.card}
                      rarityLabel={rarityLabelFor(pokemon.card.rarity)}
                      faceDownLabel={faceDownLabel}
                      damage={pokemon.damage}
                      statuses={benchStatuses}
                    />
                    <span className="bnb-side-energy">⚡{pokemon.attachedEnergy.length}</span>
                  </span>
                )
                return (
                  <li key={pokemon.uid}>
                    {isSelectableBench
                      ? (
                        <button
                          type="button"
                          className="bnb-bench-pick"
                          aria-pressed={selected}
                          aria-label={`${pokemon.card.name} — ${targetHint}`}
                          onClick={() => onSelectBench?.(selected ? null : index)}
                        >
                          {face}
                        </button>
                      )
                      : face}
                  </li>
                )
              })}
            </ol>
          )
          : <span aria-hidden="true">—</span>}
      </div>
      {isSelf && side.hand.length > 0 && (
        <div className="bnb-side-hand">
          <ol className="bnb-hand-list">
            {side.hand.map((card, index) => {
              const selected = selectedHand === index
              return (
                <li key={`${card.id}-${index}`}>
                  <button
                    type="button"
                    className="bnb-hand-pick"
                    aria-pressed={selected}
                    aria-label={`${t('pokemonBnb.selectHandCard')} — ${card.name}`}
                    onClick={() => onSelectHand?.(selected ? null : index)}
                  >
                    <span className="bnb-hand-chip">{card.name}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}

type LocalSeatControlsProps = {
  actor: PlayerSlot
  side: SideState
  promotionPending: boolean
  onAction: (action: BattleAction) => void
  t: (key: TranslationKey) => string
}

/**
 * CP7-F dev harness: one seat's manual controls for the `?local=1` hot-seat
 * battle. Buttons carry the technical action ids on purpose (dev/QA only,
 * never shown to normal players); the target select uses translated zone
 * labels. Engine rejections surface through the translated error slot.
 */
function LocalSeatControls({ actor, side, promotionPending, onAction, t }: LocalSeatControlsProps) {
  const [handIndex, setHandIndex] = useState(0)
  const [target, setTarget] = useState<'active' | number>('active')
  const safeIndex = Math.min(handIndex, Math.max(side.hand.length - 1, 0))
  const active = side.active
  return (
    <fieldset className="bnb-harness-seat">
      <legend className="bnb-side-name">{actor}</legend>
      <div className="bnb-harness-row">
        <select className="bnb-harness-select" value={safeIndex} onChange={(event) => setHandIndex(Number(event.target.value))}>
          {side.hand.map((card, index) => <option key={`${card.id}-${index}`} value={index}>{card.name}</option>)}
        </select>
        <select className="bnb-harness-select" value={String(target)} onChange={(event) => setTarget(event.target.value === 'active' ? 'active' : Number(event.target.value))}>
          <option value="active">{t('pokemonBnb.zoneActive')}</option>
          {side.bench.map((_, index) => <option key={index} value={index}>{t('pokemonBnb.zoneBench')} {index + 1}</option>)}
        </select>
      </div>
      <div className="bnb-harness-row">
        <button type="button" onClick={() => onAction({ type: 'attachEnergy', handIndex: safeIndex, target })}>attachEnergy</button>
        <button type="button" onClick={() => onAction({ type: 'playTrainer', handIndex: safeIndex })}>playTrainer</button>
        <button type="button" onClick={() => onAction({ type: 'evolve', handIndex: safeIndex, target })}>evolve</button>
      </div>
      <div className="bnb-harness-row">
        <button type="button" onClick={() => onAction({ type: 'retreatToBench', benchIndex: 0 })}>retreatToBench</button>
        <button type="button" disabled={!promotionPending} onClick={() => onAction({ type: 'promoteActive', benchIndex: 0 })}>promoteActive</button>
        <button type="button" onClick={() => onAction({ type: 'endTurn' })}>endTurn</button>
      </div>
      {active && (
        <div className="bnb-harness-row">
          {active.card.attacks.map((attack, attackIndex) => (
            <button key={`${attack.name}-${attackIndex}`} type="button" onClick={() => onAction({ type: 'useAttack', attackIndex })}>{attack.name}</button>
          ))}
        </div>
      )}
    </fieldset>
  )
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
  /** CP9-D: peer channel down mid-match; drives the battle connection banner. */
  const [connLost, setConnLost] = useState(false)
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
  /** Opponent's deck-ready id list; kept until the next match reset. */
  const opponentDeckIdsRef = useRef<string[] | null>(null)
  /** Battle state for the current match (null until both decks are ready). */
  const [battle, setBattle] = useState<BattleState | null>(null)
  /** Last rejected action code from the engine; shown translated in-battle. */
  const [battleError, setBattleError] = useState<string | null>(null)
  /** CP8-B selection state: hand/bench/attack picks for the turn action bar. */
  const [selHand, setSelHand] = useState<number | null>(null)
  const [selBench, setSelBench] = useState<number | null>(null)
  // CP8-B reserved: attacks fire directly per-button (D-1), so this stays
  // unused until a future pass needs an attack pick.
  const [_selAttack, setSelAttack] = useState<number | null>(null)
  const clearBattleSelection = useCallback(() => {
    setSelHand(null)
    setSelBench(null)
    setSelAttack(null)
  }, [])
  void _selAttack
  // CP8-C/D tabletop + action bar now consume the selection above.
  /** CP8-D help overlay: local dialog state, cleared on match reset. */
  const [helpOpen, setHelpOpen] = useState(false)
  const sessionRef = useRef<SessionBase | null>(null)
  const roleRef = useRef<Role | null>(null)
  const viewRef = useRef<View>('start')
  /** CP9-D mirror of `connLost` for the stable session callbacks. */
  const connLostRef = useRef(false)
  const noticeTimerRef = useRef<number | null>(null)
  const settingsRef = useRef<LobbySettings>(settings)
  const nameRef = useRef('')
  const openingReadyRef = useRef(false)
  const closingRef = useRef(false)
  const copyTimerRef = useRef<number | null>(null)
  const messageHandlerRef = useRef<(message: NetMessage) => void>(() => undefined)
  const battleRef = useRef<BattleState | null>(null)
  const battleLogRef = useRef<HTMLOListElement | null>(null)

  /** CP7-F dev harness: `?local=1` hot-seat battle (dev/QA only). */
  const localMode = useMemo(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('local') === '1',
    [],
  )
  useEffect(() => {
    // Host-authoritative play (CP9-B) keeps the live engine state in
    // `battleRef`; the rendered `battle` is a view-only snapshot there, so it
    // must never sync back over the authoritative state (defect fix found
    // while wiring the CP9-C timer).
    if (battle && !battle.viewOnly) battleRef.current = battle
  }, [battle])

  // Mirror of the current view for the stable session callbacks (CP9-D).
  useEffect(() => { viewRef.current = view }, [view])

  /**
   * CP9-B host broadcast: send each seat its own privacy-scoped snapshot over
   * the single peer connection (one `battle-snapshot` frame per seat; the
   * guest applies the second). Host-authoritative: the host keeps the live
   * engine state in `battleRef` and both seats render from snapshots.
   */
  const broadcastBattle = useCallback((state: BattleState) => {
    sessionRef.current?.send({ kind: 'battle-snapshot', snapshot: { snapshot: toSnapshot(state, 'host') } })
    sessionRef.current?.send({ kind: 'battle-snapshot', snapshot: { snapshot: toSnapshot(state, 'guest') } })
    battleRef.current = state
    setBattle(applySnapshot(toSnapshot(state, 'host')))
  }, [])

  /**
   * CP9-C turn timer wall clock. Elapsed time is recorded per turn key (match
   * seed + turn + seat + limit) and `secondsLeft` is derived during render, so
   * a new turn starts from a full timer with no reset effect, a mid-turn action
   * (which re-broadcasts a snapshot) cannot refund time, and pause/resume
   * freezes rather than resets the clock (CP8-D note resolved). On expiry the
   * host -- and the `?local=1` harness -- runs `applyTimeout` on the live
   * authoritative state and broadcasts; the guest only displays. `0` disables.
   */
  const timerSeconds = battle?.timerSeconds ?? 0
  const battleTurn = battle?.turn ?? 0
  const battleActivePlayer = battle?.activePlayer
  const battleOver = battle?.over ?? false
  const [turnTimer, setTurnTimer] = useState<{ key: string; elapsed: number } | null>(null)
  const timerSeedKey = `${matchSeed ?? 0}:${battleTurn}:${battleActivePlayer ?? ''}:${timerSeconds}`
  const timerSeeded = turnTimer !== null && turnTimer.key === timerSeedKey ? turnTimer : null
  const timerVisible = (view === 'playing' || view === 'paused') && timerSeconds > 0 && !battleOver
  const secondsLeft = timerVisible ? Math.max(0, timerSeconds - (timerSeeded?.elapsed ?? 0)) : null
  useEffect(() => {
    // Ticks only while playing, so the paused table freezes the clock.
    if (view !== 'playing' || !timerVisible) return
    const elapsed = timerSeeded?.elapsed ?? 0
    if (elapsed < timerSeconds) {
      const tick = window.setTimeout(() => {
        setTurnTimer((prev) => ({ key: timerSeedKey, elapsed: (prev && prev.key === timerSeedKey ? prev.elapsed : 0) + 1 }))
      }, 1000)
      return () => window.clearTimeout(tick)
    }
    // Expiry: only the authoritative seat forfeits the turn and broadcasts;
    // the guest waits for the snapshot that ends this turn. Deferred to a
    // macrotask so the effect body does not setState synchronously.
    if (!localMode && roleRef.current !== 'host') return
    const fire = window.setTimeout(() => {
      const live = battleRef.current
      if (!live || live.over || live.timerSeconds <= 0) return
      const next = applyTimeout(live)
      if (next === live) return
      battleRef.current = next
      if (localMode) setBattle(next)
      else broadcastBattle(next)
    }, 0)
    return () => window.clearTimeout(fire)
  }, [view, timerVisible, timerSeeded, timerSeconds, timerSeedKey, localMode, broadcastBattle])

  const displayName = playerName.trim() || t('pokemonBnb.defaultName')
  const isHost = role === 'host'

  const localStartedRef = useRef(false)

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

  const beginBattleRef = useRef<() => void>(() => {})

  const beginBattle = useCallback(() => {
    beginBattleRef.current?.()
  }, [])

  /**
   * CP7-F dev harness: start a hot-seat battle without a peer. Both seats get
   * the same max-pack pool deck from a fresh seed; the match runs entirely on
   * this client through processAction (never touches the peer session).
   */
  const beginLocalBattle = useCallback(() => {
    const entry = getSet(settingsRef.current.set)
    if (!entry) return
    const seed = randomSeed()
    const deck: CardDef[] = openPacks(entry.data.cards, entry.pack, LOBBY_LIMITS.maxPacks, createRng(seed)).map((opened) => opened.card)
    setBattle(setupBattle(settingsRef.current, deck, deck, seed))
    setView('playing')
  }, [])

  const closeSession = useCallback(() => {
    sessionRef.current?.dispose()
    sessionRef.current = null
  }, [])

  /**
   * CP9-D: transient notice that auto-clears, so a disconnect/restore message
   * cannot outlive the moment it describes (the previous one-shot `notice`
   * setter left stale copy on screen until the next state change).
   */
  const showNotice = (key: TranslationKey) => {
    setNotice(key)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, 6000)
  }

  const readMessage = (message: NetMessage) => {
    switch (message.kind) {
      case 'hello': {
        setOpponentName(message.name)
        setNotice(null)
        // The host answers with its identity and the current lobby settings.
        sessionRef.current?.send({ kind: 'hello-ack', name: nameRef.current, protocolVersion: PROTOCOL_VERSION })
        sessionRef.current?.send({ kind: 'lobby-update', settings: clampLobbySettings(settingsRef.current) })
        // CP9-D resync: a re-`hello` means the guest re-dialled after a blip.
        // The host re-sends the per-seat snapshots of the live engine state so
        // the guest can rebuild its view without restarting the match.
        const live = battleRef.current
        if (live && !live.over) {
          broadcastBattle(live)
          setStatus('connected')
          showNotice('pokemonBnb.connectionRestored')
        }
        return
      }
      case 'hello-ack': {
        setOpponentName(message.name)
        setNotice(null)
        // CP9-D: the host answered our re-`hello`, so the link is live again.
        if (connLostRef.current) {
          connLostRef.current = false
          setConnLost(false)
          showNotice('pokemonBnb.connectionRestored')
        }
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
        opponentDeckIdsRef.current = [...message.deckIds]
        setNotice(null)
        if (deckReadyRef.current) {
          setView('loading')
          beginBattle()
        }
        return
      }
      case 'leave': {
        // CP9-D: if the peer leaves mid-battle, say so and stop the match
        // locally (the opponent chose to leave; there is nothing to resync).
        const inBattle = viewRef.current === 'playing' || viewRef.current === 'paused'
        if (roleRef.current === 'host') {
          setOpponentName('')
          setStatus('waiting')
          showNotice(inBattle ? 'pokemonBnb.opponentDisconnected' : 'pokemonBnb.peerLeft')
          if (inBattle) {
            // The opponent chose to leave: end this match locally rather than
            // leave the host parked in a battle that can never resume.
            closeSession()
            roleRef.current = null
            setRole(null)
            setStatus('closed')
            setMatchSeed(null)
            resetMatchState()
            setView('start')
          }
          return
        }
        closeSession()
        roleRef.current = null
        setRole(null)
        setStatus('closed')
        showNotice(inBattle ? 'pokemonBnb.opponentDisconnected' : 'pokemonBnb.peerLeft')
        setView('start')
        return
      }
      case 'battle-action': {
        // Host-authoritative (CP9-B): only the host runs the engine on guest
        // intents. The host validates via processAction, then broadcasts a
        // per-seat snapshot to both seats.
        if (roleRef.current !== 'host') return
        if (!battleRef.current || message.action.player !== 'guest') return
        const action = message.action.action as BattleAction
        const result = processAction(battleRef.current, 'guest', action)
        setBattleError(result.error ?? null)
        broadcastBattle(result.state)
        return
      }
      case 'battle-snapshot': {
        // Guest render path (CP9-B): rebuild the view-only state from the
        // host's snapshot. The guest never runs the engine on it.
        if (roleRef.current !== 'guest') return
        const snapshot = message.snapshot.snapshot as Snapshot
        const next = applySnapshot(snapshot)
        battleRef.current = next
        setBattle(next)
        setBattleError(null)
        setSelHand(null)
        setSelBench(null)
        setSelAttack(null)
        // CP9-D: a snapshot arriving mid-battle is proof the host replayed the
        // authoritative state after our re-dial; clear the connection banner.
        if (connLostRef.current) {
          connLostRef.current = false
          setConnLost(false)
          showNotice('pokemonBnb.connectionRestored')
        }
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
    // Fresh every render: setupBattle needs the final deckIds memo, the
    // opponent's deck ids, the shared seed and the locked lobby settings.
    // CP9-B: the host runs the single authoritative setupBattle, then
    // broadcasts per-seat snapshots so the guest renders from its own view.
    beginBattleRef.current = () => {
      if (matchSeed === null || opponentDeckIdsRef.current === null) return
      const resolveDeck = (ids: string[]): CardDef[] => {
        const defs: CardDef[] = []
        for (const id of ids) {
          const def = openedPool.cards.find((card) => card.id === id)
          if (def) defs.push(def)
        }
        return defs
      }
      const myDeck = resolveDeck(deckIds)
      const foeDeck = resolveDeck(opponentDeckIdsRef.current)
      const state = setupBattle(
        settingsRef.current,
        roleRef.current === 'guest' ? foeDeck : myDeck,
        roleRef.current === 'guest' ? myDeck : foeDeck,
        matchSeed,
      )
      if (localMode) {
        battleRef.current = state
        setBattle(state)
        return
      }
      if (roleRef.current === 'host') {
        broadcastBattle(state)
        return
      }
      // Guest renders from the host's snapshot (arrives right after); nothing
      // to show until then, so keep the loading beat waiting on battle.
      battleRef.current = null
      setBattle(null)
    }
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
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
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
      opponentDeckIdsRef.current = null
      battleRef.current = null
      setBattle(null)
      setBattleError(null)
      setSelHand(null)
      setSelBench(null)
      setSelAttack(null)
      setHelpOpen(false)
      // CP9-D: a new match/leave starts with a healthy connection banner.
      connLostRef.current = false
      setConnLost(false)
    }
  }, [openingReady, opponentReady, deckReady, opponentDeckReady, openedPool])

  // loading -> short beat -> playing (Tron's 500 ms pattern). The timer only
  // starts once the battle state exists, so a failed setup cannot leave a
  // seat staring at a battle that never renders.
  useEffect(() => {
    if (view !== 'loading' || battle === null) return
    const timer = window.setTimeout(() => setView('playing'), 500)
    return () => window.clearTimeout(timer)
  }, [view, battle])

  // Keep the newest battle-log entry visible when the strip overflows.
  useEffect(() => {
    const list = battleLogRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [battle?.log.length])

  // CP7-F dev harness: `?local=1` skips the lobby entirely and starts a
  // hot-seat battle once per page load.
  useEffect(() => {
    if (!localMode || localStartedRef.current) return
    localStartedRef.current = true
    beginLocalBattle()
  }, [localMode, beginLocalBattle])

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
      // CP9-D: never step in mid-battle (a channel blip re-dials without
      // changing the view), and confirm the restore once.
      onPeerConnected: () => {
        setStatus('connected')
        if (!connLostRef.current) return
        // CP9-D: the channel is back. (For a guest re-dial the host replays its
        // snapshots right after this; the view is never re-routed mid-battle.)
        connLostRef.current = false
        setConnLost(false)
        showNotice('pokemonBnb.connectionRestored')
      },
      /**
       * CP9-D: the other seat dropped. Mid-battle the engine state stays intact
       * (host-authoritative, so it can be re-sent on re-`hello`); the banner and
       * `connLost` mark the link as down instead of tearing the match down.
       */
      onPeerDisconnected: () => {
        if (closingRef.current) return
        const inBattle = viewRef.current === 'playing' || viewRef.current === 'paused'
        if (inBattle) {
          connLostRef.current = true
          setConnLost(true)
          showNotice('pokemonBnb.opponentDisconnected')
          return
        }
        if (roleRef.current === 'guest') {
          closeSession()
          roleRef.current = null
          setRole(null)
          setStatus('closed')
          showNotice('pokemonBnb.opponentDisconnected')
          setView('start')
          return
        }
        setOpponentName('')
        setStatus('waiting')
        showNotice('pokemonBnb.opponentDisconnected')
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
    if (opponentDeckReadyRef.current) {
      setView('loading')
      beginBattle()
    }
  }

  /** Seat display name: lobby names, falling back to the role labels. */
  const seatName = (slot: PlayerSlot): string => {
    if (role === slot) return displayName
    if (opponentName) return opponentName
    return t(slot === 'host' ? 'pokemonBnb.hostRole' : 'pokemonBnb.guestRole')
  }
  const conditionLabel = (status: string): string => {
    const key = CONDITION_LABEL_KEYS[status]
    return key ? t(key) : status
  }
  /** One structured log entry -> player-facing copy (params substituted). */
  const logCopy = (entry: BattleLogEntry): string => {
    const params: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.params ?? {})) {
      if (name === 'player') params[name] = seatName(value as PlayerSlot)
      else if (name === 'status') params[name] = conditionLabel(String(value))
      else params[name] = String(value)
    }
    return substituteParams(t(entry.key as TranslationKey), params)
  }
  /** Engine error code -> translated copy (kebab code -> camelCase key). */
  const battleErrorCopy = (code: string): string => {
    const camel = code.split('-').map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1))).join('')
    return t(`pokemonBnb.error.${camel}` as TranslationKey)
  }

  /**
   * CP9-B host-authoritative action driver. `?local=1` and the host run the
   * engine directly; the guest sends a `battle-action` intent and renders the
   * host's `battle-snapshot` reply (view-only, so it can never inject state).
   * Success clears the hand/bench/attack selection; failure keeps it.
   */
  const runBattleAction = (actor: PlayerSlot, action: BattleAction): boolean => {
    if (!battle) return false
    if (battle.over) {
      setBattleError('match-over')
      return false
    }
    if (!localMode && roleRef.current === 'guest') {
      if (battle.viewOnly) {
        sessionRef.current?.send({ kind: 'battle-action', action: { player: 'guest', action } })
        return true
      }
      setBattleError('view-only')
      return false
    }
    // The authoritative seat (host, or the `?local=1` harness) acts on the live
    // engine state held in `battleRef`; `battle` is only the render snapshot.
    const live = roleRef.current === 'host' && !localMode ? (battleRef.current ?? battle) : battle
    const result = processAction(live, actor, action)
    setBattleError(result.error ?? null)
    if (result.error != null) {
      if (roleRef.current === 'host' && !localMode) {
        battleRef.current = result.state
        setBattle(applySnapshot(toSnapshot(result.state, 'host')))
      } else {
        setBattle(result.state)
      }
      return false
    }
    clearBattleSelection()
    if (roleRef.current === 'host' && !localMode) {
      broadcastBattle(result.state)
    } else {
      battleRef.current = result.state
      setBattle(result.state)
    }
    return true
  }

  /** CP7-F dev harness: delegates to the shared CP8-B action driver. */
  const runLocalAction = (actor: PlayerSlot, action: BattleAction) => {
    runBattleAction(actor, action)
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
    // CP9-D: drop the connection banner state with the session.
    connLostRef.current = false
    setConnLost(false)
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = null
    }
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

  // CP7-E-d: the battle tabletop. Both seats render their own engine state;
  // the opponent's hand stays a count-only line (privacy, per CP6) until the
  // host-authoritative snapshots of CP9 replace this with toSnapshot views.
  // CP8-D: the paused view renders the same tabletop under the pause overlay
  // (CP9 adds the wall-clock pause there; the battle itself is untouched).
  if ((view === 'playing' || view === 'paused') && battle) {
    const mySlot: PlayerSlot = role === 'guest' ? 'guest' : 'host'
    const foeSlot: PlayerSlot = mySlot === 'host' ? 'guest' : 'host'
    return (
      <main className="bnb-page">
        <header className="bnb-topbar">
          <span className="bnb-hud-label">{t('pokemonBnb.title')}</span>
          <div className="bnb-topbar-actions">
            <button type="button" disabled={battle.over} onClick={() => setView('paused')}>{t('pokemonBnb.pause')}</button>
            <button type="button" aria-label={t('pokemonBnb.helpTitle')} onClick={() => setHelpOpen(true)}>?</button>
            <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
            <button type="button" onClick={onExit}>{t('pokemonBnb.exit')}</button>
          </div>
        </header>
        {helpOpen && (
          <div className="bnb-overlay" role="dialog" aria-modal="true" aria-label={t('pokemonBnb.helpTitle')}>
            <div className="bnb-overlay-card">
              <h2>{t('pokemonBnb.helpTitle')}</h2>
              <p className="bnb-copy">{t('pokemonBnb.helpBody')}</p>
              <div className="bnb-actions">
                <button className="bnb-primary" type="button" autoFocus onClick={() => setHelpOpen(false)}>{t('pokemonBnb.cancel')}</button>
              </div>
            </div>
          </div>
        )}
        {view === 'paused' && battle && (
          <div className="bnb-overlay" role="dialog" aria-modal="true" aria-label={t('pokemonBnb.paused')}>
            <div className="bnb-overlay-card">
              <p className="eyebrow">{t('pokemonBnb.title')}</p>
              <h2>{t('pokemonBnb.paused')}</h2>
              <p className="bnb-copy">{t('pokemonBnb.pauseHint')}</p>
              <div className="bnb-actions">
                <button className="bnb-primary" type="button" onClick={() => setView('playing')}>{t('pokemonBnb.resume')}</button>
                <button type="button" onClick={leaveLobby}>{t('pokemonBnb.leaveLobby')}</button>
              </div>
            </div>
          </div>
        )}
        <section className="bnb-battle">
          <header className="bnb-battle-head">
            <p className="bnb-battle-turn">
              {substituteParams(t('pokemonBnb.turnHeader'), { turn: String(battle.turn), player: seatName(battle.activePlayer) })}
              {secondsLeft !== null && battle.timerSeconds > 0 && (
                <span className="bnb-timer">{substituteParams(t('pokemonBnb.timerRemaining'), { count: String(secondsLeft) })}</span>
              )}
            </p>
            {battle.over && battle.winner && (
              <p className="bnb-battle-banner" role="status">
                <span>{t('pokemonBnb.matchOverTitle')}</span>
                <span>{battle.winReason ? `${seatName(battle.winner)} · ${t(WIN_REASON_KEYS[battle.winReason])}` : seatName(battle.winner)}</span>
              </p>
            )}
            {connLost && !battle.over && (
              <p className="bnb-conn-lost" role="status">
                <span>{t('pokemonBnb.opponentDisconnected')}</span>
                <span>{t('pokemonBnb.resyncNotice')}</span>
              </p>
            )}
            {notice && <p className="bnb-notice" role="status">{t(notice)}</p>}
            {battle.pendingPromotion === mySlot && !battle.over && (
              <p className="bnb-notice">{battleErrorCopy('must-promote')}</p>
            )}
          </header>
          {battle.pendingPromotion === mySlot && !battle.over
            ? (
              <div className="bnb-promote-gate" role="dialog" aria-modal="false" aria-label={t('pokemonBnb.promoteTitle')}>
                <p className="bnb-promote-title">{t('pokemonBnb.promoteTitle')}</p>
                <p className="bnb-hint">{t('pokemonBnb.selectTarget').replace('{index}', String((selBench ?? 0) + 1))}</p>
                <div className="bnb-actions">
                  <button
                    className="bnb-primary"
                    type="button"
                    disabled={selBench === null}
                    onClick={() => selBench !== null && runBattleAction(mySlot, { type: 'promoteActive', benchIndex: selBench })}
                  >
                    {t('pokemonBnb.actionPromote').replace('{name}', selBench !== null ? (battle[mySlot].bench[selBench]?.card.name ?? '') : '')}
                  </button>
                </div>
              </div>
            )
            : localMode && battle.pendingPromotion !== null
              ? null
              : (() => {
                const mySide = battle[mySlot]
                const myHandCard = selHand !== null ? mySide.hand[selHand] ?? null : null
                const benchTarget = selBench !== null ? mySide.bench[selBench] ?? null : null
                const isMyTurn = !battle.over && battle.pendingPromotion === null && battle.activePlayer === (localMode ? battle.activePlayer : mySlot)
                const actor: PlayerSlot = localMode ? battle.activePlayer : mySlot
                const attacks = mySide.active?.card.attacks ?? []
                return (
                  <div className="bnb-action-bar" role="toolbar" aria-label={t('pokemonBnb.battleActions')}>
                    {!isMyTurn && !battle.over && (
                      <span className="bnb-waiting" aria-live="polite">
                        {substituteParams(t('pokemonBnb.waitingTurn'), { player: seatName(battle.activePlayer) })}
                      </span>
                    )}
                    {isMyTurn && <span className="bnb-hint">{t('pokemonBnb.yourTurn')}</span>}
                    <div className="bnb-actions">
                      <button
                        type="button"
                        disabled={!isMyTurn || selHand === null}
                        onClick={() => {
                          if (selHand === null) return
                          const target: 'active' | number = selBench !== null ? selBench : 'active'
                          runBattleAction(actor, { type: 'attachEnergy', handIndex: selHand, target })
                        }}
                      >
                        {t('pokemonBnb.actionAttach')}
                      </button>
                      <button
                        type="button"
                        disabled={!isMyTurn || selHand === null}
                        onClick={() => selHand !== null && runBattleAction(actor, { type: 'playTrainer', handIndex: selHand })}
                      >
                        {t('pokemonBnb.actionPlayTrainer')}
                      </button>
                      <button
                        type="button"
                        disabled={!isMyTurn || selHand === null}
                        onClick={() => {
                          if (selHand === null) return
                          const target: 'active' | number = selBench !== null ? selBench : 'active'
                          runBattleAction(actor, { type: 'evolve', handIndex: selHand, target })
                        }}
                      >
                        {t('pokemonBnb.actionEvolve')}
                      </button>
                      <button
                        type="button"
                        disabled={!isMyTurn || selBench === null}
                        onClick={() => selBench !== null && runBattleAction(actor, { type: 'retreatToBench', benchIndex: selBench })}
                      >
                        {t('pokemonBnb.actionRetreat')}
                      </button>
                      {attacks.map((attack, index) => (
                        <button
                          key={attack.name}
                          type="button"
                          disabled={!isMyTurn}
                          aria-label={`${t('pokemonBnb.actionAttack')} — ${attack.name}`}
                          onClick={() => runBattleAction(actor, { type: 'useAttack', attackIndex: index })}
                        >
                          {attack.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={!isMyTurn}
                        onClick={() => runBattleAction(actor, { type: 'endTurn' })}
                      >
                        {t('pokemonBnb.actionEndTurn')}
                      </button>
                    </div>
                    {isMyTurn && selHand === null && <p className="bnb-hint">{t('pokemonBnb.selectHandCard')}</p>}
                    {isMyTurn && myHandCard && benchTarget && <p className="bnb-hint">{myHandCard.name} → {benchTarget.card.name}</p>}
                    {isMyTurn && myHandCard && selBench === null && <p className="bnb-hint">{myHandCard.name} → {t('pokemonBnb.zoneActive')}</p>}
                  </div>
                )
              })()}
          <div className="bnb-battle-main">
            <div className="bnb-battle-table">
              <BattlePanel heading={seatName(foeSlot)} side={battle[foeSlot]} prizeTotal={battle.prizeCards} isSelf={false} t={t} conditionLabel={conditionLabel} rarityLabelFor={rarityLabel} faceDownLabel={t('pokemonBnb.cardFaceDown')} isSelectableBench={false} selectedBench={null} selectedHand={null} />
              <BattlePanel heading={seatName(mySlot)} side={battle[mySlot]} prizeTotal={battle.prizeCards} isSelf t={t} conditionLabel={conditionLabel} rarityLabelFor={rarityLabel} faceDownLabel={t('pokemonBnb.cardFaceDown')} isSelectableBench selectedBench={selBench} onSelectBench={setSelBench} selectedHand={selHand} onSelectHand={setSelHand} />
            </div>
            <ol className="bnb-battle-log" ref={battleLogRef}>
              {battle.log.slice(-24).map((entry, index) => <li key={`${entry.key}-${index}`}>{logCopy(entry)}</li>)}
            </ol>
          </div>
          {localMode && (
            <div className="bnb-battle-harness">
              <p className="bnb-hint">?local=1</p>
              <div className="bnb-battle-harness-seats">
                {(['host', 'guest'] as const).map((actor) => (
                  <LocalSeatControls
                    key={actor}
                    actor={actor}
                    side={battle[actor]}
                    promotionPending={battle.pendingPromotion === actor}
                    onAction={(action) => runLocalAction(actor, action)}
                    t={t}
                  />
                ))}
              </div>
            </div>
          )}
          {battleError && <p className="bnb-error" role="alert">{battleErrorCopy(battleError)}</p>}
        </section>
      </main>
    )
  }

  // Placeholder seat for the post-deck views the battle render does not cover
  // yet (loading beat, pause, results). It shows the locked-in match settings
  // so both clients can verify they agree.
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

