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
import { HIDDEN_CARD, MAX_BENCH, STATUS_CONDITIONS, type InPlayPokemon, type SideState } from './game-core'
import { BASIC_ENERGY_TYPES, type BasicEnergyType } from './pack'
import type { PlayerSlot } from './net/protocol'
import { PokemonCard } from './PokemonCard'
import { PokemonVitals } from './PokemonVitals'
import { substituteParams } from './format'
import type { TranslationKey } from '../../assets/languages'
import './BattleBoard.css'

/** True for a snapshot placeholder, which must never render as a real face. */
function isHiddenCard(card: CardDef): boolean {
  return card.id === HIDDEN_CARD.id
}

export type BattleSideProps = {
  heading: string
  side: SideState
  /** Which seat this lane is, so an inspected card knows whose card it is. */
  seat: PlayerSlot
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
  /** Open a card in the focus overlay. `seat` is which lane it came from. */
  onInspect?: (seat: PlayerSlot, source: 'hand' | 'active' | 'bench' | 'discard', index: number) => void
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
 * Attached Energy, grouped by the TYPE it provides, each with its own count.
 *
 * The rulebook costs attacks in Energy TYPES, so a single `⚡3` cannot answer
 * "can I pay for this attack" — the player has to know they hold 2 Fire and 1
 * Lightning. The per-type chips carry that; the total chip stays too, so nothing
 * the old readout showed is lost.
 *
 * `provides` is undefined for special Energy, which is grouped as `special`
 * rather than dropped or mislabelled as a basic type. Order follows
 * `BASIC_ENERGY_TYPES` (the canonical ruleset order) with anything unrecognised
 * last, so the row is stable instead of hand-ordered.
 */
function energyGroups(pokemon: InPlayPokemon): { type: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const card of pokemon.attachedEnergy) {
    const key = card.provides ?? 'special'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const order = [...BASIC_ENERGY_TYPES, 'special']
  const rank = (type: string) => {
    const index = order.indexOf(type as BasicEnergyType)
    return index === -1 ? order.length : index
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => rank(a.type) - rank(b.type))
}

/** Technical Energy type id -> its translated name. Never an English literal. */
const ENERGY_TYPE_KEYS: Record<string, TranslationKey> = {
  grass: 'pokemonBnb.energyTypeGrass',
  fire: 'pokemonBnb.energyTypeFire',
  water: 'pokemonBnb.energyTypeWater',
  lightning: 'pokemonBnb.energyTypeLightning',
  psychic: 'pokemonBnb.energyTypePsychic',
  fighting: 'pokemonBnb.energyTypeFighting',
  darkness: 'pokemonBnb.energyTypeDarkness',
  metal: 'pokemonBnb.energyTypeMetal',
  special: 'pokemonBnb.energyTypeSpecial',
}

function energyTypeName(type: string, t: (key: TranslationKey) => string): string {
  const key = ENERGY_TYPE_KEYS[type]
  return key ? t(key) : type
}

/**
 * Energy + Tool attached to one Pokemon, as chips rather than full faces: a
 * Pokemon can hold a dozen Energy and full faces would blow the 16:9 stage.
 * The count and the Tool's name are all the rules need.
 */
function Attachments({ pokemon, t }: { pokemon: InPlayPokemon; t: (key: TranslationKey) => string }) {
  if (pokemon.attachedEnergy.length === 0 && !pokemon.attachedTool) return null
  const groups = energyGroups(pokemon)
  return (
    <ul className="bnb-attachments" aria-label={t('pokemonBnb.zoneAttachments')}>
      {groups.map((group) => (
        // The swatch and the number are both decorative: the chip's accessible
        // name carries the whole meaning, so a screen reader hears "2 Fire
        // Energy attached" rather than a bare digit next to a colour.
        <li
          key={group.type}
          className="bnb-attachment bnb-attachment-energy-type"
          data-energy-type={group.type}
          aria-label={substituteParams(t('pokemonBnb.energyAttached'), {
            count: String(group.count),
            type: energyTypeName(group.type, t),
          })}
        >
          <span className={`bnb-energy-swatch bnb-energy-swatch-${group.type}`} aria-hidden="true" />
          <span aria-hidden="true">{group.count}</span>
        </li>
      ))}
      {pokemon.attachedEnergy.length > 0 && (
        <li
          className="bnb-attachment bnb-attachment-energy"
          aria-label={substituteParams(t('pokemonBnb.energyTotalAttached'), {
            count: String(pokemon.attachedEnergy.length),
          })}
        >
          <span aria-hidden="true">⚡</span>
          <span aria-hidden="true">{pokemon.attachedEnergy.length}</span>
        </li>
      )}
      {pokemon.attachedTool && <li className="bnb-attachment bnb-attachment-tool">{pokemon.attachedTool.name}</li>}
    </ul>
  )
}

/** One seat's half of the board. Used for BOTH players (see the header note). */
export function BattleSide({
  heading, side, seat, prizeTotal, isFoe, t, conditionLabel, rarityLabelFor, faceDownLabel,
  isSelectableBench, selectedBench, onSelectBench, selectedHand, onSelectHand, onInspect,
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
            <button
              type="button"
              className="bnb-inspect"
              aria-label={`${active.card.name} — ${t('pokemonBnb.focusOpen')}`}
              onClick={() => onInspect?.(seat, 'active', 0)}
            >
              <PokemonCard
                card={active.card}
                rarityLabel={rarityLabelFor(active.card.rarity)}
                faceDownLabel={faceDownLabel}
                damage={active.damage}
                statuses={activeStatuses}
              />
            </button>
            <Attachments pokemon={active} t={t} />
            {/* CP4: health and damage counters, beside the card. The card face
                is the hosted artwork, so the readout lives next to it. */}
            <PokemonVitals pokemon={active} t={t} />
            {activeConditionLabels.length > 0 && (
              <span className="bnb-side-conditions">{activeConditionLabels.join(' / ')}</span>
            )}
          </div>
        ) : (
          <span className="bnb-side-card">{t('pokemonBnb.zoneActive')}: —</span>
        )}
      </div>


      {/* Bench: the rulebook board always shows all five slots, so empty space is
          visible as space. Rendering only the occupied Pokemon left the player
          with no indication of where a Basic could legally go. */}
      <div className="bnb-side-bench">
        <span className="bnb-zone-label">{t('pokemonBnb.zoneBench')}</span>
        <ol className="bnb-bench-list">
          {Array.from({ length: MAX_BENCH }, (_, slot) => {
            const pokemon = side.bench[slot]
            if (!pokemon) {
              return <li key={`empty-${slot}`} className="bnb-bench-slot bnb-bench-slot-empty" aria-hidden="true" />
            }
            const selected = isSelectableBench && selectedBench === slot
            const targetHint = t('pokemonBnb.selectTarget').replace('{index}', String(slot + 1))
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
                {/* CP4: the Bench gets the same readout as the Active — a
                    benched Pokemon takes damage the same way. */}
                <PokemonVitals pokemon={pokemon} t={t} />
              </span>
            )
            return (
              <li key={pokemon.uid} className="bnb-bench-slot">
                {isSelectableBench ? (
                  <button
                    type="button"
                    className="bnb-bench-pick"
                    aria-pressed={selected}
                    aria-label={`${pokemon.card.name} — ${targetHint}`}
                    onClick={() => onSelectBench?.(selected ? null : slot)}
                  >
                    {face}
                  </button>
                ) : face}
                {/* Inspect is a separate control from "select as target": the foe
                    lane offers it, so an opponent's card is readable even though
                    it can never be a target. */}
                <button
                  type="button"
                  className="bnb-inspect bnb-inspect-corner"
                  aria-label={`${pokemon.card.name} — ${t('pokemonBnb.focusOpen')}`}
                  onClick={() => onInspect?.(seat, 'bench', slot)}
                >
                  <span aria-hidden="true">⤢</span>
                </button>
              </li>
            )
          })}
        </ol>
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
            <button
              type="button"
              className="bnb-inspect"
              aria-label={`${side.discard[side.discard.length - 1].name} — ${t('pokemonBnb.focusOpen')}`}
              onClick={() => onInspect?.(seat, 'discard', side.discard.length - 1)}
            >
              <PokemonCard
                card={side.discard[side.discard.length - 1]}
                rarityLabel={rarityLabelFor(side.discard[side.discard.length - 1].rarity)}
                faceDownLabel={faceDownLabel}
              />
            </button>
          ) : (
            <span className="bnb-side-card">—</span>
          )}
        </div>
      </div>

      {/* Hand: the viewer's own cards are shown as real card faces and are
          selectable; the opponent's is a count only. `onSelectHand` is absent on
          the foe lane, so that gate — not a hidden-card check — is what keeps the
          opponent read-only. */}
      <div className="bnb-side-hand">
        <span className="bnb-zone-label">{t('pokemonBnb.zoneHand')}</span>
        {onSelectHand && !side.hand.every(isHiddenCard) ? (
          <ol className="bnb-hand-list">
            {side.hand.map((card, index) => {
              if (isHiddenCard(card)) return null
              const selected = selectedHand === index
              return (
                <li key={`${card.id}-${index}`} className="bnb-hand-slot">
                  <button
                    type="button"
                    className="bnb-hand-pick"
                    aria-pressed={selected}
                    aria-label={`${t('pokemonBnb.selectHandCard')} — ${card.name}`}
                    onClick={() => onSelectHand?.(selected ? null : index)}
                  >
                    <PokemonCard
                      card={card}
                      rarityLabel={rarityLabelFor(card.rarity)}
                      faceDownLabel={faceDownLabel}
                    />
                  </button>
                  {/* Reading a hand card is separate from arming it with the action
                      bar, so the face is its own focus target. */}
                  {onInspect && (
                    <button
                      type="button"
                      className="bnb-inspect bnb-inspect-corner"
                      aria-label={`${card.name} — ${t('pokemonBnb.focusOpen')}`}
                      onClick={() => onInspect(seat, 'hand', index)}
                    >
                      <span aria-hidden="true">⤢</span>
                    </button>
                  )}
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


export type BattleBoardProps = Omit<BattleSideProps, 'side' | 'isFoe' | 'heading' | 'seat'> & {
  self: { heading: string; side: SideState; seat: PlayerSlot }
  foe: { heading: string; side: SideState; seat: PlayerSlot }
  /** The shared Stadium in play, or null. One zone, visible to both players. */
  stadium: CardDef | null
}

/**
 * The whole tabletop: the shared Stadium lane, then the opponent's mirrored
 * lane, then the viewer's own lane. Nothing scrolls horizontally.
 */
export function BattleBoard({
  self, foe, stadium, prizeTotal, t, conditionLabel, rarityLabelFor, faceDownLabel,
  isSelectableBench, selectedBench, onSelectBench, selectedHand, onSelectHand, onInspect,
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
          seat={foe.seat}
          prizeTotal={prizeTotal}
          isFoe
          t={t}
          conditionLabel={conditionLabel}
          rarityLabelFor={rarityLabelFor}
          faceDownLabel={faceDownLabel}
          isSelectableBench={false}
          selectedBench={null}
          selectedHand={null}
          onInspect={onInspect}
        />
        <BattleSide
          heading={self.heading}
          side={self.side}
          seat={self.seat}
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
          onInspect={onInspect}
        />
      </div>
    </div>
  )
}