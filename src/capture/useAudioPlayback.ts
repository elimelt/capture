import { useCallback, useEffect, useRef, useState } from 'react'
import { getBlob } from '../store/events'

export interface AudioPlayback {
  playing: boolean
  /** 0..1 through the clip. */
  progress: number
  /** Play from the start, or stop if already playing (B10). */
  toggle: () => Promise<void>
}

export function useAudioPlayback(file: string | undefined): AudioPlayback {
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const rafRef = useRef(0)
  const loadingRef = useRef(false)

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    setPlaying(false)
    setProgress(0)
  }, [])

  useEffect(() => stop, [stop])

  const toggle = useCallback(async () => {
    if (audioRef.current) {
      stop()
      return
    }
    // Guard the getBlob await: a second tap here must not start a second clip.
    if (!file || loadingRef.current) return
    loadingRef.current = true
    try {
      const blob = await getBlob(file)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const el = new Audio(url)
      audioRef.current = el
      urlRef.current = url
      el.onended = stop
      el.onerror = stop
      const tick = () => {
        if (!audioRef.current) return
        if (Number.isFinite(el.duration) && el.duration > 0) {
          setProgress(el.currentTime / el.duration)
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      try {
        await el.play()
        setPlaying(true)
        rafRef.current = requestAnimationFrame(tick)
      } catch {
        stop()
      }
    } finally {
      loadingRef.current = false
    }
  }, [file, stop])

  return { playing, progress, toggle }
}
