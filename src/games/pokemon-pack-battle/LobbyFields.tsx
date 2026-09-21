// Lobby settings fields for Pokemon Pack Battle (04) — mirrors the 03
// pokemon-bnb LobbyFields pattern: one component shared by the host (editable
// segmented/stepper controls) and the guest (read-only values). Labels are
// translation keys; the packs stepper clamps to the protocol limits 1-36 and
// the host pushes every change to the guest as a `lobby-update`.
import type { TranslationKey } from '../../assets/languages'
import { PACK_BATTLE_LIMITS, type PackBattleSettings } from './net/protocol'
import { listSets } from './sets'

type LobbyFieldsProps = {
  settings: PackBattleSettings
  /** Only the host edits; the guest sees the same fields read-only. */
  editable: boolean
  idPrefix: string
  t: (key: TranslationKey) => string
  onChange?: (patch: Partial<PackBattleSettings>) => void
}

/** Set + packs stepper — shared by the host and guest lobby views. */
export function LobbyFields({ settings, editable, idPrefix, t, onChange }: LobbyFieldsProps) {
  const ids = { set: `${idPrefix}-set`, packs: `${idPrefix}-packs` }
  const patch = (next: Partial<PackBattleSettings>) => onChange?.(next)
  const setLabelKey = listSets().find((entry) => entry.id === settings.set)?.labelKey ?? 'packBattle.set30c'

  return (
    <div className="ppb-fields">
      <div className="ppb-field">
        <span className="ppb-field-label" id={ids.set}>{t('packBattle.setLabel')}</span>
        {editable
          ? (
            <div className="ppb-segmented" role="group" aria-labelledby={ids.set}>
              {listSets().map((entry) => (
                <button key={entry.id} type="button" aria-pressed={settings.set === entry.id} onClick={() => patch({ set: entry.id })}>
                  {t(entry.labelKey)}
                </button>
              ))}
            </div>
          )
          : <span className="ppb-field-value">{t(setLabelKey)}</span>}
      </div>
      <div className="ppb-field">
        <span className="ppb-field-label" id={ids.packs}>{t('packBattle.packsLabel')}</span>
        {editable
          ? (
            <div className="ppb-stepper" role="group" aria-labelledby={ids.packs}>
              <button
                type="button"
                aria-label={t('packBattle.decrease')}
                disabled={settings.packs <= PACK_BATTLE_LIMITS.minPacks}
                onClick={() => patch({ packs: settings.packs - 1 })}
              >
                −
              </button>
              <span className="ppb-stepper-value" aria-live="polite">{settings.packs}</span>
              <button
                type="button"
                aria-label={t('packBattle.increase')}
                disabled={settings.packs >= PACK_BATTLE_LIMITS.maxPacks}
                onClick={() => patch({ packs: settings.packs + 1 })}
              >
                +
              </button>
            </div>
          )
          : <span className="ppb-field-value">{settings.packs}</span>}
      </div>
    </div>
  )
}
