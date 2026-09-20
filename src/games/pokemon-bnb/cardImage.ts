// Card-artwork URL resolver for Pokemon TCG B&B mini. Hotlinks the images
// TCGdex (tcgdex.net) hosts for each set — nothing is downloaded or stored in
// the repo (user decision). Offline / missing-image handling is the <img>'s
// onError fallback in PokemonCard.tsx: the typographic facsimile beneath
// always remains the semantic layer. Pure builder: no state, no fetching.
import type { CardDef } from './cards'

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
