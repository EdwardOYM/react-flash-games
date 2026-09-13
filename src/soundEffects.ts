import buttonClickUrl from './assets/button-click.mp3'
import bubblePopUrl from './assets/bubble-trouble/bubble-pop.mp3'
import { readConfig } from './config'

let clickAudio: HTMLAudioElement | null = null
let audioContext: AudioContext | null = null
let popBuffer: AudioBuffer | null = null

function configuredVolume(): number {
  return Math.min(1, Math.max(0, readConfig().settings.volume / 100))
}

/** Play the UI button-click sound effect at the configured audio volume. */
export function playUiClick() {
  clickAudio ??= new Audio(buttonClickUrl)
  clickAudio.volume = configuredVolume()
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
    if (!buffer || !audioContext) return
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.max(0.25, rate)
    const gain = audioContext.createGain()
    gain.gain.value = configuredVolume()
    source.connect(gain)
    gain.connect(audioContext.destination)
    source.start()
  })
}