// Pure Tron light-cycle arena + match logic.
// No React, DOM, or canvas imports: TronGame.tsx drives this module on a tick
// timer and renders its state; the future Player-vs-Bot mode (bots.ts) will
// feed inputs through the same public API, so no core change is needed.
//
// Grid model
//   - The arena is GRID_COLS x GRID_ROWS cells; CELL_PX and TICK_MS are the
//     rendering/timing constants the component shares with this module.
//   - `grid` is a flat occupancy array: 0 = empty, 1 = player 1 wall, 2 = player 2 wall.
//   - Each cycle paints a persistent wall behind itself (old cell becomes a
//     wall when the head moves), so re-entering any trail is fatal.
//
// Tick model
//   - step() advances exactly one grid cell per player per tick and consumes
//     at most ONE buffered turn per player ("1 buffered turn"): a newer turn
//     replaces a still-pending one. Opposite-direction reversals are impossible
//     because each turn is a single 90-degree rotation applied once.
//
// End conditions
//   - A player loses by hitting a wall, an arena edge, or the other cycle.
//   - A head-on meeting (both heads on the same cell) or a same-tick swap
//     (each head enters the other's cell) is a tie. Both players crashing on
//     the same tick is also a tie.
//   - The match ends once a player's round tally reaches roundsToWin; ties only
//     advance the match when no decisive winner exists (a tie round is never a
//     match win). forfeitMatch() abandons the match with no winner.

export const GRID_COLS = 64
export const GRID_ROWS = 36
export const CELL_PX = 15
export const TICK_MS = 100
export const P1_COLOR = '#22d3ee'
export const P2_COLOR = '#fb7185'

export type Direction = 'up' | 'right' | 'down' | 'left'
export type Turn = 'left' | 'right'
export type PlayerId = 'p1' | 'p2'
export type RoundOutcome = PlayerId | 'tie'
export type Phase = 'playing' | 'roundOver' | 'matchOver'

export type TrailCell = {
  col: number
  row: number
  direction: Direction
}

export type CycleState = {
  col: number
  row: number
  direction: Direction
  alive: boolean
  path: TrailCell[]
}

export type RoundResult = {
  outcome: RoundOutcome
  tick: number
}

export type MatchTotals = {
  p1: number
  p2: number
  ties: number
}

export type MatchResult = {
  winner: PlayerId | null
  roundsWon: number
  totals: MatchTotals
}

export type GameState = {
  grid: Uint8Array
  p1: CycleState
  p2: CycleState
  p1Turn: Turn | null
  p2Turn: Turn | null
  round: number
  totals: MatchTotals
  roundsToWin: number
  phase: Phase
  tick: number
  roundResult: RoundResult | null
  matchResult: MatchResult | null
}

const ORDER: Direction[] = ['up', 'right', 'down', 'left']

const DELTA: Record<Direction, { col: number; row: number }> = {
  up: { col: 0, row: -1 },
  right: { col: 1, row: 0 },
  down: { col: 0, row: 1 },
  left: { col: -1, row: 0 },
}

/** Rotate a direction by a single 90-degree turn. */
export function turnDirection(direction: Direction, turn: Turn): Direction {
  const index = ORDER.indexOf(direction)
  const step = turn === 'left' ? -1 : 1
  return ORDER[(index + step + ORDER.length) % ORDER.length]
}

/**
 * The buffered turn (if any) that steers a cycle toward an absolute direction:
 * 90 degrees away returns 'left'/'right'; the current heading or its reverse
 * returns null (no turn, reversals are impossible).
 */
export function turnToward(current: Direction, desired: Direction): Turn | null {
  const diff = (ORDER.indexOf(desired) - ORDER.indexOf(current) + ORDER.length) % ORDER.length
  if (diff === 1) return 'right'
  if (diff === 3) return 'left'
  return null
}

/** Flat index into the grid for a cell. */
export function indexOf(col: number, row: number): number {
  return row * GRID_COLS + col
}

function advance(cycle: CycleState, direction: Direction): { col: number; row: number } {
  const delta = DELTA[direction]
  return { col: cycle.col + delta.col, row: cycle.row + delta.row }
}

/**
 * True when a head entering `next` crashes: arena edge, an existing wall, or
 * the cell the other cycle occupies right now (that cell becomes the other's
 * fresh wall the moment the other head leaves it).
 */
function crashed(grid: Uint8Array, next: { col: number; row: number }, other: CycleState): boolean {
  if (next.col < 0 || next.col >= GRID_COLS || next.row < 0 || next.row >= GRID_ROWS) return true
  if (grid[indexOf(next.col, next.row)] !== 0) return true
  return next.col === other.col && next.row === other.row
}

/**
 * Start a fresh round. Pass the previous match state to carry tallies and
 * increment the round number, or `null` to begin a brand-new match at round 1.
 * Rounds-to-win is clamped to at least 1.
 */
export function startRound(previous: GameState | null, roundsToWin: number): GameState {
  const target = Math.max(1, roundsToWin)
  return {
    grid: new Uint8Array(GRID_COLS * GRID_ROWS),
    p1: { col: 0, row: GRID_ROWS / 2, direction: 'right', alive: true, path: [] },
    p2: { col: GRID_COLS - 1, row: GRID_ROWS / 2, direction: 'left', alive: true, path: [] },
    p1Turn: null,
    p2Turn: null,
    round: previous ? previous.round + 1 : 1,
    totals: previous ? { ...previous.totals } : { p1: 0, p2: 0, ties: 0 },
    roundsToWin: target,
    phase: 'playing',
    tick: 0,
    roundResult: null,
    matchResult: null,
  }
}

/**
 * Queue (or replace) a player's single buffered turn. A second turn pressed
 * before the next tick replaces the first. Ignored outside `playing`.
 */
export function bufferTurn(state: GameState, player: PlayerId, turn: Turn): GameState {
  if (state.phase !== 'playing') return state
  if (player === 'p1') return { ...state, p1Turn: turn }
  return { ...state, p2Turn: turn }
}

/**
 * Advance the round by exactly one tick: consume buffered turns, move both
 * heads, paint the trail they left behind, resolve wall/edge/head-on
 * collisions, and update round and match progress.
 */
export function step(state: GameState): GameState {
  if (state.phase !== 'playing') return state

  const p1Dir = state.p1Turn ? turnDirection(state.p1.direction, state.p1Turn) : state.p1.direction
  const p2Dir = state.p2Turn ? turnDirection(state.p2.direction, state.p2Turn) : state.p2.direction
  const p1Next = advance(state.p1, p1Dir)
  const p2Next = advance(state.p2, p2Dir)

  const headOn = p1Next.col === p2Next.col && p1Next.row === p2Next.row
  const swap =
    p1Next.col === state.p2.col && p1Next.row === state.p2.row && p2Next.col === state.p1.col && p2Next.row === state.p1.row
  const p1Crash = headOn || swap || crashed(state.grid, p1Next, state.p2)
  const p2Crash = headOn || swap || crashed(state.grid, p2Next, state.p1)

  // Paint the walls both cycles just left behind (owners 1 and 2).
  const grid = state.grid.slice()
  grid[indexOf(state.p1.col, state.p1.row)] = 1
  grid[indexOf(state.p2.col, state.p2.row)] = 2

  const p1Path = [...state.p1.path, { col: state.p1.col, row: state.p1.row, direction: p1Dir }]
  const p2Path = [...state.p2.path, { col: state.p2.col, row: state.p2.row, direction: p2Dir }]

  const next: GameState = {
    ...state,
    grid,
    p1: { col: p1Next.col, row: p1Next.row, direction: p1Dir, alive: !p1Crash, path: p1Path },
    p2: { col: p2Next.col, row: p2Next.row, direction: p2Dir, alive: !p2Crash, path: p2Path },
    p1Turn: null,
    p2Turn: null,
    tick: state.tick + 1,
  }

  if (!p1Crash && !p2Crash) return next
  if (p1Crash && p2Crash) return finishRound(next, 'tie')
  return finishRound(next, p1Crash ? 'p2' : 'p1')
}

function finishRound(state: GameState, outcome: RoundOutcome): GameState {
  const totals = { ...state.totals }
  if (outcome === 'p1') totals.p1 += 1
  else if (outcome === 'p2') totals.p2 += 1
  else totals.ties += 1

  const winner = outcome === 'p1' || outcome === 'p2' ? outcome : null
  const matchWon = winner !== null && totals[winner] >= state.roundsToWin

  return {
    ...state,
    totals,
    roundResult: { outcome, tick: state.tick },
    phase: matchWon ? 'matchOver' : 'roundOver',
    matchResult: matchWon ? { winner: winner as PlayerId, roundsWon: totals[winner as PlayerId], totals } : null,
  }
}

/** After a round-over overlay, begin the next round carrying tallies forward. */
export function continueAfterRound(state: GameState): GameState {
  if (state.phase !== 'roundOver') return state
  return startRound(state, state.roundsToWin)
}

/**
 * Abandon the match (forfeit from the pause menu). Nobody wins; the phase goes
 * straight to `matchOver` so the component can route to the game-over view.
 */
export function forfeitMatch(state: GameState): GameState {
  if (state.phase === 'matchOver') return state
  return {
    ...state,
    phase: 'matchOver',
    matchResult: { winner: null, roundsWon: 0, totals: { ...state.totals } },
  }
}