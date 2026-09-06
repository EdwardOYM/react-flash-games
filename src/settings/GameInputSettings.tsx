import { useEffect, useState } from 'react'
import type { TranslationKey, useTranslations } from '../assets/languages'
import { readConfig, updateConfig } from '../config'

export type AdditionalKeyBinding = {
  id: string
  labelKey: TranslationKey
  defaultKey: string
}

type KeyBindings = { primary: string }

type GameInputSettingsProps = {
  t: ReturnType<typeof useTranslations>
  additionalBindings?: AdditionalKeyBinding[]
  labelKey?: TranslationKey
  onRemapController?: () => void
}

type InputMode = 'keyboard' | 'gamepad'

function hasTouchInput() {
  if (typeof navigator === 'undefined') return false
  return navigator.maxTouchPoints > 0 || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
}

function hasConnectedGamepad() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return false
  return Array.from(navigator.getGamepads()).some((gamepad) => gamepad?.connected)
}

function useInputMode() {
  const [inputMode, setInputMode] = useState<InputMode>(() => hasTouchInput() || hasConnectedGamepad() ? 'gamepad' : 'keyboard')

  useEffect(() => {
    const handleKeyDown = () => setInputMode('keyboard')
    const handlePointerDown = (event: PointerEvent) => { if (event.pointerType === 'touch') setInputMode('gamepad') }
    const handleGamepadConnected = () => setInputMode('gamepad')
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('gamepadconnected', handleGamepadConnected)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('gamepadconnected', handleGamepadConnected)
    }
  }, [])

  return inputMode
}

export function GameInputSettings({ t, additionalBindings = [], labelKey = 'keybinds', onRemapController }: GameInputSettingsProps) {
  const inputMode = useInputMode()
  const isDesktop = inputMode === 'keyboard'
  const [bindings, setBindings] = useState<KeyBindings>(() => ({ primary: readConfig().settings.primaryKey }))
  const [listening, setListening] = useState(false)
  const [activeBinding, setActiveBinding] = useState<string | null>(null)
  const [extraBindings, setExtraBindings] = useState<Record<string, string>>(() => Object.fromEntries(additionalBindings.map(({ id, defaultKey }) => [id, readConfig().settings.keybindings[id] ?? defaultKey])))

  useEffect(() => {
    if (!listening || !isDesktop) return
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      const key = event.key === ' ' ? 'Space' : event.key
      if (activeBinding) {
        setExtraBindings((current) => ({ ...current, [activeBinding]: key }))
        updateConfig((config) => ({ ...config, settings: { ...config.settings, keybindings: { ...config.settings.keybindings, [activeBinding]: key } } }))
      } else {
        setBindings({ primary: key })
        updateConfig((config) => ({ ...config, settings: { ...config.settings, primaryKey: key } }))
      }
      setListening(false)
      setActiveBinding(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeBinding, isDesktop, listening])

  if (!isDesktop) return onRemapController ? <div className="setting-control mobile-gamepad-setting"><button className="music-toggle" type="button" onClick={onRemapController}>{t('remapController')}</button></div> : null

  const listenFor = (bindingId: string | null) => {
    setActiveBinding(bindingId)
    setListening(true)
  }

  const resetBinding = () => {
    setBindings({ primary: 'Space' })
    updateConfig((config) => ({ ...config, settings: { ...config.settings, primaryKey: 'Space' } }))
  }

  const resetExtraBinding = (binding: AdditionalKeyBinding) => {
    setExtraBindings((current) => ({ ...current, [binding.id]: binding.defaultKey }))
    updateConfig((config) => ({ ...config, settings: { ...config.settings, keybindings: { ...config.settings.keybindings, [binding.id]: binding.defaultKey } } }))
  }

  return <div className="setting-control game-input-settings"><span className="setting-label">{t(labelKey)}</span><div className="keybind-row"><span>{t('keyNames.primary')}</span><kbd>{listening && !activeBinding ? t('pressKey') : bindings.primary}</kbd><button type="button" onClick={() => listenFor(null)}>{t('remap')}</button><button className="reset-button" type="button" onClick={resetBinding}>{t('resetKey')}</button></div>{additionalBindings.map((binding) => <div className="keybind-row" key={binding.id}><span>{t(binding.labelKey)}</span><kbd>{listening && activeBinding === binding.id ? t('pressKey') : extraBindings[binding.id]}</kbd><button type="button" onClick={() => listenFor(binding.id)}>{t('remap')}</button><button className="reset-button" type="button" onClick={() => resetExtraBinding(binding)}>{t('resetKey')}</button></div>)}</div>
}
