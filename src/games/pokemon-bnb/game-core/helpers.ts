// Pure helpers shared by every battle-engine module: zone access, structured
// logging, cloning, once-per-turn rejection, cost/evolution legality, and the
// Weakness/Resistance value parsers.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { CardDef, CardType, EnergyCardDef, PokemonCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import type { ActionResult, BattleLogEntry, BattleState, InPlayPokemon, SideState } from './types'

// -- Pure helpers --

export function sideOf(state: BattleState, slot: PlayerSlot): SideState {
  return slot === 'host' ? state.host : state.guest
}

export function foeOf(slot: PlayerSlot): PlayerSlot {
  return slot === 'host' ? 'guest' : 'host'
}

/**
 * Append one structured log entry. Templates are translation keys, never
 * player-facing English, so the UI owns the copy (card names stay data).
 */
export function logEvent(state: BattleState, key: string, params?: Record<string, string | number>): void {
  state.log.push(params ? { key, params } : { key })
}

/**
 * Weakness from the verbatim card-data value string ("×2", "×3").
 * Unparseable values fall back to the rulebook's common ×2; the damage step
 * emits a log note so the fallback is never silent.
 */
export function parseWeaknessValue(value: string): { multiplier: number; reduction: number } {
  const match = value.match(/(\d+)/)
  if (!match) return { multiplier: 2, reduction: 0 }
  return { multiplier: Number(match[1]), reduction: 0 }
}

/**
 * Resistance from the verbatim card-data value string ("-30", "-20").
 * Unparseable values fall back to no reduction (0).
 */
export function parseResistanceValue(value: string): { multiplier: number; reduction: number } {
  const match = value.match(/-\s*(\d+)/)
  if (!match) return { multiplier: 1, reduction: 0 }
  return { multiplier: 1, reduction: Number(match[1]) }
}

/** True when a weakness/resistance value string could not be read as a number. */
export function isUnreadableDamageValue(value: string, kind: 'weakness' | 'resistance'): boolean {
  const pattern = kind === 'weakness' ? /(\d+)/ : /-\s*(\d+)/
  return !pattern.test(value)
}

export function effectiveHp(pokemon: InPlayPokemon): number {
  return pokemon.card.hp
}

export function isKnockedOut(pokemon: InPlayPokemon): boolean {
  return pokemon.damage >= effectiveHp(pokemon)
}

/** Draw up to `count` from the top of the deck into hand. */
export function drawCards(side: SideState, count: number): CardDef[] {
  const drawn: CardDef[] = []
  for (let index = 0; index < count; index++) {
    const card = side.deck.shift()
    if (!card) break
    side.hand.push(card)
    drawn.push(card)
  }
  return drawn
}

/** Deep-copy plain battle data so an invalid action can never mutate input. */
export function cloneBattleState(state: BattleState): BattleState {
  return JSON.parse(JSON.stringify(state)) as BattleState
}

/** Stage rank from the data's stage string ('Basic' -> 0, 'Stage1' -> 1, ...). */
export function stageRank(stage: string): number {
  const match = stage.match(/^Stage\s*(\d+)$/i)
  if (match) return Number(match[1])
  return stage.trim().toLowerCase() === 'basic' ? 0 : -1
}

export function inPlayOf(side: SideState, target: 'active' | number): InPlayPokemon | null {
  return target === 'active' ? side.active : (side.bench[target] ?? null)
}

/** Every Pokemon this side has in play (Active first, then Bench). */
export function inPlayList(side: SideState): InPlayPokemon[] {
  return side.active ? [side.active, ...side.bench] : [...side.bench]
}

/** Rejection result: the caller keeps the untouched state and gets a code. */
export function failure(state: BattleState, error: string): ActionResult {
  return { state, log: [], error }
}

/** Shared precondition: the match is live and it is `actor`'s main phase. */
export function checkTurn(state: BattleState, actor: PlayerSlot): string | null {
  if (state.setup.phase !== 'complete') return 'setup-incomplete'
  if (state.over) return 'match-over'
  if (state.activePlayer !== actor) return 'not-your-turn'
  if (state.phase !== 'main') return 'not-main-phase'
  return null
}

/** Log entries appended by the action just applied. */
export function tailLog(state: BattleState, from: number): BattleLogEntry[] {
  return state.log.slice(from)
}

/**
 * Attack-cost payable check. `cost` comes from card data
 * (`['darkness', 'colorless']`) and colorless is wild. Typed requirements are
 * matched first, then leftover Energy covers the colorless count. Energy with
 * no `provides` (special energy) pays colorless only in v1 — a documented
 * approximation until special-energy scripts land in the effect library.
 */
export function canPayCost(attached: EnergyCardDef[], cost: CardType[]): boolean {
  const pool: CardType[] = attached.map((energy) => energy.provides ?? 'colorless')
  const used: boolean[] = pool.map(() => false)
  let colorlessNeeded = 0
  for (const requirement of cost) {
    if (requirement === 'colorless') {
      colorlessNeeded += 1
      continue
    }
    const index = pool.findIndex((type, position) => !used[position] && type === requirement)
    if (index === -1) return false
    used[index] = true
  }
  return used.filter((spent) => !spent).length >= colorlessNeeded
}

function sharesType(card: PokemonCardDef, target: PokemonCardDef): boolean {
  return card.types.some((type) => target.types.includes(type))
}

/**
 * Evolution legality. 30C card data carries no `evolvesFrom`, so the fallback
 * is stage progression (Basic -> Stage1 -> Stage2) plus a shared type. Sets
 * that do supply `evolvesFrom` are matched by name instead, so future data
 * needs no engine change.
 */
export function canEvolveOnto(evolution: PokemonCardDef, target: InPlayPokemon): boolean {
  if (stageRank(evolution.stage) <= 0) return false
  const targetCard = target.card
  if (evolution.evolvesFrom) {
    const sources = evolution.evolvesFrom.split(/[,/]/).map((name) => name.trim().toLowerCase())
    return sources.includes(targetCard.name.trim().toLowerCase())
  }
  return stageRank(evolution.stage) === stageRank(targetCard.stage) + 1 && sharesType(evolution, targetCard)
}
