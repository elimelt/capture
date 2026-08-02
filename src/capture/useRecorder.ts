/**
 * getUserMedia + MediaRecorder wrapper. Negotiates the container at runtime
 * (iOS Safari records audio/mp4, not webm — never hardcode). On mic failure
 * the state becomes 'error' with a kind so the screen can offer the right
 * recovery (retry vs. iOS Settings hint) alongside text entry (SPEC §4.1).
 *
 * All the imperative getUserMedia/MediaRecorder/timer wiring — including
 * out-of-band stop handling for mic-revoked/audio-session-stolen/recorder-
 * error mid-recording (#49) — lives in the framework-free `recorderEngine.ts`
 * so it's directly unit-testable; this hook only bridges the engine's
 * callbacks to React state.
 */
import { useEffect, useRef, useState } from 'react'
import { createRecorderEngine } from './recorderEngine'
import type { RecorderErrorKind, RecorderState, RecordingResult } from './recorderEngine'

export type { RecordingResult, RecorderState, RecorderErrorKind }

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

export function useRecorder(): Recorder {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [errorKind, setErrorKind] = useState<RecorderErrorKind>()

  const engineRef = useRef<ReturnType<typeof createRecorderEngine>>(undefined)
  if (!engineRef.current) {
    engineRef.current = createRecorderEngine({
      onStateChange: setState,
      onElapsed: setElapsedSec,
      onErrorKind: setErrorKind,
    })
  }
  const engine = engineRef.current

  useEffect(() => () => engine.destroy(), [engine])

  return {
    state,
    elapsedSec,
    start: engine.start,
    stop: engine.stop,
    cancel: engine.cancel,
    resetError: engine.resetError,
    getLevel: engine.getLevel,
    errorKind,
  }
}
