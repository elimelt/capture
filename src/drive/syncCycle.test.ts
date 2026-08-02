import { describe, expect, it, vi } from 'vitest'
import type { DrainResult } from './queue'
import type { PullResult } from './pull'
import { OUTCOME_RANK, runSyncCycle, type SyncCycleDeps } from './syncCycle'

const STREAMS = ['settings', 'assistant-chats', 'timelog']

/** Fake deps: fixed pull/drain results per stream, recording call order. */
function fakeDeps(overrides: {
  pull?: (stream: string) => PullResult
  drain?: (stream: string) => DrainResult
} = {}): SyncCycleDeps & { setLastSyncAtCalls: [string, string][] } {
  const pullFn = overrides.pull ?? ((): PullResult => ({ outcome: 'idle', pulled: 0 }))
  const drainFn = overrides.drain ?? ((): DrainResult => ({ outcome: 'idle', uploaded: 0 }))
  const setLastSyncAtCalls: [string, string][] = []
  return {
    pull: async (_token, stream, onProgress) => {
      onProgress({ kind: 'pull-progress', stream, delta: 0 })
      return pullFn(stream)
    },
    drain: async (_token, stream, onProgress) => {
      onProgress({ kind: 'upload-start', stream, itemsTotal: 0 })
      return drainFn(stream)
    },
    setLastSyncAt: async (stream, at) => {
      setLastSyncAtCalls.push([stream, at])
    },
    now: () => '2026-08-02T09:00:00-04:00',
    setLastSyncAtCalls,
  }
}

describe('runSyncCycle', () => {
  it('pulls then drains every stream, in order', async () => {
    const deps = fakeDeps()
    const pullOrder: string[] = []
    const drainOrder: string[] = []
    deps.pull = async (_t, stream, onProgress) => {
      pullOrder.push(stream)
      onProgress({ kind: 'pull-progress', stream, delta: 0 })
      return { outcome: 'idle', pulled: 0 }
    }
    deps.drain = async (_t, stream, onProgress) => {
      drainOrder.push(stream)
      onProgress({ kind: 'upload-start', stream, itemsTotal: 0 })
      return { outcome: 'idle', uploaded: 0 }
    }
    const { result, reconnect, quotaExceeded } = await runSyncCycle('tok', STREAMS, deps)
    expect(pullOrder).toEqual(STREAMS)
    expect(drainOrder).toEqual(STREAMS)
    expect(result.outcome).toBe('idle')
    expect(reconnect).toBe(false)
    expect(quotaExceeded).toBe(false)
  })

  it('sums uploaded/pulled across streams and reports per-stream results', async () => {
    const deps = fakeDeps({
      pull: (stream) => (stream === 'timelog' ? { outcome: 'pulled', pulled: 2 } : { outcome: 'idle', pulled: 0 }),
      drain: (stream) =>
        stream === 'settings' ? { outcome: 'drained', uploaded: 1 } : { outcome: 'drained', uploaded: 3 },
    })
    const { result } = await runSyncCycle('tok', STREAMS, deps)
    expect(result.outcome).toBe('drained')
    expect(result.uploaded).toBe(7)
    expect(result.pulled).toBe(2)
    expect(result.perStream).toEqual([
      { stream: 'settings', outcome: 'drained', uploaded: 1, pulled: 0 },
      { stream: 'assistant-chats', outcome: 'drained', uploaded: 3, pulled: 0 },
      { stream: 'timelog', outcome: 'drained', uploaded: 3, pulled: 2 },
    ])
  })

  it('a pull reconnect aborts the remaining streams and marks them reconnect', async () => {
    const deps = fakeDeps({ pull: () => ({ outcome: 'reconnect', pulled: 0 }) })
    const drainSpy = vi.fn(deps.drain)
    deps.drain = drainSpy
    const { result, reconnect, quotaExceeded } = await runSyncCycle('tok', STREAMS, deps)
    expect(drainSpy).not.toHaveBeenCalled()
    expect(reconnect).toBe(true)
    expect(quotaExceeded).toBe(false)
    expect(result.perStream).toEqual(
      STREAMS.map((stream) => ({ stream, outcome: 'reconnect', uploaded: 0, pulled: 0 })),
    )
  })

  it('a drain reconnect mid-loop aborts the streams after it', async () => {
    const deps = fakeDeps({
      drain: (stream) =>
        stream === 'assistant-chats' ? { outcome: 'reconnect', uploaded: 0 } : { outcome: 'drained', uploaded: 1 },
    })
    const { result, reconnect } = await runSyncCycle('tok', STREAMS, deps)
    expect(reconnect).toBe(true)
    expect(result.perStream).toEqual([
      { stream: 'settings', outcome: 'drained', uploaded: 1, pulled: 0 },
      { stream: 'assistant-chats', outcome: 'reconnect', uploaded: 0, pulled: 0 },
      { stream: 'timelog', outcome: 'reconnect', uploaded: 0, pulled: 0 },
    ])
  })

  it('a quota outcome mid-loop aborts the streams after it without reporting reconnect', async () => {
    const deps = fakeDeps({
      drain: (stream) =>
        stream === 'assistant-chats'
          ? { outcome: 'quota', uploaded: 0, error: 'Drive 403: storageQuotaExceeded' }
          : { outcome: 'drained', uploaded: 1 },
    })
    const { result, reconnect, quotaExceeded } = await runSyncCycle('tok', STREAMS, deps)
    expect(reconnect).toBe(false)
    expect(quotaExceeded).toBe(true)
    expect(result.outcome).toBe('quota')
    expect(result.perStream).toEqual([
      { stream: 'settings', outcome: 'drained', uploaded: 1, pulled: 0 },
      {
        stream: 'assistant-chats',
        outcome: 'quota',
        uploaded: 0,
        pulled: 0,
        error: 'Drive 403: storageQuotaExceeded',
      },
      { stream: 'timelog', outcome: 'quota', uploaded: 0, pulled: 0 },
    ])
  })

  it('retry-later on one stream does not block the others', async () => {
    const deps = fakeDeps({
      pull: (stream) => (stream === 'settings' ? { outcome: 'retry-later', pulled: 0 } : { outcome: 'idle', pulled: 0 }),
    })
    const { result } = await runSyncCycle('tok', STREAMS, deps)
    expect(result.outcome).toBe('retry-later')
    expect(result.perStream.map((r) => r.outcome)).toEqual(['retry-later', 'idle', 'idle'])
  })

  it('an error on one stream does not block the others and surfaces as the aggregate error', async () => {
    const deps = fakeDeps({
      drain: (stream) =>
        stream === 'settings' ? { outcome: 'error', uploaded: 0, error: 'Drive full' } : { outcome: 'drained', uploaded: 2 },
    })
    const { result } = await runSyncCycle('tok', STREAMS, deps)
    expect(result.outcome).toBe('error')
    expect(result.error).toBe('Drive full')
    expect(result.uploaded).toBe(4)
  })

  it('an error can outrank a later reconnect in the aggregate outcome, but reconnect is still reported', async () => {
    // settings errors (rank 5); assistant-chats then hits a pull reconnect
    // (rank 4, and it aborts timelog too). The worst-of aggregate outcome is
    // 'error' (5 > 4), but the cycle still asks the caller to flip the
    // reconnect pill — that must come from the abort itself, not from
    // deriving it off the aggregate outcome.
    const deps = fakeDeps({
      pull: (stream) => (stream === 'assistant-chats' ? { outcome: 'reconnect', pulled: 0 } : { outcome: 'idle', pulled: 0 }),
      drain: (stream) => (stream === 'settings' ? { outcome: 'error', uploaded: 0, error: 'boom' } : { outcome: 'drained', uploaded: 1 }),
    })
    const { result, reconnect } = await runSyncCycle('tok', STREAMS, deps)
    expect(reconnect).toBe(true)
    expect(result.outcome).toBe('error')
  })

  it('stamps lastSyncAt only for streams whose own cycle was clean', async () => {
    const deps = fakeDeps({
      drain: (stream) => (stream === 'timelog' ? { outcome: 'error', uploaded: 0, error: 'boom' } : { outcome: 'drained', uploaded: 1 }),
    })
    await runSyncCycle('tok', STREAMS, deps)
    expect(deps.setLastSyncAtCalls.map(([stream]) => stream)).toEqual(['settings', 'assistant-chats'])
  })

  it('stamps every stream after a fully clean cycle (idle streams included)', async () => {
    const deps = fakeDeps()
    const { result } = await runSyncCycle('tok', STREAMS, deps)
    expect(result.outcome).toBe('idle')
    expect(deps.setLastSyncAtCalls.map(([stream]) => stream)).toEqual(STREAMS)
  })

  it('does not stamp any lastSyncAt when the first pull asks to reconnect', async () => {
    const deps = fakeDeps({ pull: () => ({ outcome: 'reconnect', pulled: 0 }) })
    await runSyncCycle('tok', STREAMS, deps)
    expect(deps.setLastSyncAtCalls).toEqual([])
  })

  it('emits progress in stream-start/stream-done order around each pull+drain, even for skipped streams', async () => {
    const events: string[] = []
    const deps: SyncCycleDeps = {
      pull: async () => ({ outcome: 'reconnect', pulled: 0 }),
      drain: async () => ({ outcome: 'idle', uploaded: 0 }),
      setLastSyncAt: async () => {},
      now: () => '2026-08-02T09:00:00-04:00',
      onProgress: (e) => events.push(e.kind),
    }
    await runSyncCycle('tok', STREAMS, deps)
    // First stream: stream-start, stream-done (from the abort branch's own
    // emission, since drain never runs); remaining two: same skip pattern.
    expect(events.filter((k) => k === 'stream-start')).toHaveLength(3)
    expect(events.filter((k) => k === 'stream-done')).toHaveLength(3)
  })

  it('OUTCOME_RANK orders idle < drained < retry-later < quota < reconnect < error', () => {
    expect(OUTCOME_RANK.idle).toBeLessThan(OUTCOME_RANK.drained)
    expect(OUTCOME_RANK.drained).toBeLessThan(OUTCOME_RANK['retry-later'])
    expect(OUTCOME_RANK['retry-later']).toBeLessThan(OUTCOME_RANK.quota)
    expect(OUTCOME_RANK.quota).toBeLessThan(OUTCOME_RANK.reconnect)
    expect(OUTCOME_RANK.reconnect).toBeLessThan(OUTCOME_RANK.error)
  })
})
