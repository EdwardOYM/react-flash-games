// Reusable Pokemon TCG card face for B&B mini. Typographic facsimile only
// (no scans/artwork): rarity chip, name, HP, type line, attacks, abilities,
// trainer/energy text, plus a face-down back for the opening ceremony.
// Card content (names, attack text) is data and renders verbatim — only the
// rarity chip and back label arrive pre-translated via props.
import { cardIsEnergy, cardIsPokemon, cardIsTrainer, type CardDef } from './cards'
import './PokemonCard.css'

type PokemonCardProps = {
  card: CardDef
  /** Face-down back instead of the face (unrevealed ceremony cards). */
  faceDown?: boolean
  /** Translated rarity chip, e.g. t('pokemonBnb.rarityRare'). */
  rarityLabel?: string
  /** Translated aria-label for the back, e.g. t('pokemonBnb.cardFaceDown'). */
  faceDownLabel?: string
  /** Battle overlay (CP8): damage counters banked on this Pokemon. */
  damage?: number
  /** Battle overlay (CP8): status pips, e.g. ['poison', 'burn']. */
  statuses?: string[]
}

export function PokemonCard({ card, faceDown, rarityLabel, faceDownLabel, damage, statuses }: PokemonCardProps) {
  if (faceDown) {
    return (
      <div className="pkm-card pkm-card-back" role="img" aria-label={faceDownLabel ?? 'Face-down card'}>
        <span className="pkm-card-back-mark" aria-hidden="true">⬢</span>
      </div>
    )
  }

  const typeLine = card.supertype === 'pokemon' ? card.types.join(' · ') : card.supertype
  const statusList = statuses ?? []

  return (
    <article className={`pkm-card pkm-card-${card.supertype} pkm-card-rarity-${card.rarity}`} aria-label={card.name}>
      <header className="pkm-card-head">
        <span className="pkm-card-name">{card.name}</span>
        {cardIsPokemon(card) && <span className="pkm-card-hp">{card.hp} HP</span>}
      </header>
      <p className="pkm-card-meta">
        <span className="pkm-card-number">{card.number}</span>
        {typeLine && <span className="pkm-card-types">{typeLine}</span>}
      </p>
      {rarityLabel && <span className="pkm-card-rarity">{rarityLabel}</span>}
      {cardIsPokemon(card) && (
        <div className="pkm-card-body">
          <p className="pkm-card-stage">{card.stage}{card.evolvesFrom ? ` · ← ${card.evolvesFrom}` : ''}</p>
          {card.abilities.length > 0 && (
            <ul className="pkm-card-abilities">
              {card.abilities.map((ability) => <li key={ability.name}><strong>{ability.name}</strong><span>{ability.text}</span></li>)}
            </ul>
          )}
          <ul className="pkm-card-attacks">
            {card.attacks.map((attack) => (
              <li key={attack.name}>
                <p className="pkm-card-attack-head"><strong>{attack.name}</strong><span>{attack.damage}</span></p>
                {attack.cost.length > 0 && <p className="pkm-card-cost">{attack.cost.join(' · ')}</p>}
                {attack.text && <p className="pkm-card-text">{attack.text}</p>}
              </li>
            ))}
          </ul>
          <p className="pkm-card-foot">retreat {card.retreat}</p>
        </div>
      )}
      {cardIsTrainer(card) && <p className="pkm-card-text pkm-card-effect">{card.effect}</p>}
      {cardIsEnergy(card) && card.provides && <p className="pkm-card-text pkm-card-effect">{card.provides}</p>}
      {typeof damage === 'number' && damage > 0 && <span className="pkm-card-damage" aria-hidden="true">{damage}</span>}
      {statusList.length > 0 && (
        <span className="pkm-card-statuses" aria-hidden="true">{statusList.map((status) => <i key={status} className={`pkm-card-status pkm-card-status-${status}`} />)}</span>
      )}
    </article>
  )
}
