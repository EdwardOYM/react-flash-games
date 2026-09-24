// Pokemon Pack Rips — solo pack rip page + unlocked collection page (04.3).
// Reuses the shared 30C pack definition and card pool so a solo rip draws from the
// same rarity distribution as the ceremony without any new weights or slots.
import { useMemo, useState } from 'react'
import { type Locale, useTranslations } from '../../assets/languages'
import { readConfig } from '../../config'
import { PokemonCard } from '../pokemon-bnb/PokemonCard'
import { listPlayers, readOpenedCards, recordOpenedCards } from './collection'
import { PACK_BATTLE_30C, battleSetCards, openBattlePacks, type BattleOpenedCard } from './battlePack'
import { createPackBattleRng, randomPackBattleSeed } from './rng'
import { listSets } from './sets'
import './PokemonPackRip.css'

export type PokemonPackRipView = 'rip' | 'unlocked'

type PokemonPackRipProps = {
  view: PokemonPackRipView
  playerName?: string
  setIndex?: number
  packCount?: number
  onViewChange?: (view: PokemonPackRipView) => void
  onExit?: () => void
  onRipPlayerName?: (name: string) => void
  onRipSetIndex?: (index: number) => void
  onRipPackCount?: (count: number) => void
}

const clampPackCount = (value: number) => Math.min(18, Math.max(1, value))

function substituteParams(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? `{${key}}`)
}

function cardSortNumber(card: { number: string }): number {
  const parsed = Number.parseInt((card.number ?? '').replace(/\D+/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

/**
 * Cards the player has opened in one set, in set-number order. Cards that were
 * never opened are not rendered (the collection shows exactly what was pulled).
 * The bucket is read here — not memoised — because a rip writes straight to the
 * persisted config and this page has no storage subscription.
 */
function cardsForPlayerSet(player: string, setId: string) {
  const ids = new Set(readOpenedCards(player))
  return battleSetCards()
    .filter((card) => card.set === setId && ids.has(card.id))
    .sort((a, b) => cardSortNumber(a) - cardSortNumber(b))
}

export function PokemonPackRip({
  view,
  playerName = '',
  setIndex = 0,
  packCount = 1,
  onViewChange,
  onExit,
  onRipPlayerName,
  onRipSetIndex,
  onRipPackCount,
}: PokemonPackRipProps) {
  const translate = useTranslations((readConfig().settings.locale ?? 'en') as Locale)
  const setEntries = useMemo(() => listSets(), [])

  // The fields are seeded by the props and the parent mirrors every change back
  // down, so a remount restores the last name, set, and pack count; no effect has
  // to re-sync a value that already matches.
  const [playerNameField, setPlayerNameField] = useState(playerName)
  const [setIndexField, setSetIndexField] = useState(setIndex)
  const [packCountField, setPackCountField] = useState(clampPackCount(packCount))
  const [soloOpened, setSoloOpened] = useState<BattleOpenedCard[] | null>(null)
  const [soloPlayer, setSoloPlayer] = useState('')
  const [collectionPlayer, setCollectionPlayer] = useState('')
  const [collectionSetIndex, setCollectionSetIndex] = useState(0)

  // The bucket is read during render (no memo): the player list must include a
  // player the rip just created, and a stale list would hide them entirely.
  const playersList = listPlayers().filter(Boolean)
  const selectedPlayer = collectionPlayer && playersList.includes(collectionPlayer)
    ? collectionPlayer
    : playersList[0] ?? ''
  const currentSet = setEntries[Math.min(setIndexField, setEntries.length - 1)] ?? setEntries[0]
  const unlockedSet = setEntries[Math.min(collectionSetIndex, setEntries.length - 1)] ?? setEntries[0]

  const rarityLabelForCard = (rarity: string): string => {
    switch (rarity) {
      case 'uncommon':
        return translate('packBattle.rarityUncommon')
      case 'rare':
        return translate('packBattle.rarityRare')
      case 'double rare':
        return translate('packBattle.rarityUltraRare')
      case 'illustration rare':
        return translate('packBattle.rarityIllustrationRare')
      default:
        return translate('packBattle.rarityCommon')
    }
  }

  const collectionCards = selectedPlayer ? cardsForPlayerSet(selectedPlayer, unlockedSet.id) : []

  const handleNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value.slice(0, 16)
    setPlayerNameField(nextValue)
    onRipPlayerName?.(nextValue)
  }

  const handleSetChange = (nextIndex: number) => {
    const clamped = Math.min(nextIndex, setEntries.length - 1)
    setSetIndexField(clamped)
    onRipSetIndex?.(clamped)
  }

  const handlePackCountChange = (delta: number) => {
    const next = clampPackCount(packCountField + delta)
    setPackCountField(next)
    onRipPackCount?.(next)
  }

  const handleOpenPacks = () => {
    const trimmed = playerNameField.trim()
    if (!trimmed) return

    const rng = createPackBattleRng(randomPackBattleSeed())
    const opened = openBattlePacks(battleSetCards(), PACK_BATTLE_30C, packCountField, rng)
    const ids = opened.map((entry) => entry.card.id)

    recordOpenedCards(trimmed, ids)
    setSoloPlayer(trimmed)
    setSoloOpened(opened)
    onRipPlayerName?.(trimmed)
    onRipSetIndex?.(setIndexField)
    onRipPackCount?.(packCountField)
  }

  const handleBackToPackBattle = () => {
    onExit?.()
  }

  const handleBackToRip = () => {
    onViewChange?.('rip')
  }

  const handleToUnlocked = () => {
    // Carry the rip's set and player into the collection page, so (Unlocked)
    // lands on the cards the player just opened (bucket keys are lowercased).
    setCollectionSetIndex(setIndexField)
    setCollectionPlayer((soloPlayer || playerNameField.trim()).toLowerCase())
    onViewChange?.('unlocked')
  }

  const renderRipPage = () => (
    <div className="ppb-rip-page">
      <div className="ppb-rip-topbar">
        <h1>{translate('packBattle.ripTitle')}</h1>
        <div className="ppb-rip-topbar-actions">
          <button type="button" onClick={handleBackToPackBattle}>{translate('packBattle.back')}</button>
        </div>
      </div>

      <div className="ppb-rip-shell">
        <p className="ppb-rip-eyebrow">{translate('packBattle.ripEyebrow')}</p>
        <div className="ppb-rip-form">
          <div className="ppb-rip-field">
            <label className="ppb-rip-field-label" htmlFor="rip-player-name">
              {translate('packBattle.displayName')}
            </label>
            <input
              id="rip-player-name"
              className="ppb-rip-input"
              type="text"
              value={playerNameField}
              maxLength={16}
              onChange={handleNameChange}
              placeholder={translate('packBattle.defaultName')}
            />
          </div>

          <div className="ppb-rip-fields">
            <div className="ppb-rip-field">
              <span className="ppb-rip-field-label">{translate('packBattle.setLabel')}</span>
              <div className="ppb-rip-segmented" role="group" aria-label={translate('packBattle.setLabel')}>
                {setEntries.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={currentSet.id === entry.id ? 'true' : undefined}
                    onClick={() => handleSetChange(index)}
                  >
                    {translate(entry.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            <div className="ppb-rip-field">
              <span className="ppb-rip-field-label">{translate('packBattle.packsLabel')}</span>
              <div className="ppb-rip-stepper" role="group" aria-label={translate('packBattle.packsLabel')}>
                <button type="button" aria-label={translate('packBattle.decrease')} onClick={() => handlePackCountChange(-1)}>
                  -
                </button>
                <span className="ppb-rip-stepper-num" aria-live="polite">{packCountField}</span>
                <button type="button" aria-label={translate('packBattle.increase')} onClick={() => handlePackCountChange(1)}>
                  +
                </button>
              </div>
            </div>
          </div>

          <div className="ppb-rip-actions">
            <button className="ppb-rip-primary" type="button" onClick={handleOpenPacks} disabled={!playerNameField.trim()}>
              {translate('packBattle.ripOpen')}
            </button>
            <button className="ppb-rip-secondary" type="button" onClick={() => setSoloOpened(null)} disabled={!soloOpened}>
              {translate('packBattle.ripMorePacks')}
            </button>
          </div>
        </div>

        {soloOpened && (
          <div className="ppb-rip-shell" style={{ marginTop: '22px' }}>
            <p className="ppb-rip-notice" role="status">
              {substituteParams(translate('packBattle.collectionSaved'), {
                player: soloPlayer || translate('packBattle.defaultName'),
              })}
            </p>
            <p className="ppb-rip-copy" style={{ marginTop: '8px' }}>
              {substituteParams(translate('packBattle.ripResultPacks'), {
                count: String(packCountField),
                plural: packCountField === 1 ? '' : 's',
              })}
              {' '}
              {substituteParams(translate('packBattle.ripResultCards'), {
                count: String(soloOpened.length),
                plural: soloOpened.length === 1 ? '' : 's',
              })}
            </p>
            <div className="ppb-rip-cardgrid">
              {soloOpened.map((opened, index) => (
                <div key={`${opened.card.id}-${index}`} className="ppb-rip-cardwrap">
                  <PokemonCard card={opened.card} rarityLabel={rarityLabelForCard(opened.card.rarity)} />
                </div>
              ))}
            </div>
            <div className="ppb-rip-actions" style={{ marginTop: '16px' }}>
              <button className="ppb-rip-primary" type="button" onClick={handleToUnlocked}>
                {translate('packBattle.unlockedTitle')}
              </button>
              <button className="ppb-rip-secondary" type="button" onClick={handleBackToPackBattle}>
                {translate('packBattle.back')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  const renderUnlockedPage = () => (
    <div className="ppb-rip-page">
      <div className="ppb-rip-topbar">
        <h1>{translate('packBattle.unlockedTitle')}</h1>
        <div className="ppb-rip-topbar-actions">
          <button type="button" onClick={handleBackToPackBattle}>{translate('packBattle.back')}</button>
        </div>
      </div>

      <div className="ppb-rip-shell">
        <p className="ppb-rip-eyebrow">{translate('packBattle.unlockedEyebrow')}</p>

        {playersList.length === 0 ? (
          <p className="ppb-rip-empty" role="status">{translate('packBattle.unlockedNoPlayers')}</p>
        ) : (
          <>
            <div className="ppb-rip-fields">
              <div className="ppb-rip-field">
                <span className="ppb-rip-field-label">{translate('packBattle.setLabel')}</span>
                <div className="ppb-rip-segmented" role="group" aria-label={translate('packBattle.setLabel')}>
                  {setEntries.map((entry, index) => (
                    <button
                      key={entry.id}
                      type="button"
                      aria-pressed={unlockedSet.id === entry.id ? 'true' : undefined}
                      onClick={() => setCollectionSetIndex(index)}
                    >
                      {translate(entry.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ppb-rip-field">
                <span className="ppb-rip-field-label">{translate('packBattle.unlockedPlayer')}</span>
                <select
                  className="ppb-rip-select"
                  value={selectedPlayer}
                  onChange={(event) => setCollectionPlayer(event.target.value)}
                  aria-label={translate('packBattle.unlockedPlayer')}
                >
                  {playersList.map((player) => (
                    <option key={player} value={player}>
                      {player}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {collectionCards.length === 0 ? (
              <p className="ppb-rip-empty" role="status">{translate('packBattle.unlockedEmpty')}</p>
            ) : (
              <div className="ppb-rip-cardgrid">
                {collectionCards.map((card) => (
                  <div key={card.id} className="ppb-rip-cardwrap">
                    <PokemonCard card={card} rarityLabel={rarityLabelForCard(card.rarity)} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="ppb-rip-actions" style={{ marginTop: '16px' }}>
          <button className="ppb-rip-primary" type="button" onClick={handleBackToRip}>
            {translate('packBattle.backToPackRip')}
          </button>
          <button className="ppb-rip-secondary" type="button" onClick={handleBackToPackBattle}>
            {translate('packBattle.back')}
          </button>
        </div>
      </div>
    </div>
  )

  return view === 'rip' ? renderRipPage() : renderUnlockedPage()
}

