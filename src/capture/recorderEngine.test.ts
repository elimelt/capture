// #49 regression coverage: the recorder must never get stuck showing
// 'recording' once the underlying MediaRecorder/track stops itself
// out-of-band. Exercises `createRecorderEngine` directly (no React, no DOM)
// by stubbing `navigator.mediaDevices` and `MediaRecorder` the same way
// `notify/badge.test.ts`/`notify/local.test.ts` stub browser globals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildResult, createRecorderEngine, type RecorderErrorKind, type RecorderState } from './recorderEngine'

class FakeTrack extends EventTarget {
  stopped = false
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  private tracks: FakeTrack[]
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported() {
    return true
  }
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  stream: FakeStream

  constructor(stream: FakeStream, options?: { mimeType?: string }) {
    this.stream = stream
    this.mimeType = options?.mimeType ?? 'audio/webm'
    FakeMediaRecorder.instances.push(this)
  }

  start() {
    this.state = 'recording'
  }

  /** Explicit stop, as the engine's finalize() calls it. */
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.onstop?.()
  }

  /** Delivers a chunk, as a real recorder would on a timeslice/stop. */
  deliver(size: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)], { type: this.mimeType }) })
  }

  /** The browser stopping the recorder itself (e.g. a resource error). */
  emitError() {
    this.state = 'inactive'
    this.onerror?.()
  }
}

function stubBrowser(stream = new FakeStream()) {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
  })
  return stream
}

function callbacks() {
  const states: RecorderState[] = []
  const errorKinds: (RecorderErrorKind | undefined)[] = []
  return {
    onStateChange: vi.fn((s: RecorderState) => states.push(s)),
    onElapsed: vi.fn(),
    onErrorKind: vi.fn((k: RecorderErrorKind | undefined) => errorKinds.push(k)),
    states,
    errorKinds,
  }
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildResult', () => {
  it('assembles chunks into a blob with duration and mime fallbacks', () => {
    const result = buildResult([new Blob(['abc'], { type: 'audio/webm' })], 'audio/webm', 0, 2500)
    expect(result).toEqual({ blob: expect.any(Blob), mimeType: 'audio/webm', durationSec: 3 })
  })

  it('falls back to the first chunk type, then audio/webm, when the recorder omits one', () => {
    expect(buildResult([new Blob(['x'], { type: 'audio/mp4' })], '', 0, 1000)?.mimeType).toBe(
      'audio/mp4',
    )
    expect(buildResult([new Blob(['x'])], '', 0, 1000)?.mimeType).toBe('audio/webm')
  })

  it('returns null for an empty recording (no bytes captured)', () => {
    expect(buildResult([], 'audio/webm', 0, 1000)).toBeNull()
  })

  it('clamps duration to a minimum of 1 second', () => {
    expect(buildResult([new Blob(['x'])], 'audio/webm', 1000, 1000)?.durationSec).toBe(1)
  })
})

describe('createRecorderEngine — out-of-band stop (#49)', () => {
  it('salvages captured audio and returns to idle when a track ends mid-recording', async () => {
    const stream = stubBrowser()
    const cb = callbacks()
    const engine = createRecorderEngine(cb)
    const onAutoStop = vi.fn()

    await engine.start(60, onAutoStop)
    const recorder = FakeMediaRecorder.instances[0]
    recorder.deliver(10) // some audio was captured before the interruption

    // The mic is revoked / OS takes the audio session: the track ends on
    // its own, out from under the app.
    stream.getTracks()[0].dispatchEvent(new Event('ended'))

    expect(cb.states.at(-1)).toBe('idle') // never stuck on 'recording'
    expect(onAutoStop).toHaveBeenCalledTimes(1)
    expect(onAutoStop.mock.calls[0][0].blob.size).toBe(10)
    expect(engine.getLevel()).toBe(0) // cleaned up, not left dangling
  })

  it('surfaces a retryable error when the recorder errors with no audio captured', async () => {
    const stream = stubBrowser()
    const cb = callbacks()
    const engine = createRecorderEngine(cb)
    const onAutoStop = vi.fn()

    await engine.start(60, onAutoStop)
    const recorder = FakeMediaRecorder.instances[0]
    recorder.emitError() // no deliver() call — nothing was captured

    expect(cb.states.at(-1)).toBe('error')
    expect(cb.errorKinds.at(-1)).toBe('failed')
    expect(onAutoStop).not.toHaveBeenCalled()
    void stream
  })

  it('clears the elapsed timer so it can never wedge into an infinite finalize loop', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    stubBrowser()
    const engine = createRecorderEngine(callbacks())
    await engine.start(60)
    const recorder = FakeMediaRecorder.instances[0]
    recorder.emitError()
    expect(clearIntervalSpy).toHaveBeenCalled()
  })

  it('an explicit stop() after an out-of-band stop is a no-op, never a double resolve', async () => {
    stubBrowser()
    const cb = callbacks()
    const engine = createRecorderEngine(cb)
    await engine.start(60)
    const recorder = FakeMediaRecorder.instances[0]
    recorder.deliver(5)
    recorder.emitError()
    cb.onStateChange.mockClear()

    const result = await engine.stop()
    expect(result).toBeNull()
    expect(cb.onStateChange).not.toHaveBeenCalled()
  })

  it('finalize() settles instead of silently no-oping when the recorder is already inactive', async () => {
    stubBrowser()
    const cb = callbacks()
    const engine = createRecorderEngine(cb)
    await engine.start(60)
    const recorder = FakeMediaRecorder.instances[0]
    recorder.deliver(7)
    // Simulate the recorder having gone inactive without either finalize()
    // or the out-of-band handlers having run yet (a lost identity race).
    recorder.state = 'inactive'

    const result = await engine.stop()
    expect(result?.blob.size).toBe(7)
    expect(cb.states.at(-1)).toBe('idle')
    expect(engine.getLevel()).toBe(0)
  })

  it('a normal explicit stop still resolves the captured clip via onstop', async () => {
    stubBrowser()
    const cb = callbacks()
    const engine = createRecorderEngine(cb)
    await engine.start(60)
    const recorder = FakeMediaRecorder.instances[0]
    recorder.deliver(20)

    const result = await engine.stop()
    expect(result?.blob.size).toBe(20)
    expect(cb.states.at(-1)).toBe('idle')
  })
})
