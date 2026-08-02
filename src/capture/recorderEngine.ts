/**
 * Framework-free `getUserMedia` + `MediaRecorder` controller behind
 * `useRecorder` (`useRecorder.ts`). Kept free of React so the out-of-band
 * stop handling — mic revoked, iOS audio session taken by another app, a
 * `MediaRecorderErrorEvent` — can be exercised directly in tests by
 * stubbing the browser globals (`navigator.mediaDevices`, `MediaRecorder`),
 * the same way `notify/badge.ts`/`notify/local.ts` are tested, without a
 * DOM or a hook renderer (#49).
 *
 * `useRecorder.ts` owns nothing but React state; every ref, timer, and
 * event handler lives here.
 */

export interface RecordingResult {
  blob: Blob
  mimeType: string
  durationSec: number
}

export type RecorderState = 'idle' | 'recording' | 'error'

/** 'denied': user must enable the mic in iOS Settings. 'failed': worth retrying. */
export type RecorderErrorKind = 'denied' | 'failed'

export interface RecorderEngineCallbacks {
  onStateChange: (state: RecorderState) => void
  onElapsed: (sec: number) => void
  onErrorKind: (kind: RecorderErrorKind | undefined) => void
}

export interface RecorderEngine {
  start: (maxSec?: number, onAutoStop?: (result: RecordingResult) => void) => Promise<void>
  stop: () => Promise<RecordingResult | null>
  cancel: () => void
  resetError: () => void
  getLevel: () => number
  /** Releases the mic/timers/AudioContext; call on unmount. */
  destroy: () => void
}

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']

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

/**
 * Assembles the delivered chunks into a result, exactly as a clean
 * `onstop` would. Exported so a stop triggered out-of-band (chunks stop
 * arriving because the browser ended the recorder on its own) can be
 * settled through the identical path as a user-initiated stop — an
 * interrupted clip is still the user's words, not nothing.
 */
export function buildResult(
  chunks: Blob[],
  recorderMimeType: string,
  startedAtMs: number,
  nowMs: number,
): RecordingResult | null {
  const mimeType = recorderMimeType || chunks[0]?.type || 'audio/webm'
  const blob = new Blob(chunks, { type: mimeType })
  const durationSec = Math.max(1, Math.round((nowMs - startedAtMs) / 1000))
  return blob.size > 0 ? { blob, mimeType, durationSec } : null
}

export function createRecorderEngine(callbacks: RecorderEngineCallbacks): RecorderEngine {
  const recorderRef: { current: MediaRecorder | null } = { current: null }
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let startedAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let levelBuf: Uint8Array<ArrayBuffer> | null = null

  function cleanup() {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    recorderRef.current = null
    void audioCtx?.close().catch(() => {})
    audioCtx = null
    analyser = null
    levelBuf = null
  }

  function getLevel(): number {
    if (!analyser || !levelBuf) return 0
    analyser.getByteTimeDomainData(levelBuf)
    let sumSquares = 0
    for (let i = 0; i < levelBuf.length; i++) {
      const v = (levelBuf[i] - 128) / 128
      sumSquares += v * v
    }
    return Math.sqrt(sumSquares / levelBuf.length)
  }

  function settleIdle(result: RecordingResult | null) {
    cleanup()
    callbacks.onStateChange('idle')
    callbacks.onElapsed(0)
    return result
  }

  /**
   * Handles a stop the recorder or its stream initiated on its own — mid-
   * recording `error`, a track `ended` (mic revoked, OS took the audio
   * session, device disconnected), or a spontaneous `stop` no explicit
   * `stop()`/`finalize()` call is waiting on. Guarded by identity so it's a
   * no-op once `finalize()` has already claimed the recorder (set
   * `recorderRef.current` to something other than `recorder`, including
   * `null`) — the two paths can never both settle the same recording.
   */
  function handleOutOfBandStop(
    recorder: MediaRecorder,
    onAutoStop: ((result: RecordingResult) => void) | undefined,
  ) {
    return () => {
      if (recorderRef.current !== recorder) return
      recorderRef.current = null
      const result = buildResult(chunks, recorder.mimeType, startedAt, Date.now())
      cleanup()
      if (result) {
        callbacks.onStateChange('idle')
        callbacks.onElapsed(0)
        onAutoStop?.(result)
      } else {
        callbacks.onErrorKind('failed')
        callbacks.onStateChange('error')
      }
    }
  }

  function finalize(): Promise<RecordingResult | null> {
    const recorder = recorderRef.current
    if (!recorder) return Promise.resolve(null)
    recorderRef.current = null // claim: concurrent stop/auto-stop/out-of-band become no-ops
    if (recorder.state === 'inactive') {
      // The recorder already stopped (a stop/error event may be about to
      // fire, or already did and this call lost the identity race). Settle
      // here instead of the old silent no-op, so this branch can never
      // permanently leave the UI showing 'recording' (#49).
      return Promise.resolve(settleIdle(buildResult(chunks, recorder.mimeType, startedAt, Date.now())))
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(settleIdle(buildResult(chunks, recorder.mimeType, startedAt, Date.now())))
      }
      recorder.stop()
    })
  }

  function cancel() {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.onerror = null
      recorder.stop()
    }
    chunks = []
    cleanup()
    callbacks.onStateChange('idle')
    callbacks.onElapsed(0)
  }

  async function start(maxSec = 60, onAutoStop?: (result: RecordingResult) => void) {
    if (recorderRef.current) return
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
      chunks = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const onOutOfBandStop = handleOutOfBandStop(recorder, onAutoStop)
      // Covers a UA-initiated `stop` (e.g. all tracks ended) firing before
      // any explicit `stop()`/auto-stop claims the recorder, plus real
      // `error` events. `finalize()` always overwrites `onstop`/`onerror`
      // once it claims the recorder, so these never double-fire.
      recorder.onstop = onOutOfBandStop
      recorder.onerror = onOutOfBandStop
      mediaStream.getTracks().forEach((track) => {
        track.addEventListener('ended', onOutOfBandStop)
      })
      stream = mediaStream
      recorderRef.current = recorder
      startedAt = Date.now()
      // Level analyser is best-effort; recording must not depend on it.
      try {
        const Ctx = window.AudioContext ?? window.webkitAudioContext
        if (Ctx) {
          const ctx = new Ctx()
          const node = ctx.createAnalyser()
          node.fftSize = 512
          ctx.createMediaStreamSource(mediaStream).connect(node)
          audioCtx = ctx
          analyser = node
          levelBuf = new Uint8Array(node.fftSize)
        }
      } catch {
        /* meter unavailable; recording continues */
      }
      recorder.start()
      callbacks.onErrorKind(undefined)
      callbacks.onStateChange('recording')
      callbacks.onElapsed(0)
      timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000)
        callbacks.onElapsed(elapsed)
        if (elapsed >= maxSec) {
          void finalize().then((result) => {
            if (result && onAutoStop) onAutoStop(result)
          })
        }
      }, 250)
    } catch (e) {
      cleanup()
      callbacks.onErrorKind(classifyError(e))
      callbacks.onStateChange('error')
    }
  }

  function resetError() {
    callbacks.onErrorKind(undefined)
    callbacks.onStateChange('idle')
  }

  return { start, stop: finalize, cancel, resetError, getLevel, destroy: cleanup }
}
