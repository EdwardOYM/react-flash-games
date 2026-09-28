// Pure helpers shared by every battle-engine module: zone access, structured
// logging, cloning, once-per-turn rejection, cost/evolution legality, and the
// Weakness/Resistance value parsers.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import type { CardDef, CardType, EnergyCardDef, PokemonCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { DAMAGE_PER_COUNTER } from './constants'
import { classifyPassiveAbility, type PassiveAbility } from './effects'
import type { ActionResult, ActiveDuration, BattleLogEntry, BattleState, DurationEffect, InPlayPokemon, SideState } from './types'

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

/**
 * 04.9 CP6: total HP bonus a Pokémon's own PASSIVE Abilities grant, in raw points.
 *
 * **Additive and self-contained on purpose.** 002/129 reads only the holder's OWN
 * attached Energy, so this needs no board state and no other Pokémon — which is what
 * lets `effectiveHp` stay a one-argument pure function that every existing caller
 * (`isKnockedOut`, `hpCounters`, `remainingCounters`, the vitals readout) keeps
 * using unchanged. A bonus that needed a sibling in play could not be folded in here
 * without changing that signature, which is why 004 ("if you have Volbeat in play")
 * is NOT modelled here and is recorded as deferred.
 *
 * The bonus is added to the RAW printed HP, never to a counter count, so
 * `isKnockedOut`'s `damage >= effectiveHp` comparison stays the single authority.
 */
export function passiveHpBonus(pokemon: InPlayPokemon): number {
  let bonus = 0
  for (const ability of pokemon.card.abilities) {
    const passive = classifyPassiveAbility(ability.text)
    if (!passive || passive.id !== 'hpBonusForEnergy') continue
    // Count attached Energy that actually PROVIDES the printed type. Special Energy
    // has no `provides` and can never satisfy a typed requirement, so it is excluded
    // rather than counted as a wildcard.
    const matching = pokemon.attachedEnergy.filter((card) => card.provides === passive.energyType).length
    if (matching >= passive.count) bonus += passive.hp
  }
  return bonus
}

// -- 04.9 CP6: the PASSIVE hook --
//
// One function answers "which passives are live right now?" for the whole board, so
// each call site reads a derived fact instead of re-scanning cards and re-matching
// printed text. That matters for correctness, not just speed: a rule that lives in
// two places can disagree with itself, and the engine's standard is that a wrong
// effect is worse than a missing one.

/** Every Pokémon a side has in play, Active first. */
function inPlayOfSide(state: BattleState, slot: PlayerSlot): InPlayPokemon[] {
  const side = sideOf(state, slot)
  return side.active ? [side.active, ...side.bench] : [...side.bench]
}

/** Every supported passive rule currently live on the board, with its holder. */
export type LivePassive = { holder: InPlayPokemon; holderSlot: PlayerSlot; rule: Exclude<PassiveAbility, { id: 'unsupported' }> }

/**
 * 04.9 CP6: every SUPPORTED passive rule that is in force on the board right now.
 *
 * A rule is live when its holder is in play; some rules additionally depend on WHERE
 * that holder sits (028 and 033 print "as long as this Pokemon is in the Active Spot"
 * / "on your Bench"), and that condition is checked by the CONSUMER, not here. Keeping
 * the hook dumb and the rules honest is what makes a misread obvious at the call site
 * instead of hidden in a shared predicate.
 */
export function passiveAbilitiesInPlay(state: BattleState): LivePassive[] {
  const live: LivePassive[] = []
  for (const slot of ['host', 'guest'] as const) {
    for (const holder of inPlayOfSide(state, slot)) {
      for (const ability of holder.card.abilities) {
        const passive = classifyPassiveAbility(ability.text)
        // `null` is a player-triggered text, which has its own registry; `unsupported`
        // is a passive this checkpoint deliberately did not model.
        if (!passive || passive.id === 'unsupported') continue
        live.push({ holder, holderSlot: slot, rule: passive })
      }
    }
  }
  return live
}

/** True when a Pokémon carries a given supported passive rule. */
export function hasPassive(pokemon: InPlayPokemon, id: PassiveAbility['id']): boolean {
  return pokemon.card.abilities.some((ability) => {
    const passive = classifyPassiveAbility(ability.text)
    return passive !== null && passive.id === id
  })
}

/**
 * 04.9 CP6 / 096: the Retreat Cost actually payable by `slot`'s Active, after any
 * Benched passive reduction.
 *
 * **Floored at 0** so a "-2" on a Retreat Cost of 1 gives a free retreat rather than
 * a negative cost the engine would have to special-case. Read by BOTH `retreatToBench`
 * and `controls.ts`, so the button's `retreat-cost` reason and the engine's refusal
 * can never disagree.
 */
export function effectiveRetreatCost(state: BattleState, slot: PlayerSlot): number {
  const active = sideOf(state, slot).active
  if (!active) return 0
  let reduction = 0
  const side = sideOf(state, slot)
  // 096 is a Benched ability of the holder's OWN side, so the Bench is scanned
  // directly rather than through the whole-board hook.
  for (const benched of side.bench) {
    for (const ability of benched.card.abilities) {
      const passive = classifyPassiveAbility(ability.text)
      if (passive && passive.id === 'retreatCostReduction') reduction += passive.amount
    }
  }
  return Math.max(0, active.card.retreat - reduction)
}

/**
 * 04.9 CP6 / 100: true when `targetSlot`'s Active is shielded from healing.
 *
 * 100 is the HOLDER's own passive and protects the holder's OPPONENT's Active, so the
 * scan is over the opposing side. Returns false when there is no Active to protect.
 */
export function activeIsUnhealable(state: BattleState, targetSlot: PlayerSlot): boolean {
  const target = sideOf(state, targetSlot).active
  if (!target) return false
  const foeSlot = foeOf(targetSlot)
  for (const holder of inPlayOfSide(state, foeSlot)) {
    if (hasPassive(holder, 'opponentCannotHeal')) return true
  }
  return false
}

export function isKnockedOut(pokemon: InPlayPokemon): boolean {
  return pokemon.damage >= effectiveHp(pokemon) + passiveHpBonus(pokemon)
}

// -- Damage counters (display unit; the engine stays in raw damage points) --
//
// The rulebook measures damage in counters, and one counter is 10 damage. The
// match is still decided by `isKnockedOut` above, which compares RAW damage to
// RAW hp and is deliberately left untouched: these three helpers are pure
// presentation, so no display change can ever alter a result. The rounding
// below is chosen so the counter readout and the KO test can never disagree
// (CP1: `damage < hp`  =>  at least 1 counter remaining).

/**
 * Damage counters banked on a Pokemon. `floor`, so the counter that first
 * reaches the Pokemon's full health is exactly the counter that knocks it out
 * (a KO at raw `damage >= hp` always reports at least `hpCounters(hp)`
 * counters), and a partial counter never rounds up into a false KO. Negative
 * damage is clamped to 0 so a display can never show "-1 counters".
 */
export function damageCounters(damage: number): number {
  return Math.floor(Math.max(0, damage) / DAMAGE_PER_COUNTER)
}

/**
 * A Pokemon's health expressed in damage counters. `ceil`, so a hypothetical
 * future card whose hp is not a multiple of 10 can never report positive
 * remaining health while it is already knocked out.
 */
export function hpCounters(hp: number): number {
  return Math.ceil(Math.max(0, hp) / DAMAGE_PER_COUNTER)
}

/**
 * Damage counters still to be placed before this Pokemon is knocked out.
 * Clamped at 0 so extra damage on an already-KO'd Pokemon cannot read as
 * negative health.
 */
export function remainingCounters(pokemon: InPlayPokemon): number {
  return Math.max(0, hpCounters(effectiveHp(pokemon)) - damageCounters(pokemon.damage))
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

/**
 * 04.9 CP7: swap a Benched Pokémon with a side's Active, in place.
 *
 * **This moves the whole `InPlayPokemon` OBJECT, it does not copy fields.** That is
 * the entire trick: attached Energy, damage, Special Conditions, the Tool, every turn
 * counter and the `uid` are properties of that one object, so a reference move
 * carries all of them for free and none of them can be forgotten. A field-by-field
 * copy would have to enumerate every field added in 04.5, 04.6, 04.9 CP5 and CP6, and
 * a field added later would silently drop on a switch.
 *
 * Moving the object rather than its contents is also what keeps a `uid` meaning the
 * same Pokémon afterwards — 04.9 CP5's durations ride the `uid`, so a switch that
 * re-created the object would detach every live duration from the card it belongs to.
 *
 * `benchIndex` is an index into the LIVE array and is spliced out **before** the
 * Active slot is written, so the two assignments cannot collide.
 */
export function applySwitchInPlace(side: SideState, benchIndex: number): InPlayPokemon | null {
  const active = side.active
  const incoming = side.bench[benchIndex]
  if (!active || !incoming) return null
  // Splice first: after this, `side.bench` no longer holds `incoming`, so pushing
  // `active` cannot accidentally duplicate or drop either Pokemon.
  side.bench.splice(benchIndex, 1)
  side.bench.push(active)
  side.active = incoming
  return active
}

/** Rejection result: the caller keeps the untouched state and gets a code. */
export function failure(state: BattleState, error: string): ActionResult {
  return { state, log: [], error }
}

// -- 04.9 CP5: time-limited "during your next turn" effects --
//
// One module-level home for the whole mechanism, so the expiry rule exists in
// exactly one place. The four operations are: ADD (when a printed clause
// resolves), PRUNE (when a turn ends), and the two READS the action gates need.

// The turn a clause printed during turn `turn` is live for. The engine's counter
// advances by one per `applyEndTurn` and the seats strictly alternate, so the
// OPPONENT's next turn is always +1 and the actor's OWN next turn is always +2.
// That is why this needs no seat parameter: the number already encodes whose turn
// it is, and the two can never disagree.
export function durationTurnFor(turn: number, whose: 'self' | 'foe'): number {
  return whose === 'foe' ? turn + 1 : turn + 2
}

/**
 * Deterministic identity for a duration, so applying the same printed clause
 * twice for the same Pokemon in the same window REPLACES rather than stacks.
 * Without this, re-resolving an attack would double a "-60 damage" modifier.
 */
export function durationId(uid: string, effect: DurationEffect): string {
  const argument = 'amount' in effect ? String(effect.amount) : 'attackName' in effect ? effect.attackName : ''
  return argument ? `${uid}:${effect.kind}:${argument}` : `${uid}:${effect.kind}`
}

/**
 * Add or replace one duration.
 *
 * REPLACEMENT is by `id`, and a re-add refreshes `activeTurn` and `sourceName`:
 * a Pokémon hit by the same clause twice in one window must not end up with two
 * -60 modifiers, which is the idempotence the plan's gate demands.
 */
export function addDuration(
  state: BattleState,
  uid: string,
  effect: DurationEffect,
  activeTurn: number,
  sourceName: string,
): void {
  const id = durationId(uid, effect)
  const index = state.durations.findIndex((duration) => duration.id === id)
  if (index === -1) state.durations.push({ id, uid, effect, activeTurn, sourceName })
  else state.durations[index] = { id, uid, effect, activeTurn, sourceName }
}

/**
 * Drop every duration whose turn has passed, plus any riding a Pokemon that is no
 * longer in play (Knocked Out, or otherwise gone).
 *
 * Called from `applyEndTurn` and nowhere else, so expiry has a single trigger. A
 * duration for a removed `uid` is inert anyway — every read looks the Pokemon up
 * by uid and finds nothing — but dropping it keeps the snapshot small and stops a
 * stale entry from mattering if a uid is ever reused.
 */
export function pruneDurations(state: BattleState): void {
  const inPlay = new Set<string>()
  if (state.host.active) inPlay.add(state.host.active.uid)
  for (const pokemon of state.host.bench) inPlay.add(pokemon.uid)
  if (state.guest.active) inPlay.add(state.guest.active.uid)
  for (const pokemon of state.guest.bench) inPlay.add(pokemon.uid)
  state.durations = state.durations.filter(
    (duration) => duration.activeTurn >= state.turn && inPlay.has(duration.uid),
  )
}

/** Every live duration riding one in-play Pokemon, read by uid. */
export function durationsFor(state: BattleState, uid: string): ActiveDuration[] {
  return state.durations.filter((duration) => duration.uid === uid && duration.activeTurn >= state.turn)
}

/**
 * The single live duration of one kind on one Pokemon, or null.
 *
 * `cantAttack` and `preventAllDamage` are answered as a BOOLEAN on purpose: they
 * are gates, and a gate that summed two entries would be a different rule.
 */
export function findDuration(
  state: BattleState,
  uid: string,
  kind: DurationEffect['kind'],
): ActiveDuration | null {
  return state.durations.find(
    (duration) => duration.uid === uid && duration.activeTurn >= state.turn && duration.effect.kind === kind,
  ) ?? null
}

/** True when a printed clause forbids `pokemon` from using `attackName` at all. */
export function isAttackLocked(state: BattleState, uid: string, attackName: string): boolean {
  if (findDuration(state, uid, 'cantAttack')) return true
  return state.durations.some(
    (duration) =>
      duration.uid === uid &&
      duration.activeTurn >= state.turn &&
      duration.effect.kind === 'cantUseAttack' &&
      duration.effect.attackName === attackName,
  )
}

/**
 * Signed damage adjustment from the `lessDamageTaken` / `moreDamageTaken` families,
 * in RAW points, applied AFTER Weakness and Resistance exactly as those cards
 * print. Positive means the Pokemon takes MORE.
 *
 * The two are separate effect kinds rather than one signed `amount` because the
 * printed sentences are asymmetric: 079/107 say "this Pokemon takes N LESS" and
 * 110 says "the Defending Pokemon takes N MORE". Collapsing them would lose which
 * Pokemon each rides, which is the whole point — 110's subject is the DEFENDER.
 */
export function durationDamageAdjustment(state: BattleState, uid: string): number {
  let total = 0
  for (const duration of durationsFor(state, uid)) {
    if (duration.effect.kind === 'lessDamageTaken') total -= duration.effect.amount
    // 04.10 CP2 / 087. It is NEGATIVE here for a different reason than the line
    // above: `lessDamageTaken` means "this Pokemon takes less", while `lessDamageDealt`
    // means "this Pokemon's ATTACKS deal less". Both reduce an amount, so they share
    // the sign, and `activeDealtReduction` negates it when reading the attacking side.
    else if (duration.effect.kind === 'lessDamageDealt') total -= duration.effect.amount
    else if (duration.effect.kind === 'moreDamageTaken') total += duration.effect.amount
  }
  return total
}

/** Shared precondition: the match is live and it is `actor`'s main phase. */
export function checkTurn(state: BattleState, actor: PlayerSlot): string | null {
  if (state.setup.phase !== 'complete') return 'setup-incomplete'
  if (state.over) return 'match-over'
  if (state.activePlayer !== actor) return 'not-your-turn'
  if (state.phase !== 'main') return 'not-main-phase'
  return null
}

export function checkAttackPhase(state: BattleState, actor: PlayerSlot): string | null {
  if (state.setup.phase !== 'complete') return 'setup-incomplete'
  if (state.over) return 'match-over'
  if (state.activePlayer !== actor) return 'not-your-turn'
  if (state.phase !== 'attack') return 'not-attack-phase'
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
