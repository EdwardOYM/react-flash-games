// CP8: the shared card-stack presentation primitive, extracted from the shipped
// Pack Battle `PackStack` so B&B and Pack Battle reveal cards with the same
// interaction instead of two implementations that drift.
//
// Generalized in two ways:
//   1. It takes plain `CardDef[]`, not Pack Battle's `BattleOpenedCard[]`, so it
//      carries no knowledge of packs, seats, tiers, points, or ceremony state.
//      The owning game keeps all of that and passes only presentation data.
//   2. Overlay/class hooks receive the plain card, so a consumer can decorate a
//      card without the stack knowing anything about the game.
//
// The reveal contract is deliberately unchanged from the shipped Pack Battle
// behavior, and is asserted in both games' checkpoints:
//   - one overlapping stack, cards absolutely positioned and fanned by depth;
//   - fixed-order reveal driven by the `revealed` flags the caller owns;
//   - exactly ONE transparent action target over the stack, so a single click
//     reveals the next card (never a pile of stacked click targets);
//   - the latest revealed card sits on top and is the only unrevealed-era card
//     exposed to assistive tech — earlier revealed cards stay mounted (so the
//     flip animation persists) but are `aria-hidden`;
//   - `expanded` immediately lays every card out for review;
//   - there is NO auto-advance: a completed stack just stays where it is, and
//     the owning game decides what happens next (focus retention).

import type { ReactNode } from 'react'
import type { CardDef, CardRarity } from '../pokemon-bnb/cards'
import { PokemonCard } from '../pokemon-bnb/PokemonCard'
import './PackStack.css'

export type PackStackProps = {
  /** The pack contents in fixed reveal order. */
  cards: CardDef[]
  /** Parallel reveal flags; `false` keeps that slot face-down. */
  revealed: boolean[]
  expanded: boolean
  /** Accessible name for the stack as a group. */
  stackLabel: string
  /** Accessible name for a face-down card. */
  faceDownLabel: string
  /** Accessible name for the single reveal action. */
  actionLabel: string
  rarityLabel: (rarity: CardRarity) => string
  /** Omitted (or undefined) when the next reveal is not this seat's to make. */
  onReveal?: () => void
  className?: string
  cardClassName?: (card: CardDef, index: number, revealed: boolean) => string
  renderCardOverlay?: (card: CardDef, index: number, revealed: boolean) => ReactNode
}

export function PackStack({
  cards,
  revealed,
  expanded,
  stackLabel,
  faceDownLabel,
  actionLabel,
  rarityLabel,
  onReveal,
  className,
  cardClassName,
  renderCardOverlay,
}: PackStackProps) {
  const latestRevealed = revealed.reduce(
    (latest, isRevealed, index) => isRevealed ? index : latest,
    -1,
  )
  const nextHidden = revealed.findIndex((isRevealed) => !isRevealed)
  const hasHidden = nextHidden >= 0
  const rootClassName = ['pkcs-stack', expanded ? 'pkcs-stack-expanded' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClassName} role="group" aria-label={stackLabel}>
      {cards.map((card, index) => {
        const isRevealed = revealed[index] === true
        const isLatestRevealed = isRevealed && index === latestRevealed
        const hiddenDepth = revealed.slice(0, index).filter((isCardRevealed) => !isCardRevealed).length
        const visibleToAssistiveTech = expanded || isLatestRevealed
        return (
          <div
            key={`${card.id}-${index}`}
            className={[
              'pkcs-stack-card',
              isRevealed ? 'pkcs-stack-card-revealed' : `pkcs-stack-card-hidden pkcs-stack-hidden-depth-${hiddenDepth}`,
              isLatestRevealed ? 'pkcs-stack-card-latest' : '',
              cardClassName?.(card, index, isRevealed) ?? '',
            ].filter(Boolean).join(' ')}
            aria-hidden={visibleToAssistiveTech ? undefined : 'true'}
          >
            <PokemonCard
              card={card}
              faceDown={!isRevealed}
              rarityLabel={rarityLabel(card.rarity)}
              faceDownLabel={faceDownLabel}
            />
            {isRevealed ? renderCardOverlay?.(card, index, isRevealed) : null}
          </div>
        )
      })}
      {!expanded && hasHidden && onReveal && (
        <button className="pkcs-stack-action" type="button" aria-label={actionLabel} onClick={onReveal} />
      )}
    </div>
  )
}
