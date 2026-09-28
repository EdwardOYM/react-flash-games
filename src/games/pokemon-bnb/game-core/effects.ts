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

import { DAMAGE_PER_COUNTER } from './constants'
import { cardIsEnergy, cardIsPokemon, cardIsTrainer, type AttackDef, type CardDef, type EnergyCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { createRng, randomInt } from '../rng'
import { damageCounters, drawCards, foeOf, inPlayList, isKnockedOut, isUnreadableDamageValue, logEvent, parseResistanceValue, parseWeaknessValue, sideOf, tailLog } from './helpers'
import { STATUS_CONDITIONS, type BattleLogEntry, type BattleState, type InPlayPokemon, type StatusCondition } from './types'
import { applyDeckOutLoss, performBenchKo, performKo, prizesTaken, takePrizeCard } from './turns'
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
  // -- 04.8 CP1: effects that reach past the defender, and so need their own
  // resolution rather than a `base` bonus. All print a base damage of 0.
  //
  // `spreadDamage` hits EVERY Pokemon the opponent has in play, so it cannot be
  // folded into `base`: that is applied to the Active alone, with Weakness and
  // Resistance. The printed "(Don't apply Weakness and Resistance for Benched
  // Pokemon.)" reminder is stripped before parsing, since it is a caveat on the
  // spread rather than an effect of its own. `exOnly` is the Mewtwo ex variant.
  | { kind: 'spreadDamage'; amount: number; exOnly: boolean }
  // "Flip 3 coins. This attack does 50 damage for each heads." — a bounded,
  // seeded flip against the single defender, so it stays ordinary damage maths.
  | { kind: 'coinFlipDamage'; amount: number; flips: number }
  // -- 04.8 CP2-B/C: the clauses that hand the TARGET to the player. None is ever
  // applied directly: `resolveAttack` parks a `PendingChoice` instead, and
  // `resolveChoice` applies it once the player picks. All anchored end-to-end, so
  // a neighbouring shape cannot fall in and be silently mis-read.
  // (a) "This attack does 20 damage to 1 of your opponent's Pokemon." / "This
  //     attack also does 20 damage to 1 of your opponent's BENCHED Pokemon." The
  //     latter is printed alongside a normal base damage, so the Active still
  //     takes that and only the Bench is offered — that is what `benchedOnly` buys.
  | { kind: 'damageChosenTarget'; amount: number; benchedOnly: boolean }
  | { kind: 'damageChosenPerCounter'; amountPerCounter: number }
  // 04.8 CP3-B: the trailing "Then, shuffle your deck." on every search text.
  // Recognised as an explicit NO-OP rather than left to fall through as
  // `unsupported` — otherwise the all-or-nothing guard would throw away the whole
  // search. See the note on `shuffleDeck` below for why a no-op is safe.
  | { kind: 'shuffleDeck' }
  // 04.8 CP3-B: the search itself, parked by resolveAttack and applied by
  // resolveChoice. `filter` mirrors the existing `searchToHand` Ability filter.
  | { kind: 'searchDeck'; filter: 'pokemon' | 'trainer' | 'energy' }
  // -- 04.9 CP1: the PURE slice. Twelve clause kinds that read state the engine
  // already holds — no picker, no UI, no new per-turn state. Measured, not
  // estimated: ~27 of the 82 remaining unsupported instances are these.
  //
  // Damage modifiers (folded into `base` in resolveAttack):
  | { kind: 'bonusDamageIfDefenderDamaged'; amount: number }
  | { kind: 'bonusDamageIfHasTool'; amount: number }
  | { kind: 'bonusDamagePerHandCard'; amount: number }
  | { kind: 'bonusDamagePerBenchWithHp'; amount: number; hp: number }
  // "This attack's damage isn't affected by Weakness or Resistance…". A FLAG, not
  // a bonus: resolveAttack reads it to bypass computeAttackDamage entirely.
  | { kind: 'noWeakness' }
  // Secondary damage (resolved in resolveAttack, because a hit can KO):
  | { kind: 'selfDamage'; amount: number }
  | { kind: 'spreadOwnBench'; amount: number }
  // Zone effects (plain after-damage clauses, no KO risk):
  | { kind: 'discardTopOfDeck'; count: number }
  | { kind: 'opponentShufflesHandAndDraws'; count: number }
  | { kind: 'drawUntilHandSize'; count: number }
  | { kind: 'clearSpecialConditions' }
  // "If you have exactly 30 cards in your hand, take 2 Prize cards. If you do,
  // shuffle your hand into your deck." One clause, not two: the second sentence
  // only fires if the first did, and threading that across sentences would need
  // cross-sentence state this parser deliberately does not keep.
  | { kind: 'prizesThenShuffleHand'; handSize: number; amount: number }
  // -- 04.9 CP2: the target is a CHOSEN Pokemon and the effect is healing. The
  // existing `heal` clause heals the ATTACKER, so this is a genuinely new kind
  // rather than a flag on that one. `amount: 'all'` is Comfey's sibling clause
  // ("heal ALL damage"), so the printed "all" is preserved rather than being
  // flattened to a number at parse time.
  | { kind: 'healChosenTarget'; amount: number | 'all' }
  // (b) "Place 13 damage counters on 1 of your opponent's Pokemon." Converted to
  //     damage at parse time with 04.5's unit, so no second code path exists for
  //     a counter-denominated amount.
  // (c) "…for each damage counter on that Pokemon." The amount depends on the
  //     TARGET, so it cannot be a flat number and is resolved at pick time.
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
  // 04.8 CP1: strip the spread caveat before splitting into sentences, or the
  // reminder becomes a clause of its own and the whole attack reports
  // `unsupported`. Matched exactly rather than as a general parenthetical,
  // because other sets print parentheses that ARE effects ("If you do, ...").
  const plain = plainCardText(text).replace(
    /\(\s*don't apply weakness and resistance for benched pokemon\.?\s*\)/gi,
    ' ',
  )
  if (!plain.trim()) return []
  const effects: ParsedEffect[] = []
  // An empty sentence would become an `unsupported` clause with no text, and the
  // all-or-nothing guard below would then read the whole attack as unparseable.
  // Stripping the reminder can leave exactly such a trailing fragment.
  const sentences = plain.split(/(?<=\.)\s+/).filter((sentence) => sentence.trim().length > 0)
  let pendingCoin = false
  let pendingCoinCount = 0
  let pendingUntilTails = false

  for (const sentence of sentences) {
    // -- 04.9 CP1: the pure slice, matched FIRST so no looser pattern below can
    // swallow one. Every pattern is anchored end-to-end; the near-miss suite in
    // the CP1 harness is what proves that.
    // 04.9 CP2: "Heal 80 damage from 1 of your Benched Pokemon." / "Heal all damage
    // from 1 of your Benched Pokemon." Anchored, and matched BEFORE the older
    // `^heal (\d+) damage from this` clause below — that one heals the ATTACKER and
    // is deliberately non-anchored, so letting it see this text first would be a
    // chance to read "1 of your Benched" as something else.
    const healChosen = sentence.match(
      /^heal (\d+|all) damage from 1 of your benched pokemon\.$/i,
    )
    if (healChosen) {
      effects.push({
        kind: 'healChosenTarget',
        amount: healChosen[1].toLowerCase() === 'all' ? 'all' : Number(healChosen[1]),
      })
      pendingCoin = false
      continue
    }
    const selfHit = sentence.match(/^this pokemon also does (\d+) damage to itself\.$/i)
    if (selfHit) {
      effects.push({ kind: 'selfDamage', amount: Number(selfHit[1]) })
      pendingCoin = false
      continue
    }
    const ownBenchSpread = sentence.match(
      /^this attack also does (\d+) damage to each of your benched pokemon\.$/i,
    )
    if (ownBenchSpread) {
      effects.push({ kind: 'spreadOwnBench', amount: Number(ownBenchSpread[1]) })
      pendingCoin = false
      continue
    }
    if (/^this attack's damage isn't affected by weakness or resistance,? or by any effects on your opponent's active pokemon\.$/i.test(sentence)) {
      effects.push({ kind: 'noWeakness' })
      pendingCoin = false
      continue
    }
    const defenderHurt = sentence.match(
      /^if your opponent's active pokemon already has any damage counters on it, this attack does (\d+) more damage\.$/i,
    )
    if (defenderHurt) {
      effects.push({ kind: 'bonusDamageIfDefenderDamaged', amount: Number(defenderHurt[1]) })
      pendingCoin = false
      continue
    }
    const hasTool = sentence.match(
      /^if this pokemon has a pokemon tool attached, this attack does (\d+) more damage\.$/i,
    )
    if (hasTool) {
      effects.push({ kind: 'bonusDamageIfHasTool', amount: Number(hasTool[1]) })
      pendingCoin = false
      continue
    }
    const perHand = sentence.match(/^this attack does (\d+) damage for each card in your hand\.$/i)
    if (perHand) {
      effects.push({ kind: 'bonusDamagePerHandCard', amount: Number(perHand[1]) })
      pendingCoin = false
      continue
    }
    const perFrailBench = sentence.match(
      /^this attack does (\d+) damage for each of your benched pokemon that has a maximum hp of (\d+)\.$/i,
    )
    if (perFrailBench) {
      effects.push({
        kind: 'bonusDamagePerBenchWithHp',
        amount: Number(perFrailBench[1]),
        hp: Number(perFrailBench[2]),
      })
      pendingCoin = false
      continue
    }
    const prizesThenShuffle = sentence.match(
      /^if you have exactly (\d+) cards in your hand, take (\d+) prize cards\.$/i,
    )
    if (prizesThenShuffle) {
      effects.push({
        kind: 'prizesThenShuffleHand',
        handSize: Number(prizesThenShuffle[1]),
        amount: Number(prizesThenShuffle[2]),
      })
      pendingCoin = false
      continue
    }
    if (/^if you do, shuffle your hand into your deck\.$/i.test(sentence)) {
      // Absorbed by the clause above: it is that clause's second half, and a
      // standalone clause here would fire even when the hand-size test failed.
      pendingCoin = false
      continue
    }
    const discardTop = sentence.match(/^discard the top (\d+) cards? of your deck\.$/i)
    if (discardTop) {
      effects.push({ kind: 'discardTopOfDeck', count: Number(discardTop[1]) })
      pendingCoin = false
      continue
    }
    const foeShuffles = sentence.match(
      /^your opponent shuffles their hand into their deck and draws (\d+) cards\.$/i,
    )
    if (foeShuffles) {
      effects.push({ kind: 'opponentShufflesHandAndDraws', count: Number(foeShuffles[1]) })
      pendingCoin = false
      continue
    }
    const drawUntil = sentence.match(/^draw cards until you have (\d+) cards in your hand\.$/i)
    if (drawUntil) {
      effects.push({ kind: 'drawUntilHandSize', count: Number(drawUntil[1]) })
      pendingCoin = false
      continue
    }
    if (/^this pokemon recovers from all special conditions\.$/i.test(sentence)) {
      effects.push({ kind: 'clearSpecialConditions' })
      pendingCoin = false
      continue
    }
    // -- 04.8 CP1: spread damage. Matched before the "for each" families because
    // "to each of your opponent's Pokemon" would otherwise be read as a per-card
    // count. The trailing `\s*\.?` absorbs the data's odd "Pokemon ex ." spacing
    // (a `$`-anchored pattern would silently miss all three Mewtwo ex attacks).
    const spread = sentence.match(
      /^this attack does (\d+) damage to each of your opponent's pokemon( ex)?\s*\.?$/i,
    )
    if (spread) {
      effects.push({
        kind: 'spreadDamage',
        amount: Number(spread[1]),
        exOnly: Boolean(spread[2]),
      })
      pendingCoin = false
      continue
    }
    // 04.8 CP3-B: the trailing "Then, shuffle your deck." Recognised so it does
    // not become an `unsupported` sentence and take the whole search down with it.
    if (/^then, shuffle your deck\.$/i.test(sentence)) {
      effects.push({ kind: 'shuffleDeck' })
      pendingCoin = false
      continue
    }
    // 04.8 CP3-B: "Search your deck for a Pokemon, reveal it, and put it into your
    // hand." Anchored, and the `a`/`an` article decides pokemon-vs-energy so the
    // two one-card searches cannot be confused. The multi-card variants ("up to 2",
    // "any number") are deliberately NOT matched — a count is a different feature.
    const searchOne = sentence.match(
      /^search your deck for an? (pokemon|energy card|supporter card|stadium card), reveal it, and put it into your hand\.$/i,
    )
    if (searchOne) {
      const kind = searchOne[1].toLowerCase()
      effects.push({
        kind: 'searchDeck',
        filter: kind === 'pokemon' ? 'pokemon' : kind === 'energy card' ? 'energy' : 'trainer',
      })
      pendingCoin = false
      continue
    }
    // 04.8 CP2-C (b): "Place 13 damage counters on 1 of your opponent's Pokemon."
    // Converted with 04.5's unit, so the whole set of counter-denominated
    // amounts ends up on the one `damage` path rather than a parallel one.
    const placeCounters = sentence.match(/^place (\d+) damage counters on 1 of your opponent's pokemon\.$/i)
    if (placeCounters) {
      effects.push({
        kind: 'damageChosenTarget',
        amount: Number(placeCounters[1]) * DAMAGE_PER_COUNTER,
        benchedOnly: false,
      })
      pendingCoin = false
      continue
    }
    // 04.8 CP2-C (c): "This attack does 30 damage to 1 of your opponent's Pokemon
    // for each damage counter on that Pokemon." Checked BEFORE the flat form,
    // which it would otherwise be a prefix of.
    const perCounterOnTarget = sentence.match(
      /^this attack does (\d+) damage to 1 of your opponent's pokemon for each damage counter on that pokemon\.$/i,
    )
    if (perCounterOnTarget) {
      effects.push({ kind: 'damageChosenPerCounter', amountPerCounter: Number(perCounterOnTarget[1]) })
      pendingCoin = false
      continue
    }
    // 04.8 CP2-C (a): the "also … Benched" variant, printed alongside a normal
    // base damage. The Active still takes that base; only the Bench is offered.
    const chosenBenched = sentence.match(
      /^this attack also does (\d+) damage to 1 of your opponent's benched pokemon\.$/i,
    )
    if (chosenBenched) {
      effects.push({ kind: 'damageChosenTarget', amount: Number(chosenBenched[1]), benchedOnly: true })
      pendingCoin = false
      continue
    }
    // 04.8 CP2-B: "This attack does 20 damage to 1 of your opponent's Pokemon."
    // The trailing `\.` is load-bearing — without it this would also swallow
    // the per-counter form above and apply a flat amount where a count belongs.
    const chosenTarget = sentence.match(/^this attack does (\d+) damage to 1 of your opponent's pokemon\.$/i)
    if (chosenTarget) {
      effects.push({ kind: 'damageChosenTarget', amount: Number(chosenTarget[1]), benchedOnly: false })
      pendingCoin = false
      continue
    }
    // 04.8 CP1: "Flip 3 coins." then a per-heads amount. `pendingCoinCount`
    // carries the count to the next sentence; a stray "Flip a coin." still means
    // one, so it does not clear it. Hydreigen's "Flip 3 coins. For each heads,
    // discard an Energy..." deliberately does NOT match — its second sentence is
    // a discard, not a damage amount, so it falls through to `unsupported`.
    const coinCount = sentence.match(/^flip (\d+) coins\.?$/i)
    if (coinCount) {
      pendingCoinCount = Number(coinCount[1])
      pendingCoin = false
      continue
    }
    const perHeads = sentence.match(/^this attack does (\d+) damage for each heads\.?$/i)
    if (perHeads && pendingCoinCount > 0) {
      effects.push({ kind: 'coinFlipDamage', amount: Number(perHeads[1]), flips: pendingCoinCount })
      pendingCoinCount = 0
      continue
    }
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
  // 04.8 CP1: the reach effects are ALL-OR-NOTHING. Ferrothorn reads "This
  // attack does 50 damage to each of your opponent's Pokemon. ... This Pokemon
  // also does 130 damage to itself." — applying the spread while dropping the
  // self-Knock-Out would be a materially wrong game state, so the unsupported
  // clause wins and the spread is dropped. Scoped to the two NEW kinds only, so
  // no pre-existing parse result changes.
  if (effects.some((effect) => effect.kind === 'unsupported')) {
    const filtered = effects.filter(
      (effect) =>
        effect.kind !== 'spreadDamage' &&
        effect.kind !== 'coinFlipDamage' &&
        effect.kind !== 'damageChosenTarget' &&
        effect.kind !== 'damageChosenPerCounter',
    )
    if (filtered.length !== effects.length) return filtered
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
    // -- 04.9 CP1: the pure zone effects. None of these can Knock Out, so they
    // belong here rather than in resolveAttack's secondary-damage step.
    case 'discardTopOfDeck': {
      // The top of a deck is a FACT, not a choice: the acting seat can see its
      // own deck (04.8 CP3-A) and "the top N" is fully determined. Shifting takes
      // from the front, which is the side `drawCards` also consumes.
      const drawn = side.deck.splice(0, effect.count)
      side.discard.push(...drawn)
      logEvent(state, 'pokemonBnb.log.effectDiscardEnergy', { player: context.actor, count: drawn.length })
      break
    }
    case 'opponentShufflesHandAndDraws': {
      // 04.9 CP1. The hand returns to the deck and N are drawn. The shuffle is a
      // deterministic reversal of the known order rather than a random one: both
      // peers run this over an identical state, so a seeded shuffle would change
      // the physical order without changing determinism — and reversal is the
      // cheaper way to keep the two in step. Recorded as a fidelity gap, as in
      // 04.8 CP3-B.
      const foe = sideOf(state, foeOf(context.actor))
      foe.deck.push(...foe.hand)
      foe.hand = []
      const drawn = drawCards(foe, effect.count)
      logEvent(state, 'pokemonBnb.log.effectDraw', { player: foeOf(context.actor), count: drawn.length })
      if (drawn.length < effect.count) applyDeckOutLoss(state, foeOf(context.actor))
      break
    }
    case 'drawUntilHandSize': {
      // Bounded by the deck: `drawCards` returns what it could get, and a short
      // draw is a deck-out rather than an infinite loop.
      const needed = Math.max(0, effect.count - side.hand.length)
      const drawn = drawCards(side, needed)
      logEvent(state, 'pokemonBnb.log.effectDraw', { player: context.actor, count: drawn.length })
      if (drawn.length < needed) applyDeckOutLoss(state, context.actor)
      break
    }
    case 'clearSpecialConditions': {
      // "recovers from all Special Conditions" — the attacker, matching the
      // existing `heal` clause which also acts on `context.attacker`. Iterating the
      // engine's own STATUS_CONDITIONS list rather than `Object.keys` keeps this
      // exhaustive AND typed: a new condition cannot be silently left behind.
      for (const key of STATUS_CONDITIONS) context.attacker.conditions[key] = false
      logEvent(state, 'pokemonBnb.log.effectHeal', { player: context.actor, amount: context.attacker.damage })
      break
    }
    case 'prizesThenShuffleHand': {
      // "If you have exactly 30 cards in your hand, take 2 Prize cards. If you do,
      // shuffle your hand into your deck." The second sentence fires ONLY on
      // success, which is why this is one clause rather than two.
      if (side.hand.length !== effect.handSize) break
      for (let taken = 0; taken < effect.amount; taken += 1) {
        if (side.prizeCount === 0) break
        takePrizeCard(state, context.actor)
        if (state.over) return tailLog(state, logStart)
      }
      side.deck.push(...side.hand)
      side.hand = []
      logEvent(state, 'pokemonBnb.log.effectShuffleHand', { player: context.actor })
      break
    }
    // 04.9 CP1: consumed by resolveAttack (the bonuses, the flag, the recoil).
    case 'bonusDamageIfDefenderDamaged':
    case 'bonusDamageIfHasTool':
    case 'bonusDamagePerHandCard':
    case 'bonusDamagePerBenchWithHp':
    case 'noWeakness':
    case 'selfDamage':
    case 'spreadOwnBench':
      break
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
    // 04.8 CP1: consumed by resolveAttack — the spread resolves against every
    // opponent Pokemon in play, the coin flip only against the defender. Both
    // reach here only if a phase were mis-classified, and then doing nothing is
    // the safe answer.
    case 'spreadDamage':
    case 'coinFlipDamage':
    // 04.8 CP2-B: consumed by resolveAttack, which parks the choice; resolveChoice
    // then applies it. Reaching here means a mis-classified phase, where doing
    // nothing is the safe answer.
    case 'damageChosenTarget':
    case 'damageChosenPerCounter':
    // 04.8 CP3-B: `searchDeck` is resolved by resolveChoice from a parked choice.
    // 04.8 CP2-C: consumed by resolveAttack from a parked choice.
    case 'shuffleDeck':
      break
    // 04.9 CP2: parked by resolveAttack, applied by resolveChoice.
    case 'healChosenTarget':
      break
    default:
      break // before-damage clauses are consumed by resolveAttack
  }
  return tailLog(state, logStart)
}

/**
 * Resolve a spread attack against every Pokemon the opponent has in play
 * (04.8 CP1).
 *
 * The Active takes the attack through the ordinary Weakness/Resistance path: the
 * printed reminder exempts only BENCHED Pokemon, so the Active is still weak to
 * a matching type. Benched targets take the flat printed amount with no Weakness
 * or Resistance, exactly as the card says.
 *
 * Damage is applied to every target first, then the knockouts settle. The Bench
 * settles BEFORE the Active, and that order is load-bearing: `performKo` opens a
 * promotion gate onto whatever is left in the Bench, so knocking the Active out
 * first would leave a gate pointing at an empty Bench. Both target lists are
 * captured before any knockout, since the Active reference goes stale the moment
 * `performKo` nulls it.
 */
function resolveSpreadAttack(
  state: BattleState,
  actor: PlayerSlot,
  attacker: InPlayPokemon,
  attack: AttackDef,
  effect: { amount: number; exOnly: boolean },
): void {
  const defenderSlot = foeOf(actor)
  const foeSide = sideOf(state, defenderSlot)
  const isEx = (pokemon: InPlayPokemon) => pokemon.card.suffix?.trim().toUpperCase() === 'EX'
  const matches = (pokemon: InPlayPokemon) => !effect.exOnly || isEx(pokemon)
  const active = foeSide.active
  const bench = foeSide.bench.filter(matches)

  if (active && matches(active)) {
    const outcome = computeAttackDamage(state, attacker, active, effect.amount)
    if (outcome.damage > 0) {
      active.damage += outcome.damage
      logEvent(state, 'pokemonBnb.log.damageDealt', {
        player: actor,
        attack: attack.name,
        target: active.card.name,
        amount: outcome.damage,
        weakness: outcome.weakness,
        resistance: outcome.resistance,
      })
    } else {
      logEvent(state, 'pokemonBnb.log.noDamage', {
        player: actor,
        attack: attack.name,
        target: active.card.name,
      })
    }
  }
  for (const target of bench) {
    target.damage += effect.amount
    logEvent(state, 'pokemonBnb.log.damageDealt', {
      player: actor,
      attack: attack.name,
      target: target.card.name,
      amount: effect.amount,
      weakness: 1,
      resistance: 0,
    })
  }

  for (const target of bench) {
    if (!isKnockedOut(target)) continue
    performBenchKo(state, defenderSlot, target)
    if (state.over) return
  }
  if (active && matches(active) && isKnockedOut(active)) performKo(state, defenderSlot)
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

  // 0. A spread attack is its own damage resolution: it is the only clause on
  // such a card (the parser drops a spread that shares a sentence with anything it
  // cannot honour). It sets a FLAG rather than returning, because a card may pair a
  // spread with further clauses — 104 Ferrothorn is "50 damage to each of your
  // opponent's Pokémon … This Pokémon also does 130 damage to itself", and an
  // early return silently dropped that second half. Steps 1-2 are skipped for a
  // spread; every later step still runs.
  const spread = effects.find((effect) => effect.kind === 'spreadDamage')
  if (spread) resolveSpreadAttack(state, actor, attacker, attack, spread)

  // 1. Damage modifiers: flat bonuses, per-Prize-taken bonuses, coin gates.
  // Skipped entirely for a spread (step 0 already resolved it) — a spread prints a
  // base damage of 0, so running these would be harmless, but leaving the step out
  // is what makes "a spread never touches the Active" a structural fact.
  let base = spread ? 0 : attack.damage
  for (const effect of spread ? [] : effects) {
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
    } else if (effect.kind === 'coinFlipDamage') {
      // 04.8 CP1: "Flip 3 coins. This attack does 50 damage for each heads." A
      // fixed count, so the loop is bounded by the printed number and the amount
      // lands in `base` like any other damage maths — the defender's Weakness and
      // Resistance still apply, as they do to any single-target attack.
      let heads = 0
      for (let flip = 0; flip < effect.flips; flip += 1) if (flipCoin(state)) heads += 1
      const bonus = effect.amount * heads
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamageIfDefenderDamaged') {
      // 04.9 CP1: "already has any damage counters on it". `damage > 0` is the
      // whole test — and it is the same raw number `isKnockedOut` reads, so a
      // display change can never disagree with it.
      const bonus = defender.damage > 0 ? effect.amount : 0
      base += bonus
      if (bonus > 0) logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamageIfHasTool') {
      const bonus = attacker.attachedTool ? effect.amount : 0
      base += bonus
      if (bonus > 0) logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerHandCard') {
      const bonus = effect.amount * sideOf(state, actor).hand.length
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerBenchWithHp') {
      // Bench ONLY, never the Active: "each of your BENCHED Pokemon that has…".
      // `ownInPlay` includes the Active, so slicing is load-bearing here — the
      // CP1 harness caught the Active being counted.
      const matches = ownInPlay(state, actor).slice(1).filter((p) => p.card.hp === effect.hp)
      const bonus = effect.amount * matches.length
      base += bonus
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'noWeakness') {
      // 04.9 CP1: a FLAG, not a bonus. It deliberately adds nothing to `base` and
      // is read just below, where the Weakness/Resistance maths would otherwise run.
    } else if (effect.kind === 'noDamageOnTails' && !flipCoin(state)) {
      logEvent(state, 'pokemonBnb.log.coinTails', { player: actor })
      base = 0
    }
  }

  // 2. Weakness / Resistance, then damage on the defender. A spread already dealt
  // its own damage in step 0, so this step is skipped for one.
  if (!spread) {
  // 04.9 CP1: `noWeakness` bypasses the multiplier entirely — that is the whole
  // printed clause ("isn't affected by Weakness or Resistance"), so the damage
  // lands at face value and the modifier is never consulted.
  const ignoresWeakness = effects.some((effect) => effect.kind === 'noWeakness')
  const outcome = ignoresWeakness
    ? { damage: Math.max(0, base), weakness: 1, resistance: 0 }
    : computeAttackDamage(state, attacker, defender, base)
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
  }

  // 3. Non-damage clauses (statuses, healing, energy discard, draw). These run for
  // a spread too — a spread card can carry them (04.9 CP1's Ferrothorn carries
  // `selfDamage`, resolved in 3b below).
  for (const effect of effects) {
    if (effectTiming(effect.kind) === 'afterDamage') applyEffect(state, effect, context)
  }

  // 3b. 04.9 CP1: secondary damage that can Knock Out. These sit HERE rather than in
  // `applyEffect` because a KO has to settle, and all the KO machinery (prizes, the
  // promotion queue, the ordered Bench path) lives in this file's neighbours.
  //
  // The BENCH settles before the SELF hit, matching CP1's 04.8 ordering rule: the
  // attacker's own promotion gate must be the last thing a simultaneous effect
  // opens, never something a later clause can contradict.
  {
    const ownBench = effects.find((effect) => effect.kind === 'spreadOwnBench')
    if (ownBench && ownBench.kind === 'spreadOwnBench') {
      const targets = ownInPlay(state, actor).slice(1)
      for (const target of targets) {
        target.damage += ownBench.amount
        logEvent(state, 'pokemonBnb.log.damageDealt', {
          player: actor,
          attack: context.attackName,
          target: target.card.name,
          amount: ownBench.amount,
        })
      }
      for (const target of targets) {
        if (!isKnockedOut(target)) continue
        performBenchKo(state, actor, target)
        if (state.over) break
      }
    }
    const recoil = effects.find((effect) => effect.kind === 'selfDamage')
    if (recoil && recoil.kind === 'selfDamage' && !state.over) {
      attacker.damage += recoil.amount
      logEvent(state, 'pokemonBnb.log.damageDealt', {
        player: actor,
        attack: context.attackName,
        target: attacker.card.name,
        amount: recoil.amount,
      })
      if (isKnockedOut(attacker)) performKo(state, actor)
    }
  }

  // 4. Knock Out of the defender.
  if (!spread && isKnockedOut(defender)) {
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

  // 5. 04.8 CP2-B/C: a clause that hands the target to the player parks a choice
  // rather than applying anything. Built AFTER the Knock Out on purpose, so the
  // offered list is the board as it actually stands now. `declareAttack` then
  // holds the turn open until `resolveChoice` runs.
  const flat = effects.find(
    (effect) => effect.kind === 'damageChosenTarget' || effect.kind === 'damageChosenPerCounter',
  )
  if (flat) {
    const benchedOnly = flat.kind === 'damageChosenTarget' ? flat.benchedOnly : false
    const foeSlot = foeOf(actor)
    const foeSide = sideOf(state, foeSlot)
    const bench = benchedOnly
      ? foeSide.bench.map((pokemon, index) => ({ side: foeSlot, zone: index, uid: pokemon.uid }))
      : [
          ...(foeSide.active ? [{ side: foeSlot, zone: 'active' as const, uid: foeSide.active.uid }] : []),
          ...foeSide.bench.map((pokemon, index) => ({ side: foeSlot, zone: index, uid: pokemon.uid })),
        ]
    // "…to 1 of your opponent's BENCHED Pokemon" with an empty Bench has no legal
    // target at all. The attack's own printed damage still stands; only the clause
    // is dropped, and it is logged rather than swallowed.
    if (bench.length > 0) {
      state.pendingChoice = {
        actor,
        targets: bench,
        effect:
          flat.kind === 'damageChosenTarget'
            ? { kind: 'damage', amount: flat.amount }
            : { kind: 'damagePerCounter', amountPerCounter: flat.amountPerCounter },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: bench.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no legal target' })
    }
  }

  // 6. 04.8 CP3-B: a deck search parks a choice over the ACTOR'S OWN deck. Only
  // the actor's deck is ever offered — the opponent's is not in scope for a search
  // and, before CP3-A, was not even in the actor's snapshot.
  const search = effects.find((effect) => effect.kind === 'searchDeck')
  if (search && search.kind === 'searchDeck') {
    const fits = (card: CardDef) =>
      search.filter === 'pokemon'
        ? cardIsPokemon(card)
        : search.filter === 'energy'
          ? cardIsEnergy(card)
          : cardIsTrainer(card)
    // One pass, not filter-then-`includes`: a Deck may legally hold DUPLICATES, so
    // matching by object identity against a pre-filtered list is both O(n^2) and
    // needlessly indirect. The deck index is carried instead of a card id for the
    // same reason — see `ChoiceTarget`.
    const targets = sideOf(state, actor).deck
      .map((card, deckIndex) => ({ side: actor, zone: 'deck' as const, deckIndex, cardId: card.id }))
      .filter((entry) => fits(sideOf(state, actor).deck[entry.deckIndex]))
    // A failed search is a LEGAL no-op, not a soft-lock: the rulebook lets a
    // "search your deck for…" come up empty, and it simply ends the turn. The
    // clause is logged rather than swallowed, and NO choice is parked — parking
    // an empty picker would refuse every action with nothing to tap.
    if (targets.length > 0) {
      state.pendingChoice = {
        actor,
        targets,
        effect: { kind: 'searchDeck', filter: search.filter },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: targets.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no matching card in deck' })
    }
  }

  // 7. 04.9 CP2: a heal parks a choice over the ATTACKER'S OWN BENCH — the
  // printed "1 of your Benched Pokemon" never includes the Active, so the Active
  // is deliberately absent from the offered targets. No matching Pokemon means no
  // choice is parked at all: an empty picker would refuse every action with
  // nothing to tap, which is the same soft-lock rule CP3-B used.
  const healTarget = effects.find((effect) => effect.kind === 'healChosenTarget')
  if (healTarget && healTarget.kind === 'healChosenTarget') {
    const bench = ownInPlay(state, actor)
      .slice(1)
      .map((pokemon, index) => ({ side: actor, zone: index, uid: pokemon.uid }))
    if (bench.length > 0) {
      state.pendingChoice = {
        actor,
        targets: bench,
        effect: { kind: 'healChosen', amount: healTarget.amount },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: bench.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no Benched Pokemon to heal' })
    }
  }
}
