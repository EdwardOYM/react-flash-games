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

import { DAMAGE_PER_COUNTER, MAX_BENCH } from './constants'
import { cardIsEnergy, cardIsPokemon, cardIsStadium, cardIsTrainer, isBasicPokemon, type AttackDef, type CardDef, type CardType, type EnergyCardDef } from '../cards'
import type { PlayerSlot } from '../net/protocol'
import { createRng, randomInt } from '../rng'
import { damageCounters, drawCards, foeOf, inPlayList, isKnockedOut, isUnreadableDamageValue, logEvent, parseResistanceValue, parseWeaknessValue, sideOf, tailLog } from './helpers'
import { addDuration, durationDamageAdjustment, durationTurnFor, findDuration, hasPassive } from './helpers'
import { STATUS_CONDITIONS, type BattleLogEntry, type BattleState, type ChoiceTarget, type DurationEffect, type InPlayPokemon, type PendingChoice, type SearchAttachEnergyClause, type StatusCondition } from './types'
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
  // 04.9 CP6 / 028: the DEFENDER's own passive reduces the incoming hit, and the card
  // prints "(before applying Weakness and Resistance)" — so it is subtracted from
  // `baseDamage` HERE, ahead of the multiplier. Applying it afterwards would let a
  // Weakness ×2 quietly restore the 20 points the Ability removed.
  //
  // 04.10 CP2 / 087 is the MIRROR and reduces what the ATTACKER deals, by the same
  // "before the multiplier" rule. Both land on `baseDamage` and both happen before
  // `weakness` is read, which is exactly what the printed riders ask for.
  const reducedBase = Math.max(0, baseDamage - passiveAttackerReduction(state, defender) - activeDealtReduction(state, attacker))
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
  return { damage: Math.max(0, reducedBase * weakness - resistance), weakness, resistance }
}

/**
 * 04.9 CP6 / 028: raw points removed from an attack against `defender` by its own
 * "Lonely Gaze" passive.
 *
 * The card's condition is "**as long as this Pokemon is in the Active Spot**", so the
 * position is part of the rule and not an incidental detail: benched, the Ability does
 * nothing. Checked here rather than in the registry because the registry classifies
 * TEXT and this needs the BOARD.
 */
export function passiveAttackerReduction(state: BattleState, defender: InPlayPokemon): number {
  const defenderSlot = slotOwning(state, defender)
  // Only the Active qualifies, and only while it is genuinely the Active — a
  // `zone: 0` bench read is not the same thing.
  if (!defenderSlot || sideOf(state, defenderSlot).active !== defender) return 0
  let reduction = 0
  for (const ability of defender.card.abilities) {
    const passive = classifyPassiveAbility(ability.text)
    if (passive && passive.id === 'lessDamageTakenWhileActive') reduction += passive.amount
  }
  return reduction
}

/**
 * 04.10 CP2 / 087: raw points removed from what `attacker` DEALS because of a
 * duration riding it.
 *
 * The mirror of `passiveAttackerReduction`, and the position test is the same — the
 * clause only bites while its subject is the ACTIVE, which is the one that attacks.
 * The DURATION itself rides the opponent's Active (see the parser comment), so this
 * is read on whichever Pokémon is currently attacking.
 */
export function activeDealtReduction(state: BattleState, attacker: InPlayPokemon): number {
  const slot = slotOwning(state, attacker)
  if (!slot || sideOf(state, slot).active !== attacker) return 0
  return -durationDamageAdjustment(state, attacker.uid)
}

/**
 * 04.10 CP3: remember that an ATTACK put `amount` damage on `pokemon`, for 085/138's
 * "damaged by an attack during your opponent's last turn".
 *
 * Re-records rather than accumulates, which is what makes a SECOND hit on a later turn
 * replace the first instead of summing with it. Without that, a Pokemon hit for 20 on
 * turn 4 and 30 on turn 6 would answer 50 on turn 7 — reading damage from two turns
 * back as if it were "last turn". The turn stamp is the authority; the amount is only
 * ever the value belonging to the stamped turn.
 */
export function recordAttackDamageOn(pokemon: InPlayPokemon, turn: number, amount: number): void {
  if (pokemon.lastTurnAttackedTurn !== turn) {
    pokemon.lastTurnAttackedTurn = turn
    pokemon.lastTurnAttackedAmount = 0
  }
  pokemon.lastTurnAttackedAmount += amount
}

/**
 * 04.10 CP3: how much ATTACK damage `pokemon` took during the opponent's LAST turn,
 * or 0. The single read point for 085/138, and the only place the `turn - 1` test
 * lives, so the two Lycanrocs cannot drift apart.
 */
export function damageTakenLastTurn(state: BattleState, pokemon: InPlayPokemon): number {
  return pokemon.lastTurnAttackedTurn === state.turn - 1 ? pokemon.lastTurnAttackedAmount : 0
}

/**
 * 04.10 CP3: whether one of `slot`'s Pokemon was Knocked Out by an attack during the
 * opponent's last turn — the read for 005/091.
 *
 * The `turn - 1` test is the same anti-compounding device as `damageTakenLastTurn`: a
 * KO from two turns ago is simply not "last turn", with nothing to clear.
 */
export function koByAttackLastTurn(state: BattleState, slot: PlayerSlot): boolean {
  return sideOf(state, slot).koByAttackTurn === state.turn - 1
}

/** Which seat a given in-play Pokémon belongs to, or null when it is not in play. */
export function slotOwning(state: BattleState, pokemon: InPlayPokemon): PlayerSlot | null {
  for (const slot of ['host', 'guest'] as const) {
    const side = sideOf(state, slot)
    if (side.active === pokemon) return slot
    if (side.bench.includes(pokemon)) return slot
  }
  return null
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
  // -- 04.10 CP3: the "opponent's LAST turn" family. Both read a per-turn MEMORY
  // rather than live state, which is why they are two kinds and not one flag:
  // 005/091 is side-wide and a fixed amount; 085/138 is per-Pokemon and the amount is
  // whatever was taken. Neither amount is known at parse time in 085/138's case.
  /** 005 Tropius / 091 Umbreon: fixed bonus if a KO by attack happened last turn. */
  | { kind: 'bonusDamageIfKoByAttackLastTurn'; amount: number }
  /** 085/138 Lycanroc: bonus EQUALS the attack damage this Pokemon took last turn. */
  | { kind: 'bonusDamagePerDamageTakenLastTurn' }
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
  // 04.9 CP3: "Discard the top 3 cards of your deck and put 1 of them into your
  // hand." Two phases in one clause — it discards first, THEN parks a pick over
  // the cards it just discarded. Split across two sentences would need
  // cross-sentence state, which the parser deliberately does not keep.
  | { kind: 'discardTopForPick'; count: number }
  // 04.9 CP3: "Place damage counters on your opponent's Active Pokemon until its
  // remaining HP is 50." Not a choice at all — a threshold, which floors at 0.
  | { kind: 'setDamageToRemainingHp'; hp: number }
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
  // 04.9 CP4: "Search your deck for up to 2 Basic Pokemon and put them onto your
  // Bench. Then, shuffle your deck." (013 Victini) / "…any number of Basic
  // Pokemon…" (053/149 Pikachu ex) / "…up to 2 Stadium cards, reveal them, and put
  // them into your hand." (076 Xerneas).
  //
  // `filter` is deliberately BASIC-specific and STADIUM-specific rather than the
  // coarse 'pokemon'/'trainer' the single-card search uses: 013 says "up to 2 BASIC
  // Pokemon" and only a Basic may legally sit on the Bench, while 076 says "up to 2
  // STADIUM cards" and an Item or Supporter is not a Stadium. The coarser filters
  // would offer cards the printed text does not allow — a wrong effect, which this
  // engine treats as worse than a missing one.
  //
  // `max` is the PRINTED cap and is `Infinity` for "any number"; the finite cap
  // actually enforced is resolved at park time (see `resolveAttack`), because
  // `Infinity` does not survive the snapshot.
  // 04.9 CP4: take up to N cards from a ZONE, resolving ONCE PER PICK — the only
  // effect kind that re-parks its own choice, because `remaining` counts down and the
  // target list is rebuilt between picks (or `finishChoice` closes it early, since
  // "up to" is a permission rather than a quota).
  //
  // 04.10 CP1 widened this from "the Deck" to "a zone, filtered". The three discard
  // families (048 energy→hand, 103 pokemon+energy→deck, 109/156 pokemon→Bench) differ
  // from 013/053/076 only in WHICH zone is read and WHICH cards qualify — a target
  // rule, not a new mechanism, which is what 04.9 CP3 predicted when it left
  // `pickFromDiscard`'s `to` open for exactly this. A separate `searchDiscardUpTo`
  // would have been a fourth near-identical kind that can drift from this one.
  //
  // `max` is the PRINTED cap and may be `Infinity` ("any number of"); it is never the
  // number enforced, because `JSON.stringify(Infinity)` is `null` and would break the
  // snapshot round trip. `remaining` is resolved to a FINITE cap at park time.
  | {
      kind: 'searchDeckUpTo'
      filter: 'basicPokemon' | 'stadium' | 'basicEnergy' | 'pokemon' | 'pokemonOrEnergy'
      to: 'hand' | 'bench' | 'deck'
      max: number
      from: 'deck' | 'discard'
      /** 109/156: the picked Pokemon must carry this printed type to be a legal target. */
      requireType?: string
    }
  // -- 04.9 CP5: DURATION state. These are the first clauses that do not resolve
  // immediately — each one installs a time-limited effect that a LATER turn reads.
  // `whose` names the window in the printed words and is turned into an absolute
  // turn number by `durationTurnFor`, so "your next turn" and "your opponent's next
  // turn" are both just a number.
  //
  // `subject` is load-bearing and is why these are not one clause: 079/107/060 ride
  // the ATTACKER ("this Pokemon"), while 110 and 093 ride the DEFENDER ("the
  // Defending Pokemon"). Collapsing them would attach 110's +30 to the wrong card.
  | { kind: 'durationCantAttack'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender' }
  // -- 04.9 CP7: board manipulation — a printed clause that changes WHICH Pokemon is
  // where, rather than what is in a zone. `optional` is 066/152/158's "You may"
  // against 032's mandatory swap; `foe` is 003, which switches in the OPPONENT's
  // Benched Pokemon. The mechanics are identical either way, so they are one kind
  // with data rather than four near-identical kinds.
  | { kind: 'switchWithBenched'; optional: boolean; foe: boolean }
  // 04.10 CP1 / 081 Gimmighoul — "search your deck for a CARD and put it into your
  // hand", behind a coin flip. A separate kind rather than a `searchDeck` filter
  // because it is COIN-GATED, and `searchDeck` is deliberately unconditioned: a
  // filter cannot express "only on heads" without adding a flag to every caller.
  | { kind: 'searchAnyToHand'; coin: boolean }
  /** 106 — the same lock narrowed to one named attack. */
  | { kind: 'durationCantUseAttack'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender'; attackName: string }
  | { kind: 'durationLessDamageTaken'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender'; amount: number }
  // 04.10 CP2 / 087: the MIRROR. 04.9 CP5's clause reduces what the holder TAKES; this
  // one reduces what it DEALS, so it is a separate kind rather than a flag — one is
  // read on the defender, one on the attacker, and a single field would let the two
  // directions be confused.
  | { kind: 'durationLessDamageDealt'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender'; amount: number }
  | { kind: 'durationMoreDamageTaken'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender'; amount: number }
  /** 006/016/044 — "prevent all damage from and effects of attacks done to this Pokemon". */
  | { kind: 'durationPreventAllDamage'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender' }
  | { kind: 'durationCantRetreat'; whose: 'self' | 'foe'; subject: 'attacker' | 'defender' }
  // (b) "Place 13 damage counters on 1 of your opponent's Pokemon." Converted to
  //     damage at parse time with 04.5's unit, so no second code path exists for
  //     a counter-denominated amount.
  // (c) "…for each damage counter on that Pokemon." The amount depends on the
  //     TARGET, so it cannot be a flat number and is resolved at pick time.
  // 04.7: NOT damage maths — it pays out at Knock Out time, so it is applied
  // after damage like the other post-damage clauses.
  | { kind: 'extraPrizeOnKo'; amount: number }
  | { kind: 'noDamageOnTails' }
  // -- 04.10 CP4: lift Basic Energy out of a zone and ATTACH it. This is deliberately
  // its own kind rather than a fourth `to` on `searchDeckUpTo`: `searchDeckUpTo` always
  // moves a card INTO a pile, and attaching moves it onto a Pokemon, which carries the
  // three different destination rules no `to` value can express. The shape is the shared
  // `SearchAttachEnergyClause`, because the pick's SECOND stage carries a copy of it.
  | SearchAttachEnergyClause
  // -- 04.10 CP2: the PER-HEAD effects. A coin count is already tracked by
  // `pendingCoinCount`; what was missing was the effect that runs once per head.
  //
  // 099's count is PRINTED ("Flip 3 coins"), so `flips` is the literal number. 125/146's
  // is DYNAMIC ("flip a coin for each Maushold you have in play"), so the clause stores
  // the card NAME and resolution counts the board — a number cannot be frozen at parse
  // time without being wrong the moment the board changes.
  | { kind: 'discardEnergyPerHead'; flips: number }
  | { kind: 'discardOpponentTopPerHead'; countPerHead: number; perOwnName: string }
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

// -- 04.9 CP6: PASSIVE Ability registry --
//
// The player-triggered registry above answers "what does pressing this button do?".
// A passive answers a different question: "what is true about the board RIGHT NOW?",
// so it has no activation, no once-per-turn marker and no log line of its own.
//
// 30C carries **10 unique passive texts across 14 cards** (measured, not estimated).
// They are recognised from the printed text, exactly like the attack clauses, and
// every pattern is anchored end-to-end: a neighbouring shape falls through to
// `unsupported` and is reported rather than guessed at.

/**
 * One passive rule, as printed.
 *
 * Each carries only what the hook needs to evaluate it — no board state is baked in
 * here, because a passive must be re-evaluated on every read (Energy can be attached
 * or knocked out between two calls).
 */
export type PassiveAbility =
  /** 002/129 Exeggutor — "+250 HP" once N of a type is attached. */
  | { id: 'hpBonusForEnergy'; energyType: string; count: number; hp: number }
  /** 028 Pikachu — the opponent's Active attacks do N less while this is Active. */
  | { id: 'lessDamageTakenWhileActive'; amount: number }
  /**
   * 087 Nidoran — the MIRROR of 028. This one changes what the *holder's* attacks
   * DEAL, not what it takes, so it is a genuinely separate effect rather than a
   * variant: 028 is a defence, 087 is an offence. "attacks used by the Defending
   * Pokemon do 30 less damage" — the holder is the one attacking, and the printed
   * "(before applying Weakness and Resistance)" puts it ahead of the multiplier,
   * exactly as 028's rider does.
   */
  | { id: 'lessDamageDealtWhileActive'; amount: number }
  /** 033 Pikachu — all damage prevented while this sits on the Bench. */
  | { id: 'preventDamageWhileBenched' }
  /** 096 Zoroark — the holder's Active Retreat Cost is N less. */
  | { id: 'retreatCostReduction'; amount: number }
  /** 100 Yveltal — the opponent's Active cannot be healed. */
  | { id: 'opponentCannotHeal' }
  | { id: 'unsupported'; text: string }

const PASSIVE_EFFECTS: { match: RegExp; build: (plain: string) => PassiveAbility }[] = [
  // 002/129. The energy type and count are read from the printed text rather than
  // hard-coded, so a sibling card printing a different type still works.
  {
    match: /^if this pokemon has (\d+) or more (\w+) energy attached, it gets \+(\d+) hp\.$/i,
    build: (plain) => {
      const match = plain.match(/if this pokemon has (\d+) or more (\w+) energy attached, it gets \+(\d+) hp\./i)
      return {
        id: 'hpBonusForEnergy',
        // Card text capitalises the type ("Grass Energy"); energy data uses
        // lowercase `provides`, so fold it here or the count silently never matches.
        energyType: (match?.[2] ?? '').toLowerCase(),
        count: Number(match?.[1] ?? 0),
        hp: Number(match?.[3] ?? 0),
      }
    },
  },
  // 028. Anchored including the trailing rider so a differently-worded reduction
  // cannot be silently read as this one.
  {
    match: /^as long as this pokemon is in the active spot, attacks used by your opponent's active pokemon do (\d+) less damage \(before applying weakness and resistance\)\.$/i,
    build: (plain) => ({
      id: 'lessDamageTakenWhileActive',
      amount: Number(plain.match(/do (\d+) less damage/i)?.[1] ?? 0),
    }),
  },
  {
    // 087. The mirror of 028, and anchored on the same rider for the same reason: the
    // "(before applying Weakness and Resistance)" placement is the whole rule, so a
    // differently-worded reduction must not be silently read as this one.
    match: /^during your opponent's next turn, attacks used by the defending pokemon do (\d+) less damage \(before applying weakness and resistance\) \.$/i,
    build: (plain) => ({
      id: 'lessDamageDealtWhileActive',
      amount: Number(plain.match(/do (\d+) less damage/i)?.[1] ?? 0),
    }),
  },
  {
    match: /^as long as this pokemon is on your bench, prevent all damage from and effects of attacks from your opponent's pokemon done to this pokemon\.$/i,
    build: () => ({ id: 'preventDamageWhileBenched' }),
  },
  {
    // 096 prints the two Colourless symbols as the word "ColorlessColorless" once
    // the energy-symbol markup is stripped, so the pattern counts THEM, not a number.
    match: /^as long as this pokemon is on your bench, your active pokemon's retreat cost is (colorless)+ less\.$/i,
    build: (plain) => ({
      id: 'retreatCostReduction',
      amount: (plain.match(/(colorless)/gi) ?? []).length,
    }),
  },
  {
    match: /^your opponent's active pokemon can't be healed\.$/i,
    build: () => ({ id: 'opponentCannotHeal' }),
  },
]

/**
 * Classify ONE printed Ability as passive, or report it unsupported.
 *
 * Returns `null` for a player-triggered text, so a caller scanning a whole board can
 * skip those without matching them twice.
 */
export function classifyPassiveAbility(text: string): PassiveAbility | null {
  const plain = plainCardText(text)
  for (const entry of PASSIVE_EFFECTS) {
    if (entry.match.test(plain)) return entry.build(plain)
  }
  return null
}

/** True when the printed text is a passive rule the engine understands. */
export function isSupportedPassiveAbility(text: string): boolean {
  const passive = classifyPassiveAbility(text)
  return passive !== null && passive.id !== 'unsupported'
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
    if (!isPlayerTriggeredAbility(ability.text)) {
      // 04.9 CP6: a passive is no longer a blanket "unsupported" bucket. It is
      // `supported` when the registry recognises it, and only the ones the hook does
      // not model yet (004/022/090/119/066) fall through to `unsupported` — so this
      // report keeps the remaining gap VISIBLE instead of claiming passives are done.
      if (isSupportedPassiveAbility(ability.text)) coverage.supported.push(ability.text)
      else coverage.unsupported.push(ability.text)
    }
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

/**
 * 04.9 CP4: rebuild a multi-pick's target list from the LIVE zone.
 *
 * **Stored indices cannot be reused across picks** — a pick moves a card out of
 * the zone and shifts everything after it, so a stored index would come to mean a
 * different card by the second pick. Re-deriving from the live zone is the only
 * stable approach.
 *
 * There is deliberately **no `taken` set to subtract**. The pick already SPLICES
 * the card out of the zone, so the live zone is authoritative: a Deck holding two
 * copies of a card still has one after the pick, and that remaining copy stays
 * pickable. An earlier draft of this checkpoint also filtered by a per-id count,
 * which double-counted the removal and hid a legitimate second copy — the exact
 * "wrong effect" failure this engine treats as worse than a missing one.
 */
export function refreshChoiceTargets(state: BattleState, choice: PendingChoice): ChoiceTarget[] {
  // A zone pick is filtered by the effect's own rule. 04.10 CP1 added the discard
  // families here rather than in a second list, so there is exactly ONE place that
  // decides what is pickable — four near-identical lists could disagree, and a wrong
  // target is worse than a missing one.
  const zoneFits = (card: CardDef): boolean => {
    if (choice.effect.kind === 'searchAttachEnergy') {
      // 04.10 CP4: Basic Energy whose `provides` is the named type. A SPECIAL Energy
      // provides nothing, so `provides !== undefined` is what makes it a "Basic Energy"
      // in the printed sense — the same test `basicEnergy` uses, plus 042's type test.
      if (!cardIsEnergy(card) || card.provides === undefined) return false
      return choice.effect.energyType
        ? card.provides === choice.effect.energyType
        : true
    }
    if (choice.effect.kind !== 'searchDeckUpTo') return true
    const { filter, requireType } = choice.effect
    const typeOk = requireType
      ? cardIsPokemon(card) && card.types.includes(requireType as CardType)
      : true
    if (!typeOk) return false
    switch (filter) {
      // 013/053/076: only a Basic may legally sit on the Bench, and only a Stadium is
      // a Stadium. The coarse families are the 04.8 CP3-B single-card search.
      case 'basicPokemon':
        return isBasicPokemon(card)
      case 'stadium':
        return cardIsStadium(card)
      // 048/063: "Basic Energy cards" — Energy whose `provides` is set, since special
      // Energy is not a "Basic Energy" in the printed sense.
      case 'basicEnergy':
        return cardIsEnergy(card) && card.provides !== undefined
      // 109/156: "Dragon Pokemon from your discard pile onto your Bench" — a Basic,
      // because only a Basic may sit on the Bench. `requireType` adds the Dragon test.
      case 'pokemon':
        return isBasicPokemon(card)
      // 103: "in any combination of Pokemon and Basic Energy cards".
      case 'pokemonOrEnergy':
        return isBasicPokemon(card) || (cardIsEnergy(card) && card.provides !== undefined)
      default:
        return true
    }
  }
  if (choice.source === 'discard') {
    return sideOf(state, choice.actor).discard
      .map((card, index) => ({ side: choice.actor, zone: 'discard' as const, index, cardId: card.id }))
      .filter((entry) => zoneFits(sideOf(state, choice.actor).discard[entry.index]))
  }
  if (choice.source === 'deck') {
    const deck = sideOf(state, choice.actor).deck
    return deck
      .map((card, deckIndex) => ({ side: choice.actor, zone: 'deck' as const, deckIndex, cardId: card.id }))
      .filter((entry) => zoneFits(deck[entry.deckIndex]))
  }
  // In-play targets are identified by `uid`, which no pick invalidates, so there is
  // nothing to re-derive: the stored list stays authoritative.
  return choice.targets
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
  // 04.10 CP2 / 125-146: the card name from "flip a coin for each X you have in
  // play". A NAME rather than a count, because the count depends on the board and is
  // therefore only knowable at resolution.
  let pendingHeadsPerOwnName = ''
  let pendingUntilTails = false

  for (const [sentenceIndex, sentence] of sentences.entries()) {
    // 04.9 CP7: whether this sentence is the ONLY one. A handful of clauses are legal
    // only as the whole printed text — 032's bare "Switch this Pokemon with 1 of your
    // Benched Pokemon." is one, and 020's first sentence is byte-identical to it while
    // being followed by a second switch. Honouring it there would apply one switch and
    // silently drop the other, which is the wrong-effect failure this engine ranks
    // above a missing one.
    const isLastSentence = sentenceIndex === sentences.length - 1
    // -- 04.9 CP1: the pure slice, matched FIRST so no looser pattern below can
    // swallow one. Every pattern is anchored end-to-end; the near-miss suite in
    // the CP1 harness is what proves that.
    // 04.9 CP4: the "up to N" searches. Matched BEFORE 04.8 CP3-B's `a/an` search,
    // which would otherwise read "up to 2" as a single card. `up to (\d+)` and the
    // "any number of" wording are the only two forms in 30c, and both are anchored
    // end-to-end so a neighbouring shape cannot fall in.
    const upToBench = sentence.match(
      /^search your deck for (?:up to (\d+)|any number of) basic pokemon and put them onto your bench\.$/i,
    )
    if (upToBench) {
      effects.push({
        kind: 'searchDeckUpTo',
        // BASIC, not "any Pokemon": only a Basic may legally sit on the Bench, and
        // 013/053/149 both print the word.
        filter: 'basicPokemon',
        to: 'bench',
        max: upToBench[1] ? Number(upToBench[1]) : Number.POSITIVE_INFINITY,
        // 04.10 CP1 made the source zone explicit; the 04.9 deck texts read `'deck'`.
        from: 'deck',
      })
      pendingCoin = false
      continue
    }
    const upToStadium = sentence.match(
      /^search your deck for up to (\d+) stadium cards?, reveal them, and put them into your hand\.$/i,
    )
    if (upToStadium) {
      effects.push({
        kind: 'searchDeckUpTo',
        // STADIUM, not "any Trainer": an Item or Supporter is not a legal pick.
        filter: 'stadium',
        to: 'hand',
        max: Number(upToStadium[1]),
        from: 'deck',
      })
      pendingCoin = false
      continue
    }
    // -- 04.9 CP7: board manipulation. 003 switches in the OPPONENT's Benched Pokemon;
    // 032 switches with your own and is MANDATORY; 066/152/158 are the same swap with
    // "You may", i.e. optional. Matched before the choices below so no damage clause
    // can swallow a sentence that has no damage in it.
    //
    // 020 ("…If you do, switch out your opponent's Active Pokemon to the Bench") and 115
    // ("search your deck … and switch it with this Pokemon") are NOT matched: both are
    // compounds, and half-applying either would be a wrong effect rather than a
    // missing one. They fall through to `unsupported`, which is the honest answer.
    const switchIn = sentence.match(/^switch in 1 of your opponent's benched pokemon to the active spot\.$/i)
    if (switchIn) {
      effects.push({ kind: 'switchWithBenched', optional: false, foe: true })
      pendingCoin = false
      continue
    }
    const switchOwn = sentence.match(/^you may switch this pokemon with 1 of your benched pokemon\.$/i)
    if (switchOwn) {
      effects.push({ kind: 'switchWithBenched', optional: true, foe: false })
      pendingCoin = false
      continue
    }
    // 020 is "Switch this Pokemon with 1 of your Benched Pokemon. If you do, switch
    // out your opponent's Active Pokemon to the Bench." — the FIRST sentence is
    // byte-identical to 032's whole text, so the pattern above happily matched it and
    // 020 would have applied one switch and silently dropped the second. The harness
    // caught exactly that. So a bare mandatory own-switch is accepted ONLY when it is
    // the ONLY clause in the sentence: 032 is one sentence, 020's first sentence is
    // followed by two more, and a clause that is one of several must not be honoured
    // on its own. This is the same all-or-nothing rule 04.8 CP1 used for spreads.
    if (/^switch this pokemon with 1 of your benched pokemon\.$/i.test(sentence) && isLastSentence) {
      effects.push({ kind: 'switchWithBenched', optional: false, foe: false })
      pendingCoin = false
      continue
    }
    // 04.10 CP2 / 087: "During your opponent's next turn, attacks used by the Defending
    // Pokemon do 30 less damage." `subject` is 'defender' — NOT 'attacker' — and that
    // is the whole reading of the card. Growl is 0 damage, so the "Defending Pokemon"
    // it refers to is simply the opponent's Active at the moment it resolves. The
    // effect therefore SLOWS THE OPPONENT's Active, which is why its window is
    // "+1": the opponent's next turn is when that Active gets to attack. Reading it
    // as 'attacker' would have made the Nidoran attack less while it is benched and
    // unable to attack at all — a rule that could never fire, which is the quietest
    // possible wrong effect.
    const lessDealt = sentence.match(
      /^during your opponent's next turn, attacks used by the defending pokemon do (\d+) less damage\s*\(before applying weakness and resistance\)\s*\.?$/i,
    )
    if (lessDealt) {
      effects.push({ kind: 'durationLessDamageDealt', whose: 'foe', subject: 'defender', amount: Number(lessDealt[1]) })
      pendingCoin = false
      continue
    }
    // 04.10 CP2 / 099: "Flip 3 coins. For each heads, discard an Energy from your
    // opponent's Active Pokemon." `pendingCoinCount` already carries the count from
    // "Flip 3 coins"; only the PER-HEAD EFFECT was missing, which is why 04.8 CP1
    // deliberately let this text fall through as unsupported.
    const perHeadsDiscardEnergy = sentence.match(
      /^for each heads, discard an energy from your opponent's active pokemon\.?$/i,
    )
    if (perHeadsDiscardEnergy && pendingCoinCount > 0) {
      effects.push({ kind: 'discardEnergyPerHead', flips: pendingCoinCount })
      pendingCoinCount = 0
      continue
    }
    // 04.10 CP2 / 125-146 Maushold: "Flip a coin FOR EACH Maushold you have in play.
    // For each heads, discard the top 2 cards of your opponent's deck." The count is
    // DYNAMIC — it depends on the board — so the sentence records how to compute it
    // rather than a number, and resolution reads the count then.
    const flipPerOwnName = sentence.match(
      /^flip a coin for each (\w+) you have in play\.?$/i,
    )
    if (flipPerOwnName) {
      pendingHeadsPerOwnName = flipPerOwnName[1]
      pendingCoin = false
      continue
    }
    const perHeadsDiscardTop = sentence.match(
      /^for each heads, discard the top (\d+) cards? of your opponent's deck\.?$/i,
    )
    if (perHeadsDiscardTop && pendingHeadsPerOwnName) {
      effects.push({
        kind: 'discardOpponentTopPerHead',
        countPerHead: Number(perHeadsDiscardTop[1]),
        perOwnName: pendingHeadsPerOwnName,
      })
      pendingHeadsPerOwnName = ''
      continue
    }
    // -- 04.9 CP5: the DURATION family. Matched before the families below so no
    // looser pattern can swallow a clause that installs state for a LATER turn, and
    // each is anchored end-to-end.
    //
    // The trailing `\s*\.?$` is load-bearing, not laziness: `plainCardText` turns
    // the data's `<em>(after applying Weakness and Resistance)</em>` into a plain
    // parenthetical, which leaves " ) ." — a space before the full stop. A
    // `$`-anchored pattern would silently miss 079, 107 and 110, i.e. three real
    // cards. 04.8 CP1 hit this same spacing artefact on Mewtwo ex and fixed it the
    // same way.
    //
    // `whose`/`subject` are read straight out of the printed words: "this Pokemon"
    // is the attacker, "the Defending Pokemon" is the defender, "your next turn" is
    // +2 and "your opponent's next turn" is +1.
    function durationWindow(raw: string): 'self' | 'foe' {
      return raw.toLowerCase() === "your opponent's" ? 'foe' : 'self'
    }
    function durationSubject(raw: string): 'attacker' | 'defender' {
      return raw.toLowerCase() === 'this' ? 'attacker' : 'defender'
    }

    const lessDamage = sentence.match(
      /^during (your|your opponent's) next turn, (this|the defending) pokemon takes (\d+) less damage from attacks\s*\(after applying weakness and resistance\)\s*\.?$/i,
    )
    if (lessDamage) {
      effects.push({
        kind: 'durationLessDamageTaken',
        whose: durationWindow(lessDamage[1]),
        subject: durationSubject(lessDamage[2]),
        amount: Number(lessDamage[3]),
      })
      pendingCoin = false
      continue
    }
    const moreDamage = sentence.match(
      /^during (your|your opponent's) next turn, (this|the defending) pokemon takes (\d+) more damage from attacks\s*\(after applying weakness and resistance\)\s*\.?$/i,
    )
    if (moreDamage) {
      effects.push({
        kind: 'durationMoreDamageTaken',
        whose: durationWindow(moreDamage[1]),
        subject: durationSubject(moreDamage[2]),
        amount: Number(moreDamage[3]),
      })
      pendingCoin = false
      continue
    }
    const preventAll = sentence.match(
      /^if heads, during (your|your opponent's) next turn, prevent all damage from and effects of attacks done to this pokemon\.?$/i,
    )
    if (preventAll && pendingCoin) {
      effects.push({ kind: 'durationPreventAllDamage', whose: durationWindow(preventAll[1]), subject: 'attacker' })
      pendingCoin = false
      continue
    }
    const lockRetreat = sentence.match(
      /^if heads, during (your|your opponent's) next turn, the defending pokemon can't retreat\.?$/i,
    )
    if (lockRetreat && pendingCoin) {
      effects.push({ kind: 'durationCantRetreat', whose: durationWindow(lockRetreat[1]), subject: 'defender' })
      pendingCoin = false
      continue
    }
    // 106 prints "can't use Slashing Strike" — ONE named attack. The same shape with
    // "attacks" is the blanket lock, so the two are split here rather than being two
    // patterns over near-identical text.
    const lockNamed = sentence.match(
      /^during (your|your opponent's) next turn, (this|the defending) pokemon can't use (.+)\.$/i,
    )
    if (lockNamed) {
      const name = lockNamed[3]
      const whose = durationWindow(lockNamed[1])
      const subject = durationSubject(lockNamed[2])
      effects.push(
        /^attacks$/i.test(name)
          ? { kind: 'durationCantAttack', whose, subject }
          : { kind: 'durationCantUseAttack', whose, subject, attackName: name },
      )
      pendingCoin = false
      continue
    }
    // -- 04.10 CP1: the ZONE searches. These differ from 013/053/076 only in which
    // zone is read and which cards qualify — the seam already exists from 04.9 CP4, so
    // each is a target rule rather than a new mechanism. Matched BEFORE the deck-only
    // patterns below so a discard text can never be read as a deck search.
    //
    // 048: "Put up to 2 Basic Energy cards from your discard pile into your hand."
    const discardEnergyToHand = sentence.match(
      /^put up to (\d+) basic energy cards? from your discard pile into your hand\.$/i,
    )
    if (discardEnergyToHand) {
      effects.push({
        kind: 'searchDeckUpTo', filter: 'basicEnergy', to: 'hand',
        max: Number(discardEnergyToHand[1]), from: 'discard',
      })
      pendingCoin = false
      continue
    }
    // 103: "Shuffle up to 3 in any combination of Pokemon and Basic Energy cards from
    // your discard pile into your deck." `any combination` is why the filter is the
    // union `pokemonOrEnergy` rather than two separate clauses.
    const discardMixedToDeck = sentence.match(
      /^shuffle up to (\d+) in any combination of pokemon and basic energy cards? from your discard pile into your deck\.$/i,
    )
    if (discardMixedToDeck) {
      effects.push({
        kind: 'searchDeckUpTo', filter: 'pokemonOrEnergy', to: 'deck',
        max: Number(discardMixedToDeck[1]), from: 'discard',
      })
      pendingCoin = false
      continue
    }
    // 109/156: "Put up to 3 Dragon Pokemon from your discard pile onto your Bench."
    // The TYPE is part of the target rule, so it is captured rather than assumed.
    const discardTypedToBench = sentence.match(
      /^put up to (\d+) (\w+) pokemon from your discard pile onto your bench\.$/i,
    )
    if (discardTypedToBench) {
      effects.push({
        kind: 'searchDeckUpTo', filter: 'pokemon', to: 'bench',
        max: Number(discardTypedToBench[1]), from: 'discard',
        // Card text capitalises the type; `types` is lowercase, so fold it here.
        requireType: discardTypedToBench[2].toLowerCase(),
      })
      pendingCoin = false
      continue
    }
    // 081: "Flip a coin. If heads, search your deck for a card and put it into your
    // hand." The existing `searchDeck` only matches a TYPED search ("a Pokemon", "an
    // Energy card"); "a card" is any card, which is the whole clause here.
    const searchAnyCard = sentence.match(/^if heads, search your deck for a card and put it into your hand\.$/i)
    if (searchAnyCard && pendingCoin) {
      effects.push({ kind: 'searchAnyToHand', coin: true })
      pendingCoin = false
      continue
    }
    // 04.9 CP3: "Discard the top 3 cards of your deck and put 1 of them into your
    // hand." Matched BEFORE 04.9 CP1's plain `discardTopOfDeck`, which would
    // otherwise read this as a bare "discard the top 3" and drop the pick half.
    const discardForPick = sentence.match(
      /^discard the top (\d+) cards of your deck and put 1 of them into your hand\.$/i,
    )
    if (discardForPick) {
      effects.push({ kind: 'discardTopForPick', count: Number(discardForPick[1]) })
      pendingCoin = false
      continue
    }
    // 04.9 CP3: "Place damage counters on your opponent's Active Pokemon until its
    // remaining HP is 50."
    const toRemainingHp = sentence.match(
      /^place damage counters on your opponent's active pokemon until its remaining hp is (\d+)\.$/i,
    )
    if (toRemainingHp) {
      effects.push({ kind: 'setDamageToRemainingHp', hp: Number(toRemainingHp[1]) })
      pendingCoin = false
      continue
    }
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
    // 04.10 CP4 / 007: "Search your deck for up to 2 Basic Energy cards and attach
    // them to your Pokemon IN ANY WAY YOU LIKE." That trailing phrase is the whole
    // rule and is why this is `perCard` and not `oneForAll`: each card gets its own
    // destination, so 007 can put both on one Pokemon or split them across two.
    // Dropping the phrase would silently narrow it to 063's rule — a wrong effect.
    const energyGift = sentence.match(
      /^search your deck for up to (\d+) basic energy cards and attach them to your pokemon in any way you like\.$/i,
    )
    if (energyGift) {
      effects.push({
        kind: 'searchAttachEnergy', from: 'deck',
        max: Number(energyGift[1]), target: 'perCard',
      })
      pendingCoin = false
      continue
    }
    // 04.10 CP4 / 042: "Search your deck for an amount of Basic Lightning Energy up to
    // the number of heads and attach it to THIS Pokemon." Two things are dynamic: the
    // cap is the heads from the flip-until-tails, and the destination is the attacker
    // itself. The clause records the cap as a FLAG rather than a number, because the
    // heads are not known until the attack resolves.
    const chargeUp = sentence.match(
      /^search your deck for an amount of basic (\w+) energy up to the number of heads and attach it to this pokemon\.$/i,
    )
    if (chargeUp && pendingUntilTails) {
      effects.push({
        kind: 'searchAttachEnergy', from: 'deck',
        energyType: chargeUp[1].toLowerCase(),
        max: 0, maxFromHeads: true, target: 'attacker',
      })
      pendingUntilTails = false
      pendingCoin = false
      continue
    }
    // 04.10 CP4 / 063: "Attach up to 2 Basic Energy cards from your discard pile to
    // 1 of your Pokemon." ONE destination for the whole set — which is the opposite
    // of 007's "in any way you like", and is the reason the two cannot share a rule.
    const empower = sentence.match(
      /^attach up to (\d+) basic energy cards from your discard pile to 1 of your pokemon\.$/i,
    )
    if (empower) {
      effects.push({
        kind: 'searchAttachEnergy', from: 'discard',
        max: Number(empower[1]), target: 'oneForAll',
      })
      pendingCoin = false
      continue
    }
    // 04.10 CP3 / 005-091: "If any of your Pokemon were Knocked Out by damage from an
    // attack during your opponent's last turn, this attack does N more damage." The
    // "by damage from an attack" rider is load-bearing and is carried by the clause
    // below; anchoring on the WHOLE sentence is what stops a "were Knocked Out during
    // your last turn" that says nothing about attacks from matching it.
    const koLastTurn = sentence.match(
      /^if any of your pokemon were knocked out by damage from an attack during your opponent's last turn, this attack does (\d+) more damage\.$/i,
    )
    if (koLastTurn) {
      effects.push({ kind: 'bonusDamageIfKoByAttackLastTurn', amount: Number(koLastTurn[1]) })
      pendingCoin = false
      continue
    }
    // 04.10 CP3 / 085-138: "If this Pokemon was damaged by an attack during your
    // opponent's last turn, this attack does that much more damage." There is NO
    // printed number — "that much" is the remembered damage — so the clause carries no
    // `amount` at all and resolution reads it off the Pokemon's own memory.
    const tookDamageLastTurn = sentence.match(
      /^if this pokemon was damaged by an attack during your opponent's last turn, this attack does that much more damage\.$/i,
    )
    if (tookDamageLastTurn) {
      effects.push({ kind: 'bonusDamagePerDamageTakenLastTurn' })
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
/**
 * 04.9 CP5: install one duration from a parsed clause.
 *
 * The window is resolved to an ABSOLUTE turn number here, once, and the Pokemon
 * the clause rides is resolved by `uid` at the same time. Both are deliberate:
 *  - a stored relative offset would have to be re-evaluated on every read and could
 *    disagree with itself across a promotion; a stored turn number cannot.
 *  - resolving the subject NOW means a later promotion cannot re-point a "+30 to
 *    the Defending Pokemon" at whichever Pokemon moved into the Active spot.
 *
 * The clause is applied even when the window is not this turn's — installing state
 * for a future turn is the entire point.
 */
function applyDuration(
  state: BattleState,
  context: EffectContext,
  whose: 'self' | 'foe',
  subject: 'attacker' | 'defender',
  effect: DurationEffect,
): void {
  // The subject is resolved to a `uid` NOW, not re-derived on each read, so a later
  // promotion cannot re-point 110's "+30 to the Defending Pokemon" at whichever
  // Pokemon moved into the Active spot.
  //
  // A clause riding the DEFENDER is skipped when there is no defender. That is not
  // defensive padding: `EffectContext.defender` is genuinely nullable, and a clause
  // with no subject has nothing to ride — installing a duration against no Pokemon
  // would be a silent no-op recorded as if it had applied.
  const target = subject === 'attacker' ? context.attacker : context.defender
  if (!target) return
  addDuration(state, target.uid, effect, durationTurnFor(state.turn, whose), context.attackName)
  logEvent(state, 'pokemonBnb.log.durationAdded', {
    player: context.actor,
    card: target.card.name,
    source: context.attackName,
  })
}

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
    // 04.9 CP3: "Place damage counters … until its remaining HP is N." Applied to
    // the DEFENDER, and floored at 0 so a Pokemon that is already below the
    // threshold takes nothing rather than being healed by a "place counters" clause.
    case 'setDamageToRemainingHp': {
      const defender = context.defender
      if (!defender) break
      const wanted = Math.max(0, defender.card.hp - effect.hp)
      const placed = Math.max(0, wanted - defender.damage)
      if (placed > 0) {
        defender.damage += placed
        logEvent(state, 'pokemonBnb.log.damageDealt', {
          player: context.actor,
          attack: context.attackName,
          target: defender.card.name,
          amount: placed,
        })
      }
      break
    }
    // 04.9 CP3: consumed by resolveAttack (it parks a pick instead).
    case 'discardTopForPick':
      break
    // 04.9 CP1: consumed by resolveAttack (the bonuses, the flag, the recoil).
    case 'bonusDamageIfDefenderDamaged':
    case 'bonusDamageIfKoByAttackLastTurn':
    case 'bonusDamagePerDamageTakenLastTurn':
    case 'bonusDamageIfHasTool':
    case 'bonusDamagePerHandCard':
    case 'bonusDamagePerBenchWithHp':
    case 'noWeakness':
    case 'selfDamage':
    case 'spreadOwnBench':
      break
    case 'heal': {
      // 04.9 CP6 / 100: Yveltal's "your opponent's Active Pokemon can't be healed".
      // The printed scope is the OPPONENT'S ACTIVE, so this heals the attacker (its
      // own Pokemon, and therefore its controller's own Active) and is never blocked.
      // The gate therefore belongs on the paths that heal someone ELSE's Active.
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
    // 04.9 CP4: parked by resolveAttack as a multi-pick, applied pick-by-pick by
    // resolveChoice. Reaching here means a mis-classified phase, where doing nothing
    // is the safe answer.
    case 'searchDeckUpTo':
      break
    // 04.10 CP4: `searchAttachEnergy` is consumed by resolveAttack (it parks a pick).
    // `attachStaged` is a `PendingChoice`-only kind and never reaches this switch.
    case 'searchAttachEnergy':
      break
    // 04.9 CP5: installed at RESOLUTION time (they take effect on a LATER turn), so
    // they read `context.attacker` / `context.defender` rather than any zone, and
    // `whose` becomes an absolute turn number inside `applyDuration`.
    case 'durationCantAttack':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'cantAttack' })
      break
    case 'durationCantUseAttack':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'cantUseAttack', attackName: effect.attackName })
      break
    case 'durationLessDamageTaken':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'lessDamageTaken', amount: effect.amount })
      break
    case 'durationMoreDamageTaken':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'moreDamageTaken', amount: effect.amount })
      break
    case 'durationPreventAllDamage':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'preventAllDamage' })
      break
    case 'durationCantRetreat':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'cantRetreat' })
      break
    // 04.10 CP2 / 087: the mirror of 04.9 CP5's `lessDamageTaken`.
    case 'durationLessDamageDealt':
      applyDuration(state, context, effect.whose, effect.subject, { kind: 'lessDamageDealt', amount: effect.amount })
      break
    // 04.10 CP2 / 099: one Energy discarded from the OPPONENT's Active per head.
    //
    // Bounded by BOTH the flip count and what is actually attached, so a run of
    // three heads against a defender holding one Energy discards one rather than
    // reporting two misses. The discard never cascades: an Energy that has no
    // `provides` is still a card and is still discarded.
    case 'discardEnergyPerHead': {
      const foeSlot = foeOf(context.actor)
      const victim = sideOf(state, foeSlot).active
      if (!victim) break
      let heads = 0
      for (let flip = 0; flip < effect.flips; flip += 1) if (flipCoin(state)) heads += 1
      const discarded = Math.min(heads, victim.attachedEnergy.length)
      for (let i = 0; i < discarded; i += 1) {
        const card = victim.attachedEnergy.pop()
        if (card) sideOf(state, foeSlot).discard.push(card)
      }
      if (discarded > 0) {
        logEvent(state, 'pokemonBnb.log.effectDiscardEnergy', { player: foeSlot, count: discarded })
      }
      break
    }
    // 04.10 CP2 / 125-146: the top N of the OPPONENT's deck per head, where the number
    // of flips is the number of matching Pokemon the attacker has in play.
    case 'discardOpponentTopPerHead': {
      const own = ownInPlay(state, context.actor)
      const matching = own.filter((pokemon) => nameMatches(pokemon.card.name, [effect.perOwnName])).length
      if (matching === 0) break
      let heads = 0
      // Bounded by the count found, so the loop cannot run away on a large board.
      for (let flip = 0; flip < matching; flip += 1) if (flipCoin(state)) heads += 1
      const foeSide = sideOf(state, foeOf(context.actor))
      let discarded = 0
      for (let i = 0; i < heads; i += 1) {
        const batch = foeSide.deck.splice(0, effect.countPerHead)
        if (batch.length === 0) break
        foeSide.discard.push(...batch)
        discarded += batch.length
        // A short deck simply ends the loop; a partial batch is NOT padded, because
        // discarding cards that do not exist would be a wrong effect.
      }
      if (discarded > 0) {
        logEvent(state, 'pokemonBnb.log.effectDiscardEnergy', { player: foeOf(context.actor), count: discarded })
      }
      break
    }
    // 04.10 CP1 / 081: parked by resolveAttack behind a coin flip, applied by
    // resolveChoice. Every deck card qualifies, so there is no filter to apply.
    case 'searchAnyToHand':
      break
    // 04.9 CP7: parked by resolveAttack as a board switch, applied by resolveChoice.
    case 'switchWithBenched':
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
      // 04.10 CP3: a spread hit is still "damage from an attack", so 085/138 must
      // remember it. Omitting this would make a benched-then-promoted Lycanrock answer
      // 0 after being hit by a spread — a wrong effect, not a missing one.
      recordAttackDamageOn(active, state.turn, outcome.damage)
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
    // 04.10 CP3: as above — a spread bench hit is attack damage too.
    recordAttackDamageOn(target, state.turn, effect.amount)
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
    // 04.10 CP3: a spread KOs the BENCH too, and 005/091 says "any of your Pokemon",
    // so a bench knockout has to set the same side flag the Active path sets.
    sideOf(state, defenderSlot).koByAttackTurn = state.turn
    performBenchKo(state, defenderSlot, target)
    if (state.over) return
  }
  if (active && matches(active) && isKnockedOut(active)) {
    // 04.10 CP3: as above, for the Active half of a spread.
    sideOf(state, defenderSlot).koByAttackTurn = state.turn
    performKo(state, defenderSlot)
  }
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
    } else if (effect.kind === 'bonusDamageIfKoByAttackLastTurn') {
      // 04.10 CP3 / 005-091. The bonus lands in `base` like any other printed
      // bonus, so the defender's Weakness and Resistance still apply to it.
      const bonus = koByAttackLastTurn(state, actor) ? effect.amount : 0
      base += bonus
      if (bonus > 0) logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
    } else if (effect.kind === 'bonusDamagePerDamageTakenLastTurn') {
      // 04.10 CP3 / 085-138. The printed "that much" is the attack damage the
      // ATTACKER itself took last turn, read off its own memory — not the
      // defender's, and not its current damage counters. A Lycanrock that was hit
      // for 60 and then healed back to zero still deals the remembered 60.
      const bonus = damageTakenLastTurn(state, attacker)
      base += bonus
      if (bonus > 0) logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: bonus })
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
  // 04.9 CP5: durations are read HERE, after Weakness and Resistance, because that
  // is the order 079/107/110 print ("after applying Weakness and Resistance").
  // Reading them before the multiplier would silently halve a "-60" against a
  // Weakness ×2 — a wrong effect, not a rounding quibble.
  //
  // `preventAllDamage` (006/016/044) is checked FIRST and is absolute: those cards
  // prevent "all damage", so a +30 modifier riding alongside cannot leak a point
  // past it. The printed "and effects of attacks" is NOT claimed here — see the
  // CP5 entry in the plan for what that would still need.
  // 04.9 CP6 / 033: a Benched "Keep Hidden" prevents ALL damage. `isBenched` is the
  // whole rule — the card reads "as long as this Pokemon is **on your Bench**", so an
  // Active copy of the same card gets nothing. `slotOwning` answers "is it benched?"
  // directly instead of testing two sides with `includes`, which would be true for an
  // ACTIVE too and silently disable the Ability everywhere.
  //
  // Checked alongside CP5's `preventAllDamage` duration because both mean "no damage
  // lands" — the order cannot change the outcome, and the log line is emitted once.
  const defenderSlot = slotOwning(state, defender)
  const benchedShield = defenderSlot
    ? sideOf(state, defenderSlot).bench.includes(defender) && hasPassive(defender, 'preventDamageWhileBenched')
    : false
  const prevented = benchedShield || findDuration(state, defender.uid, 'preventAllDamage') !== null
  const adjusted = prevented
    ? 0
    : Math.max(0, outcome.damage + durationDamageAdjustment(state, defender.uid))
  if (adjusted > 0) {
    defender.damage += adjusted
    // 04.10 CP3: an ATTACK hit is exactly what 085/138 remembers. This is the ONE
    // place main attack damage is recorded, and it sits after `preventAllDamage` has
    // already forced `adjusted` to 0, so a prevented hit leaves no memory — recording
    // it before that test would let a shielded Pokemon "remember" a hit it never took.
    recordAttackDamageOn(defender, state.turn, adjusted)
    logEvent(state, 'pokemonBnb.log.damageDealt', {
      player: actor,
      attack: context.attackName,
      target: defender.card.name,
      amount: adjusted,
      weakness: outcome.weakness,
      resistance: outcome.resistance,
    })
  } else if (outcome.damage > 0) {
    // The attack had a real number and something absorbed it. Logged rather than
    // dropped, so a player can tell a prevented attack from one that dealt 0.
    logEvent(state, 'pokemonBnb.log.damagePrevented', {
      player: actor,
      attack: context.attackName,
      target: defender.card.name,
      amount: outcome.damage,
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
    // 04.10 CP3: record the KO against the LOSING side, stamped with the current turn.
    // It is stamped rather than set, so a second KO later the same turn cannot be
    // missed and an older turn's KO cannot leak forward — the read compares the stamp
    // to `turn - 1`. This is the site that makes 005/091 true, and it is deliberately
    // NOT inside `performKo`, which also serves Between-Turns poison and Burn KOs that
    // the card's "by damage from an attack" explicitly excludes.
    sideOf(state, defenderSlot).koByAttackTurn = state.turn
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
        // 04.9 CP4: a single mandatory pick over in-play Pokemon, so `remaining` is 1
        // and `source: 'inPlay'` — a uid survives any pick, so the list is never
        // rebuilt. Making the fields explicit is what keeps them required: an
        // omitted field would silently reintroduce the one-shot assumption this
        // checkpoint is removing.
        remaining: 1,
        source: 'inPlay',
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
        // 04.9 CP4: one mandatory card, out of the actor's own deck. `source: 'deck'`
        // so the list can be re-derived from the live deck if a future variant ever
        // takes more than one.
        remaining: 1,
        source: 'deck',
        effect: { kind: 'searchDeck', filter: search.filter },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: targets.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no matching card in deck' })
    }
  }

  // 6b. 04.9 CP3: "Discard the top N of your deck and put 1 of them into your
  // hand." TWO phases in one clause: the discard happens immediately, then a pick
  // is parked over exactly the cards it just discarded. Their indices are
  // `discard.length - N .. discard.length`, so no search is needed and nothing can
  // have shifted them (a pending choice blocks every other action).
  const forPick = effects.find((effect) => effect.kind === 'discardTopForPick')
  if (forPick && forPick.kind === 'discardTopForPick') {
    const ownSide = sideOf(state, actor)
    const moved = ownSide.deck.splice(0, forPick.count)
    ownSide.discard.push(...moved)
    const firstIndex = ownSide.discard.length - moved.length
    const targets = moved.map((card, offset) => ({
      side: actor,
      zone: 'discard' as const,
      index: firstIndex + offset,
      cardId: card.id,
    }))
    // A short deck discards fewer than N; if that left nothing, there is no pick
    // to offer and the attack simply ends the turn.
    if (targets.length > 0) {
      state.pendingChoice = {
        actor,
        targets,
        // 04.9 CP4: one mandatory card out of the discard pile it just filled.
        // `source: 'discard'` is what lets the list be re-derived from the live pile
        // rather than trusted as a stored index list.
        remaining: 1,
        source: 'discard',
        effect: { kind: 'pickFromDiscard', to: 'hand' },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: targets.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no cards to choose from' })
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
        // 04.9 CP4: a heal is a single mandatory pick — `remaining` 1, and
        // `source: 'inPlay'` because a uid survives every pick and the list is
        // never rebuilt.
        remaining: 1,
        source: 'inPlay',
        effect: { kind: 'healChosen', amount: healTarget.amount },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: bench.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no Benched Pokemon to heal' })
    }
  }

  // 8. 04.9 CP4: the "up to N" deck searches — the one place the 04.8 seam has to
  // bend, because it resolves ONCE and closes the turn while "up to 2" may need
  // two resolutions and may be declined outright.
  //
  // `remaining` is FINISHED here, at park time, and never left as `Infinity`:
  // the printed cap is intersected with what the deck and the Bench can actually
  // hold. `JSON.stringify(Infinity)` is `null`, so an unbounded `remaining` would
  // silently break the snapshot round trip 04.8 CP6 established — and the honest
  // cap for "any number of Basic Pokemon onto your Bench" is the Bench room anyway.
  //
  // A full Bench (or an empty, unfiltered deck) parks NOTHING rather than an empty
  // picker. An empty picker would refuse every action with nothing to tap, which is
  // exactly the soft-lock rule CP3-B and CP2 both used.
  const upTo = effects.find((effect) => effect.kind === 'searchDeckUpTo')
  if (upTo && upTo.kind === 'searchDeckUpTo') {
    const side = sideOf(state, actor)
    // 04.10 CP1: the source zone is part of the clause, so the cap is measured against
    // THAT zone's eligible cards — a full Bench still bounds a Bench-bound search, and
    // a two-card discard bounds a "up to 3" to two.
    const source = upTo.from === 'discard' ? side.discard : side.deck
    const benchRoom = upTo.to === 'bench' ? Math.max(0, MAX_BENCH - side.bench.length) : source.length
    // `source.length` bounds the hand/deck cases: you cannot take more cards than the
    // zone holds, so an over-large cap costs nothing and stays finite either way.
    const cap = Math.min(upTo.max, benchRoom)
    if (cap <= 0) {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no room to take any card' })
    } else {
      const probe: PendingChoice = {
        actor,
        targets: [],
        remaining: cap,
        source: upTo.from,
        effect: upTo,
        attackName: context.attackName,
      }
      // Count only ELIGIBLE cards, so "up to 3" over a discard holding one Dragon is a
      // cap of 1 rather than a picker that offers nothing on the second pick.
      const eligible = refreshChoiceTargets(state, probe).length
      if (eligible === 0) {
        logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no matching card in the zone' })
      } else {
        probe.remaining = Math.min(cap, eligible)
        probe.targets = refreshChoiceTargets(state, probe)
        state.pendingChoice = probe
        logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: probe.targets.length })
      }
    }
  }

  // 04.10 CP4: take Basic Energy out of a zone and ATTACH it. This runs AFTER the
  // `searchDeckUpTo` arm above because the two can both move a card out of a pile and
  // they are never on the same card text — but the ordering means a future card that
  // printed both would take the search, not the attach.
  const attachSearch = effects.find((effect) => effect.kind === 'searchAttachEnergy')
  if (attachSearch && attachSearch.kind === 'searchAttachEnergy') {
    const side = sideOf(state, actor)
    const pile = attachSearch.from === 'discard' ? side.discard : side.deck
    // 042's cap is the heads flipped BEFORE the first tails, resolved HERE rather than
    // at parse time — the number genuinely does not exist until the attack resolves.
    // It is bounded by MAX_COIN_FLIPS, as every other until-tails loop in this file is,
    // so a pathological seed cannot park an unbounded picker.
    let cap = attachSearch.max
    if (attachSearch.maxFromHeads) {
      let heads = 0
      while (heads < MAX_COIN_FLIPS && flipCoin(state)) heads += 1
      cap = heads
      logEvent(state, 'pokemonBnb.log.effectBonusDamage', { player: actor, amount: heads })
    }
    // Bounded by ELIGIBLE cards, never by the pile's size: "up to 2 Basic Lightning
    // Energy" over a deck holding one Lightning Energy is a cap of 1, not a picker that
    // offers nothing on the second pick. That is the same rule 04.10 CP1 applied to
    // `searchDeckUpTo`, and for the same reason — a dead second pick is a soft-lock.
    const eligible = pile.filter((card) =>
      cardIsEnergy(card) && card.provides !== undefined &&
      (attachSearch.energyType ? card.provides === attachSearch.energyType : true),
    ).length
    const bounded = Math.min(cap, eligible)
    if (bounded <= 0) {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no matching Energy to attach' })
    } else {
      const probe: PendingChoice = {
        actor,
        targets: [],
        remaining: bounded,
        source: attachSearch.from,
        effect: attachSearch,
        attackName: context.attackName,
        staged: [],
      }
      const available = refreshChoiceTargets(state, probe)
      if (available.length === 0) {
        logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no matching Energy in the zone' })
      } else {
        probe.remaining = Math.min(bounded, available.length)
        probe.targets = available
        state.pendingChoice = probe
        logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: probe.targets.length })
      }
    }
  }

  // 10. 04.10 CP1 / 081: a coin-gated "search for a CARD". The flip is resolved HERE,
  // at resolution, so a tails result simply does not park — there is nothing to
  // decline, the same shape as `bonusDamage`'s coin gate. An empty deck also parks
  // nothing, for the soft-lock reason every other pick in this file uses.
  const anyCard = effects.find((effect) => effect.kind === 'searchAnyToHand')
  if (anyCard && anyCard.kind === 'searchAnyToHand') {
    if (anyCard.coin && !flipCoin(state)) {
      logEvent(state, 'pokemonBnb.log.coinTails', { player: actor })
    } else {
      const deck = sideOf(state, actor).deck
      if (deck.length === 0) {
        logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no cards in deck' })
      } else {
        state.pendingChoice = {
          actor,
          targets: deck.map((card, deckIndex) => ({ side: actor, zone: 'deck' as const, deckIndex, cardId: card.id })),
          remaining: 1,
          source: 'deck',
          effect: { kind: 'searchAnyToHand', coin: anyCard.coin },
          attackName: context.attackName,
        }
        logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: deck.length })
      }
    }
  }

  // 9. 04.9 CP7: a board switch parks a choice like every other target-picking clause.
  // An OPTIONAL switch ("You may…", 066/152/158) is still parked — the player has to be
  // offered the option, and `finishChoice` is what declines it. A mandatory one with
  // nothing to switch to parks nothing, which is the same soft-lock rule CP2/CP3 used.
  //
  // Offered targets are read from the side that OWNS the Benched Pokemon: `foe` is 003,
  // which switches in the OPPONENT's Bench, so the list comes from the other side.
  const swap = effects.find((effect) => effect.kind === 'switchWithBenched')
  if (swap && swap.kind === 'switchWithBenched') {
    const owner = swap.foe ? foeOf(actor) : actor
    const bench = sideOf(state, owner).bench
    if (bench.length > 0) {
      state.pendingChoice = {
        actor,
        targets: bench.map((pokemon, index) => ({ side: owner, zone: index, uid: pokemon.uid })),
        remaining: 1,
        source: 'inPlay',
        effect: { kind: 'switchActive', side: swap.foe ? 'defender' : 'attacker', optional: swap.optional },
        attackName: context.attackName,
      }
      logEvent(state, 'pokemonBnb.log.chooseTarget', { player: actor, count: bench.length })
    } else {
      logEvent(state, 'pokemonBnb.log.effectUnsupported', { text: 'no Benched Pokemon to switch with' })
    }
  }
}
