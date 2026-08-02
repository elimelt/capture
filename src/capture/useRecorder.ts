/**
 * getUserMedia + MediaRecorder wrapper. Negotiates the container at runtime
 * (iOS Safari records audio/mp4, not webm — never hardcode). On mic failure
 * the state becomes 'error' and the screen falls back to text (SPEC §4.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationSec: number
}

export type RecorderState = 'idle' | 'recording' | 'error'

export interface Recorder {
  state: RecorderState
  elapsedSec: number
  /** Starts recording; auto-stops at maxSec, delivering the clip to onAutoStop. */
  start: (maxSec?: number, onAutoStop?: (result: RecordingResult) => void) => Promise<void>
  stop: () => Promise<RecordingResult | null>
  error?: string
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
}

export function useRecorder(): Recorder {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [error, setError] = useState<string>()

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const cleanup = useCallback(() => {
    if (timerRef.current !== undefined) clearInterval(timerRef.current)
    timerRef.current = undefined
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const finalize = useCallback((): Promise<RecordingResult | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null)
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const durationSec = Math.max(
          1,
          Math.round((Date.now() - startedAtRef.current) / 1000),
        )
        cleanup()
        setState('idle')
        setElapsedSec(0)
        resolve(blob.size > 0 ? { blob, mimeType, durationSec } : null)
      }
      recorder.stop()
    })
  }, [cleanup])

  const start = useCallback(
    async (maxSec = 60, onAutoStop?: (result: RecordingResult) => void) => {
      if (recorderRef.current) return
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mimeType = pickMimeType()
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        chunksRef.current = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        streamRef.current = stream
        recorderRef.current = recorder
        startedAtRef.current = Date.now()
        recorder.start()
        setError(undefined)
        setState('recording')
        setElapsedSec(0)
        timerRef.current = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000)
          setElapsedSec(elapsed)
          if (elapsed >= maxSec) {
            void finalize().then((result) => {
              if (result && onAutoStop) onAutoStop(result)
            })
          }
        }, 250)
      } catch (e) {
        cleanup()
        setError(e instanceof Error ? e.message : String(e))
        setState('error')
      }
    },
    [cleanup, finalize],
  )

  const stop = useCallback(() => finalize(), [finalize])

  return { state, elapsedSec, start, stop, error }
}
