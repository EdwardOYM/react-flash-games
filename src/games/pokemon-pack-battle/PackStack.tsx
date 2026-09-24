import type { ReactNode } from 'react'
import { PokemonCard } from '../pokemon-bnb/PokemonCard'
import type { BattleOpenedCard } from './battlePack'
import './PackStack.css'

export type PackStackProps = {
  cards: BattleOpenedCard[]
  revealed: boolean[]
  expanded: boolean
  stackLabel: string
  faceDownLabel: string
  actionLabel: string
  rarityLabel: (rarity: string) => string
  onReveal?: () => void
  className?: string
  cardClassName?: (card: BattleOpenedCard, index: number, revealed: boolean) => string
  renderCardOverlay?: (card: BattleOpenedCard, index: number, revealed: boolean) => ReactNode
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
  const rootClassName = ['ppb-pack-stack', expanded ? 'ppb-pack-stack-expanded' : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClassName} role="group" aria-label={stackLabel}>
      {cards.map((opened, index) => {
        const isRevealed = revealed[index] === true
        const isLatestRevealed = isRevealed && index === latestRevealed
        const hiddenDepth = revealed.slice(0, index).filter((isCardRevealed) => !isCardRevealed).length
        const visibleToAssistiveTech = expanded || isLatestRevealed
        return (
          <div
            key={`${opened.card.id}-${index}`}
            className={[
              'ppb-pack-stack-card',
              isRevealed ? 'ppb-pack-stack-card-revealed' : `ppb-pack-stack-card-hidden ppb-pack-stack-hidden-depth-${hiddenDepth}`,
              isLatestRevealed ? 'ppb-pack-stack-card-latest' : '',
              cardClassName?.(opened, index, isRevealed) ?? '',
            ].filter(Boolean).join(' ')}
            aria-hidden={visibleToAssistiveTech ? undefined : 'true'}
          >
            <PokemonCard
              card={opened.card}
              faceDown={!isRevealed}
              rarityLabel={rarityLabel(opened.card.rarity)}
              faceDownLabel={faceDownLabel}
            />
            {isRevealed ? renderCardOverlay?.(opened, index, isRevealed) : null}
          </div>
        )
      })}
      {!expanded && hasHidden && onReveal && (
        <button className="ppb-pack-stack-action" type="button" aria-label={actionLabel} onClick={onReveal} />
      )}
    </div>
  )
}
