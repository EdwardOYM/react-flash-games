// CP1 placeholder shell for 04-pokemon-pack-battle. Full start/tutorial/
// lobby/ceremony/results arrive in CP2-CP5; this keeps the registry +
// StartPage route build-green while those checkpoints land.
import type { Locale, useTranslations } from '../../assets/languages'
import './PokemonPackBattleGame.css'

type PokemonPackBattleProps = {
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  onExit: () => void
  t?: ReturnType<typeof useTranslations>
}

export function PokemonPackBattleGame({ onExit, t }: PokemonPackBattleProps) {
  const title = t ? t('games.pokemonPackBattle') : 'Pokemon Pack Battle'
  return (
    <main className="ppb-page">
      <header className="ppb-topbar">
        <span className="ppb-hud-label">{title}</span>
        <div className="ppb-topbar-actions">
          <button type="button" onClick={onExit}>
            {t ? t('pokemonBnb.exit') : 'Exit'}
          </button>
        </div>
      </header>
      <div className="ppb-shell">
        <h1>{title}</h1>
        <p className="ppb-copy">{t ? t('pokemonBnb.wip') : ''}</p>
      </div>
    </main>
  )
}
