import { useEffect, useRef, useState } from 'react'
import { getPreferredLocale, persistLocale, type Locale, type TranslationKey, useTranslations } from '../../assets/languages'
import { readConfig, updateConfig, type MobileControlPosition } from '../../config'
import { SettingsModal, type AdditionalKeyBinding } from '../../settings'
import { HighscoreTable } from './HighscoreTable'
import { formatHighscores, readHighscores, saveHighscore } from './highscores'

type View = 'start' | 'tutorial' | 'loading' | 'playing' | 'paused' | 'gameover' | 'victory' | 'highscore'
type Ball = { x: number; y: number; radius: number; velocityX: number; velocityY: number; level: number }
type StringShot = { x: number; top: number }
type Runtime = { playerX: number; balls: Ball[]; strings: StringShot[]; score: number; health: number; spawnCount: number; hitCooldown: number }
type BubbleTroubleProps = { locale?: Locale; onLocaleChange?: (locale: Locale) => void; onExit: () => void; t?: ReturnType<typeof useTranslations> }

const WIDTH = 960
const HEIGHT = 540
const PLAYER_Y = HEIGHT - 44
const MAX_LEVEL = 4
const defaultRuntime = (): Runtime => ({ playerX: WIDTH / 2, balls: [{ x: WIDTH / 2, y: 145, radius: 48, velocityX: 145, velocityY: 0, level: 0 }], strings: [], score: 0, health: 3, spawnCount: 1, hitCooldown: 0 })
const keyBindings: AdditionalKeyBinding[] = [
  { id: 'bubble-move-left', labelKey: 'keyNames.moveLeft', defaultKey: 'ArrowLeft' },
  { id: 'bubble-move-right', labelKey: 'keyNames.moveRight', defaultKey: 'ArrowRight' },
  { id: 'bubble-shoot', labelKey: 'keyNames.shoot', defaultKey: 'ArrowUp' },
]

function readKey(id: string, fallback: string) { return readConfig().settings.keybindings[id] ?? fallback }
function randomDirection() { return Math.random() > 0.5 ? 1 : -1 }
function createBalls(count: number, radius = 48, level = 0): Ball[] { return Array.from({ length: count }, (_, index) => ({ x: 150 + index * 150, y: 145 + index * 12, radius, velocityX: randomDirection() * (130 + level * 18), velocityY: 0, level })) }
function GameCanvas({ view, runtime, gameBoardLabel, mobileLeftLabel, mobileRightLabel, mobileShootLabel, mobilePositions, onMobilePositionsChange, onScore, onHealth, onClear, onGameOver, onPause }: { view: View; runtime: React.MutableRefObject<Runtime>; gameBoardLabel: string; mobileLeftLabel: string; mobileRightLabel: string; mobileShootLabel: string; mobilePositions: { movement: MobileControlPosition; shoot: MobileControlPosition }; onMobilePositionsChange: (positions: { movement: MobileControlPosition; shoot: MobileControlPosition }) => void; onScore: (score: number) => void; onHealth: (health: number) => void; onClear: () => void; onGameOver: () => void; onPause: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pressedKeys = useRef(new Set<string>())
  const gamepadButtons = useRef({ shoot: false, pause: false })
  const dragRef = useRef<{ control: 'movement' | 'shoot'; offsetX: number; offsetY: number } | null>(null)
  const analogAxis = useRef(0)

  const pressKey = (key: string) => pressedKeys.current.add(key)
  const releaseKey = (key: string) => pressedKeys.current.delete(key)
  const startDragging = (control: 'movement' | 'shoot', event: React.PointerEvent<HTMLDivElement>) => {
    const stage = event.currentTarget.parentElement
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const position = mobilePositions[control]
    dragRef.current = { control, offsetX: event.clientX - (rect.left + rect.width * position.x / 100), offsetY: event.clientY - (rect.top + rect.height * position.y / 100) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const dragControl = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const stage = event.currentTarget.parentElement
    if (!drag || !stage) return
    const rect = stage.getBoundingClientRect()
    const x = Math.max(2, Math.min(92, ((event.clientX - rect.left - drag.offsetX) / rect.width) * 100))
    const y = Math.max(4, Math.min(84, ((event.clientY - rect.top - drag.offsetY) / rect.height) * 100))
    onMobilePositionsChange({ ...mobilePositions, [drag.control]: { x, y } })
  }
  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    onMobilePositionsChange(mobilePositions)
  }
  const updateAnalogAxis = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    analogAxis.current = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)))
    event.currentTarget.style.setProperty('--stick-axis', String(analogAxis.current))
  }
  const startAnalog = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    updateAnalogAxis(event)
  }
  const stopAnalog = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    analogAxis.current = 0
    event.currentTarget.style.setProperty('--stick-axis', '0')
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  useEffect(() => {
    if (view !== 'playing') return
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    canvas.width = WIDTH
    canvas.height = HEIGHT
    const handleKeyDown = (event: KeyboardEvent) => {
      pressedKeys.current.add(event.key)
      if (event.key === 'Escape') onPause()
      if (event.key === readKey('bubble-shoot', 'ArrowUp')) {
        event.preventDefault()
        if (runtime.current.strings.length === 0) runtime.current.strings.push({ x: runtime.current.playerX, top: PLAYER_Y })
      }
    }
    const handleKeyUp = (event: KeyboardEvent) => pressedKeys.current.delete(event.key)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    let frame = 0
    let lastTime = performance.now()
    const draw = (time: number) => {
      const delta = Math.min((time - lastTime) / 1000, 0.034)
      lastTime = time
      const game = runtime.current
      const gamepad = navigator.getGamepads?.().find((candidate) => candidate?.connected)
      const axis = gamepad?.axes[0] ?? 0
      const gamepadLeft = axis < -0.2
      const gamepadRight = axis > 0.2
      const gamepadShoot = gamepad?.buttons[0]?.pressed ?? false
      const gamepadPause = gamepad?.buttons[9]?.pressed ?? false
      if (gamepadShoot && !gamepadButtons.current.shoot && game.strings.length === 0) game.strings.push({ x: game.playerX, top: PLAYER_Y })
      if (gamepadPause && !gamepadButtons.current.pause) onPause()
      gamepadButtons.current = { shoot: gamepadShoot, pause: gamepadPause }
      if (pressedKeys.current.has(readKey('bubble-move-left', 'ArrowLeft'))) game.playerX -= 330 * delta
      if (pressedKeys.current.has(readKey('bubble-move-right', 'ArrowRight'))) game.playerX += 330 * delta
      game.playerX += analogAxis.current * 330 * delta
      if (gamepadLeft) game.playerX -= 330 * delta
      if (gamepadRight) game.playerX += 330 * delta
      game.playerX = Math.max(24, Math.min(WIDTH - 24, game.playerX))
      game.hitCooldown = Math.max(0, game.hitCooldown - delta)
      for (const ball of game.balls) {
        ball.velocityY += 700 * delta
        ball.x += ball.velocityX * delta
        ball.y += ball.velocityY * delta
        if (ball.x - ball.radius < 0 || ball.x + ball.radius > WIDTH) { ball.velocityX *= -1; ball.x = Math.max(ball.radius, Math.min(WIDTH - ball.radius, ball.x)) }
        if (ball.y - ball.radius < 0) { ball.y = ball.radius; ball.velocityY = Math.abs(ball.velocityY) }
        if (ball.y + ball.radius >= PLAYER_Y) { ball.y = PLAYER_Y - ball.radius; ball.velocityY = -380 - ball.level * 22 }
        if (game.hitCooldown === 0 && Math.abs(ball.x - game.playerX) < ball.radius + 20 && ball.y + ball.radius > PLAYER_Y - 20) { game.health -= 1; game.hitCooldown = 1.1; game.playerX = WIDTH / 2; onHealth(game.health); if (game.health <= 0) onGameOver() }
      }
      for (const shot of game.strings) shot.top -= 640 * delta
      game.strings = game.strings.filter((shot) => shot.top > 0)
      for (const shot of [...game.strings]) {
        const hitIndex = game.balls.findIndex((ball) => Math.abs(ball.x - shot.x) <= ball.radius + 5 && shot.top <= ball.y + ball.radius && PLAYER_Y >= ball.y - ball.radius)
        if (hitIndex === -1) continue
        const [hit] = game.balls.splice(hitIndex, 1)
        game.strings = game.strings.filter((current) => current !== shot)
        game.score += 1
        onScore(game.score)
        if (hit.level < MAX_LEVEL) game.balls.push({ x: hit.x - hit.radius * .55, y: hit.y, radius: hit.radius * .65, velocityX: -Math.abs(hit.velocityX) - 20, velocityY: -390, level: hit.level + 1 }, { x: hit.x + hit.radius * .55, y: hit.y, radius: hit.radius * .65, velocityX: Math.abs(hit.velocityX) + 20, velocityY: -390, level: hit.level + 1 })
      }
      if (game.balls.length === 0) { if (game.spawnCount >= 3) onClear(); else { game.spawnCount += 1; game.balls = createBalls(game.spawnCount) } }
      context.fillStyle = '#101820'
      context.fillRect(0, 0, WIDTH, HEIGHT)
      context.fillStyle = '#273d45'
      context.fillRect(0, PLAYER_Y + 12, WIDTH, HEIGHT - PLAYER_Y)
      context.strokeStyle = '#385058'
      context.beginPath()
      context.moveTo(0, PLAYER_Y + 12)
      context.lineTo(WIDTH, PLAYER_Y + 12)
      context.stroke()
      for (const ball of game.balls) { context.beginPath(); context.fillStyle = ['#f18165', '#ffc857', '#79c2b0', '#e6a4c4', '#b4c7e7'][ball.level]; context.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2); context.fill(); context.strokeStyle = '#f5f0e8'; context.stroke() }
      context.strokeStyle = '#f5f0e8'
      context.lineWidth = 4
      for (const shot of game.strings) { context.beginPath(); context.moveTo(shot.x, PLAYER_Y); context.lineTo(shot.x, shot.top); context.stroke() }
      context.fillStyle = game.hitCooldown > 0 ? '#aeb9b9' : '#ffc857'
      context.fillRect(game.playerX - 20, PLAYER_Y - 18, 40, 18)
      context.fillStyle = '#f5f0e8'
      context.fillRect(game.playerX - 3, PLAYER_Y - 30, 6, 12)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp) }
  }, [onClear, onGameOver, onHealth, onPause, runtime, view])

  return <div className="bubble-stage"><canvas className="bubble-canvas" ref={canvasRef} aria-label={gameBoardLabel} /><div className="mobile-controls" aria-label={gameBoardLabel}><div className="mobile-control-group mobile-movement-control" style={{ left: `${mobilePositions.movement.x}%`, top: `${mobilePositions.movement.y}%` }} onPointerDown={(event) => startDragging('movement', event)} onPointerMove={dragControl} onPointerUp={stopDragging}><div className="mobile-stick" aria-label={`${mobileLeftLabel} / ${mobileRightLabel}`} onPointerDown={startAnalog} onPointerMove={updateAnalogAxis} onPointerUp={stopAnalog} onPointerCancel={stopAnalog}><span className="mobile-stick-knob" /></div><span className="mobile-drag-handle" aria-hidden="true">⠿</span></div><div className="mobile-control-group mobile-shoot-control" style={{ left: `${mobilePositions.shoot.x}%`, top: `${mobilePositions.shoot.y}%` }} onPointerDown={(event) => startDragging('shoot', event)} onPointerMove={dragControl} onPointerUp={stopDragging}><button type="button" aria-label={mobileShootLabel} onPointerDown={(event) => { event.stopPropagation(); pressKey(readKey('bubble-shoot', 'ArrowUp')); if (runtime.current.strings.length === 0) runtime.current.strings.push({ x: runtime.current.playerX, top: PLAYER_Y }) }} onPointerUp={() => releaseKey(readKey('bubble-shoot', 'ArrowUp'))} onPointerCancel={() => releaseKey(readKey('bubble-shoot', 'ArrowUp'))}>▲</button><span className="mobile-drag-handle" aria-hidden="true">⠿</span></div></div></div>
}

export function BubbleTroubleGame({ locale: providedLocale, onLocaleChange, onExit, t: providedTranslations }: BubbleTroubleProps) {
  const [locale, setLocale] = useState<Locale>(providedLocale ?? getPreferredLocale())
  const t = providedTranslations ?? useTranslations(locale)
  const [view, setView] = useState<View>('start')
  const [tutorialSlide, setTutorialSlide] = useState(0)
  const [music, setMusic] = useState(() => readConfig().settings.music)
  const [score, setScore] = useState(0)
  const [health, setHealth] = useState(3)
  const [submitted, setSubmitted] = useState(false)
  const [playerName, setPlayerName] = useState('')
  const [highscores, setHighscores] = useState(() => readHighscores())
  const [mobilePositions, setMobilePositions] = useState(() => readConfig().settings.mobileControls)
  const [mobileGamepadMode, setMobileGamepadMode] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches)
  const runtime = useRef<Runtime>(defaultRuntime())
  const loadingTimer = useRef<number | null>(null)
  const tutorialKeys: TranslationKey[] = ['bubble.tutorialOne', 'bubble.tutorialTwo', 'bubble.tutorialThree']

  useEffect(() => () => { if (loadingTimer.current) window.clearTimeout(loadingTimer.current) }, [])
  useEffect(() => { if (!providedLocale) setLocale(getPreferredLocale()) }, [providedLocale])
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 720px)')
    const updateMobileMode = () => setMobileGamepadMode(mediaQuery.matches)
    updateMobileMode()
    mediaQuery.addEventListener('change', updateMobileMode)
    return () => mediaQuery.removeEventListener('change', updateMobileMode)
  }, [])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = () => setSettingsOpen(true)
  const startGame = () => { runtime.current = defaultRuntime(); setScore(0); setHealth(3); setView('loading'); loadingTimer.current = window.setTimeout(() => setView('playing'), 650) }
  const finishGame = (nextView: 'gameover' | 'victory') => setView(nextView)
  const backToStart = () => { setView('start'); setSubmitted(false); setPlayerName('') }
  const changeLocale = (nextLocale: Locale) => { setLocale(nextLocale); onLocaleChange?.(nextLocale); persistLocale(nextLocale) }
  const toggleMusic = () => { const next = !music; setMusic(next); updateConfig((config) => ({ ...config, settings: { ...config.settings, music: next } })) }
  const updateMobilePositions = (positions: typeof mobilePositions) => { setMobilePositions(positions); updateConfig((config) => ({ ...config, settings: { ...config.settings, mobileControls: positions } })) }
  const downloadScores = () => { const content = formatHighscores(highscores.length > 0 ? highscores : [{ name: playerName || t('bubble.defaultPlayerName'), score }]); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' })); link.download = 'bubble-trouble-highscores.txt'; link.click(); URL.revokeObjectURL(link.href) }
  const submitScore = () => { if (submitted) return; const entries = saveHighscore({ name: playerName.trim() || t('bubble.defaultPlayerName'), score }); setHighscores(entries); setSubmitted(false); setPlayerName(''); setView('start') }
  const gameSettings = settingsOpen && <SettingsModal locale={locale} onClose={() => setSettingsOpen(false)} onLocaleChange={changeLocale} t={t} additionalBindings={keyBindings} additionalBindingsLabel="mobileControls" hideKeybindings={mobileGamepadMode} musicEnabled={music} onMusicToggle={toggleMusic} />

  if (view === 'start') return <main className="bubble-page"><div className="bubble-shell"><p className="eyebrow">{t('bubble.title')}</p><h1>{t('bubble.title')}</h1><p className="bubble-description">{t('bubble.description')}</p><div className="bubble-menu"><button className="bubble-primary" type="button" onClick={startGame}>{t('bubble.startGame')}</button><button type="button" onClick={() => setView('tutorial')}>{t('bubble.tutorial')}</button><button type="button" onClick={openSettings}>{t('bubble.settings')}</button><button type="button" onClick={onExit}>{t('bubble.exit')}</button></div><section className="bubble-highscores"><p className="eyebrow">{t('bubble.highscore')}</p><HighscoreTable entries={highscores} t={t} /></section></div>{gameSettings}</main>
  if (view === 'tutorial') return <main className="bubble-page"><div className="bubble-panel"><p className="eyebrow">{t('bubble.tutorialTitle')}</p><h1>{t('bubble.tutorialTitle')}</h1><p className="tutorial-count">{tutorialSlide + 1} / {tutorialKeys.length}</p><p className="tutorial-copy">{t(tutorialKeys[tutorialSlide])}</p><div className="bubble-actions"><button type="button" disabled={tutorialSlide === 0} onClick={() => setTutorialSlide((current) => current - 1)}>{t('bubble.previous')}</button>{tutorialSlide === tutorialKeys.length - 1 ? <button className="bubble-primary" type="button" onClick={() => setView('start')}>{t('bubble.finish')}</button> : <button className="bubble-primary" type="button" onClick={() => setTutorialSlide((current) => current + 1)}>{t('bubble.next')}</button>}</div></div></main>
  if (view === 'loading') return <main className="bubble-page"><div className="bubble-panel"><div className="loading-orb" /><p className="eyebrow">{t('bubble.loading')}</p><h1>{t('bubble.loading')}</h1></div></main>
  if (view === 'highscore' || view === 'gameover' || view === 'victory') { const resultTitleKey: TranslationKey = view === 'highscore' ? 'bubble.highscore' : view === 'gameover' ? 'bubble.gameOver' : 'bubble.victory'; return <main className="bubble-page"><div className="bubble-panel"><p className="eyebrow">{t(resultTitleKey)}</p><h1>{t(resultTitleKey)}</h1><p className="score-display">{t('bubble.score')}: {score} {t('bubble.points')}</p>{view !== 'highscore' && <button className="bubble-primary" type="button" onClick={() => setView('highscore')}>{t('bubble.highscore')}</button>}{view === 'highscore' && <><HighscoreTable entries={highscores} t={t} /><label className="name-field" htmlFor="bubble-player-name">{t('bubble.playerName')}<input id="bubble-player-name" value={playerName} placeholder={t('bubble.namePlaceholder')} disabled={submitted} onChange={(event) => setPlayerName(event.target.value)} /></label><div className="bubble-actions"><button className="bubble-primary" type="button" onClick={submitScore} disabled={submitted}>{t('bubble.submitScore')}</button><button type="button" onClick={downloadScores}>{t('bubble.downloadScore')}</button></div>{submitted && <p className="saved-note">{t('bubble.scoreSaved')}</p>}<div className="bubble-actions"><button type="button" onClick={startGame}>{t('bubble.retry')}</button><button type="button" onClick={backToStart}>{t('bubble.backToStart')}</button></div></>}</div></main> }
  return <main className="bubble-page bubble-gameplay-page"><div className="bubble-hud"><span>{t('bubble.score')}: {score}</span><span>{t('bubble.health')}: {health}</span><button type="button" onClick={() => setView('paused')}>{t('bubble.pause')}</button></div><GameCanvas view={view} runtime={runtime} gameBoardLabel={t('bubble.gameBoardLabel')} mobileLeftLabel={t('bubble.mobileLeft')} mobileRightLabel={t('bubble.mobileRight')} mobileShootLabel={t('bubble.mobileShoot')} mobilePositions={mobilePositions} onMobilePositionsChange={updateMobilePositions} onScore={setScore} onHealth={setHealth} onClear={() => finishGame('victory')} onGameOver={() => finishGame('gameover')} onPause={() => setView('paused')} />{view === 'paused' && !settingsOpen && <div className="bubble-pause-overlay"><div className="bubble-pause-card"><p className="eyebrow">{t('bubble.paused')}</p><h2>{t('bubble.paused')}</h2><div className="bubble-actions"><button className="bubble-primary" type="button" onClick={() => setView('playing')}>{t('bubble.resume')}</button><button type="button" onClick={openSettings}>{t('bubble.settings')}</button><button type="button" onClick={onExit}>{t('bubble.exit')}</button></div></div></div>}{gameSettings}</main>
}
