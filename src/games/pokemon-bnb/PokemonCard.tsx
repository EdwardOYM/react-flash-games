// Reusable Pokemon TCG card face for B&B mini. The hosted TCGdex artwork
// (cardImage.ts) IS the face (CP11-E): cards.json content (names, HP, attacks)
// is engine data and is deliberately never rendered — the face reads as the real
// card image, at one uniform 8/11 size in every view. Battle overlays (damage,
// status pips) and the pre-translated rarity chip stay on top; cards with no
// hosted art (synthetic basic energies) or a failed load fall back to a
// data-free type tint, so the face never exposes engine text or changes size.
import { useState } from 'react'
import { cardIsEnergy, type CardDef } from './cards'
import { cardImageUrl } from './cardImage'
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

/** Hosted artwork face; unmounts itself on load failure (tint shows through). */
function CardArt({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <span className="pkm-card-artwrap" aria-hidden="true">
      <img
        className="pkm-card-art"
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </span>
  )
}

/** Data-free colour identity, used when no hosted art paints the face. */
function tintClass(card: CardDef): string {
  if (cardIsEnergy(card)) return `pkm-card-tint-${card.provides ?? 'normal'}`
  if (card.supertype === 'pokemon' && card.types.length > 0) return `pkm-card-tint-${card.types[0]}`
  return `pkm-card-tint-${card.supertype}`
}

export function PokemonCard({ card, faceDown, rarityLabel, faceDownLabel, damage, statuses }: PokemonCardProps) {
  if (faceDown) {
    return (
      <div className="pkm-card pkm-card-back" role="img" aria-label={faceDownLabel ?? 'Face-down card'}>
        <span className="pkm-card-back-mark" aria-hidden="true">⬢</span>
      </div>
    )
  }

  const statusList = statuses ?? []
  const artUrl = cardImageUrl(card)

  return (
    <article
      className={`pkm-card pkm-card-${card.supertype} pkm-card-rarity-${card.rarity} ${tintClass(card)}`}
      role="img"
      aria-label={card.name}
    >
      {artUrl && <CardArt key={artUrl} url={artUrl} />}
      {rarityLabel && <span className="pkm-card-rarity">{rarityLabel}</span>}
      {typeof damage === 'number' && damage > 0 && <span className="pkm-card-damage" aria-hidden="true">{damage}</span>}
      {statusList.length > 0 && (
        <span className="pkm-card-statuses" aria-hidden="true">{statusList.map((status) => <i key={status} className={`pkm-card-status pkm-card-status-${status}`} />)}</span>
      )}
    </article>
  )
}
