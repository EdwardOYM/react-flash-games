// Pokemon Pack Rips â€” solo pack rip page + unlocked collection page (04.3).
// Reuses the shared 30C pack definition and card pool so a solo rip draws from the
// same rarity distribution as the ceremony without any new weights or slots.
import { useMemo, useState } from 'react'
import { type Locale, useTranslations } from '../../assets/languages'
import { readConfig } from '../../config'
import { PokemonCard } from '../pokemon-bnb/PokemonCard'
import { listPlayers, readOpenedCards, recordOpenedCards } from './collection'
import { PACK_BATTLE_30C, battleSetCards, openBattlePacks, type BattleOpenedCard } from './battlePack'
import { PackStack } from './PackStack'
import { createPackBattleRng, randomPackBattleSeed } from './rng'
import { listSets } from './sets'
import './PokemonPackBattleGame.css'
import './PokemonPackRip.css'

export type PokemonPackRipView = 'rip' | 'unlocked'

type PokemonPackRipProps = {
  view: PokemonPackRipView
  playerName?: string
  setIndex?: number
  onViewChange?: (view: PokemonPackRipView) => void
  onExit?: () => void
  onRipPlayerName?: (name: string) => void
  onRipSetIndex?: (index: number) => void
}

function substituteParams(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? `{${key}}`)
}

function cardSortNumber(card: { number: string }): number {
  const parsed = Number.parseInt((card.number ?? '').replace(/\D+/g, ''), 10)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

/**
 * Every card of one set in card-number order, each tagged with whether the named
 * player has opened it. The collection shows the whole set and greyscales the
 * cards that are not unlocked yet (nothing is hidden â€” progress reads as a set
 * with gaps to fill). The bucket is read here â€” not memoised â€” because a rip
 * writes straight to the persisted config and this page has no storage
 * subscription.
 */
function setCollectionCards(player: string, setId: string) {
  const opened = new Set(readOpenedCards(player))
  return battleSetCards()
    .filter((card) => card.set === setId)
    .sort((a, b) => cardSortNumber(a) - cardSortNumber(b))
    .map((card) => ({ card, unlocked: opened.has(card.id) }))
}

export function PokemonPackRip({
  view,
  playerName = '',
  setIndex = 0,
  onViewChange,
  onExit,
  onRipPlayerName,
  onRipSetIndex,
}: PokemonPackRipProps) {
  const translate = useTranslations((readConfig().settings.locale ?? 'en') as Locale)
  const setEntries = useMemo(() => listSets(), [])

  // The fields are seeded by the props and the parent mirrors every change back
  // down, so a remount restores the last name and set; no effect has to re-sync
  // a value that already matches. Each "Open pack" click opens exactly ONE pack
  // (CP9: no pack-count stepper — repeat the click for another pack); CP10 renders
  // its six cards in one stack and reveals them in fixed seeded order.
  const [playerNameField, setPlayerNameField] = useState(playerName)
  const [setIndexField, setSetIndexField] = useState(setIndex)
  const [soloOpened, setSoloOpened] = useState<BattleOpenedCard[] | null>(null)
  const [soloRevealed, setSoloRevealed] = useState<boolean[]>([])
  const [soloExpanded, setSoloExpanded] = useState(false)
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

  const collectionCards = setCollectionCards(selectedPlayer, unlockedSet.id)
  const unlockedInSet = collectionCards.filter((entry) => entry.unlocked).length

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

  /** Open one fresh six-card stack in the fixed seeded reveal order. */
  const handleOpenPacks = () => {
    const trimmed = playerNameField.trim()
    if (!trimmed) return

    const rng = createPackBattleRng(randomPackBattleSeed())
    const opened = openBattlePacks(battleSetCards(), PACK_BATTLE_30C, 1, rng)
    const ids = opened.map((entry) => entry.card.id)

    recordOpenedCards(trimmed, ids)
    setSoloPlayer(trimmed)
    setSoloOpened(opened)
    setSoloRevealed(opened.map(() => false))
    setSoloExpanded(false)
    onRipPlayerName?.(trimmed)
    onRipSetIndex?.(setIndexField)
  }

  /** Reveal the single hidden card currently waiting beneath the visible top card. */
  const handleRevealNextSoloCard = () => {
    setSoloRevealed((prev) => {
      const nextIndex = prev.findIndex((seen) => !seen)
      if (nextIndex < 0) return prev
      const next = [...prev]
      next[nextIndex] = true
      return next
    })
  }

  /** Reveal the complete pack immediately and expand it for side-by-side review. */
  const handleRevealAllSolo = () => {
    setSoloRevealed((prev) => prev.map(() => true))
    setSoloExpanded(true)
  }

  const handleBackToPackBattle = () => {
    onExit?.()
  }

  const handleBackToRip = () => {
    onViewChange?.('rip')
  }

  /**
   * Open the collection. This backs two entry points: the form's always-available
   * "Unlocked cards" button (no rip needed, so previously opened cards are viewable
   * straight away) and the post-rip button in the results row. The form's current
   * set and name are carried over, so a typed name lands on that player's
   * collection; an empty name simply falls back to the first player the unlocked
   * page finds in the bucket (bucket keys are lowercased).
   */
  const handleToUnlocked = () => {
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
          </div>

          <div className="ppb-rip-actions">
            <button className="ppb-rip-primary" type="button" onClick={handleOpenPacks} disabled={!playerNameField.trim()}>
              {translate('packBattle.ripOpen')}
            </button>
            <button className="ppb-rip-secondary" type="button" onClick={handleToUnlocked}>
              {translate('packBattle.unlocked')}
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
                count: '1',
                plural: '',
                pelandak: '',
              })}
              {' '}
              {substituteParams(translate('packBattle.ripResultCards'), {
                count: String(soloOpened.length),
                plural: soloOpened.length === 1 ? '' : 's',
                pelandak: soloOpened.length === 1 ? '' : 's',
              })}
            </p>
            {/* All six keyed cards stay mounted. Normal mode overlaps them in one
                stack; reveal-all switches those same cards to the final grid. */}
            <div className="ppb-actions ppb-ceremony-actions">
              {!soloExpanded && soloRevealed.some((seen) => !seen) && (
                <>
                  <p className="ppb-hint ppb-ceremony-hint">{translate('packBattle.ceremonyRevealHint')}</p>
                  <button type="button" onClick={handleRevealAllSolo}>
                    {translate('packBattle.ripRevealAll')}
                  </button>
                </>
              )}
            </div>
            <PackStack
              cards={soloOpened}
              revealed={soloRevealed}
              expanded={soloExpanded}
              stackLabel={translate('packBattle.ceremonyRevealHint')}
              faceDownLabel={translate('packBattle.cardFaceDown')}
              actionLabel={substituteParams(translate('packBattle.revealCardLabel'), {
                index: String(soloRevealed.findIndex((seen) => !seen) + 1),
                total: String(soloOpened.length),
                name: soloPlayer || translate('packBattle.defaultName'),
              })}
              rarityLabel={rarityLabelForCard}
              onReveal={handleRevealNextSoloCard}
            />
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

          {playersList.length > 0 && (
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
          )}
        </div>

        {playersList.length === 0 && (
          <p className="ppb-rip-empty" role="status">{translate('packBattle.unlockedNoPlayers')}</p>
        )}
        {playersList.length > 0 && unlockedInSet === 0 && (
          <p className="ppb-rip-empty" role="status">{translate('packBattle.unlockedEmpty')}</p>
        )}

        {/* The whole set stays on screen in card-number order: a card the player
            has not opened is greyscaled and darkened with a lock chip, never
            hidden, so the collection reads as a set with gaps to fill. */}
        <div className="ppb-rip-cardgrid">
          {collectionCards.map(({ card, unlocked }) => (
            <div key={card.id} className={unlocked ? 'ppb-rip-cardwrap' : 'ppb-rip-cardwrap ppb-rip-cardwrap-locked'}>
              <div className="ppb-rip-cardface">
                <PokemonCard card={card} rarityLabel={rarityLabelForCard(card.rarity)} />
              </div>
              {!unlocked && <span className="ppb-rip-lockchip">{translate('packBattle.unlockedLocked')}</span>}
            </div>
          ))}
        </div>

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

