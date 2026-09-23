// Card-artwork resolution for Pokemon TCG B&B mini. Hotlinks the images TCGdex
// (tcgdex.net) hosts for each set — nothing is downloaded or stored in the repo
// (user decision). This module owns both halves of "what paints this face?":
// the URL builder, and the pure rule saying a face must print text when no
// reachable artwork exists (no URL at all, or that URL already failed — the
// <img> onError in PokemonCard.tsx). Pure: no state, no fetching.
//
// The *other* face of a card is the face-down back (CP10). No card-back artwork
// is hosted anywhere, so the back is the one raster asset bundled into the repo
// (`src/assets/pokemon-bnb/card-back.jpg` - see that folder's README) and its
// rule is the exact inverse of the face rule: the back paints unless there is no
// URL at all or that URL already failed. The CSS gradient back stays the
// fallback, so a missing back can never blank a card.
import type { CardDef } from './cards'
import cardBackImage from '../../assets/pokemon-bnb/card-back.jpg'

/** Game set id -> TCGdex asset path (series folder + set id, e.g. en/me/30th). */
const TCGDEX_SET_PATHS: Record<string, string> = {
  '30c': 'en/me/30th',
}

export type CardImageQuality = 'low' | 'high'

/**
 * Hosted card-artwork URL for a set card, or undefined when the card has no
 * hosted artwork (synthetic basic energies) or a non-numeric number.
 * `card.number` is already the zero-padded TCGdex localId ("001".."158").
 */
export function cardImageUrl(card: CardDef, quality: CardImageQuality = 'low'): string | undefined {
  const path = TCGDEX_SET_PATHS[card.set]
  if (!path || card.supertype === 'energy') return undefined
  const number = card.number.trim()
  if (!/^\d{1,4}$/.test(number)) return undefined
  return `https://assets.tcgdex.net/${path}/${number}/${quality}.png`
}

/**
 * Whether a face must print text instead of artwork: no resolvable art URL at
 * all (the synthetic basic energies, which have none) or the art URL that
 * already failed to load. Pure, and a *different* URL never inherits a failure —
 * so a re-used card slot can never show a stale fallback. Lives here rather than
 * in the component so the rule stays directly verifiable without a DOM.
 */
export function cardFaceShowsText(artUrl: string | undefined, failedUrl: string | null): boolean {
  return !artUrl || failedUrl === artUrl
}

/**
 * Bundled face-down card-back URL. The only raster asset the games ship, because
 * there is no hosted card back to hotlink (see the folder README). Imported
 * rather than fetched, and Vite resolves the import to a relative URL, so the
 * itch.io zip stays self-contained and the back paints offline.
 */
export const cardBackUrl = cardBackImage

/**
 * Whether the face-down side paints the bundled artwork - the exact inverse of
 * `cardFaceShowsText`, for the back: no URL at all (a build without the asset),
 * or *that exact* URL already failed, leaves the CSS gradient back as the face.
 * Pure and remembered per URL, so a different failed URL is never inherited and
 * a re-used card slot can never show a stale fallback.
 */
export function cardBackShowsArt(backUrl: string | undefined, failedUrl: string | null): boolean {
  return Boolean(backUrl) && failedUrl !== backUrl
}
