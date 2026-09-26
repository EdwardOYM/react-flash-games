// Card focus: click any card to read it large in the middle of the stage, with
// the actions that card can take listed beside it.
//
// The overlay is a real modal dialog: it closes on Escape, keeps Tab inside
// while open, and returns focus to the card that opened it. Legality is not
// decided here — `focusActions` (focus.ts) answers from the same `controlStates`
// table the action bar uses, so the two can never disagree.

import { useEffect, useRef } from 'react'
import { PokemonCard } from './PokemonCard'
import type { CardDef, CardRarity } from './cards'
import type { FocusAction } from './focus'
import type { TranslationKey } from '../../assets/languages'
import './CardFocus.css'

export type CardFocusTarget = {
  card: CardDef
  /** Damage banked on this Pokemon, when the card is in play. */
  damage?: number
  statuses?: string[]
  /** Where this card sits, for the heading. */
  zone: string
  /** In-play Pokemon this card could be attached/evolved onto. */
  targets: { key: string; label: string; selected: boolean }[]
  /** Read-only cards (the opponent's) offer no actions. */
  readOnly?: boolean
}

export type CardFocusProps = {
  target: CardFocusTarget
  actions: FocusAction[]
  onAction: (action: FocusAction) => void
  onSelectTarget: (key: string) => void
  onClose: () => void
  t: (key: TranslationKey) => string
  rarityLabel: (rarity: CardRarity) => string
  faceDownLabel: string
  /** Translated label for one action, resolved by the caller. */
  actionLabel: (action: FocusAction) => string
  /** Translated reason a control is disabled, or null when it is enabled. */
  actionReason: (action: FocusAction) => string | null
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function CardFocus({
  target, actions, onAction, onSelectTarget, onClose, t, rarityLabel, faceDownLabel, actionLabel, actionReason,
}: CardFocusProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<Element | null>(null)

  // Move focus into the dialog on open, and hand it back on close.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    closeRef.current?.focus()
    return () => {
      const previous = restoreFocusRef.current
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  // Escape closes; Tab stays inside the dialog while it is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (!root) return
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return (
    <div className="bnb-focus-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="bnb-focus" role="dialog" aria-modal="true" aria-label={target.card.name} ref={dialogRef}>
        <button ref={closeRef} type="button" className="bnb-focus-close" aria-label={t('pokemonBnb.focusClose')} onClick={onClose}>
          ✕
        </button>
        <div className="bnb-focus-face">
          <PokemonCard
            card={target.card}
            rarityLabel={rarityLabel(target.card.rarity)}
            faceDownLabel={faceDownLabel}
            damage={target.damage}
            statuses={target.statuses}
          />
        </div>
        <div className="bnb-focus-panel">
          <p className="bnb-focus-zone">{target.zone}</p>
          <h2 className="bnb-focus-name">{target.card.name}</h2>
          {target.readOnly ? (
            <p className="bnb-hint">{t('pokemonBnb.focusReadOnly')}</p>
          ) : actions.length === 0 ? (
            <p className="bnb-hint">{t('pokemonBnb.focusNoActions')}</p>
          ) : (
            <>
              {target.targets.length > 0 && (
                <div className="bnb-focus-targets">
                  <p className="bnb-field-label">{t('pokemonBnb.focusChooseTarget')}</p>
                  <div className="bnb-actions">
                    {target.targets.map((option) => (
                      <button key={option.key} type="button" aria-pressed={option.selected} onClick={() => onSelectTarget(option.key)}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="bnb-actions bnb-focus-actions">
                {actions.map((action) => {
                  const reason = action.enabled ? null : actionReason(action)
                  const reasonId = `bnb-focus-reason-${action.id}`
                  return (
                    <button
                      key={action.id}
                      type="button"
                      disabled={!action.enabled}
                      title={reason ?? undefined}
                      aria-describedby={!action.enabled && reason ? reasonId : undefined}
                      onClick={() => onAction(action)}
                    >
                      {actionLabel(action)}
                      {!action.enabled && reason && <span className="bnb-control-reason" id={reasonId}>{reason}</span>}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

