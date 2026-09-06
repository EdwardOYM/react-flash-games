import { useState } from 'react'
import type { Locale, useTranslations } from '../assets/languages'
import { readConfig, updateConfig } from '../config'
import { GameInputSettings, type AdditionalKeyBinding } from './GameInputSettings'

type SettingsModalProps = {
  locale: Locale
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
  t: ReturnType<typeof useTranslations>
  additionalBindings?: AdditionalKeyBinding[]
  additionalBindingsLabel?: Parameters<typeof GameInputSettings>[0]['labelKey']
  onRemapController?: () => void
  musicEnabled?: boolean
  onMusicToggle?: () => void
}

export function SettingsModal({ locale, onClose, onLocaleChange, t, additionalBindings = [], additionalBindingsLabel = 'keybinds', onRemapController, musicEnabled, onMusicToggle }: SettingsModalProps) {
  const [volume, setVolume] = useState(() => readConfig().settings.volume)

  const updateVolume = (value: number) => {
    setVolume(value)
    updateConfig((config) => ({ ...config, settings: { ...config.settings, volume: value } }))
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="settings-close" type="button" onClick={onClose} aria-label={t('closeSettings')}>×</button><p className="eyebrow">{t('settingsTitle')}</p><h2 id="settings-title">{t('settingsTitle')}</h2><div className="setting-control"><label htmlFor="volume">{t('volume')}<output>{volume}%</output></label><input id="volume" type="range" min="0" max="100" value={volume} onChange={(event) => updateVolume(Number(event.target.value))} /></div>{musicEnabled !== undefined && onMusicToggle && <div className="setting-control"><span className="setting-label">{t('bubble.settings')}</span><button className="music-toggle" type="button" onClick={onMusicToggle}>{musicEnabled ? t('bubble.musicOn') : t('bubble.musicOff')}</button></div>}<div className="setting-control"><label htmlFor="language">{t('language')}</label><select id="language" value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}><option value="en">{t('languageNames.en')}</option><option value="ms">{t('languageNames.ms')}</option><option value="zh">{t('languageNames.zh')}</option></select></div><GameInputSettings t={t} additionalBindings={additionalBindings} labelKey={additionalBindingsLabel} onRemapController={onRemapController} /></section></div>
}
