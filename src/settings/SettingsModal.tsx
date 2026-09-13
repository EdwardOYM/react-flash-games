import { useEffect, useState } from 'react'
import type { Locale, useTranslations } from '../assets/languages'
import { readConfig, subscribeConfig, updateConfig } from '../config'
import { ControllerSettings, type AdditionalKeyBinding } from './ControllerSettings'
import './SettingsModal.css'

type SettingsModalProps = {
  locale: Locale
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
  t: ReturnType<typeof useTranslations>
  additionalBindings?: AdditionalKeyBinding[]
  additionalBindingsLabel?: Parameters<typeof ControllerSettings>[0]['labelKey']
  onRemapController?: () => void
}

type AudioSettings = { music: boolean; musicVolume: number; sfx: boolean; sfxVolume: number; muted: boolean }

function readAudioSettings(): AudioSettings {
  const { music, musicVolume, sfx, sfxVolume, muted } = readConfig().settings
  return { music, musicVolume, sfx, sfxVolume, muted }
}

export function SettingsModal({ locale, onClose, onLocaleChange, t, additionalBindings = [], additionalBindingsLabel = 'keybinds', onRemapController }: SettingsModalProps) {
  const [audio, setAudio] = useState(readAudioSettings)

  useEffect(() => subscribeConfig((config) => setAudio({
    music: config.settings.music,
    musicVolume: config.settings.musicVolume,
    sfx: config.settings.sfx,
    sfxVolume: config.settings.sfxVolume,
    muted: config.settings.muted,
  })), [])

  const updateAudio = (patch: Partial<AudioSettings>) => {
    setAudio((current) => ({ ...current, ...patch }))
    updateConfig((config) => ({ ...config, settings: { ...config.settings, ...patch } }))
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="settings-close" type="button" onClick={onClose} aria-label={t('closeSettings')}>×</button><p className="eyebrow">{t('settingsTitle')}</p><h2 id="settings-title">{t('settingsTitle')}</h2><div className="setting-control"><span className="setting-label">{t('music')}</span><div className="setting-slider-row"><input id="music-volume" type="range" min="0" max="100" value={audio.musicVolume} disabled={audio.music || audio.muted} aria-label={`${t('music')} ${t('volume')}`} onChange={(event) => updateAudio({ musicVolume: Number(event.target.value) })} /><button className="music-toggle" type="button" disabled={audio.muted} onClick={() => updateAudio({ music: !audio.music })}>{audio.music ? t('musicOn') : t('musicOff')}</button></div></div><div className="setting-control"><span className="setting-label">{t('sfx')}</span><div className="setting-slider-row"><input id="sfx-volume" type="range" min="0" max="100" value={audio.sfxVolume} disabled={audio.sfx || audio.muted} aria-label={`${t('sfx')} ${t('volume')}`} onChange={(event) => updateAudio({ sfxVolume: Number(event.target.value) })} /><button className="music-toggle" type="button" disabled={audio.muted} onClick={() => updateAudio({ sfx: !audio.sfx })}>{audio.sfx ? t('sfxOn') : t('sfxOff')}</button></div></div><div className="setting-control"><span className="setting-label">{t('mute')}</span><button className={`music-toggle mute-toggle${audio.muted ? ' mute-active' : ''}`} type="button" onClick={() => updateAudio({ muted: !audio.muted })}>{audio.muted ? t('unmute') : t('mute')}</button></div><div className="setting-control"><label htmlFor="language">{t('language')}</label><select id="language" value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}><option value="en">{t('languageNames.en')}</option><option value="ms">{t('languageNames.ms')}</option><option value="zh">{t('languageNames.zh')}</option></select></div><ControllerSettings t={t} additionalBindings={additionalBindings} labelKey={additionalBindingsLabel} onRemapController={onRemapController} /></section></div>
}