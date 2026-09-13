import buttonClickUrl from './assets/button-click.mp3'
import bubblePopUrl from './assets/bubble-trouble/bubble-pop.mp3'
import { readConfig } from './config'

let clickAudio: HTMLAudioElement | null = null
let audioContext: AudioContext | null = null
let popBuffer: AudioBuffer | null = null
// Seconds of empty audio at the start of the bubble-pop asset, measured once
// from the decoded buffer. Playback offsets past it so the pop is heard the
// moment the bubble breaks instead of after the silent prefix plays out.
let popSilenceSeconds = 0
// A frame counts as audible once it reaches a small fraction of the loudest
// sample in the buffer, so decoder noise is not mistaken for the pop.
const POP_ONSET_THRESHOLD = 0.02

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

/**
 * Measure the silent prefix of a decoded pop buffer in seconds of buffer time.
 * A frame is silent while every channel stays below a small fraction of the
 * loudest sample; the first audible frame across all channels is the onset.
 * A buffer with no audible content returns 0.
 */
function leadingSilenceSeconds(buffer: AudioBuffer): number {
  const frames = buffer.length
  const channels = buffer.numberOfChannels
  if (frames < 1 || channels < 1) return 0
  const channelData: Array<Float32Array<ArrayBuffer>> = []
  let peak = 0
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel)
    channelData.push(data)
    for (let frame = 0; frame < frames; frame++) {
      const magnitude = Math.abs(data[frame])
      if (magnitude > peak) peak = magnitude
    }
  }
  if (peak === 0) return 0
  const threshold = peak * POP_ONSET_THRESHOLD
  for (let frame = 0; frame < frames; frame++) {
    for (const data of channelData) {
      if (Math.abs(data[frame]) >= threshold) return frame / buffer.sampleRate
    }
  }
  return 0
}

async function ensurePopBuffer(): Promise<AudioBuffer | null> {
  try {
    audioContext ??= new AudioContext()
    if (!popBuffer) {
      const response = await fetch(bubblePopUrl)
      const decoded = await audioContext.decodeAudioData(await response.arrayBuffer())
      popBuffer = decoded
      // Measure once per decoded buffer. A measurement failure just keeps the
      // previous behavior (play from the very start).
      try {
        popSilenceSeconds = leadingSilenceSeconds(decoded)
      } catch {
        popSilenceSeconds = 0
      }
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
    // Skip the asset's silent prefix. The offset is in buffer time at the
    // buffer's natural sample rate, so it works at every playbackRate.
    source.start(undefined, popSilenceSeconds)
  })
}