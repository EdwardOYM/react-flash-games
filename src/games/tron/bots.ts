// Bot seams for the future Player-vs-Bot mode (future scope; no UI in v1).
//
// A "seat" (p1 or p2) is driven by a TurnSource: either a human on this device
// or a bot produced by createBot(). Bots are pure: they read the public
// GameState and return at most one buffered turn per tick, exactly like a
// human key press or stick flick. Feeding decide()'s command through
// bufferTurn() requires no change to game-core or TronGame, so a seat can
// become a bot at any time without touching the core.
//
// Difficulty strategies
//   easy   - Short random avoidance: drives straight while it is safe, only
//            turning when the next cell is blocked (or on a rare random
//            twitch), choosing randomly between the safe turns.
//   medium - Bounded lookahead: scores straight/left/right by how far each
//            direction stays clear over the next LOOKAHEAD cells and keeps the
//            longest run (prefers straight on ties).
//   hard   - Flood-fill space scoring: after each candidate first move, counts
//            every cell the cycle could still reach and keeps the option with
//            the most open space (prefers straight on ties).

import { GRID_COLS, GRID_ROWS, indexOf, turnDirection, type CycleState, type Direction, type GameState, type PlayerId, type Turn } from './game-core'

export type BotDifficulty = 'easy' | 'medium' | 'hard'

/** One buffered 90-degree turn a source wants to apply for a seat this tick. */
export type TurnCommand = { player: PlayerId; turn: Turn }

/** Who drives a seat: a human on this device, or a bot of the given difficulty. */
export type TurnSource = { kind: 'human' } | { kind: 'bot'; difficulty: BotDifficulty }

/** A bot decides one buffered turn per tick from the public game state. */
export type BotController = {
  difficulty: BotDifficulty
  decide(state: GameState, player: PlayerId): TurnCommand | null
}

type Cell = { col: number; row: number }

const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left']

const DELTA: Record<Direction, { col: number; row: number }> = {
  up: { col: 0, row: -1 },
  right: { col: 1, row: 0 },
  down: { col: 0, row: 1 },
  left: { col: -1, row: 0 },
}

/** How many cells the medium bot projects ahead for each option. */
const LOOKAHEAD = 8

function cycleOf(state: GameState, player: PlayerId): CycleState {
  return player === 'p1' ? state.p1 : state.p2
}

function otherOf(state: GameState, player: PlayerId): CycleState {
  return player === 'p1' ? state.p2 : state.p1
}

/**
 * True when the cell is fatal: outside the arena, an existing wall, or the
 * other cycle's current cell (it becomes that cycle's fresh wall).
 */
function cellBlocked(state: GameState, col: number, row: number, other: CycleState): boolean {
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return true
  if (state.grid[indexOf(col, row)] !== 0) return true
  return col === other.col && row === other.row
}

function directionAfter(cycle: CycleState, turn: Turn | null): Direction {
  return turn ? turnDirection(cycle.direction, turn) : cycle.direction
}

function cellAfter(cycle: CycleState, turn: Turn | null): Cell {
  const delta = DELTA[directionAfter(cycle, turn)]
  return { col: cycle.col + delta.col, row: cycle.row + delta.row }
}

/** Longest clear straight run from the cell reached by `turn`, bounded by LOOKAHEAD. */
function straightRun(state: GameState, cycle: CycleState, other: CycleState, turn: Turn | null): number {
  const direction = directionAfter(cycle, turn)
  const delta = DELTA[direction]
  let { col, row } = cycle
  let steps = 0
  while (steps < LOOKAHEAD) {
    col += delta.col
    row += delta.row
    if (cellBlocked(state, col, row, other)) break
    steps += 1
  }
  return steps
}

/** Count of cells reachable from `start` over free space (bounded flood fill). */
function reachableSpace(state: GameState, start: Cell, other: CycleState): number {
  if (cellBlocked(state, start.col, start.row, other)) return 0
  const visited = new Uint8Array(GRID_COLS * GRID_ROWS)
  const queue: Cell[] = [start]
  visited[indexOf(start.col, start.row)] = 1
  let count = 0
  while (queue.length > 0) {
    const cell = queue.pop() as Cell
    count += 1
    for (const direction of DIRECTIONS) {
      const col = cell.col + DELTA[direction].col
      const row = cell.row + DELTA[direction].row
      if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) continue
      const index = indexOf(col, row)
      if (visited[index] || state.grid[index] !== 0 || (col === other.col && row === other.row)) continue
      visited[index] = 1
      queue.push({ col, row })
    }
  }
  return count
}

function decideEasy(state: GameState, player: PlayerId): TurnCommand | null {
  const cycle = cycleOf(state, player)
  const other = otherOf(state, player)
  const straight = cellAfter(cycle, null)
  const straightSafe = !cellBlocked(state, straight.col, straight.row, other)
  if (straightSafe && Math.random() > 0.08) return null
  const turns: Turn[] = Math.random() > 0.5 ? ['left', 'right'] : ['right', 'left']
  for (const turn of turns) {
    const cell = cellAfter(cycle, turn)
    if (!cellBlocked(state, cell.col, cell.row, other)) return { player, turn }
  }
  return null // boxed in either way; keep heading straight
}

function decideMedium(state: GameState, player: PlayerId): TurnCommand | null {
  const cycle = cycleOf(state, player)
  const other = otherOf(state, player)
  let best: Turn | null = null
  let bestScore = straightRun(state, cycle, other, null)
  for (const turn of ['left', 'right'] as Turn[]) {
    const score = straightRun(state, cycle, other, turn)
    if (score > bestScore) {
      best = turn
      bestScore = score
    }
  }
  if (bestScore === 0) return null // every option is blocked this tick
  return best ? { player, turn: best } : null
}

function decideHard(state: GameState, player: PlayerId): TurnCommand | null {
  const cycle = cycleOf(state, player)
  const other = otherOf(state, player)
  const evaluate = (turn: Turn | null) => {
    const cell = cellAfter(cycle, turn)
    if (cellBlocked(state, cell.col, cell.row, other)) return -1
    return reachableSpace(state, cell, other)
  }
  let best: Turn | null = null
  let bestScore = evaluate(null)
  for (const turn of ['left', 'right'] as Turn[]) {
    const score = evaluate(turn)
    if (score > bestScore) {
      best = turn
      bestScore = score
    }
  }
  if (bestScore < 0) return null // every option is blocked this tick
  return best ? { player, turn: best } : null
}

/** Build a bot controller for one seat. Strategies are documented above. */
export function createBot(difficulty: BotDifficulty): BotController {
  return {
    difficulty,
    decide: difficulty === 'easy' ? decideEasy : difficulty === 'medium' ? decideMedium : decideHard,
  }
}

