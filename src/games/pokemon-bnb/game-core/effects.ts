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
import { damageCounters, drawCards, foeOf, inPlayList, isKnockedOut, isUnreadableDamageValue, logEvent, parseResistanceValue, parseWeaknessValue, sideOf, tailLog } from './helpers'
import type { BattleLogEntry, BattleState, InPlayPokemon, StatusCondition } from './types'
import { applyDeckOutLoss, performKo, prizesTaken, takePrizeCard } from './turns'

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
  // -- 04.7: damage maths over board state the engine already holds. Every one
  // of these reads a printed "for each" / "if ... , this attack does N more
  // damage" clause. All 04.7 cards print a base damage of 0, so the clause IS
  // the attack's damage and adding to `base` is the whole rule.
  | { kind: 'bonusDamagePerEnergyType'; amount: number; energyType: string }
  | { kind: 'bonusDamagePerDamageCounter'; amount: number }
  | { kind: 'bonusDamageIfHasEnergyType'; amount: number; energyType: string }
  | { kind: 'bonusDamagePerOwnCount'; amount: number; names: string[] }
  | { kind: 'bonusDamagePerTypeCount'; amount: number }
  | { kind: 'bonusDamagePerDiscardEnergy'; amount: number }
  | { kind: 'bonusDamagePerDefenderAttached'; amount: number }
  | { kind: 'bonusDamageIfDefenderIsEx'; amount: number }
  | { kind: 'flipUntilTailsDamage'; amount: number }
  // 04.7: NOT damage maths — it pays out at Knock Out time, so it is applied
  // after damage like the other post-damage clauses.
  | { kind: 'extraPrizeOnKo'; amount: number }
  | { kind: 'noDamageOnTails' }
  | { kind: 'draw'; amount: number }
  | { kind: 'heal'; amount: number }
  | { kind: 'discardEnergy'; amount: number | 'all'; energyTypes?: string[] }
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

// -- 04.7: damage-maths clauses --

/**
 * Hard cap on "flip a coin until you get tails" (04.7). The printed effect is
 * unbounded, so without a cap a pathological seed could spin forever and hang
 * the match. The cap is far above any plausible real run, and reaching it is
 * still a legal outcome: the bonus simply stops counting.
 */
const MAX_COIN_FLIPS = 32

/** Attached Energy of one type. Special Energy (no `provides`) is its own type. */
function countAttachedEnergy(pokemon: InPlayPokemon, energyType: string): number {
  return pokemon.attachedEnergy.filter((card) => (card.provides ?? 'special') === energyType).length
}

/** Every Pokemon a side has in play: the Active first, then the Bench. */
function ownInPlay(state: BattleState, slot: PlayerSlot): InPlayPokemon[] {
  const side = sideOf(state, slot)
  return side.active ? [side.active, ...side.bench] : [...side.bench]
}

/**
 * True when a card name matches one of a printed list, tolerating the "ex"
 * suffix the list spells out: "Pikachu and Pikachu ex" must count a card
 * named either "Pikachu" or "Pikachu ex" (04.7).
 */
function nameMatches(cardName: string, names: string[]): boolean {
  const target = cardName.trim().toLowerCase()
  return names.some((name) => {
    const wanted = name.trim().toLowerCase()
    return target === wanted || target === `${wanted} ex` || target.startsWith(`${wanted} ex `)
  })
}

/** Parse one attack's verbatim text into ordered effect clauses. */
export function parseAttackEffects(text: string): ParsedEffect[] {
  const plain = plainCardText(text)
  if (!plain) return []
  const effects: ParsedEffect[] = []
  const sentences = plain.split(/(?<=\.)\s+/)
  let pendingCoin = false
  let pendingUntilTails = false

  for (const sentence of sentences) {
    // -- 04.7: the damage-maths families, matched before the generic ones so a
    // specific "for each" clause is never swallowed by a looser pattern.
    const perEnergyType = sentence.match(/^this attack does (\d+) (?:more )?damage for each (\w+) energy attached to this pokemon\.?$/i)
    if (perEnergyType) {
      effects.push({ kind: 'bonusDamagePerEnergyType', amount: Number(perEnergyType[1]), energyType: perEnergyType[2].toLowerCase() })
      pendingCoin = false
      continue
    }
    const perCounter = sentence.match(/^this attack does (\d+) (?:more )?damage for each damage counter on this pokemon\.?$/i)
    if (perCounter) {
      effects.push({ kind: 'bonusDamagePerDamageCounter', amount: Number(perCounter[1]) })
      pendingCoin = false
      continue
    }
    const hasEnergyType = sentence.match(/^if this pokemon has any (\w+) energy attached, this attack does (\d+) more damage\.?$/i)
    if (hasEnergyType) {
      effects.push({ kind: 'bonusDamageIfHasEnergyType', amount: Number(hasEnergyType[2]), energyType: hasEnergyType[1].toLowerCase() })
      pendingCoin = false
      continue
    }
    const perOwn = sentence.match(/^this attack does (\d+) (?:more )?damage for each of your (.+) in play\.?$/i)
    // Guard the name list: "for each of your BENCHED Pokemon in play" is a
    // different (unimplemented) effect, not a per-card-name count. Without this
    // the loose capture would read "Benched Pokemon" as two card names and
    // silently apply a wrong bonus — exactly the failure the anchored patterns
    // exist to prevent.
    const positional = /^(?:active|benched|benched pokemon|your|pokemon ex)$/i
    if (perOwn && !positional.test(perOwn[2].trim())) {
      // A bare "Pokemon" means any Pokemon in play; anything else is a name list
      // ("Pikachu and Pikachu ex").
      const names = perOwn[2].trim().toLowerCase() === 'pokemon' ? [] : perOwn[2].split(/\s+and\s+/i)
      effects.push({ kind: 'bonusDamagePerOwnCount', amount: Number(perOwn[1]), names: names.map((n) => n.trim()) })
      pendingCoin = false
      continue
    }
    const perType = sentence.match(/^this attack does (\d+) damage for each type of basic energy attached to all of your pokemon\.?$/i)
    if (perType) {
      effects.push({ kind: 'bonusDamagePerTypeCount', amount: Number(perType[1]) })
      pendingCoin = false
      continue
    }
    const perDiscard = sentence.match(/^this attack does (\d+) more damage for each energy card in your discard pile\.?$/i)
    if (perDiscard) {
      effects.push({ kind: 'bonusDamagePerDiscardEnergy', amount: Number(perDiscard[1]) })
      pendingCoin = false
      continue
    }
    const perDefender = sentence.match(/^this attack does (\d+) more damage for each energy attached to your opponent's active pokemon\.?$/i)
    if (perDefender) {
      effects.push({ kind: 'bonusDamagePerDefenderAttached', amount: Number(perDefender[1]) })
      pendingCoin = false
      continue
    }
    // Card markup leaves "ex , this" (a space before the comma), so allow it.
    const defenderEx = sentence.match(/^if your opponent's active pokemon is a pokemon ex\s*, this attack does (\d+) more damage\.?$/i)
    if (defenderEx) {
      effects.push({ kind: 'bonusDamageIfDefenderIsEx', amount: Number(defenderEx[1]) })
      pendingCoin = false
      continue
    }
    if (/^flip a coin until you get tails\.?$/i.test(sentence)) {
      pendingUntilTails = true
      continue
    }
    const untilTailsDamage = sentence.match(/^this attack does (\d+) damage for each heads\.?$/i)
    if (untilTailsDamage && pendingUntilTails) {
      effects.push({ kind: 'flipUntilTailsDamage', amount: Number(untilTailsDamage[1]) })
      pendingUntilTails = false
      continue
    }
    const bonusPrize = sentence.match(/^if your opponent's pokemon is knocked out by damage from this attack, take (\d+) more prize cards?\.?$/i)
    if (bonusPrize) {
      effects.push({ kind: 'extraPrizeOnKo', amount: Number(bonusPrize[1]) })
      pendingCoin = false
      continue
    }
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
    // 04.7 CP2: one general "discard ... from this Pokemon" branch replaces the
    // two narrow ones it subsumes. It only matches when the WHOLE sentence is
    // the discard, so a compound clause ("Discard all Energy from this Pokemon,
    // and this attack does 90 damage to 1 of your opponent's Pokemon") still
    // falls through to `unsupported` — discarding there is not the only effect,
    // and the rest needs a player choice this game cannot make.
    const discardFrom = sentence.match(/^discard (.+?) from this pokemon\.?$/i)
    if (discardFrom) {
      const body = discardFrom[1].trim()
      if (/^all energy$/i.test(body)) {
        effects.push({ kind: 'discardEnergy', amount: 'all' })
      } else {
        // Strip the printed article first, or "an Energy" would yield a type
        // called "an". Type names are then the words directly before each
        // "Energy": "2 Lightning Energy" -> one type counted twice; "a Fire
        // Energy, a Water Energy, and a Lightning Energy" -> one of each. A
        // leading digit is a COUNT of that type, and with no digit at all the
        // clause still means one Energy, so the floor is 1.
        const cleaned = body.replace(/^(?:an?|the)\s+/i, '').trim()
        const types = [...cleaned.matchAll(/([a-z]+)\s+energy/gi)].map((m) => m[1].toLowerCase())
        const count = cleaned.match(/^(\d+)\b/)?.[1]
        effects.push({
          kind: 'discardEnergy',
          amount: count ? Number(count) : Math.max(1, types.length),
          energyTypes: types,
        })
      }
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
      // 04.7 CP2: `energyTypes` narrows what may be discarded, and a list of more
      // than one type means ONE OF EACH (Lugia: "a Fire Energy, a Water Energy,
      // and a Lightning Energy"). With no types the old behaviour is unchanged:
      // `all` empties the slot, a number takes that many from the front.
      const types = effect.energyTypes ?? []
      const user = context.attacker
      const discarded: EnergyCardDef[] = []
      if (types.length > 1) {
        for (const type of types) {
          const index = user.attachedEnergy.findIndex((card) => card.provides === type)
          if (index >= 0) discarded.push(user.attachedEnergy.splice(index, 1)[0])
        }
      } else {
        const wanted = effect.amount === 'all' ? user.attachedEnergy.length : effect.amount
        const only = types[0]
        for (let i = 0; i < wanted; i += 1) {
          const index = only
            ? user.attachedEnergy.findIndex((card) => card.provides === only)
            : user.attachedEnergy.length - 1
          if (index < 0) break
          discarded.push(user.attachedEnergy.splice(index, 1)[0])
        }
      }
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
    // 04.7: the extra Prize card is a Knock-Out payout, not a post-damage
    // clause, so it is settled in resolveAttack's KO block. Reaching here means
    // no knockout happened, and then there is correctly nothing to pay.
    case 'extraPrizeOnKo':
      break
    // 04.7: the damage-maths kinds are consumed by resolveAttack's damage loop.
    // They reach this switch only if a phase were ever mis-classified, and then
    // applying nothing is the safe answer.
    case 'bonusDamagePerEnergyType':
    case 'bonusDamagePerDamageCounter':
    case 'bonusDamageIfHasEnergyType':
    case 'bonusDamagePerOwnCount':
    case 'bonusDamagePerTypeCount':
    case 'bonusDamagePerDiscardEnergy':
    case 'bonusDamagePerDefenderAttached':
    case 'bonusDamageIfDefenderIsEx':
    case 'flipUntilTailsDamage':
      break
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
    } else if (effect.kind === 'bonusDamagePerEnergyType') {
      const bonus = effect.amount * countAttachedEnergy(attacker, effect.energyType)
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerDamageCounter') {
      // 04.5's counter unit: one counter is 10 damage.
      const bonus = effect.amount * damageCounters(defender.damage)
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamageIfHasEnergyType') {
      const bonus = countAttachedEnergy(attacker, effect.energyType) > 0 ? effect.amount : 0
      base += bonus
      if (bonus > 0) logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerOwnCount') {
      const inPlay = ownInPlay(state, actor)
      const matches = effect.names.length === 0
        ? inPlay.length
        : inPlay.filter((pokemon) => nameMatches(pokemon.card.name, effect.names)).length
      const bonus = effect.amount * matches
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerTypeCount') {
      // "each TYPE of Basic Energy" — distinct types, not cards. Special Energy
      // provides no type, so it never counts toward a "type of Basic" clause.
      const types = new Set(
        ownInPlay(state, actor)
          .flatMap((pokemon) => pokemon.attachedEnergy)
          .map((card) => card.provides)
          .filter((type) => type !== undefined),
      )
      const bonus = effect.amount * types.size
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerDiscardEnergy') {
      const bonus = effect.amount * sideOf(state, actor).discard.filter(cardIsEnergy).length
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerDefenderAttached') {
      const bonus = effect.amount * defender.attachedEnergy.length
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamageIfDefenderIsEx') {
      // 04.6's rule-box field, reused as a condition instead of a Prize take.
      const isEx = defender.card.suffix?.trim().toUpperCase() === 'EX'
      const bonus = isEx ? effect.amount : 0
      base += bonus
      if (bonus > 0) logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'flipUntilTailsDamage') {
      // Bounded: an unbounded loop would hang the match on a pathological seed.
      let heads = 0
      while (heads < MAX_COIN_FLIPS && flipCoin(state)) heads += 1
      const bonus = effect.amount * heads
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
  if (isKnockedOut(defender)) {
    performKo(state, defenderSlot)
    // 04.7: "If your opponent's Pokémon is Knocked Out by damage from this
    // attack, take 1 more Prize card." The bonus is a plain extra take, not a
    // new rule box, and it reuses 04.6's take loop. It is applied HERE rather
    // than inside performKo, so the KO path needs no extra parameter — and it
    // fires only when this very attack is what did the knocking out.
    if (!state.over) {
      for (const effect of effects) {
        if (effect.kind !== 'extraPrizeOnKo') continue
        for (let taken = 0; taken < effect.amount; taken += 1) {
          if (sideOf(state, actor).prizeCount === 0) break
          takePrizeCard(state, actor)
          if (state.over) break
        }
      }
    }
  }
}
