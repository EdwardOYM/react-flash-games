import { useEffect, useState } from 'react'
import type { Locale, TranslationKey, useTranslations } from '../assets/languages'

type KeyBindings = { primary: string }

export type AdditionalKeyBinding = {
  id: string
  labelKey: TranslationKey
  defaultKey: string
}

type SettingsModalProps = {
  locale: Locale
  onClose: () => void
  onLocaleChange: (locale: Locale) => void
  t: ReturnType<typeof useTranslations>
  additionalBindings?: AdditionalKeyBinding[]
  musicEnabled?: boolean
  onMusicToggle?: () => void
}

export function SettingsModal({ locale, onClose, onLocaleChange, t, additionalBindings = [], musicEnabled, onMusicToggle }: SettingsModalProps) {
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('flash-games-volume') ?? 70))
  const [bindings, setBindings] = useState<KeyBindings>(() => ({ primary: localStorage.getItem('flash-games-primary-key') ?? 'Space' }))
  const [listening, setListening] = useState(false)
  const [activeBinding, setActiveBinding] = useState<string | null>(null)
  const [extraBindings, setExtraBindings] = useState<Record<string, string>>(() => Object.fromEntries(additionalBindings.map(({ id, defaultKey }) => [id, localStorage.getItem(`flash-games-key-${id}`) ?? defaultKey])))

  useEffect(() => {
    if (!listening) return
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      const key = event.key === ' ' ? 'Space' : event.key
      if (activeBinding) {
        setExtraBindings((current) => ({ ...current, [activeBinding]: key }))
        localStorage.setItem(`flash-games-key-${activeBinding}`, key)
      } else {
        setBindings({ primary: key })
        localStorage.setItem('flash-games-primary-key', key)
      }
      setListening(false)
      setActiveBinding(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeBinding, listening])

  const updateVolume = (value: number) => {
    setVolume(value)
    localStorage.setItem('flash-games-volume', String(value))
  }

  const resetBinding = () => {
    setBindings({ primary: 'Space' })
    localStorage.setItem('flash-games-primary-key', 'Space')
  }

  const listenFor = (bindingId: string | null) => {
    setActiveBinding(bindingId)
    setListening(true)
  }

  const resetExtraBinding = (binding: AdditionalKeyBinding) => {
    setExtraBindings((current) => ({ ...current, [binding.id]: binding.defaultKey }))
    localStorage.setItem(`flash-games-key-${binding.id}`, binding.defaultKey)
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="settings-close" type="button" onClick={onClose} aria-label={t('closeSettings')}>×</button><p className="eyebrow">{t('settingsTitle')}</p><h2 id="settings-title">{t('settingsTitle')}</h2><div className="setting-control"><label htmlFor="volume">{t('volume')}<output>{volume}%</output></label><input id="volume" type="range" min="0" max="100" value={volume} onChange={(event) => updateVolume(Number(event.target.value))} /></div>{musicEnabled !== undefined && onMusicToggle && <div className="setting-control"><span className="setting-label">{t('bubble.settings')}</span><button className="music-toggle" type="button" onClick={onMusicToggle}>{musicEnabled ? t('bubble.musicOn') : t('bubble.musicOff')}</button></div>}<div className="setting-control"><label htmlFor="language">{t('language')}</label><select id="language" value={locale} onChange={(event) => onLocaleChange(event.target.value as Locale)}><option value="en">{t('languageNames.en')}</option><option value="ms">{t('languageNames.ms')}</option><option value="zh">{t('languageNames.zh')}</option></select></div><div className="setting-control"><span className="setting-label">{t('keybinds')}</span><div className="keybind-row"><span>{t('keyNames.primary')}</span><kbd>{listening && !activeBinding ? t('pressKey') : bindings.primary}</kbd><button type="button" onClick={() => listenFor(null)}>{t('remap')}</button><button className="reset-button" type="button" onClick={resetBinding}>{t('resetKey')}</button></div>{additionalBindings.map((binding) => <div className="keybind-row" key={binding.id}><span>{t(binding.labelKey)}</span><kbd>{listening && activeBinding === binding.id ? t('pressKey') : extraBindings[binding.id]}</kbd><button type="button" onClick={() => listenFor(binding.id)}>{t('remap')}</button><button className="reset-button" type="button" onClick={() => resetExtraBinding(binding)}>{t('resetKey')}</button></div>)}</div></section></div>
}
