import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { getPreferredLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig, type MobileControlPosition } from '../../config'
import { ControllerSettings, useControllerVisibility, useInputMode, type AdditionalKeyBinding } from '../../settings'
import {
  bufferTurn,
  continueAfterRound,
  forfeitMatch,
  startRound,
  step,
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
} from './game-core'
import '../bubble-trouble/BubbleTroubleGame.css' // reuse the shared .mobile-controls primitives
import './TronGame.css'

type TronProps = { locale?: Locale; onLocaleChange?: (locale: Locale) => void; onExit: () => void; t?: ReturnType<typeof useTranslations> }
type View = 'start' | 'loading' | 'playing' | 'paused'

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

function playerLabel(player: 'p1' | 'p2', t: (key: TranslationKey) => string) {
  return t(player === 'p1' ? 'tron.p1' : 'tron.p2')
}

function roundBanner(outcome: RoundOutcome, t: (key: TranslationKey) => string) {
  if (outcome === 'tie') return { text: t('tron.roundTie'), tone: 'neutral' as const }
  return { text: substituteParams(t('tron.roundWonBy'), { player: playerLabel(outcome, t) }), tone: outcome }
}

function matchBanner(state: GameState, t: (key: TranslationKey) => string) {
  const winner = state.matchResult?.winner
  if (!winner) return { text: t('tron.gameOver'), tone: 'neutral' as const }
  return { text: substituteParams(t('tron.victory'), { player: playerLabel(winner, t) }), tone: winner }
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

function MobileSticks({ visible, editable, p1Label, p2Label, positions, onPositionsChange, onTurn }: { visible: boolean; editable: boolean; p1Label: string; p2Label: string; positions: StickPositions; onPositionsChange: (positions: StickPositions) => void; onTurn: (player: PlayerId, desired: Direction) => void }) {
  const dragRef = useRef<{ slot: StickSlot; offsetX: number; offsetY: number } | null>(null)
  const resizeRef = useRef<{ slot: StickSlot; startScale: number; baseDistance: number } | null>(null)
  const engagedRef = useRef<{ p1: Direction | null; p2: Direction | null }>({ p1: null, p2: null })

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
  const updateAnalog = (player: PlayerId, event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const rect = element.getBoundingClientRect()
    const x = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)))
    const y = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)))
    element.style.setProperty('--stick-axis-x', x.toFixed(2))
    element.style.setProperty('--stick-axis-y', y.toFixed(2))
    if (Math.hypot(x, y) < 0.3) {
      engagedRef.current[player] = null
      return
    }
    if (engagedRef.current[player]) return
    const desired: Direction = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up')
    engagedRef.current[player] = desired
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
  const stopAnalog = (player: PlayerId, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (editable) {
      stopDragging(event)
      return
    }
    engagedRef.current[player] = null
    event.currentTarget.style.setProperty('--stick-axis-x', '0')
    event.currentTarget.style.setProperty('--stick-axis-y', '0')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div className={`mobile-controls${visible ? ' mobile-controls-visible' : ''}${editable ? ' mobile-controls-editable' : ''}`}>
      <div className="mobile-control-group mobile-movement-control tron-p1-stick-group" style={({ left: `${positions.movement.x}%`, top: `${positions.movement.y}%`, '--control-scale': positions.movement.scale, '--control-half': '38px' } as CSSProperties)} onPointerDown={(event) => startDragging('movement', event)} onPointerMove={dragControl} onPointerUp={stopDragging}>
        <div className="mobile-stick" aria-label={p1Label} style={{ transform: `scale(${positions.movement.scale})` }} onPointerDown={(event) => startAnalog('p1', 'movement', event)} onPointerMove={editable ? dragControl : (event) => updateAnalog('p1', event)} onPointerUp={(event) => stopAnalog('p1', event)} onPointerCancel={(event) => stopAnalog('p1', event)}>
          <span className="mobile-stick-knob" />
        </div>
        <div className="mobile-control-resize" onPointerDown={(event) => startResizing('movement', event)} onPointerMove={resizeControl} onPointerUp={stopResizing} onPointerCancel={stopResizing} />
      </div>
      <div className="mobile-control-group mobile-shoot-control tron-p2-stick-group" style={({ left: `${positions.shoot.x}%`, top: `${positions.shoot.y}%`, '--control-scale': positions.shoot.scale, '--control-half': '38px' } as CSSProperties)} onPointerDown={(event) => startDragging('shoot', event)} onPointerMove={dragControl} onPointerUp={stopDragging}>
        <div className="mobile-stick" aria-label={p2Label} style={{ transform: `scale(${positions.shoot.scale})` }} onPointerDown={(event) => startAnalog('p2', 'shoot', event)} onPointerMove={editable ? dragControl : (event) => updateAnalog('p2', event)} onPointerUp={(event) => stopAnalog('p2', event)} onPointerCancel={(event) => stopAnalog('p2', event)}>
          <span className="mobile-stick-knob" />
        </div>
        <div className="mobile-control-resize" onPointerDown={(event) => startResizing('shoot', event)} onPointerMove={resizeControl} onPointerUp={stopResizing} onPointerCancel={stopResizing} />
      </div>
    </div>
  )
}

export function TronGame(props: TronProps) {
  const { locale: providedLocale, onExit, t: providedTranslations } = props
  const [locale] = useState<Locale>(providedLocale ?? getPreferredLocale())
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

  useEffect(() => { viewRef.current = view }, [view])

  useEffect(() => {
    if (view !== 'loading') return
    const timer = window.setTimeout(() => setView('playing'), 500)
    return () => window.clearTimeout(timer)
  }, [view])

  const startMatch = useCallback(() => {
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
    setView('playing')
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

  const applyTurn = useCallback((player: PlayerId, desired: Direction) => {
    const state = stateRef.current
    if (!state || state.phase !== 'playing') return
    const cycle = player === 'p1' ? state.p1 : state.p2
    const turn = turnToward(cycle.direction, desired)
    if (turn) stateRef.current = bufferTurn(state, player, turn)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const key = normalizeKey(event.key)
      const binding = DIRECTION_BINDINGS.find((candidate) => normalizeKey(readKey(candidate.id)) === key)
      if (!binding) return
      if (viewRef.current !== 'playing') return
      event.preventDefault()
      if (pressedKeysRef.current.has(binding.id)) return
      pressedKeysRef.current.add(binding.id)
      applyTurn(playerOf(binding.id), binding.direction)
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
  }, [applyTurn])

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

  if (view === 'start') {
    return (
      <main className="tron-page" style={accentVars}>
        <div className="tron-shell">
          <p className="eyebrow">{t('games.tron')}</p>
          <h1>{t('tron.title')}</h1>
          <p className="tron-description">{t('tron.description')}</p>
          {inputMode === 'keyboard' && (
            <div className="tron-keybinds" aria-label={t('keybinds')}>
              <KeybindGroup player="p1" label={t('tron.p1')} />
              <KeybindGroup player="p2" label={t('tron.p2')} />
            </div>
          )}
          <div className="tron-setup">
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
            <button type="button" onClick={onExit}>{t('tron.exit')}</button>
          </div>
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

  const state = snapshot
  const showRoundOverlay = view === 'playing' && state?.phase === 'roundOver'
  const showMatchOverlay = view === 'playing' && state?.phase === 'matchOver'
  const banner = state?.phase === 'roundOver' && state.roundResult
    ? roundBanner(state.roundResult.outcome, t)
    : state
      ? matchBanner(state, t)
      : null

  return (
    <main className="tron-page tron-gameplay-page" style={accentVars}>
      <div className="tron-hud">
        <span>{t('tron.round')} {state?.round ?? 1}</span>
        <span>{t('tron.firstTo')} {roundsToWin}</span>
        <span className="tron-score-p1">{t('tron.p1')} {state?.totals.p1 ?? 0}</span>
        <span className="tron-score-p2">{t('tron.p2')} {state?.totals.p2 ?? 0}</span>
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
        {(showRoundOverlay || showMatchOverlay) && banner && (
          <div className="tron-round-overlay">
            <div className="tron-round-card">
              <p className="eyebrow">{showMatchOverlay ? t('tron.match') : `${t('tron.round')} ${state?.round ?? 1}`}</p>
              <h2 className={`tron-banner-${banner.tone}`}>{banner.text}</h2>
              <div className="tron-actions">
                {showMatchOverlay ? (
                  <>
                    <button className="tron-primary" type="button" onClick={startMatch}>{t('tron.retry')}</button>
                    <button type="button" onClick={handleExitToStart}>{t('tron.backToStart')}</button>
                  </>
                ) : (
                  <button className="tron-primary" type="button" onClick={handleContinue}>{t('tron.continue')}</button>
                )}
              </div>
            </div>
          </div>
        )}
        {view === 'paused' && (
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
                    <button type="button" onClick={handleForfeit}>{t('tron.endMatch')}</button>
                    <button type="button" onClick={handleExitToStart}>{t('tron.exit')}</button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {controlsPanel}
    </main>
  )
}



