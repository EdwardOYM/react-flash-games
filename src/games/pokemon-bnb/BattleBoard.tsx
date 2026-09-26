// CP6: the shared battle board. ONE side component renders BOTH seats — the
// opponent's lane is only mirrored, never a second implementation, so the two
// sides cannot drift apart. Mirroring uses `column-reverse` (CSS flex order),
// never a transform: rotating the lane would turn every translated zone label
// and card name upside down and reverse screen-reader reading order, while
// reversing flex order reads as "facing you" and keeps all glyphs upright.
//
// Zone privacy is honoured, not re-derived: this component renders only what the
// engine handed it. A hidden zone arrives as `HIDDEN_CARD` placeholders (see
// game-core/snapshots.ts) and `isHiddenCard` is what turns those into a count
// instead of a face, so the board can never leak a card the snapshot hid.

import type { CardDef, CardRarity } from './cards'
import { HIDDEN_CARD, STATUS_CONDITIONS, type InPlayPokemon, type SideState } from './game-core'
import { PokemonCard } from './PokemonCard'
import type { TranslationKey } from '../../assets/languages'
import './BattleBoard.css'

/** True for a snapshot placeholder, which must never render as a real face. */
function isHiddenCard(card: CardDef): boolean {
  return card.id === HIDDEN_CARD.id
}

export type BattleSideProps = {
  heading: string
  side: SideState
  prizeTotal: number
  /** True for the opponent: the lane renders mirrored. */
  isFoe: boolean
  t: (key: TranslationKey) => string
  conditionLabel: (status: string) => string
  rarityLabelFor: (rarity: CardRarity) => string
  faceDownLabel: string
  /** Only the viewer's own Bench is a target, so only it is selectable. */
  isSelectableBench: boolean
  selectedBench: number | null
  onSelectBench?: (index: number | null) => void
  selectedHand: number | null
  onSelectHand?: (index: number | null) => void
}

/** Status pips for one in-play Pokemon, in the engine's canonical order. */
function statusListFor(pokemon: InPlayPokemon): string[] {
  const statuses: string[] = []
  for (const status of STATUS_CONDITIONS) {
    if (pokemon.conditions[status]) statuses.push(status)
  }
  return statuses
}

/**
 * Energy + Tool attached to one Pokemon, as chips rather than full faces: a
 * Pokemon can hold a dozen Energy and full faces would blow the 16:9 stage.
 * The count and the Tool's name are all the rules need.
 */
function Attachments({ pokemon, t }: { pokemon: InPlayPokemon; t: (key: TranslationKey) => string }) {
  if (pokemon.attachedEnergy.length === 0 && !pokemon.attachedTool) return null
  return (
    <ul className="bnb-attachments" aria-label={t('pokemonBnb.zoneAttachments')}>
      {pokemon.attachedEnergy.length > 0 && (
        <li className="bnb-attachment bnb-attachment-energy">
          <span aria-hidden="true">⚡</span>
          <span>{pokemon.attachedEnergy.length}</span>
        </li>
      )}
      {pokemon.attachedTool && <li className="bnb-attachment bnb-attachment-tool">{pokemon.attachedTool.name}</li>}
    </ul>
  )
}

/** One seat's half of the board. Used for BOTH players (see the header note). */
export function BattleSide({
  heading, side, prizeTotal, isFoe, t, conditionLabel, rarityLabelFor, faceDownLabel,
  isSelectableBench, selectedBench, onSelectBench, selectedHand, onSelectHand,
}: BattleSideProps) {
  const active = side.active
  const activeStatuses = active ? statusListFor(active) : []
  const activeConditionLabels = activeStatuses.map(conditionLabel)
  const prizesTaken = prizeTotal - side.prizeCount
  return (
    <section
      className={`bnb-side${isFoe ? ' bnb-side-foe' : ' bnb-side-self'}`}
      aria-label={heading}
      data-seat={isFoe ? 'foe' : 'self'}
    >
      <header className="bnb-side-head">
        <span className="bnb-side-name">{heading}</span>
        <span className="bnb-side-zones">
          {t('pokemonBnb.zoneHand')} {side.hand.length}
          <span className="bnb-status-sep" aria-hidden="true">·</span>
          {t('pokemonBnb.zoneDeck')} {side.deck.length}
          <span className="bnb-status-sep" aria-hidden="true">·</span>
          {t('pokemonBnb.zonePrizes')} {side.prizeCount}/{prizeTotal}
          <span className="bnb-status-sep" aria-hidden="true">·</span>
          {t('pokemonBnb.zoneDiscard')} {side.discard.length}
        </span>
      </header>

      <div className="bnb-side-active">
        <span className="bnb-zone-label">{t('pokemonBnb.zoneActive')}</span>
        {active ? (
          <div className="bnb-active-face">
            <PokemonCard
              card={active.card}
              rarityLabel={rarityLabelFor(active.card.rarity)}
              faceDownLabel={faceDownLabel}
              damage={active.damage}
              statuses={activeStatuses}
            />
            <Attachments pokemon={active} t={t} />
            {activeConditionLabels.length > 0 && (
              <span className="bnb-side-conditions">{activeConditionLabels.join(' / ')}</span>
            )}
          </div>
        ) : (
          <span className="bnb-side-card">{t('pokemonBnb.zoneActive')}: —</span>
        )}
      </div>


      <div className="bnb-side-bench">
        <span className="bnb-zone-label">{t('pokemonBnb.zoneBench')}</span>
        {side.bench.length > 0 ? (
          <ol className="bnb-bench-list">
            {side.bench.map((pokemon, index) => {
              const selected = isSelectableBench && selectedBench === index
              const targetHint = t('pokemonBnb.selectTarget').replace('{index}', String(index + 1))
              const face = (
                <span className="bnb-bench-face">
                  <PokemonCard
                    card={pokemon.card}
                    rarityLabel={rarityLabelFor(pokemon.card.rarity)}
                    faceDownLabel={faceDownLabel}
                    damage={pokemon.damage}
                    statuses={statusListFor(pokemon)}
                  />
                  <Attachments pokemon={pokemon} t={t} />
                </span>
              )
              return (
                <li key={pokemon.uid}>
                  {isSelectableBench ? (
                    <button
                      type="button"
                      className="bnb-bench-pick"
                      aria-pressed={selected}
                      aria-label={`${pokemon.card.name} — ${targetHint}`}
                      onClick={() => onSelectBench?.(selected ? null : index)}
                    >
                      {face}
                    </button>
                  ) : face}
                </li>
              )
            })}
          </ol>
        ) : (
          <span className="bnb-side-card">—</span>
        )}
      </div>


      {/* Prize / Deck / Discard. Deck and Prize are always face-down, so only a
          count and the card back are ever drawn. */}
      <div className="bnb-side-zones-row">
        <div className="bnb-side-zone">
          <span className="bnb-zone-label">{t('pokemonBnb.zonePrizes')}</span>
          <span className="bnb-side-card">{side.prizeCount} ({prizesTaken})</span>
        </div>
        <div className="bnb-side-zone">
          <span className="bnb-zone-label">{t('pokemonBnb.zoneDeck')}</span>
          <PokemonCard
            card={side.deck[0] ?? HIDDEN_CARD}
            faceDown
            rarityLabel={rarityLabelFor('common')}
            faceDownLabel={faceDownLabel}
          />
        </div>
        <div className="bnb-side-zone">
          <span className="bnb-zone-label">{t('pokemonBnb.zoneDiscard')}</span>
          {side.discard.length > 0 ? (
            <PokemonCard
              card={side.discard[side.discard.length - 1]}
              rarityLabel={rarityLabelFor(side.discard[side.discard.length - 1].rarity)}
              faceDownLabel={faceDownLabel}
            />
          ) : (
            <span className="bnb-side-card">—</span>
          )}
        </div>
      </div>

      {/* Hand: the viewer's own cards are named and selectable; the opponent's is
          a count only. `onSelectHand` is absent on the foe lane, so that gate —
          not a hidden-card check — is what keeps the opponent read-only. */}
      <div className="bnb-side-hand">
        <span className="bnb-zone-label">{t('pokemonBnb.zoneHand')}</span>
        {onSelectHand && !side.hand.every(isHiddenCard) ? (
          <ol className="bnb-hand-list">
            {side.hand.map((card, index) => {
              if (isHiddenCard(card)) return null
              const selected = selectedHand === index
              return (
                <li key={`${card.id}-${index}`}>
                  <button
                    type="button"
                    className="bnb-hand-pick"
                    aria-pressed={selected}
                    aria-label={`${t('pokemonBnb.selectHandCard')} — ${card.name}`}
                    onClick={() => onSelectHand?.(selected ? null : index)}
                  >
                    <span className="bnb-hand-chip">{card.name}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        ) : (
          <span className="bnb-side-card">{side.hand.length}</span>
        )}
      </div>
    </section>
  )
}


export type BattleBoardProps = Omit<BattleSideProps, 'side' | 'isFoe' | 'heading'> & {
  self: { heading: string; side: SideState }
  foe: { heading: string; side: SideState }
  /** The shared Stadium in play, or null. One zone, visible to both players. */
  stadium: CardDef | null
}

/**
 * The whole tabletop: the shared Stadium lane, then the opponent's mirrored
 * lane, then the viewer's own lane. Nothing scrolls horizontally.
 */
export function BattleBoard({
  self, foe, stadium, prizeTotal, t, conditionLabel, rarityLabelFor, faceDownLabel,
  isSelectableBench, selectedBench, onSelectBench, selectedHand, onSelectHand,
}: BattleBoardProps) {
  return (
    <div className="bnb-board">
      <div className="bnb-board-stadium">
        <span className="bnb-zone-label">{t('pokemonBnb.zoneStadium')}</span>
        {stadium ? (
          <PokemonCard
            card={stadium}
            rarityLabel={rarityLabelFor(stadium.rarity)}
            faceDownLabel={faceDownLabel}
          />
        ) : (
          <span className="bnb-side-card">—</span>
        )}
      </div>
      <div className="bnb-board-lanes">
        <BattleSide
          heading={foe.heading}
          side={foe.side}
          prizeTotal={prizeTotal}
          isFoe
          t={t}
          conditionLabel={conditionLabel}
          rarityLabelFor={rarityLabelFor}
          faceDownLabel={faceDownLabel}
          isSelectableBench={false}
          selectedBench={null}
          selectedHand={null}
        />
        <BattleSide
          heading={self.heading}
          side={self.side}
          prizeTotal={prizeTotal}
          isFoe={false}
          t={t}
          conditionLabel={conditionLabel}
          rarityLabelFor={rarityLabelFor}
          faceDownLabel={faceDownLabel}
          isSelectableBench={isSelectableBench}
          selectedBench={selectedBench}
          onSelectBench={onSelectBench}
          selectedHand={selectedHand}
          onSelectHand={onSelectHand}
        />
      </div>
    </div>
  )
}

