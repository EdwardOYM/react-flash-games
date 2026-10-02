// 04.12 CP8 — Trainer effect PARSING and the trainer coverage measurement.
//
// **Why this module exists, and what it deliberately does NOT do.** 04.11 measured
// attacks, 04.12 CP1 measured abilities, and TRAINERS were missed by both: `playTrainer`
// existed as an action and the UI could play an Item, a Supporter and a Stadium, while
// nothing anywhere read a trainer's rule text. That is the same class of gap abilities
// had — a whole card category that reads as playable while its text does nothing.
//
// The first attempt to measure it found the real blocker: **all five 30C trainers shipped
// with `effect: ""`**, so there were no rules in the dataset to parse at all. Writing a
// parser then would have implemented ZERO cards while the coverage number read
// "0/5 blocked-on-data" rather than "0/5 done", which is worse than no number. Those
// five effect strings have since been hand-written into the card data, so the measurement
// this plan originally asked for is finally possible — and this module is it.
//
// **THE DISTINCTION THIS MODULE EXISTS TO KEEP: RECOGNISED IS NOT IMPLEMENTED.**
// A parser can name every sentence of every trainer in the set on the day it is written,
// and that number would be worthless — it measures the REGEX, not the game. So a trainer
// card is reported twice over:
//   - `recognised`  — every sentence the parser matched, and
//   - `implemented` — every clause the engine can actually execute today.
// The second number is 0/5 on arrival, and it is derived from `trainerClauseSupport`,
// a hand-audited table carrying a named blocker per unimplemented clause. Reporting
// 5/5 recognised and 0/5 implemented in the same breath is the honest shape; a single
// blended number is how a set gets reported as supported when it is not.
//
// **A NEW KIND WITH NO SUPPORT ENTRY REPORTS `unstated`, NOT A DEFAULT.** The fallback
// is a named status rather than a guess, so adding a clause kind without auditing it
// cannot quietly move a number — the same lesson as the `abilities` vs `ability` scan
// that twice reported a confident 0.
//
// Parsing discipline is copied from `parseAttackEffects` on purpose: accent-folded via
// `plainCardText` ("Pokémon" must match ASCII patterns), patterns anchored
// end-to-end, a trailing parenthetical REMINDER stripped rather than parsed, and a
// STRICT all-or-nothing guard — if any sentence is unrecognised the whole trainer is
// unsupported. The guard is stricter here than the attack one on purpose: an attack that
// half-resolves misprices one card, while a Trainer that half-resolves silently eats a
// card from the player's hand and gives back a weaker effect, which is a wrong game
// state rather than a wrong number.

import { plainCardText } from './effects'

/** One clause of a Trainer card's printed rule text. */
export type ParsedTrainerEffect =
  /**
   * 126/128/163's PLAY COST: "You can use this card only if you discard 2 other cards
   * from your hand." / "Discard 2 of the other cards in your hand in order to play this
   * card." These are two different printed sentences for one rule, so they are one kind
   * with a count rather than two kinds.
   */
  | { kind: 'discardToPlay'; count: number }
  /**
   * 126/128's search. `pokemonWithoutRuleBox` is 126 Poké Pad's own filter — the card
   * prints "(Pokémon ex, Pokémon V, etc. have Rule Boxes.)" and the engine's data-backed
   * answer to "has a Rule Box" is the `suffix` field, which `prizesForKnockOut` already
   * reads. A filter, not a new mechanism, for the same reason 04.10 CP1 widened
   * `searchDeckUpTo` rather than adding a `searchDiscardUpTo`.
   */
  | {
      kind: 'searchDeckToHand'
      filter: 'pokemon' | 'pokemonWithoutRuleBox' | 'energy' | 'trainer'
    }
  /**
   * The trailing "Then, shuffle your deck." Recognised as an explicit NO-OP so it does
   * not become an `unsupported` sentence and take the whole search down with it.
   *
   * **Carries forward 04.8 CP3-B's recorded fidelity gap rather than hiding it:** the
   * printed shuffle is NOT performed, so a later search may see a different deck order
   * than a physical game would. Both peers run identical code over identical seeded
   * state, so they cannot diverge — the gap is fidelity to the table, not sync.
   */
  | { kind: 'shuffleDeck' }
  /** 127 Switch: "Switch your Active Pokémon with 1 of your Benched Pokémon." */
  | { kind: 'switchOwnActiveWithBenched' }
  /**
   * 163 Misty: a conditional damage bonus gated on the ATTACKER's printed name, applied
   * AFTER Weakness and Resistance. `afterWeaknessResistance` is carried rather than
   * assumed, because it is the whole reason this card is not an existing `bonusDamage`
   * clause — see the support table.
   */
  | {
      kind: 'bonusDamageIfAttackerNameContains'
      nameFragment: string
      amount: number
      afterWeaknessResistance: boolean
    }
  /**
   * 179 N: BOTH players shuffle their hand into their deck, then each draws one card per
   * remaining Prize card. One kind for the pair, because the second sentence only means
   * anything as the second half of the first.
   */
  | { kind: 'bothPlayersShuffleHandIntoDeckThenDrawPerRemainingPrize' }
  /**
   * A sentence this parser does not recognise. Carries the sentence VERBATIM so the
   * coverage report can name what it failed on rather than only that it failed.
   */
  | { kind: 'unsupported'; sentence: string }

/**
 * Split a trainer's rule text into sentences, the way `parseAttackEffects` does.
 *
 * **The reminder strip is the reason 126 does not read as unparseable.** Poke Pad ends
 * "(Pokemon ex, Pokemon V, etc. have Rule Boxes.)" — a parenthetical GLOSS that defines
 * the card's own filter, not an effect. Left in, it becomes its own sentence, the
 * all-or-nothing guard fires, and a card whose search clause parses perfectly is
 * reported unsupported. 04.8 CP1 hit this exact trap with the spread caveat, and 04.10
 * CP8 with "(Apply Weakness as x2.)"; the rule is the same each time: a reminder is
 * dropped, and anything it carried is preserved on the clause that needed it.
 */
function trainerSentences(text: string): string[] {
  const plain = plainCardText(text)
    .replace(/\(\s*pokemon ex, pokemon v, etc\.? have rule boxes\.?\s*\)/gi, ' ')
  if (!plain.trim()) return []
  return plain.split(/(?<=\.)\s+/).filter((sentence) => sentence.trim().length > 0)
}

/**
 * Parse one trainer card's verbatim `effect` text into ordered clauses.
 *
 * **Never throws.** A malformed or absent effect string yields either `[]` (no text) or
 * a single `unsupported` clause, so a bad record can never abort a whole-set scan — the
 * same rule `coverage.ts` applies to every category it measures.
 */
export function parseTrainerEffects(text: string): ParsedTrainerEffect[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const sentences = trainerSentences(text)
  const effects: ParsedTrainerEffect[] = []
  // 179 N's "Then, each player draws..." only means something as the SECOND half of the
  // preceding shuffle, so the first half is held between the sentences rather than
  // pushed alone — the same shape `parseAttackEffects` uses for 174's "or" between two
  // Energy types and 161's "If you do,".
  let pendingBothShuffle = false

  for (const sentence of sentences) {
    // -- 128: the play cost, phrased as a restriction on USE.
    const useIfDiscard = sentence.match(
      /^you can use this card only if you discard (\d+) other cards? from your hand\.$/i,
    )
    if (useIfDiscard) {
      effects.push({ kind: 'discardToPlay', count: Number(useIfDiscard[1]) })
      continue
    }
    // -- 163: the same cost, phrased as a condition of PLAYING. Matched separately
    // because the two sentences are genuinely different printed words, and one anchored
    // pattern covering both would be a pattern that quietly accepts a third shape.
    const discardToPlay = sentence.match(
      /^discard (\d+) of the other cards in your hand in order to play this card\.$/i,
    )
    if (discardToPlay) {
      effects.push({ kind: 'discardToPlay', count: Number(discardToPlay[1]) })
      continue
    }
    // -- 126/128: the search. Anchored, and the "doesn't have a Rule Box" qualifier is
    // matched as its own alternative rather than by stripping the words and reusing the
    // plain search: dropping the qualifier would silently widen 126 into "any Pokemon",
    // which is a STRONGER card than the one printed.
    const search = sentence.match(
      /^search your deck for a pokemon(?: that doesn't have a rule box)?, reveal it, and put it into your hand\.$/i,
    )
    if (search) {
      effects.push({
        kind: 'searchDeckToHand',
        filter: /rule box/i.test(search[0]) ? 'pokemonWithoutRuleBox' : 'pokemon',
      })
      continue
    }
    // -- 126/128: the trailing shuffle, carried forward as the recorded no-op.
    if (/^then, shuffle your deck\.$/i.test(sentence)) {
      effects.push({ kind: 'shuffleDeck' })
      continue
    }
    // -- 127.
    if (/^switch your active pokemon with 1 of your benched pokemon\.$/i.test(sentence)) {
      effects.push({ kind: 'switchOwnActiveWithBenched' })
      continue
    }
    // -- 179 N, first half.
    if (/^each player shuffles his or her hand into his or her deck\.$/i.test(sentence)) {
      pendingBothShuffle = true
      continue
    }
    // -- 179 N, second half. Consumes the held flag, so the pair resolves to ONE clause
    // and a lone "each player draws" sentence cannot become an effect on its own.
    if (/^then, each player draws a card for each of his or her remaining prize cards\.$/i.test(sentence)) {
      if (pendingBothShuffle) {
        effects.push({ kind: 'bothPlayersShuffleHandIntoDeckThenDrawPerRemainingPrize' })
        pendingBothShuffle = false
      } else {
        effects.push({ kind: 'unsupported', sentence })
      }
      continue
    }
    // -- 163. The qualifier is captured rather than matched away: "after applying
    // Weakness and Resistance" is the reason this is NOT an ordinary `bonusDamage`, and
    // a clause that dropped the words would be applied at the wrong point in the maths.
    const misty = sentence.match(
      /^if this turn's attack does damage to the defending pokemon \(after applying weakness and resistance\), and if the attacking pokemon has (.+?) in its name, the attack does (\d+) more damage to the defending pokemon\.$/i,
    )
    if (misty) {
      effects.push({
        kind: 'bonusDamageIfAttackerNameContains',
        nameFragment: misty[1].trim(),
        amount: Number(misty[2]),
        afterWeaknessResistance: true,
      })
      continue
    }
    // Anything left is unrecognised, and the sentence is kept VERBATIM so the report can
    // name it. This is the correct outcome, not a gap: a wrong effect is worse than a
    // missing one, and a confident guess at an unfamiliar sentence is a wrong effect.
    effects.push({ kind: 'unsupported', sentence })
  }

  // A half-finished 179 (the shuffle with no matching draw) is not a partial effect — it
  // is an unparseable card, and reporting the first half as if it applied would move the
  // opponent's hand for free.
  if (pendingBothShuffle) {
    return [
      {
        kind: 'unsupported',
        sentence: 'each player shuffles his or her hand into his or her deck (unpaired)',
      },
    ]
  }

  // STRICT all-or-nothing, unlike the attack parser's filtered exception list. See the
  // module header: a Trainer that half-resolves takes a card from the player's hand and
  // returns a weaker effect, which is a wrong game state and not merely a wrong number.
  if (effects.some((effect) => effect.kind === 'unsupported')) {
    return effects.filter((effect) => effect.kind === 'unsupported')
  }
  return effects
}

// -- the coverage measurement --

/**
 * How far the ENGINE has actually got with one clause, which is a different question
 * from whether the parser recognised it.
 *
 * The three states exist because collapsing them is exactly the error this checkpoint
 * was written to prevent:
 *  - `supported` — the engine executes this today.
 *  - `reusable` — the mechanism demonstrably exists (04.x built it for an ATTACK) but
 *    `playTrainer` has no call site for it, so a Trainer cannot reach it. This is the
 *    state a reader most needs separated out: the work is wiring, not invention, and
 *    reporting it as "unsupported" would send someone to build a second deck search.
 *  - `needs-mechanism` — no engine path exists at all.
 */
export type TrainerClauseSupport = 'supported' | 'reusable' | 'needs-mechanism'

const CLAUSE_SUPPORT: Record<Exclude<ParsedTrainerEffect['kind'], 'unsupported'>, TrainerClauseSupport> = {
  // 04.8 CP3-B made the printed shuffle a deliberate no-op and recorded the fidelity
  // gap (deck order may differ from a physical game; both peers still agree, so there is
  // no sync consequence). The clause is "done" in the same sense and for the same
  // reason — but per the module header's honesty rule `playTrainer` does not yet route
  // ANY clause, so no CARD containing it is reported implemented.
  shuffleDeck: 'supported',
  // The `searchDeck` choice effect, `refreshChoiceTargets`' deck arm and the
  // `pile[index].id === target.cardId` re-check all exist (04.8 CP3-B). `playTrainer`
  // simply never reaches them, so this is wiring.
  searchDeckToHand: 'reusable',
  // `applySwitchInPlace` plus the `switchActive` choice exist (04.9 CP7), but that
  // choice is built from the ATTACKER's/DEFENDER's in-play list. A Trainer switching its
  // own Active needs a `self` side, so it is close but not a call site.
  switchOwnActiveWithBenched: 'reusable',
  // The discard is a PLAY COST, not a clause: it must be paid before the card resolves,
  // and the card must not leave the hand until it is. Nothing in `playTrainer` gates on
  // a cost, and there is no pending-choice kind for "choose cards to discard as a price".
  discardToPlay: 'needs-mechanism',
  // 163 needs a Supporter-played-this-turn flag AND a name fragment on the battle state,
  // and the bonus must land AFTER the Weakness multiplier. Every existing `bonusDamage`
  // adds to `baseDamage` BEFORE it, so no existing clause can express it — folding it
  // into one would apply 20 damage pre-Weakness, i.e. 40 against a weak defender.
  bonusDamageIfAttackerNameContains: 'needs-mechanism',
  // 179 reaches into the OPPONENT's hand and deck. That is a privacy-shaped change: the
  // snapshot fills the other seat's hand with `HIDDEN_CARD` placeholders, so this can
  // only be resolved host-side and must never be echoed back into that seat's own view.
  bothPlayersShuffleHandIntoDeckThenDrawPerRemainingPrize: 'needs-mechanism',
}

/**
 * Engine support for one clause. `unsupported` and an unaudited kind are answered
 * explicitly rather than falling through a default, so a new clause kind added without
 * a support entry reports `unstated` and raises a diagnostic instead of quietly moving
 * a number.
 */
export function trainerClauseSupport(effect: ParsedTrainerEffect): TrainerClauseSupport | 'unstated' {
  if (effect.kind === 'unsupported') return 'unstated'
  return CLAUSE_SUPPORT[effect.kind] ?? 'unstated'
}

export type TrainerCoverageEntry = {
  number: string
  name: string
  trainerType: string
  text: string
  /** Every clause the parser produced, in printed order. */
  clauses: ParsedTrainerEffect[]
  /** True when the parser matched EVERY sentence (no `unsupported` clause). */
  recognised: boolean
  /** True only when every clause is `supported` by the engine today. */
  implemented: boolean
  /** The worst state across the card's clauses — the card's own headline number. */
  support: TrainerClauseSupport | 'unstated'
  /** Named reasons, one per clause that is not `supported`. Never empty when unsupported. */
  blockers: string[]
}

export type TrainerCoverage = {
  total: number
  /** Cards whose every sentence parsed. Measures the REGEX, not the game. */
  recognised: number
  /** Cards the engine executes end to end. Measures the GAME. */
  implemented: number
  entries: TrainerCoverageEntry[]
  /** Named reasons these numbers may be wrong. */
  diagnostics: string[]
}

/** Worst-state reduction. `unstated` is worst: it means the audit itself is incomplete. */
const SUPPORT_ORDER: Record<TrainerClauseSupport | 'unstated', number> = {
  supported: 0,
  reusable: 1,
  'needs-mechanism': 2,
  unstated: 3,
}

/**
 * Measure the whole trainer category.
 *
 * **Distinct by PRINTED TEXT, not by name** — the same rule `coverageReport` already
 * applies to abilities. Two cards sharing a wording are one thing to implement, and a
 * name is a weaker identity than the rule it prints.
 *
 * Never throws: a record with a missing or non-string `effect` is counted and reported
 * rather than crashing the scan, and an empty `effect` is called out as a DATA gap so it
 * can never be mistaken for a card the engine declined to implement. That distinction is
 * the whole of what CP8 originally found, and it is preserved here as a live guard rather
 * than as a paragraph in a plan file.
 */
export function trainerCoverageReport(trainers: readonly unknown[]): TrainerCoverage {
  const entries: TrainerCoverageEntry[] = []
  const diagnostics: string[] = []
  const seen = new Set<string>()
  let emptyEffect = 0

  for (const raw of trainers) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const number = typeof record.number === 'string' ? record.number : '?'
    const name = typeof record.name === 'string' ? record.name : '(unnamed)'
    const trainerType = typeof record.trainerType === 'string' ? record.trainerType : '(none)'
    const text = typeof record.effect === 'string' ? record.effect.trim() : ''

    // The data-gap guard. An empty `effect` is exactly how all five trainers shipped,
    // and a report that counted that as "unsupported by the engine" would blame the code
    // for missing data — the inversion CP8 caught.
    if (!text) {
      emptyEffect += 1
      entries.push({
        number,
        name,
        trainerType,
        text: '',
        clauses: [],
        recognised: false,
        implemented: false,
        support: 'unstated',
        blockers: ['DATA GAP: `effect` is empty, so there is no rule text to parse or implement.'],
      })
      continue
    }
    if (seen.has(text)) continue
    seen.add(text)

    let clauses: ParsedTrainerEffect[]
    try {
      clauses = parseTrainerEffects(text)
    } catch {
      // A parser CRASH is a defect, not an unsupported card: counting it as one would
      // hide the crash behind a plausible-looking number — the rule `coverageReport`
      // already applies to `parseAttackEffects`.
      diagnostics.push(`parseTrainerEffects THREW on ${number} (${name}); NOT counted as unsupported.`)
      continue
    }

    const supports = clauses.map(trainerClauseSupport)
    const unstated = supports.filter((support) => support === 'unstated').length
    if (unstated > 0) {
      diagnostics.push(
        `${number} (${name}) produced ${unstated} clause(s) with no entry in CLAUSE_SUPPORT. `
          + 'A clause kind was added without an engine audit; it reports `unstated`, not a guess.',
      )
    }
    const blockers = clauses
      .map((clause, index) => ({ clause, support: supports[index] }))
      .filter((entry) => entry.support !== 'supported')
      .map(({ clause, support }) =>
        clause.kind === 'unsupported'
          ? `unrecognised sentence: ${clause.sentence}`
          : `${clause.kind} [${support}]`)

    const support = clauses.length === 0
      ? 'unstated'
      : supports.reduce(
        (worst, current) => (SUPPORT_ORDER[current] > SUPPORT_ORDER[worst] ? current : worst),
        supports[0],
      )

    entries.push({
      number,
      name,
      trainerType,
      text,
      clauses,
      recognised: !clauses.some((clause) => clause.kind === 'unsupported'),
      // 04.12 CP14: `reusable` now COUNTS as implemented. It did not before CP14 because
      // a reusable clause is one the engine can already execute -- and `playTrainer` never
      // called the effect pipeline, so "executable" was a property of the clause rather
      // than of the game. With the call site in `actions.ts` it is a property of the game,
      // which is exactly the distinction this module exists to draw. Leaving `reusable`
      // excluded here would report 0/5 for two cards that demonstrably work.
      implemented: clauses.length > 0 && (support === 'supported' || support === 'reusable'),
      support,
      blockers,
    })
  }

  if (emptyEffect > 0) {
    diagnostics.push(
      `${emptyEffect} Trainer card(s) ship an EMPTY "effect" string: a DATA gap, not an engine gap. `
        + 'They are counted separately and are never reported as unsupported-by-the-engine.',
    )
  }
  // 04.12 CP14: this diagnostic used to say the call site did not exist. It now names only
  // what is STILL missing, so it stays useful rather than becoming a stale lie.
  if (entries.some((entry) => !entry.implemented && entry.recognised)) {
    diagnostics.push(
      `${entries.filter((e) => !e.implemented && e.recognised).length} trainer(s) parse fully but hold at least one `
        + '`needs-mechanism` clause the engine cannot execute yet. `playTrainer` DOES call the effect pipeline as of '
        + '04.12 CP14, and `reusable` clauses count as implemented -- so a remaining gap is a real missing mechanism, '
        + 'never a missing call site.',
    )
  }

  return {
    total: entries.length,
    recognised: entries.filter((entry) => entry.recognised).length,
    implemented: entries.filter((entry) => entry.implemented).length,
    entries,
    diagnostics,
  }
}

