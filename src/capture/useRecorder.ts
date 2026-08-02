/**
 * getUserMedia + MediaRecorder wrapper. Negotiates the container at runtime
 * (iOS Safari records audio/mp4, not webm — never hardcode). On mic failure
 * the state becomes 'error' with a kind so the screen can offer the right
 * recovery (retry vs. iOS Settings hint) alongside text entry (SPEC §4.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationSec: number
}

export type RecorderState = 'idle' | 'recording' | 'error'

/** 'denied': user must enable the mic in iOS Settings. 'failed': worth retrying. */
export type RecorderErrorKind = 'denied' | 'failed'

export interface Recorder {
  state: RecorderState
  elapsedSec: number
  /** Starts recording; auto-stops at maxSec, delivering the clip to onAutoStop. */
  start: (maxSec?: number, onAutoStop?: (result: RecordingResult) => void) => Promise<void>
  stop: () => Promise<RecordingResult | null>
  /** Discards the in-progress recording (A2). */
  cancel: () => void
  /** Clears the error state so the mic can be retried (A4). */
  resetError: () => void
  /** Live input level 0..1 (RMS); safe to call anytime (A1). */
  getLevel: () => number
  errorKind?: RecorderErrorKind
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
}

function classifyError(e: unknown): RecorderErrorKind {
  return e instanceof DOMException &&
    (e.name === 'NotAllowedError' || e.name === 'SecurityError')
    ? 'denied'
    : 'failed'
}

export function useRecorder(): Recorder {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [errorKind, setErrorKind] = useState<RecorderErrorKind>()

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null)

  const cleanup = useCallback(() => {
    if (timerRef.current !== undefined) clearInterval(timerRef.current)
    timerRef.current = undefined
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    void audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    analyserRef.current = null
    levelBufRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const getLevel = useCallback((): number => {
    const analyser = analyserRef.current
    const buf = levelBufRef.current
    if (!analyser || !buf) return 0
    analyser.getByteTimeDomainData(buf)
    let sumSquares = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sumSquares += v * v
    }
    return Math.sqrt(sumSquares / buf.length)
  }, [])

  const finalize = useCallback((): Promise<RecordingResult | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null)
    recorderRef.current = null // claim it: concurrent stop/auto-stop become no-ops
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

  const cancel = useCallback(() => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    chunksRef.current = []
    cleanup()
    setState('idle')
    setElapsedSec(0)
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
        // Level analyser is best-effort; recording must not depend on it.
        try {
          const Ctx = window.AudioContext ?? window.webkitAudioContext
          if (Ctx) {
            const ctx = new Ctx()
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 512
            ctx.createMediaStreamSource(stream).connect(analyser)
            audioCtxRef.current = ctx
            analyserRef.current = analyser
            levelBufRef.current = new Uint8Array(analyser.fftSize)
          }
        } catch {
          /* meter unavailable; recording continues */
        }
        recorder.start()
        setErrorKind(undefined)
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
        setErrorKind(classifyError(e))
        setState('error')
      }
    },
    [cleanup, finalize],
  )

  const stop = useCallback(() => finalize(), [finalize])

  const resetError = useCallback(() => {
    setErrorKind(undefined)
    setState('idle')
  }, [])

  return { state, elapsedSec, start, stop, cancel, resetError, getLevel, errorKind }
}
