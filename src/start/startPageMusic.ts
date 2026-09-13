import { useEffect, useRef } from 'react'
import startPageMusicUrl from '../assets/start-page-music.mp3'
import { readConfig, subscribeConfig } from '../config'

/**
 * Looping start-page music, driven entirely by the shared config store
 * (`settings.music` + `settings.volume`). Playback waits for the first user
 * gesture when the browser blocks autoplay, pauses while a game page is open,
 * and releases its audio element on unmount.
 */
export function useStartPageMusic(suspended: boolean) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const syncRef = useRef<(() => void) | null>(null)
  const suspendedRef = useRef(suspended)

  useEffect(() => {
    const audio = new Audio(startPageMusicUrl)
    audio.loop = true
    audioRef.current = audio

    const removeUnlockListeners = () => {
      window.removeEventListener('pointerdown', play)
      window.removeEventListener('keydown', play)
      window.removeEventListener('touchstart', play)
    }

    function play() {
      if (suspendedRef.current || !readConfig().settings.music) return
      audio.play().then(removeUnlockListeners).catch(() => {
        window.addEventListener('pointerdown', play)
        window.addEventListener('keydown', play)
        window.addEventListener('touchstart', play)
      })
    }

    const sync = () => {
      const { music, volume } = readConfig().settings
      audio.volume = Math.min(1, Math.max(0, volume / 100))
      removeUnlockListeners()
      if (!music || suspendedRef.current) {
        audio.pause()
        return
      }
      play()
    }
    syncRef.current = sync
    sync()
    const unsubscribe = subscribeConfig(sync)

    return () => {
      unsubscribe()
      removeUnlockListeners()
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
      syncRef.current = null
    }
  }, [])

  useEffect(() => {
    suspendedRef.current = suspended
    syncRef.current?.()
  }, [suspended])
}