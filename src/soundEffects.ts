import buttonClickUrl from './assets/button-click.mp3'
import bubblePopUrl from './assets/bubble-trouble/bubble-pop.mp3'
import { readConfig } from './config'

let clickAudio: HTMLAudioElement | null = null
let audioContext: AudioContext | null = null
let popBuffer: AudioBuffer | null = null

/** Sound effects play only when the SFX channel is on and global mute is off. */
function sfxSettings(): { allowed: boolean; volume: number } {
  const { sfx, muted, sfxVolume } = readConfig().settings
  return { allowed: sfx && !muted, volume: Math.min(1, Math.max(0, sfxVolume / 100)) }
}

/** Play the UI button-click sound effect at the configured SFX volume. */
export function playUiClick() {
  const sfx = sfxSettings()
  if (!sfx.allowed) return
  clickAudio ??= new Audio(buttonClickUrl)
  clickAudio.volume = sfx.volume
  clickAudio.currentTime = 0
  clickAudio.play().catch(() => undefined)
}

/**
 * Play a click sound for every <button> press app-wide. Uses a capture-phase
 * click listener so it also covers keyboard activation (Enter / Space) and
 * clicks on elements nested inside buttons. Install once at the app root.
 */
export function installUiSounds() {
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('button')) playUiClick()
  }, true)
}

async function ensurePopBuffer(): Promise<AudioBuffer | null> {
  try {
    audioContext ??= new AudioContext()
    if (!popBuffer) {
      const response = await fetch(bubblePopUrl)
      popBuffer = await audioContext.decodeAudioData(await response.arrayBuffer())
    }
    // Gameplay sounds only occur after a user gesture, but resume defensively.
    if (audioContext.state === 'suspended') await audioContext.resume()
    return popBuffer
  } catch {
    return null
  }
}

/**
 * Play the bubble pop sound effect through the shared Web Audio graph.
 * `rate` scales playback speed — since pitch follows speed, callers pass a
 * higher rate for smaller bubbles. Safe to call for many overlapping pops.
 */
export function playBubblePop(rate: number) {
  void ensurePopBuffer().then((buffer) => {
    const sfx = sfxSettings()
    if (!buffer || !audioContext || !sfx.allowed) return
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.max(0.25, rate)
    const gain = audioContext.createGain()
    gain.gain.value = sfx.volume
    source.connect(gain)
    gain.connect(audioContext.destination)
    source.start()
  })
}