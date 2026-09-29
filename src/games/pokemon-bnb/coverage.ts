// 04.12 CP1 — a real coverage report for pokemon-bnb.
//
// **Why this exists.** Attack coverage was measured by a throwaway harness in 04.11 and
// ability coverage by another in 04.12. Both were hand-rolled, and both had to be REDONE
// before they were right: the first two ability scans reported **0 abilities** because the
// field is `abilities` (a plural array), not `ability`. A number of zero turned out to be a
// measurement bug twice in a row. This module is the one place that produces those numbers.
//
// **Two design rules that come straight from that.**
// 1. **Never throw on a malformed record.** Cards come from an upstream API, so a missing
//    `attacks`, a non-array, a null entry or a non-string `text` must degrade to a counted
//    skip — not an exception. A report that dies on one bad card reports nothing at all.
// 2. **Surface the traps instead of absorbing them.** `diagnostics` is not decoration: if a
//    card carries an `ability` key (singular) the scan will read zero abilities, which is
//    exactly the silent-zero failure that happened twice. So the zero is reported AND the
//    reason is named.

import { abilityCoverageReport, classifyAbility, parseAttackEffects } from './game-core'
import type { CardDef } from './cards'

export type UnsupportedAttack = {
  /** Card number as printed in the set, e.g. "161". */
  number: string
  cardName: string
  /** Index into the card's `attacks` array, so a report line identifies one attack. */
  attackIndex: number
  attackName: string
  text: string
}

export type CoverageReport = {
  attacks: { total: number; supported: number; unsupported: UnsupportedAttack[] }
  abilities: {
    /** Ability entries across all cards, duplicates included. */
    instances: number
    /** Distinct printed texts — how many ABILITIES actually exist to implement. */
    distinct: number
    supported: number
    passive: number
    unsupported: { name: string; text: string }[]
  }
  /**
   * 04.12 CP8: trainers have no parser and no measurement at all. Reported as an explicit
   * `false` rather than omitted, so a coverage summary can never be read as covering the
   * whole set when a third of the card categories is unmeasured.
   */
  trainers: { total: number; measured: false }
  /** Named reasons the numbers above may be wrong. */
  diagnostics: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function coverageReport(input: readonly unknown[]): CoverageReport {
  const cards = Array.isArray(input) ? input : []
  const diagnostics: string[] = []

  // ---- attacks ----
  const unsupported: UnsupportedAttack[] = []
  let attackTotal = 0
  let attackSupported = 0

  for (const raw of cards) {
    if (!isRecord(raw)) continue
    const attacks = raw.attacks
    if (!Array.isArray(attacks)) continue
    const number = textOf(raw.number) || '?'
    const cardName = textOf(raw.name) || '(unnamed)'
    attacks.forEach((entry, attackIndex) => {
      if (!isRecord(entry)) return
      const text = textOf(entry.text).trim()
      if (!text) return
      attackTotal += 1
      let effects: { kind: string }[]
      try {
        effects = parseAttackEffects(text)
      } catch {
        // A parser crash is a DEFECT, not an unsupported card: counting it as
        // "unsupported" would hide a crash behind a plausible-looking number.
        diagnostics.push(`parser threw on attack ${number}#${attackIndex} (${cardName})`)
        return
      }
      if (effects.some((effect) => effect.kind === 'unsupported')) {
        unsupported.push({ number, cardName, attackIndex, attackName: textOf(entry.name), text })
      } else {
        attackSupported += 1
      }
    })
  }

  // ---- abilities ----
  const collected: { name: string; text: string }[] = []
  const byText = new Map<string, { name: string; text: string }>()
  let singularAbilityCards = 0

  for (const raw of cards) {
    if (!isRecord(raw)) continue
    // The plural/singular trap guard. A card carrying `ability` (singular) is invisible to
    // the scan below, which would then honestly report 0 abilities — the exact silent
    // failure this module exists to prevent. Name the cause rather than emit a bare 0.
    if ('ability' in raw && !('abilities' in raw)) singularAbilityCards += 1
    const abilities = raw.abilities
    if (!Array.isArray(abilities)) continue
    for (const entry of abilities) {
      if (!isRecord(entry)) continue
      const text = textOf(entry.text).trim()
      if (!text) continue
      const name = textOf(entry.name)
      collected.push({ name, text })
      // Distinct by PRINTED TEXT, not by name: two cards sharing a wording are one ability
      // to implement, and a name is a far weaker identity than the rule it prints.
      if (!byText.has(text)) byText.set(text, { name, text })
    }
  }

  const distinct = [...byText.values()]
  let supported = 0
  let passive = 0
  const unsupportedAbilities: { name: string; text: string }[] = []

  if (distinct.length === 0) {
    if (singularAbilityCards > 0) {
      diagnostics.push(
        `0 abilities found, but ${singularAbilityCards} card(s) carry a SINGULAR "ability" key. `
        + 'This scan reads the plural "abilities" array, so a renamed field reports 0 here.',
      )
    }
  } else {
    try {
      const coverage = abilityCoverageReport(distinct)
      supported = coverage.supported.length
      passive = coverage.passive.length
      const bad = new Set(coverage.unsupported)
      unsupportedAbilities.push(...distinct.filter((ability) => bad.has(ability.text)))
    } catch {
      // The arity trap: `abilityCoverageReport` throws unless handed `{ name, text }[]` —
      // a `string[]` or a `CardDef[]` both crash it deep inside `plainCardText`. Fall back
      // to classifying one text at a time rather than losing the whole category.
      diagnostics.push(
        'abilityCoverageReport threw on {name,text}[] — fell back to per-text classifyAbility. '
        + 'Check its parameter arity: it is loosely typed and fails at runtime, not compile time.',
      )
      for (const ability of distinct) {
        let id = 'unsupported'
        try { id = classifyAbility(ability.text).id } catch { id = 'unsupported' }
        if (id === 'unsupported') unsupportedAbilities.push(ability)
        else supported += 1
      }
    }
  }

  // ---- trainers ----
  const trainers = cards.filter((raw) => isRecord(raw) && raw.supertype === 'trainer').length
  if (trainers > 0) {
    diagnostics.push(
      `${trainers} Trainer card(s) exist and are NOT covered by this report: there is no `
      + 'parseTrainerEffects and no trainer coverage. 04.12 CP8 measures them.',
    )
  }

  return {
    attacks: { total: attackTotal, supported: attackSupported, unsupported },
    abilities: {
      instances: collected.length,
      distinct: distinct.length,
      supported,
      passive,
      unsupported: unsupportedAbilities,
    },
    trainers: { total: trainers, measured: false },
    diagnostics,
  }
}

/** Human-readable summary. Pure, so it can be asserted on without capturing stdout. */
export function formatCoverageReport(report: CoverageReport): string {
  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)
  const lines: string[] = [
    `ATTACKS   ${report.attacks.supported}/${report.attacks.total} modelled (${pct(report.attacks.supported, report.attacks.total)})`,
    `ABILITIES ${report.abilities.supported}/${report.abilities.distinct} distinct supported (${pct(report.abilities.supported, report.abilities.distinct)}), ${report.abilities.passive} passive, ${report.abilities.instances} instances`,
    `TRAINERS  ${report.trainers.total} in the set - NOT MEASURED`,
  ]
  for (const attack of report.attacks.unsupported) {
    lines.push(`  attack  ${attack.number}#${attack.attackIndex} ${attack.cardName} / ${attack.attackName}`)
  }
  for (const ability of report.abilities.unsupported) {
    lines.push(`  ability ${ability.name || '(unnamed)'}`)
  }
  for (const note of report.diagnostics) lines.push(`  DIAGNOSTIC ${note}`)
  return lines.join('\n')
}

/** Convenience for a set file shaped `{ cards: CardDef[] }`. */
export function coverageReportForCards(cards: readonly CardDef[]): CoverageReport {
  return coverageReport(cards)
}
