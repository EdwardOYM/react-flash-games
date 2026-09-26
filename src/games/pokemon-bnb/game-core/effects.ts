// Attack resolution (CP7-C): the seeded coin flip, Weakness/Resistance damage
// maths, verbatim-text effect parsing and the clause applier, and the
// resolveAttack pipeline.
//
// Note: effects and turns reference each other through function declarations
// only (performKo/prizesTaken/applyDeckOutLoss vs flipCoin); ESM hoists
// function declarations, so the cross-import is safe and side-effect free.
//
// Part of the game-core module split (CP7-E-a); see ./index.ts for the full
// engine header and the re-export barrel.

import { cardIsEnergy, cardIsPokemon, type AttackDef, type CardDef, type EnergyCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { createRng, randomInt } from '../rng'
import { drawCards, foeOf, inPlayList, isKnockedOut, isUnreadableDamageValue, logEvent, parseResistanceValue, parseWeaknessValue, sideOf, tailLog } from './helpers'
import type { BattleLogEntry, BattleState, InPlayPokemon, StatusCondition } from './types'
import { applyDeckOutLoss, performKo, prizesTaken } from './turns'

// -- CP7-C: damage, effects, KO, prizes, victory --

/**
 * Seeded coin flip. The shared seed is mixed with the running draw counter so
 * consecutive flips differ, while both peers still derive identical results
 * from the same seed (the counter lives in `BattleState`).
 */
export function flipCoin(state: BattleState): boolean {
  const rng = createRng((state.seed + state.rngDraws + 1) | 0)
  state.rngDraws += 1
  return randomInt(rng, 2) === 0
}

/**
 * Damage after Weakness/Resistance. Weakness is read from the *defender's*
 * weakness entry whose type matches the attacking Pokemon's type (rulebook),
 * applied first; Resistance then subtracts, never below zero.
 */
export function computeAttackDamage(
  state: BattleState,
  attacker: InPlayPokemon,
  defender: InPlayPokemon,
  baseDamage: number,
): { damage: number; weakness: number; resistance: number } {
  if (baseDamage <= 0) return { damage: 0, weakness: 1, resistance: 0 }
  const attackerTypes = attacker.card.types
  const weaknessEntry = defender.card.weaknesses.find((entry) => attackerTypes.includes(entry.type))
  const resistanceEntry = defender.card.resistances.find((entry) => attackerTypes.includes(entry.type))

  let weakness = 1
  if (weaknessEntry) {
    if (isUnreadableDamageValue(weaknessEntry.value, 'weakness')) {
      logEvent(state, 'pokemonBnb.log.unreadableWeakness', { value: weaknessEntry.value })
    }
    weakness = parseWeaknessValue(weaknessEntry.value).multiplier
  }
  let resistance = 0
  if (resistanceEntry) {
    if (isUnreadableDamageValue(resistanceEntry.value, 'resistance')) {
      logEvent(state, 'pokemonBnb.log.unreadableResistance', { value: resistanceEntry.value })
    }
    resistance = parseResistanceValue(resistanceEntry.value).reduction
  }
  return { damage: Math.max(0, baseDamage * weakness - resistance), weakness, resistance }
}

/**
 * Recognised attack-effect clauses.
 *
 * 30C card data has **no** `effectId` field (verified: 0 occurrences in
 * cards.json) while 154 of its attacks carry effect text, so effects are
 * recognised from the text rather than keyed by a data id. Patterns are
 * anchored end-to-end: a conditional clause ("for each …", "If this Pokemon
 * has …") deliberately falls through to `unsupported` rather than being
 * applied unconditionally, because a wrong effect is worse than a missing one.
 */
export type ParsedEffect =
  | { kind: 'bonusDamage'; amount: number; coin: boolean }
  | { kind: 'bonusDamagePerPrize'; amount: number }
  | { kind: 'noDamageOnTails' }
  | { kind: 'draw'; amount: number }
  | { kind: 'heal'; amount: number }
  | { kind: 'discardEnergy'; amount: number | 'all' }
  | { kind: 'status'; status: StatusCondition; coin: boolean }
  | { kind: 'unsupported'; text: string }

export type EffectTiming = 'beforeDamage' | 'afterDamage'

/** Damage-modifying clauses resolve before damage; the rest afterwards. */
export function effectTiming(kind: ParsedEffect['kind']): EffectTiming {
  if (kind === 'bonusDamage' || kind === 'bonusDamagePerPrize' || kind === 'noDamageOnTails') {
    return 'beforeDamage'
  }
  return 'afterDamage'
}

/**
 * Strip card-text markup and fold diacritics so patterns can be written in
 * plain ASCII. 30C card data spells "Pokémon" with an accent, so an un-folded
 * match against "pokemon" would silently miss every such clause.
 */
export function plainCardText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// -- CP5: Ability registry --

/**
 * Player-triggered Ability effects, as data.
 *
 * 30C ships 16 distinct printed Ability texts across 23 cards. Only the ones
 * beginning "Once during your turn" are player-triggered (rulebook), and the
 * other 9 are passive/static clauses (damage prevention, HP bonuses, Bench
 * cost reduction, Knock Out reactions) that the engine does not simulate: the
 * `abilityIneligible` gate rejects them before any effect lookup, and
 * `abilityCoverageReport()` lists them so the gap stays visible rather than
 * being guessed at.
 */
export type AbilityEffect =
  /** Reveal the topmost matching deck card into hand. */
  | { id: 'searchToHand'; filter: 'pokemon' | 'basicEnergy' | 'energy'; energyType?: string; coin: boolean }
  /** Attach matching basic Energy from hand onto the Ability's own Pokemon. */
  | { id: 'attachFromHand'; energyType: string; count: number; requiresInPlay: string[] }
  /** Search the deck for basic Energy and attach it to the Ability's Pokemon. */
  | { id: 'searchEnergyToAttach'; energyType: string; count: number; benchOnly: boolean }
  /** Heal the chosen Pokemon of the controller. */
  | { id: 'healChosen'; amount: number }
  | { id: 'unsupported'; text: string }

const ABILITY_EFFECTS: { match: RegExp; build: (plain: string) => AbilityEffect }[] = [
  {
    match: /^once during your turn, you may use this ability\. flip a coin\. if heads, search your deck for a pokemon/i,
    build: () => ({ id: 'searchToHand', filter: 'pokemon', coin: true }),
  },
  {
    match: /^once during your turn, if you have (.+) and (.+) in play, you may use this ability\. attach a basic (fire|water|lightning) energy card from your hand to this pokemon/i,
    build: (plain) => {
      const match = plain.match(/if you have (.+?) and (.+?) in play/i)
      // Card text capitalises the type ("Basic Fire Energy"); energy data uses
      // lowercase ids, so fold it here or the match silently fails.
      const energyType = plain.match(/basic (fire|water|lightning) energy/i)?.[1]?.toLowerCase() ?? 'fire'
      return {
        id: 'attachFromHand',
        energyType,
        count: 1,
        requiresInPlay: (match ? [match[1], match[2]] : []).map((name) => name.trim().toLowerCase()),
      }
    },
  },
  {
    match: /^once during your turn, if this pokemon is on your bench, you may use this ability\. search your deck for up to 2 basic (.+) energy cards and attach them to this pokemon/i,
    build: (plain) => ({
      id: 'searchEnergyToAttach',
      energyType: plain.match(/basic (\w+) energy cards/i)?.[1]?.toLowerCase() ?? 'metal',
      count: 2,
      benchOnly: true,
    }),
  },
  {
    match: /^once during your turn, you may use this ability\. heal (\d+) damage from 1 of your pokemon/i,
    build: (plain) => ({ id: 'healChosen', amount: Number(plain.match(/heal (\d+)/i)?.[1] ?? 0) }),
  },
]

/**
 * Classify one printed Ability into a supported effect, or report it as
 * unsupported so a wrong effect is never silently applied.
 */
export function classifyAbility(text: string): AbilityEffect {
  const plain = plainCardText(text)
  for (const entry of ABILITY_EFFECTS) {
    if (entry.match.test(plain)) return entry.build(plain)
  }
  return { id: 'unsupported', text: plain }
}

/** True when the printed text permits the player to trigger the Ability. */
export function isPlayerTriggeredAbility(text: string): boolean {
  return /^once during your turn/i.test(plainCardText(text))
}

export type AbilityCoverage = { supported: string[]; passive: string[]; unsupported: string[] }

/**
 * Coverage report over the whole set: which printed Ability texts resolve,
 * which are passive (never player-triggered), and which are player-triggered
 * but still unimplemented.
 */
export function abilityCoverageReport(abilities: { name: string; text: string }[]): AbilityCoverage {
  const coverage: AbilityCoverage = { supported: [], passive: [], unsupported: [] }
  const seen = new Set<string>()
  for (const ability of abilities) {
    if (seen.has(ability.text)) continue
    seen.add(ability.text)
    if (!isPlayerTriggeredAbility(ability.text)) coverage.passive.push(ability.text)
    else if (classifyAbility(ability.text).id === 'unsupported') coverage.unsupported.push(ability.text)
    else coverage.supported.push(ability.text)
  }
  return coverage
}

const STATUS_WORDS: Record<string, StatusCondition> = {
  asleep: 'asleep',
  poisoned: 'poisoned',
  burned: 'burned',
  confused: 'confused',
  paralyzed: 'paralyzed',
}

/** Parse one attack's verbatim text into ordered effect clauses. */
export function parseAttackEffects(text: string): ParsedEffect[] {
  const plain = plainCardText(text)
  if (!plain) return []
  const effects: ParsedEffect[] = []
  const sentences = plain.split(/(?<=\.)\s+/)
  let pendingCoin = false

  for (const sentence of sentences) {
    if (/^flip a coin\.?$/i.test(sentence)) {
      pendingCoin = true
      continue
    }
    const perPrize = sentence.match(/^this attack does (\d+) damage for each prize card you have taken\.?$/i)
    if (perPrize) {
      effects.push({ kind: 'bonusDamagePerPrize', amount: Number(perPrize[1]) })
      pendingCoin = false
      continue
    }
    const coinBonus = sentence.match(/^if heads, this attack does (\d+) more damage\.?$/i)
    if (coinBonus && pendingCoin) {
      effects.push({ kind: 'bonusDamage', amount: Number(coinBonus[1]), coin: true })
      pendingCoin = false
      continue
    }
    const flatBonus = sentence.match(/^this attack does (\d+) more damage\.?$/i)
    if (flatBonus && !pendingCoin) {
      effects.push({ kind: 'bonusDamage', amount: Number(flatBonus[1]), coin: false })
      continue
    }
    if (/^if tails, this attack does nothing\.?$/i.test(sentence)) {
      effects.push({ kind: 'noDamageOnTails' })
      pendingCoin = false
      continue
    }
    const heal = sentence.match(/^heal (\d+) damage from this/i)
    if (heal) {
      effects.push({ kind: 'heal', amount: Number(heal[1]) })
      pendingCoin = false
      continue
    }
    const discardCount = sentence.match(/^discard (\d+) energy from this/i)
    if (discardCount) {
      effects.push({ kind: 'discardEnergy', amount: Number(discardCount[1]) })
      pendingCoin = false
      continue
    }
    if (/^discard all energy from this/i.test(sentence)) {
      effects.push({ kind: 'discardEnergy', amount: 'all' })
      pendingCoin = false
      continue
    }
    if (/^draw a card\.?$/i.test(sentence)) {
      effects.push({ kind: 'draw', amount: 1 })
      pendingCoin = false
      continue
    }
    const status = sentence.match(/is now (asleep|poisoned|burned|confused|paralyzed)/i)
    if (status) {
      effects.push({ kind: 'status', status: STATUS_WORDS[status[1].toLowerCase()], coin: pendingCoin })
      pendingCoin = false
      continue
    }
    effects.push({ kind: 'unsupported', text: sentence })
    pendingCoin = false
  }
  return effects
}

/** Who an attack's non-damage clauses act on. */
export type EffectContext = {
  actor: PlayerSlot
  attacker: InPlayPokemon
  defender: InPlayPokemon | null
  attackName: string
}

// -- CP5: Ability resolution --

/** Everything an Ability effect needs: who used it, on which Pokemon, and any
 * player-chosen Pokemon for "1 of your Pokemon" clauses. */
export type AbilityContext = {
  actor: PlayerSlot
  /** The Pokemon carrying the Ability. */
  user: InPlayPokemon
  /** Player-chosen Pokemon of the controller, when the text demands one. */
  chosen: InPlayPokemon | null
}

/** Move the first deck card matching `filter` into hand (rulebook "search"). */
function searchToHand(
  state: BattleState,
  actor: PlayerSlot,
  filter: 'pokemon' | 'basicEnergy' | 'energy',
  energyType?: string,
): CardDef | null {
  const side = sideOf(state, actor)
  const index = side.deck.findIndex((card) => {
    if (filter === 'pokemon') return cardIsPokemon(card)
    if (!cardIsEnergy(card)) return false
    return !energyType || (card as EnergyCardDef).provides === energyType
  })
  if (index === -1) return null
  const [found] = side.deck.splice(index, 1)
  side.hand.push(found)
  return found
}

/**
 * Apply one player-triggered Ability effect. Returns an error code when the
 * effect cannot resolve (missing requirement or no matching card), so the
 * caller can reject the action without mutating the passed state.
 *
 * Coin gates use the shared seeded flip, so both peers derive the same result
 * from the shared seed and draw counter.
 */
export function applyAbilityEffect(
  state: BattleState,
  effect: AbilityEffect,
  context: AbilityContext,
): string | null {
  const side = sideOf(state, context.actor)
  switch (effect.id) {
    case 'searchToHand': {
      if (effect.coin && !flipCoin(state)) {
        logEvent(state, 'pokemonBnb.log.coinTails', { player: context.actor })
        return null
      }
      const found = searchToHand(state, context.actor, effect.filter, effect.energyType)
      if (!found) return 'ability-no-match'
      logEvent(state, 'pokemonBnb.log.abilitySearch', { player: context.actor, card: found.name, pokemon: context.user.card.name })
      return null
    }
    case 'attachFromHand': {
      for (const name of effect.requiresInPlay) {
        const present = inPlayList(side).some((pokemon) => pokemon.card.name.trim().toLowerCase() === name)
        if (!present) return 'ability-requirement-unmet'
      }
      let attached = 0
      for (let index = side.hand.length - 1; index >= 0 && attached < effect.count; index--) {
        const card = side.hand[index]
        if (!cardIsEnergy(card) || card.provides !== effect.energyType) continue
        side.hand.splice(index, 1)
        context.user.attachedEnergy.push(card)
        attached += 1
      }
      if (attached === 0) return 'ability-no-match'
      logEvent(state, 'pokemonBnb.log.abilityAttachEnergy', { player: context.actor, pokemon: context.user.card.name, count: attached })
      return null
    }
    case 'searchEnergyToAttach': {
      if (effect.benchOnly && side.active === context.user) return 'ability-requirement-unmet'
      let attached = 0
      for (let index = 0; index < effect.count; index++) {
        const found = searchToHand(state, context.actor, 'energy', effect.energyType)
        if (!found) break
        context.user.attachedEnergy.push(found as EnergyCardDef)
        attached += 1
      }
      if (attached === 0) return 'ability-no-match'
      logEvent(state, 'pokemonBnb.log.abilityAttachEnergy', { player: context.actor, pokemon: context.user.card.name, count: attached })
      return null
    }
    case 'healChosen': {
      const target = context.chosen
      if (!target) return 'ability-need-target'
      const healed = Math.min(effect.amount, target.damage)
      if (healed === 0) return 'ability-no-match'
      target.damage -= healed
      logEvent(state, 'pokemonBnb.log.abilityHeal', { player: context.actor, target: target.card.name, amount: healed })
      return null
    }
    case 'unsupported':
      logEvent(state, 'pokemonBnb.log.abilityUnsupported', { text: effect.text })
      return null
  }
}

/**
 * Apply one parsed clause.
 *
 * Named `applyEffect` per the plan, but it takes the live `state` plus an
 * `EffectContext` instead of the plan's `(effectId, targets)`: clauses mutate
 * zones, and coin-gated clauses need the seeded rng. `unsupported` clauses only
 * log, so card text the engine cannot honour degrades gracefully rather than
 * silently pretending to work.
 */
export function applyEffect(
  state: BattleState,
  effect: ParsedEffect,
  context: EffectContext,
): BattleLogEntry[] {
  const logStart = state.log.length
  const side = sideOf(state, context.actor)
  switch (effect.kind) {
    case 'draw': {
      const drawn = drawCards(side, effect.amount)
      logEvent(state, 'pokemonBnb.log.effectDraw', { player: context.actor, count: drawn.length })
      if (drawn.length < effect.amount) applyDeckOutLoss(state, context.actor)
      break
    }
    case 'heal': {
      const healed = Math.min(effect.amount, context.attacker.damage)
      context.attacker.damage -= healed
      logEvent(state, 'pokemonBnb.log.effectHeal', { player: context.actor, amount: healed })
      break
    }
    case 'discardEnergy': {
      const count = effect.amount === 'all' ? context.attacker.attachedEnergy.length : effect.amount
      const discarded = context.attacker.attachedEnergy.splice(0, count)
      side.discard.push(...discarded)
      logEvent(state, 'pokemonBnb.log.effectDiscardEnergy', {
        player: context.actor,
        count: discarded.length,
      })
      break
    }
    case 'status': {
      const defender = context.defender
      if (!defender) break
      if (effect.coin && !flipCoin(state)) {
        logEvent(state, 'pokemonBnb.log.coinTails', { player: context.actor })
        break
      }
      defender.conditions[effect.status] = true
      logEvent(state, 'pokemonBnb.log.effectStatus', {
        player: context.actor,
        target: defender.card.name,
        status: effect.status,
      })
      break
    }
    case 'unsupported': {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: effect.text })
      break
    }
    default:
      break // before-damage clauses are consumed by resolveAttack
  }
  return tailLog(state, logStart)
}

/**
 * Resolve a declared attack against the opponent's Active Pokemon: damage
 * modifiers, Weakness/Resistance, damage, the attack's non-damage clauses, then
 * the Knock Out.
 *
 * Self-Knock-Out attack recoil remains outside this resolver; Confusion self-hit
 * and Between-Turns damage use the ordered KO queue.
 */
export function resolveAttack(
  state: BattleState,
  actor: PlayerSlot,
  attack: AttackDef,
  effects: ParsedEffect[],
): void {
  const attacker = sideOf(state, actor).active
  const defenderSlot = foeOf(actor)
  const defender = sideOf(state, defenderSlot).active
  if (!attacker || !defender) return
  const context: EffectContext = { actor, attacker, defender, attackName: attack.name }

  // 1. Damage modifiers: flat bonuses, per-Prize-taken bonuses, coin gates.
  let base = attack.damage
  for (const effect of effects) {
    if (effect.kind === 'bonusDamage') {
      if (effect.coin && !flipCoin(state)) {
        logEvent(state, 'pokemonBnb.log.coinTails', { player: actor })
        continue
      }
      base += effect.amount
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: effect.amount })
    } else if (effect.kind === 'bonusDamagePerPrize') {
      const bonus = effect.amount * prizesTaken(state, actor)
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'noDamageOnTails' && !flipCoin(state)) {
      logEvent(state, 'pokemonBnb.log.coinTails', { player: actor })
      base = 0
    }
  }

  // 2. Weakness / Resistance, then damage on the defender.
  const outcome = computeAttackDamage(state, attacker, defender, base)
  if (outcome.damage > 0) {
    defender.damage += outcome.damage
    logEvent(state, 'pokemonBnb.log.damageDealt', {
      player: actor,
      attack: context.attackName,
      target: defender.card.name,
      amount: outcome.damage,
      weakness: outcome.weakness,
      resistance: outcome.resistance,
    })
  } else {
    logEvent(state, 'pokemonBnb.log.noDamage', {
      player: actor,
      attack: context.attackName,
      target: defender.card.name,
    })
  }

  // 3. Non-damage clauses (statuses, healing, energy discard, draw).
  for (const effect of effects) {
    if (effectTiming(effect.kind) === 'afterDamage') applyEffect(state, effect, context)
  }

  // 4. Knock Out of the defender.
  if (isKnockedOut(defender)) performKo(state, defenderSlot)
}
