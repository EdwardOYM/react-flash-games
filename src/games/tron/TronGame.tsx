import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { getPreferredLocale, persistLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig, type MobileControlPosition } from '../../config'
import { ControllerSettings, SettingsModal, useControllerVisibility, useInputMode, type AdditionalKeyBinding } from '../../settings'
import {
  bufferTurn,
  continueAfterRound,
  forfeitMatch,
  startRound,
  step,
  stepTutorial,
  turnToward,
  CELL_PX,
  GRID_COLS,
  GRID_ROWS,
  P1_COLOR,
  P2_COLOR,
  TICK_MS,
  type CycleState,
  type Direction,
  type GameState,
  type PlayerId,
  type RoundOutcome,
  type Turn,
} from './game-core'
import '../bubble-trouble/BubbleTroubleGame.css' // reuse the shared .mobile-controls primitives
import { HighscoreTable } from '../highscore/HighscoreTable'
import { readHighscores, recordMatchWin } from './highscores'
import './TronGame.css'

type TronProps = { locale?: Locale; onLocaleChange?: (locale: Locale) => void; onExit: () => void; t?: ReturnType<typeof useTranslations> }
type View = 'start' | 'tutorial' | 'loading' | 'playing' | 'paused' | 'gameover' | 'victory' | 'highscore'

const WIDTH = GRID_COLS * CELL_PX
const HEIGHT = GRID_ROWS * CELL_PX

type DirectionBinding = { id: string; direction: Direction; labelKey: TranslationKey; defaultKey: string }

const DIRECTION_BINDINGS: DirectionBinding[] = [
  { id: 'tron-p1-up', direction: 'up', labelKey: 'keyNames.p1Up', defaultKey: 'w' },
  { id: 'tron-p1-down', direction: 'down', labelKey: 'keyNames.p1Down', defaultKey: 's' },
  { id: 'tron-p1-left', direction: 'left', labelKey: 'keyNames.p1Left', defaultKey: 'a' },
  { id: 'tron-p1-right', direction: 'right', labelKey: 'keyNames.p1Right', defaultKey: 'd' },
  { id: 'tron-p2-up', direction: 'up', labelKey: 'keyNames.p2Up', defaultKey: 'ArrowUp' },
  { id: 'tron-p2-down', direction: 'down', labelKey: 'keyNames.p2Down', defaultKey: 'ArrowDown' },
  { id: 'tron-p2-left', direction: 'left', labelKey: 'keyNames.p2Left', defaultKey: 'ArrowLeft' },
  { id: 'tron-p2-right', direction: 'right', labelKey: 'keyNames.p2Right', defaultKey: 'ArrowRight' },
]

const HEAD_DELTAS: Record<Direction, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  right: { dx: 1, dy: 0 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
}

const tronKeyBindings: AdditionalKeyBinding[] = DIRECTION_BINDINGS.map(({ id, labelKey, defaultKey }) => ({ id, labelKey, defaultKey }))

type StickSlot = 'movement' | 'shoot'
type StickPositions = { movement: MobileControlPosition; shoot: MobileControlPosition }

type TutorialGoal = 'left' | 'right' | 'wall'
const TUTORIAL_STEPS: { goal: TutorialGoal; copyKey: TranslationKey }[] = [
  { goal: 'left', copyKey: 'tron.tutorialTurnLeft' },
  { goal: 'right', copyKey: 'tron.tutorialTurnRight' },
  { goal: 'wall', copyKey: 'tron.tutorialWall' },
]
const WALL_GOAL_TICKS = 12

function playerOf(id: string) { return id.startsWith('tron-p1') ? 'p1' as const : 'p2' as const }

function readKey(id: string) {
  const binding = DIRECTION_BINDINGS.find((candidate) => candidate.id === id)
  return readConfig().settings.keybindings[id] ?? binding?.defaultKey ?? ''
}

function normalizeKey(key: string) { return key.length === 1 ? key.toLowerCase() : key }

function displayKey(id: string) {
  const key = readKey(id)
  return key.length === 1 ? key.toUpperCase() : key
}

function substituteParams(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`)
}

type PlayerNames = { p1: string; p2: string }

/** Display label for a player: their set name, or the localized default. */
function playerLabel(player: PlayerId, names: PlayerNames, t: (key: TranslationKey) => string) {
  return names[player].trim() || t(player === 'p1' ? 'tron.p1' : 'tron.p2')
}

function roundBanner(outcome: RoundOutcome, names: PlayerNames, t: (key: TranslationKey) => string) {
  if (outcome === 'tie') return { text: t('tron.roundTie'), tone: 'neutral' as const }
  return { text: substituteParams(t('tron.roundWonBy'), { player: playerLabel(outcome, names, t) }), tone: outcome }
}

function matchBanner(state: GameState, names: PlayerNames, t: (key: TranslationKey) => string) {
  const winner = state.matchResult?.winner
  if (!winner) return { text: t('tron.gameOver'), tone: 'neutral' as const }
  return { text: substituteParams(t('tron.victory'), { player: playerLabel(winner, names, t) }), tone: winner }
}

function drawBoard(context: CanvasRenderingContext2D, state: GameState | null, fraction: number, p1Color: string, p2Color: string) {
  context.fillStyle = '#050a12'
  context.fillRect(0, 0, WIDTH, HEIGHT)

  context.strokeStyle = 'rgba(39, 75, 102, 0.28)'
  context.lineWidth = 1
  context.beginPath()
  for (let col = 1; col < GRID_COLS; col++) {
    context.moveTo(col * CELL_PX + 0.5, 0)
    context.lineTo(col * CELL_PX + 0.5, HEIGHT)
  }
  for (let row = 1; row < GRID_ROWS; row++) {
    context.moveTo(0, row * CELL_PX + 0.5)
    context.lineTo(WIDTH, row * CELL_PX + 0.5)
  }
  context.stroke()

  if (!state) return

  for (let index = 0; index < state.grid.length; index++) {
    const owner = state.grid[index]
    if (owner === 0) continue
    const col = index % GRID_COLS
    const row = Math.floor(index / GRID_COLS)
    context.fillStyle = owner === 1 ? p1Color : p2Color
    context.globalAlpha = 0.82
    context.fillRect(col * CELL_PX + 1, row * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2)
    context.globalAlpha = 1
  }

  const drawHead = (cycle: CycleState, color: string) => {
    if (!cycle.alive) return
    const delta = HEAD_DELTAS[cycle.direction]
    const x = (cycle.col - delta.dx + fraction * delta.dx) * CELL_PX
    const y = (cycle.row - delta.dy + fraction * delta.dy) * CELL_PX
    context.save()
    context.shadowColor = color
    context.shadowBlur = 14
    context.fillStyle = color
    context.fillRect(x + 1, y + 1, CELL_PX - 2, CELL_PX - 2)
    context.shadowBlur = 0
    context.fillStyle = '#f5fdff'
    context.fillRect(x + 5, y + 5, CELL_PX - 10, CELL_PX - 10)
    context.restore()
  }

  drawHead(state.p1, p1Color)
  drawHead(state.p2, p2Color)
}

function KeybindGroup({ player, label }: { player: 'p1' | 'p2'; label: string }) {
  const ids = DIRECTION_BINDINGS.filter((binding) => playerOf(binding.id) === player).map((binding) => binding.id)
  return (
    <span className={`tron-keybind-group tron-keybind-${player}`}>
      {label ? <span className="tron-keybind-label">{label}</span> : null}
      {ids.map((id) => <kbd key={id}>{displayKey(id)}</kbd>)}
    </span>
  )
}

function MobileSticks({ visible, editable, showP2 = true, p1Label, p2Label, positions, onPositionsChange, onTurn }: { visible: boolean; editable: boolean; showP2?: boolean; p1Label: string; p2Label: string; positions: StickPositions; onPositionsChange: (positions: StickPositions) => void; onTurn: (player: PlayerId, desired: Direction) => void }) {
  const dragRef = useRef<{ slot: StickSlot; offsetX: number; offsetY: number } | null>(null)
  const resizeRef = useRef<{ slot: StickSlot; startScale: number; baseDistance: number } | null>(null)

  const stageOf = (element: HTMLElement) => element.closest('.mobile-controls')?.parentElement

  const startDragging = (slot: StickSlot, event: React.PointerEvent<HTMLElement>) => {
    if (!editable) return
    const stage = stageOf(event.currentTarget)
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const position = positions[slot]
    dragRef.current = { slot, offsetX: event.clientX - (rect.left + rect.width * position.x / 100), offsetY: event.clientY - (rect.top + rect.height * position.y / 100) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const dragControl = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const stage = stageOf(event.currentTarget)
    if (!drag || !stage) return
    const rect = stage.getBoundingClientRect()
    const x = Math.max(2, Math.min(92, ((event.clientX - rect.left - drag.offsetX) / rect.width) * 100))
    const y = Math.max(4, Math.min(84, ((event.clientY - rect.top - drag.offsetY) / rect.height) * 100))
    onPositionsChange({ ...positions, [drag.slot]: { ...positions[drag.slot], x, y } })
  }
  const stopDragging = (event: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onPositionsChange(positions)
  }
  const startResizing = (slot: StickSlot, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (!editable) return
    const stage = stageOf(event.currentTarget)
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const position = positions[slot]
    const centerX = rect.left + rect.width * position.x / 100
    const centerY = rect.top + rect.height * position.y / 100
    resizeRef.current = { slot, startScale: position.scale, baseDistance: Math.max(1, Math.hypot(event.clientX - centerX, event.clientY - centerY)) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const resizeControl = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current
    const stage = stageOf(event.currentTarget)
    if (!resize || !stage) return
    const rect = stage.getBoundingClientRect()
    const position = positions[resize.slot]
    const centerX = rect.left + rect.width * position.x / 100
    const centerY = rect.top + rect.height * position.y / 100
    const distance = Math.max(1, Math.hypot(event.clientX - centerX, event.clientY - centerY))
    const scale = Math.max(0.5, Math.min(2.5, resize.startScale * (distance / resize.baseDistance)))
    onPositionsChange({ ...positions, [resize.slot]: { ...position, scale } })
  }
  const stopResizing = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onPositionsChange(positions)
  }
  // Absolute steering: the stick points where the cycle should travel (push up
  // = travel up). It fires on every move past the dead zone so a held stick
  // keeps steering; applyTurn/turnToward ignore same-heading and reverse
  // (180-degree) inputs, so the cycle can never drive backwards.
  const updateAnalog = (player: PlayerId, event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)))
    const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)))
    element.style.setProperty('--stick-axis-x', x.toFixed(2))
    element.style.setProperty('--stick-axis-y', y.toFixed(2))
    if (Math.hypot(x, y) < 0.3) return
    const desired: Direction = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up')
    onTurn(player, desired)
  }
  const startAnalog = (player: PlayerId, slot: StickSlot, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (editable) {
      startDragging(slot, event)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    updateAnalog(player, event)
  }
  const stopAnalog = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (editable) {
      stopDragging(event)
      return
    }
    event.currentTarget.style.setProperty('--stick-axis-x', '0')
    event.currentTarget.style.setProperty('--stick-axis-y', '0')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className={`mobile-controls${visible ? ' mobile-controls-visible' : ''}${editable ? ' mobile-controls-editable' : ''}`}>
      <div className="mobile-control-group mobile-movement-control tron-p1-stick-group" style={({ left: `${positions.movement.x}%`, top: `${positions.movement.y}%`, '--control-scale': positions.movement.scale, '--control-half': '38px' } as CSSProperties)} onPointerDown={(event) => startDragging('movement', event)} onPointerMove={dragControl} onPointerUp={stopDragging}>
        <div className="mobile-stick" aria-label={p1Label} style={{ transform: `scale(${positions.movement.scale})` }} onPointerDown={(event) => startAnalog('p1', 'movement', event)} onPointerMove={editable ? dragControl : (event) => updateAnalog('p1', event)} onPointerUp={stopAnalog} onPointerCancel={stopAnalog}>
          <span className="mobile-stick-knob" />
        </div>
        <div className="mobile-control-resize" onPointerDown={(event) => startResizing('movement', event)} onPointerMove={resizeControl} onPointerUp={stopResizing} onPointerCancel={stopResizing} />
      </div>
      <div className="mobile-control-group mobile-shoot-control tron-p2-stick-group" style={({ left: `${positions.shoot.x}%`, top: `${positions.shoot.y}%`, '--control-scale': positions.shoot.scale, '--control-half': '38px' } as CSSProperties)} onPointerDown={(event) => startDragging('shoot', event)} onPointerMove={dragControl} onPointerUp={stopDragging}>
        {showP2 && <div className="mobile-stick" aria-label={p2Label} style={{ transform: `scale(${positions.shoot.scale})` }} onPointerDown={(event) => startAnalog('p2', 'shoot', event)} onPointerMove={editable ? dragControl : (event) => updateAnalog('p2', event)} onPointerUp={stopAnalog} onPointerCancel={stopAnalog}>
          <span className="mobile-stick-knob" />
        </div>}
        {showP2 && <div className="mobile-control-resize" onPointerDown={(event) => startResizing('shoot', event)} onPointerMove={resizeControl} onPointerUp={stopResizing} onPointerCancel={stopResizing} />}
      </div>
    </div>
  )
}

export function TronGame(props: TronProps) {
  const { locale: providedLocale, onExit, onLocaleChange, t: providedTranslations } = props
  const [locale, setLocale] = useState<Locale>(providedLocale ?? getPreferredLocale())
  const translations = useTranslations(locale)
  const t = providedTranslations ?? translations
  const inputMode = useInputMode()
  const controllerVisible = useControllerVisibility()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef<GameState | null>(null)
  const lastTickRef = useRef(0)
  const viewRef = useRef<View>('start')
  const pressedKeysRef = useRef<Set<string>>(new Set())

  const [view, setView] = useState<View>('start')
  const [roundsToWin, setRoundsToWin] = useState(5)
  const [p1Color, setP1Color] = useState(P1_COLOR)
  const [p2Color, setP2Color] = useState(P2_COLOR)
  const [snapshot, setSnapshot] = useState<GameState | null>(null)
  const [mobilePositions, setMobilePositions] = useState<StickPositions>(() => readConfig().settings.mobileControls)
  const [savedMobilePositions, setSavedMobilePositions] = useState<StickPositions>(() => readConfig().settings.mobileControls)
  const [editingControls, setEditingControls] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false)
  const [tutorialStep, setTutorialStep] = useState(0)
  const [tutorialDone, setTutorialDone] = useState(false)
  const [highscores, setHighscores] = useState(() => readHighscores())
  const [playerNames, setPlayerNames] = useState<PlayerNames>({ p1: '', p2: '' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const tutorialStepRef = useRef(0)
  // Guards the one-time win record for the current match.
  const recordedMatchRef = useRef(false)

  useEffect(() => { viewRef.current = view }, [view])

  useEffect(() => { tutorialStepRef.current = tutorialStep }, [tutorialStep])

  const changeLocale = useCallback((nextLocale: Locale) => {
    setLocale(nextLocale)
    onLocaleChange?.(nextLocale)
    persistLocale(nextLocale)
  }, [onLocaleChange])

  useEffect(() => {
    if (view !== 'loading') return
    const timer = window.setTimeout(() => setView('playing'), 500)
    return () => window.clearTimeout(timer)
  }, [view])

  const startMatch = useCallback(() => {
    recordedMatchRef.current = false
    const next = startRound(null, roundsToWin)
    stateRef.current = next
    setSnapshot(next)
    setView('loading')
  }, [roundsToWin])

  const handleExitToStart = useCallback(() => {
    stateRef.current = null
    setSnapshot(null)
    setView('start')
  }, [])

  const handlePause = useCallback(() => setView('paused'), [])

  const handleResume = useCallback(() => {
    lastTickRef.current = performance.now()
    setView('playing')
  }, [])

  const handleForfeit = useCallback(() => {
    const state = stateRef.current
    if (!state || state.phase === 'matchOver') return
    const next = forfeitMatch(state)
    stateRef.current = next
    setSnapshot(next)
    setView('gameover')
  }, [])

  const handleContinue = useCallback(() => {
    const state = stateRef.current
    if (!state) return
    if (state.phase === 'roundOver') {
      const next = continueAfterRound(state)
      stateRef.current = next
      setSnapshot(next)
      lastTickRef.current = performance.now()
    }
  }, [])

  const updateMobilePositions = useCallback((positions: StickPositions) => setMobilePositions(positions), [])

  const beginControllerAdjustment = useCallback(() => {
    setMobilePositions(savedMobilePositions)
    setEditingControls(true)
    setControlsOpen(false)
    setView('paused')
  }, [savedMobilePositions])

  const saveControllerAdjustment = useCallback(() => {
    updateConfig((config) => ({ ...config, settings: { ...config.settings, mobileControls: mobilePositions } }))
    setSavedMobilePositions(mobilePositions)
    setEditingControls(false)
  }, [mobilePositions])

  const exitControllerAdjustment = useCallback(() => {
    setMobilePositions(savedMobilePositions)
    setEditingControls(false)
  }, [savedMobilePositions])

  const startTutorial = useCallback(() => {
    const state = startRound(null, roundsToWin)
    // Park P2 safely in a corner, facing away from the arena.
    stateRef.current = { ...state, p2: { col: GRID_COLS - 2, row: 1, direction: 'up', alive: true, path: [] } }
    setSnapshot(stateRef.current)
    setTutorialStep(0)
    tutorialStepRef.current = 0
    setTutorialDone(false)
    setView('tutorial')
  }, [roundsToWin])

  const handleTutorialTurn = useCallback((turn: Turn) => {
    setTutorialStep((step) => (turn === 'left' && step === 0 ? 1 : turn === 'right' && step === 1 ? 2 : step))
  }, [])

  // A decisive match win is recorded once per match, under the winner's name.
  // Forfeits and ties record nothing.
  useEffect(() => {
    if (view !== 'victory') return
    const state = stateRef.current
    const winner = state?.matchResult?.winner
    if (!winner || recordedMatchRef.current) return
    recordedMatchRef.current = true
    const entries = recordMatchWin(playerLabel(winner, playerNames, t))
    setHighscores(entries ?? [])
  }, [view, playerNames, t])
  // `desired` is an absolute travel direction (stick up = travel up, key
  // binding up = travel up). turnToward() converts it to the single buffered
  // 90-degree turn and returns null for the current heading or its reverse,
  // so a cycle can never drive backwards.
  const applyTurn = useCallback((player: PlayerId, desired: Direction): Turn | null => {
    const state = stateRef.current
    if (!state || state.phase !== 'playing') return null
    const cycle = player === 'p1' ? state.p1 : state.p2
    const turn = turnToward(cycle.direction, desired)
    if (!turn) return null
    const pending = player === 'p1' ? state.p1Turn : state.p2Turn
    if (pending === turn) return turn // already queued; skip redundant buffering
    stateRef.current = bufferTurn(state, player, turn)
    return turn
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const key = normalizeKey(event.key)
      const binding = DIRECTION_BINDINGS.find((candidate) => normalizeKey(readKey(candidate.id)) === key)
      if (!binding) return
      if (viewRef.current !== 'playing' && viewRef.current !== 'tutorial') return
      event.preventDefault()
      if (pressedKeysRef.current.has(binding.id)) return
      pressedKeysRef.current.add(binding.id)
      const applied = applyTurn(playerOf(binding.id), binding.direction)
      if (viewRef.current === 'tutorial' && applied) handleTutorialTurn(applied)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      const key = normalizeKey(event.key)
      const binding = DIRECTION_BINDINGS.find((candidate) => normalizeKey(readKey(candidate.id)) === key)
      if (binding) pressedKeysRef.current.delete(binding.id)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [applyTurn, handleTutorialTurn])

  useEffect(() => {
    if (view !== 'playing') return
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const render = (fraction: number) => drawBoard(context, stateRef.current, fraction, p1Color, p2Color)

    let frame = 0
    const loop = () => {
      const state = stateRef.current
      if (state) {
        if (state.phase === 'playing') {
          const now = performance.now()
          if (now - lastTickRef.current >= TICK_MS) {
            lastTickRef.current = now
            const next = step(state)
            stateRef.current = next
            render(0)
            if (next.phase !== 'playing') setSnapshot(next)
            if (next.phase === 'matchOver') setView('victory')
          } else {
            render(Math.min((now - lastTickRef.current) / TICK_MS, 1))
          }
        } else {
          render(1)
        }
      }
      frame = requestAnimationFrame(loop)
    }

    lastTickRef.current = performance.now()
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [view, p1Color, p2Color])

  useEffect(() => {
    if (view !== 'tutorial') return
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const render = (fraction: number) => drawBoard(context, stateRef.current, fraction, p1Color, p2Color)

    let frame = 0
    const loop = () => {
      const state = stateRef.current
      if (state) {
        const now = performance.now()
        if (now - lastTickRef.current >= TICK_MS) {
          lastTickRef.current = now
          const next = stepTutorial(state)
          stateRef.current = next
          render(0)
          if (tutorialStepRef.current === 2 && next.tick >= WALL_GOAL_TICKS) {
            setTutorialStep(3)
            setTutorialDone(true)
          }
        } else {
          render(Math.min((now - lastTickRef.current) / TICK_MS, 1))
        }
      }
      frame = requestAnimationFrame(loop)
    }

    lastTickRef.current = performance.now()
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [view, p1Color, p2Color])

  const accentVars = { '--tron-p1': p1Color, '--tron-p2': p2Color } as CSSProperties

  const controlsPanel = controlsOpen && (
    <div className="tron-controls-overlay">
      <div className="tron-controls-card">
        <p className="eyebrow">{t('tron.controls')}</p>
        <h2>{t('tron.controls')}</h2>
        <ControllerSettings t={t} additionalBindings={tronKeyBindings} onRemapController={beginControllerAdjustment} />
        <div className="tron-actions">
          <button type="button" onClick={() => setControlsOpen(false)}>{t('tron.back')}</button>
        </div>
      </div>
    </div>
  )

  const gameSettings = settingsOpen && (
    <SettingsModal locale={locale} onClose={() => setSettingsOpen(false)} onLocaleChange={changeLocale} t={t} additionalBindings={tronKeyBindings} />
  )

  if (view === 'start') {
    return (
      <main className="tron-page" style={accentVars}>
        <div className="tron-shell">
          <p className="eyebrow">{t('games.tron')}</p>
          <h1>{t('tron.title')}</h1>
          <p className="tron-description">{t('tron.description')}</p>
          {inputMode === 'keyboard' && (
            <div className="tron-keybinds" aria-label={t('keybinds')}>
              <KeybindGroup player="p1" label={playerLabel('p1', playerNames, t)} />
              <KeybindGroup player="p2" label={playerLabel('p2', playerNames, t)} />
            </div>
          )}
          <div className="tron-setup">
            <label className="tron-setup-field">
              <span className="tron-field-label">{t('tron.player1Name')}</span>
              <input type="text" maxLength={12} autoComplete="off" spellCheck={false} value={playerNames.p1} placeholder={t('tron.namePlaceholder')} onChange={(event) => setPlayerNames((names) => ({ ...names, p1: event.target.value }))} />
            </label>
            <label className="tron-setup-field">
              <span className="tron-field-label">{t('tron.player2Name')}</span>
              <input type="text" maxLength={12} autoComplete="off" spellCheck={false} value={playerNames.p2} placeholder={t('tron.namePlaceholder')} onChange={(event) => setPlayerNames((names) => ({ ...names, p2: event.target.value }))} />
            </label>
            <div className="tron-setup-field">
              <span className="tron-field-label" id="tron-rounds-label">{t('tron.roundsToWin')}</span>
              <div className="tron-stepper" role="group" aria-labelledby="tron-rounds-label">
                <button type="button" aria-label={t('tron.stepperDecrease')} disabled={roundsToWin <= 1} onClick={() => setRoundsToWin((rounds) => Math.max(1, rounds - 1))}>−</button>
                <span className="tron-stepper-value" aria-live="polite">{roundsToWin}</span>
                <button type="button" aria-label={t('tron.stepperIncrease')} disabled={roundsToWin >= 9} onClick={() => setRoundsToWin((rounds) => Math.min(9, rounds + 1))}>+</button>
              </div>
            </div>
            <label className="tron-setup-field">
              <span className="tron-field-label">{t('tron.player1Color')}</span>
              <input type="color" value={p1Color} onChange={(event) => setP1Color(event.target.value)} />
            </label>
            <label className="tron-setup-field">
              <span className="tron-field-label">{t('tron.player2Color')}</span>
              <input type="color" value={p2Color} onChange={(event) => setP2Color(event.target.value)} />
            </label>
          </div>
          <div className="tron-menu">
            <button className="tron-primary" type="button" onClick={startMatch}>{t('tron.startMatch')}</button>
            <button type="button" onClick={startTutorial}>{t('tron.tutorial')}</button>
            <button type="button" onClick={() => setControlsOpen(true)}>{t('tron.controls')}</button>
            <button type="button" onClick={() => setSettingsOpen(true)}>{t('settings')}</button>
            <button type="button" onClick={onExit}>{t('tron.exit')}</button>
          </div>
        </div>
        <section className="tron-highscores">
          <p className="eyebrow">{t('tron.highscore')}</p>
          <HighscoreTable entries={highscores} labels={{ rank: t('tron.rank'), playerName: t('tron.player'), score: t('tron.wins'), noScores: t('tron.noScores') }} />
        </section>
        {gameSettings}
        {controlsPanel}
      </main>
    )
  }

  if (view === 'tutorial') {
    const step = TUTORIAL_STEPS[Math.min(tutorialStep, TUTORIAL_STEPS.length - 1)]
    return (
      <main className="tron-page tron-gameplay-page tron-tutorial-page" style={accentVars}>
        <div className="tron-hud">
          <span>{t('tron.tutorialTitle')}: {tutorialDone ? TUTORIAL_STEPS.length : tutorialStep + 1} / {TUTORIAL_STEPS.length}</span>
          <button type="button" onClick={handleExitToStart}>{t('tron.tutorialSkip')}</button>
        </div>
        <div className="tron-stage">
          <canvas ref={canvasRef} className="tron-canvas" width={WIDTH} height={HEIGHT} role="img" aria-label={t('tron.gameBoardLabel')} />
          <MobileSticks visible={controllerVisible} editable={false} showP2={false} p1Label={t('tron.mobileP1Stick')} p2Label={t('tron.mobileP2Stick')} positions={mobilePositions} onPositionsChange={updateMobilePositions} onTurn={(player, desired) => { const applied = applyTurn(player, desired); if (applied) handleTutorialTurn(applied) }} />
        </div>
        <div className="tron-tutorial-card" aria-live="polite" aria-label={t('tron.tutorialTitle')}>
          <div className="tron-tutorial-steps" aria-hidden="true">
            {TUTORIAL_STEPS.map((entry, index) => <span key={entry.goal} className={index <= (tutorialDone ? TUTORIAL_STEPS.length - 1 : tutorialStep) ? 'tron-tutorial-step-done' : ''} />)}
          </div>
          <p className="tron-tutorial-copy">{t(tutorialDone ? 'tron.tutorialComplete' : step.copyKey)}</p>
          {tutorialDone && (
            <div className="tron-actions">
              <button className="tron-primary" type="button" onClick={handleExitToStart}>{t('tron.finish')}</button>
            </div>
          )}
        </div>
      </main>
    )
  }

  if (view === 'loading') {
    return (
      <main className="tron-page" style={accentVars}>
        <div className="tron-panel">
          <div className="tron-loading-orb" />
          <p className="eyebrow">{t('games.tron')}</p>
          <h1>{t('tron.loading')}</h1>
        </div>
      </main>
    )
  }

  if (view === 'victory' || view === 'gameover') {
    const banner = snapshot ? matchBanner(snapshot, playerNames, t) : { text: t('tron.gameOver'), tone: 'neutral' as const }
    const resultScore = snapshot ? snapshot.matchResult?.roundsWon || Math.max(snapshot.totals.p1, snapshot.totals.p2) : 0
    return (
      <main className="tron-page tron-result-page" style={accentVars}>
        <div className="tron-panel tron-result-panel">
          <p className="eyebrow">{view === 'victory' ? t('tron.match') : t('games.tron')}</p>
          <h1 className={`tron-banner-${banner.tone}`}>{banner.text}</h1>
          <p className="score-display">{t('tron.score')}: {resultScore} {t('tron.rounds')}</p>
          <div className="tron-actions">
            <button className="tron-primary result-next-button" type="button" onClick={() => { setHighscores(readHighscores()); setView('highscore') }}>{t('tron.highscore')}</button>
          </div>
        </div>
      </main>
    )
  }

  if (view === 'highscore') {
    return (
      <main className="tron-page tron-result-page" style={accentVars}>
        <div className="tron-panel tron-result-panel">
          <p className="eyebrow">{t('tron.highscore')}</p>
          <h1>{t('tron.highscore')}</h1>
          <HighscoreTable entries={highscores} labels={{ rank: t('tron.rank'), playerName: t('tron.player'), score: t('tron.wins'), noScores: t('tron.noScores') }} />
          <div className="tron-actions">
            <button className="tron-primary" type="button" onClick={startMatch}>{t('tron.retry')}</button>
            <button type="button" onClick={handleExitToStart}>{t('tron.backToStart')}</button>
          </div>
        </div>
      </main>
    )
  }

  const state = snapshot
  const showRoundOverlay = view === 'playing' && state?.phase === 'roundOver'
  const banner = state?.phase === 'roundOver' && state.roundResult
    ? roundBanner(state.roundResult.outcome, playerNames, t)
    : null

  return (
    <main className="tron-page tron-gameplay-page" style={accentVars}>
      <div className="tron-hud">
        <span>{t('tron.round')} {state?.round ?? 1}</span>
        <span>{t('tron.firstTo')} {roundsToWin}</span>
        <span className="tron-score-p1">{playerLabel('p1', playerNames, t)} {state?.totals.p1 ?? 0}</span>
        <span className="tron-score-p2">{playerLabel('p2', playerNames, t)} {state?.totals.p2 ?? 0}</span>
        <span>{t('tron.ties')} {state?.totals.ties ?? 0}</span>
        {inputMode === 'keyboard' && (
          <span className="tron-hud-keybinds" aria-label={t('keybinds')}>
            <KeybindGroup player="p1" label="" />
            <span aria-hidden="true">·</span>
            <KeybindGroup player="p2" label="" />
          </span>
        )}
        {state?.phase === 'playing' && !editingControls && <button type="button" onClick={handlePause}>{t('tron.pause')}</button>}
      </div>
      <div className="tron-stage">
        <canvas ref={canvasRef} className="tron-canvas" width={WIDTH} height={HEIGHT} role="img" aria-label={t('tron.gameBoardLabel')} />
        <MobileSticks visible={controllerVisible} editable={editingControls} p1Label={t('tron.mobileP1Stick')} p2Label={t('tron.mobileP2Stick')} positions={mobilePositions} onPositionsChange={updateMobilePositions} onTurn={applyTurn} />
        {showRoundOverlay && banner && (
          <div className="tron-round-overlay">
            <div className="tron-round-card">
              <p className="eyebrow">{`${t('tron.round')} ${state?.round ?? 1}`}</p>
              <h2 className={`tron-banner-${banner.tone}`}>{banner.text}</h2>
              <div className="tron-actions">
                <button className="tron-primary" type="button" onClick={handleContinue}>{t('tron.continue')}</button>
              </div>
            </div>
          </div>
        )}
        {view === 'paused' && !settingsOpen && !controlsOpen && (
          <div className="tron-pause-overlay">
            <div className="tron-round-card">
              <p className="eyebrow">{t('games.tron')}</p>
              <h2 className="tron-banner-neutral">{t('tron.paused')}</h2>
              <div className="tron-actions">
                {editingControls ? (
                  <>
                    <button className="tron-primary" type="button" onClick={saveControllerAdjustment}>{t('saveController')}</button>
                    <button type="button" onClick={exitControllerAdjustment}>{t('exitController')}</button>
                  </>
                ) : (
                  <>
                    <button className="tron-primary" type="button" onClick={handleResume}>{t('tron.resume')}</button>
                    <button type="button" onClick={() => setControlsOpen(true)}>{t('tron.controls')}</button>
                    <button type="button" onClick={() => setSettingsOpen(true)}>{t('settings')}</button>
                    <button type="button" onClick={handleForfeit}>{t('tron.endMatch')}</button>
                    <button type="button" onClick={handleExitToStart}>{t('tron.exit')}</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {gameSettings}
      {controlsPanel}
    </main>
  )
}



