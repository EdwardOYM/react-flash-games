// The HP + damage-counter readout for one in-play Pokemon: the rulebook
// measures damage in counters, and one counter is 10 damage, so this is where
// the raw damage the engine tracks becomes the counter unit a player reads.
//
// Health is printed in the card's own points (the number on the card) and
// damage in counters, because that is what a real board looks like: "HP 150,
// 9 counters, 6 HP left". The maths is NOT re-derived here — `hpCounters`,
// `damageCounters` and `remainingCounters` (game-core/helpers, CP1) own it, and
// the engine still decides knock-outs from raw damage, so this readout can never
// disagree with the result of a match.
//
// Rendered beside the card (not on it) on purpose: the card face is the hosted
// artwork, and the board already places status pips and attachments around it.
// `hpCounters` is deliberately not imported here: health is printed in the
// card's own points, and `remainingCounters` already folds it in.
import { damageCounters, remainingCounters, type InPlayPokemon } from './game-core'
import { countLabel, substituteParams } from './format'
import type { TranslationKey } from '../../assets/languages'
import './PokemonVitals.css'

export type PokemonVitalsProps = {
  /** The in-play Pokemon this readout describes. */
  pokemon: InPlayPokemon
  t: (key: TranslationKey) => string
}

export function PokemonVitals({ pokemon, t }: PokemonVitalsProps) {
  const hp = pokemon.card.hp
  const counters = damageCounters(pokemon.damage)
  // Kept as a data attribute so the readout is assertable in tests, and so CSS
  // can tint an unhurt Pokemon differently from a damaged one.
  const left = remainingCounters(pokemon)
  return (
    <p className="bnb-vitals" data-damage-counters={counters}>
      <span className="bnb-vitals-hp">{t('pokemonBnb.hpLabel')} {hp}</span>
      {/* An undamaged Pokemon shows health alone: "0 counters" is noise, and a
          "no damage" chip would compete with the status pips for the same
          corner of the board. */}
      {counters > 0 && (
        <>
          <span className="bnb-vitals-counters" data-counters={counters}>
            {countLabel(counters, t('pokemonBnb.damageCounter'), t('pokemonBnb.damageCounters'))}
          </span>
          <span className="bnb-vitals-left" data-remaining={left}>
            {substituteParams(t('pokemonBnb.remainingHp'), { count: String(left) })}
          </span>
        </>
      )}
    </p>
  )
}
