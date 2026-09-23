// Reusable Pokemon TCG card face for B&B mini. The hosted TCGdex artwork
// (cardImage.ts) IS the face (CP11-E): card-level engine data (HP, attacks,
// rules) is never rendered — the face reads as the real card image, at one
// uniform 8/11 size in every view. Battle overlays (damage, status pips) and
// the pre-translated rarity chip stay on top.
//
// Text fallback (player-reported): when no artwork paints the face — a card
// with no hosted art (synthetic basic energies, `cardImageUrl` -> undefined) or
// an <img> that failed to load (offline, blocked or missing asset) — the face
// states in text what the artwork would have shown: the card's own name plus the
// caller's translated rarity, over the type tint. So a missing image can never
// leave a blank, unlabelled tile. Card names are dataset values (proper nouns),
// the rarity is the caller's translated copy, and the box never changes size
// either way: only ever a name + rarity line, never rules. The decision rule
// itself is cardImage.ts `cardFaceShowsText` (pure, no React).
//
// Flip transition (face-down -> revealed): both sides render at once inside a
// shared 3D flipper — the back stays mounted under the face, so when `faceDown`
// clears the card rotates edge-on and lands face-up (`.pkm-card-flipped`), like
// a physical card turned over. The parent keys one <PokemonCard> per slot, so
// the same flipper element persists across the reveal; a boolean swaps which
// side reads legible, never which element exists. Rank/energy overlays ride the
// face side. The back paints the one bundled raster asset (`cardBackUrl`, CP10)
// over its gradient, and the gradient + mark stay mounted underneath as both the
// loading and the failure face: a back whose image has not loaded yet, or whose
// image failed, reads as the same gradient it did before, so nothing can blank
// mid-flip and nothing extra has to load for the flip to be correct.
import { useState } from 'react'
import { cardIsEnergy, type CardDef } from './cards'
import { cardBackShowsArt, cardBackUrl, cardFaceShowsText, cardImageUrl } from './cardImage'
import './PokemonCard.css'

type PokemonCardProps = {
  card: CardDef
  /** Face-down back instead of the face (unrevealed ceremony cards). Clearing
   *  it on a mounted card plays the flip transition to the face. */
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

/** Data-free colour identity: the colour of the text face's backing. */
function tintClass(card: CardDef): string {
  if (cardIsEnergy(card)) return `pkm-card-tint-${card.provides ?? 'normal'}`
  if (card.supertype === 'pokemon' && card.types.length > 0) return `pkm-card-tint-${card.types[0]}`
  return `pkm-card-tint-${card.supertype}`
}

export function PokemonCard({ card, faceDown, rarityLabel, faceDownLabel, damage, statuses }: PokemonCardProps) {
  /** Artwork URL that failed to load; a different URL never inherits it. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  /** CP10: same rule for the bundled card back, keyed by URL for the same reason. */
  const [failedBackUrl, setFailedBackUrl] = useState<string | null>(null)

  const statusList = statuses ?? []
  const artUrl = cardImageUrl(card)
  /** Text face whenever the artwork is absent or failed (see the header note). */
  const showTextFace = cardFaceShowsText(artUrl, failedUrl)

  return (
    <article
      className={`pkm-card ${faceDown ? 'pkm-card-face-down' : 'pkm-card-flipped'} pkm-card-${card.supertype} pkm-card-rarity-${card.rarity} ${tintClass(card)}`}
      role="img"
      aria-label={faceDown ? (faceDownLabel ?? 'Face-down card') : (showTextFace && rarityLabel ? `${card.name} — ${rarityLabel}` : card.name)}
    >
      <div className="pkm-card-flipper" aria-hidden="true">
        <span className="pkm-card-side pkm-card-back">
          {/* The gradient + mark below always render, so they are the loading
              state and the failure state of this image (CP10). */}
          {cardBackShowsArt(cardBackUrl, failedBackUrl) && (
            <img
              className="pkm-card-back-art"
              src={cardBackUrl}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setFailedBackUrl(cardBackUrl)}
            />
          )}
          <span className="pkm-card-back-mark">⬢</span>
        </span>
        <span className="pkm-card-side pkm-card-frontface">
          {/* `artUrl !== undefined && !showTextFace` is exhaustive: the text-face rule
              only holds when there is no URL or that exact URL already failed. The
              explicit check keeps `src` narrowed for TypeScript. */}
          {artUrl !== undefined && !showTextFace && (
            <span className="pkm-card-artwrap">
              <img
                className="pkm-card-art"
                src={artUrl}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => setFailedUrl(artUrl)}
              />
            </span>
          )}
          {/* The text face already prints the rarity, so no duplicate chip. */}
          {showTextFace ? (
            <span className="pkm-card-textface">
              <span className="pkm-card-name">{card.name}</span>
              {rarityLabel && <span className="pkm-card-textface-rarity">{rarityLabel}</span>}
            </span>
          ) : rarityLabel && <span className="pkm-card-rarity">{rarityLabel}</span>}
          {typeof damage === 'number' && damage > 0 && <span className="pkm-card-damage">{damage}</span>}
          {statusList.length > 0 && (
            <span className="pkm-card-statuses">{statusList.map((status) => <i key={status} className={`pkm-card-status pkm-card-status-${status}`} />)}</span>
          )}
        </span>
      </div>
    </article>
  )
}
