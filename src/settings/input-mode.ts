import { useEffect, useState } from 'react'

export type InputMode = 'keyboard' | 'gamepad'

export function hasTouchInput() {
  if (typeof navigator === 'undefined') return false
  return navigator.maxTouchPoints > 0 || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
}

export function hasConnectedGamepad() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return false
  return Array.from(navigator.getGamepads()).some((gamepad) => gamepad?.connected)
}

export function hasControllerCapability() {
  return hasTouchInput() || hasConnectedGamepad()
}

export function useInputMode(): InputMode {
  const [inputMode, setInputMode] = useState<InputMode>(() => hasControllerCapability() ? 'gamepad' : 'keyboard')

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

export function useControllerVisibility() {
  const [visible, setVisible] = useState(() => hasControllerCapability())

  useEffect(() => {
    const showControls = () => setVisible(true)
    const handleTouch = (event: PointerEvent) => { if (event.pointerType === 'touch') showControls() }
    window.addEventListener('gamepadconnected', showControls)
    window.addEventListener('pointerdown', handleTouch)
    return () => {
      window.removeEventListener('gamepadconnected', showControls)
      window.removeEventListener('pointerdown', handleTouch)
    }
  }, [])

  return visible
}