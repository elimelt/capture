import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allSyncStreams } from '../streams/registry'
import { useFreshIndexedDb } from '../testing/freshDb'

useFreshIndexedDb()

// Mock the drive layer so these tests exercise only the store's wiring:
// gesture → connect → per-stream pull+drain loop, and the no-token /
// reconnect / failure-isolation branches.
const connect = vi.fn()
const disconnect = vi.fn()
const drainStream = vi.fn()
const pullStream = vi.fn()
const getValidAccessToken = vi.fn<() => Promise<string | undefined>>()
const connectionState = vi.fn<() => Promise<'connected' | 'expired' | 'disconnected'>>()
const getStoredToken = vi.fn<() => Promise<{ accessToken: string } | undefined>>()

vi.mock('../drive/auth', () => ({ connect, disconnect }))
vi.mock('../drive/queue', () => ({ drainStream }))
vi.mock('../drive/pull', () => ({ pullStream }))
vi.mock('../drive/token', () => ({
  getValidAccessToken,
  connectionState,
  getStoredToken,
}))

const STREAMS = allSyncStreams() // ['settings', 'assistant-chats', 'timelog']

/**
 * Minimal Web Locks fake covering exactly what `drainSync` uses:
 * `request(name, { ifAvailable: true }, cb)` — cb(null) when held, else the
 * lock is held for the callback's duration. Stubbed onto `navigator` so the
 * suite is deterministic across Node versions (Node < 24 ships `navigator`
 * without `locks`, which would silently exercise the flag-only fallback and
 * deadlock the TOCTOU test below).
 */
function fakeWebLocks() {
  const held = new Set<string>()
  return {
    request: async (
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: { name: string; mode: 'exclusive' } | null) => unknown,
    ) => {
      if (held.has(name)) {
        if (!options.ifAvailable) throw new Error('fakeWebLocks: only ifAvailable is supported')
        return callback(null)
      }
      held.add(name)
      try {
        return await callback({ name, mode: 'exclusive' })
      } finally {
        held.delete(name)
      }
    },
  }
}

async function freshStore() {
  vi.resetModules()
  const { useAppStore } = await import('./appStore')
  return useAppStore
}

beforeEach(() => {
  // Per-stream lastSyncAt stamps must not leak between tests now that the
  // loop always covers the same fixed stream set — `useFreshIndexedDb()`
  // above gives each test its own empty IndexedDB.
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { locks: fakeWebLocks() })
  connectionState.mockResolvedValue('disconnected')
  getValidAccessToken.mockResolvedValue(undefined)
  getStoredToken.mockResolvedValue(undefined)
  drainStream.mockResolvedValue({ outcome: 'idle', uploaded: 0 })
  pullStream.mockResolvedValue({ outcome: 'idle', pulled: 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function lastSyncAtOf(stream: string): Promise<string | undefined> {
  const { getLastSyncAt } = await import('./events')
  return getLastSyncAt(stream)
}

async function persistedLastSyncResult() {
  const { getLastSyncResult } = await import('./events')
  return getLastSyncResult()
}

describe('drainSync (multi-stream loop)', () => {
  it('no-ops without a token and refreshes connection state', async () => {
    connectionState.mockResolvedValue('expired')
    const store = await freshStore()
    const result = await store.getState().drainSync()
    expect(pullStream).not.toHaveBeenCalled()
    expect(drainStream).not.toHaveBeenCalled()
    expect(store.getState().driveConnection).toBe('expired')
    expect(result).toEqual({ outcome: 'reconnect', uploaded: 0, pulled: 0, perStream: [] })
  })

  it('returns busy (not retry-later) when a drain is already in flight in this tab', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    store.setState({ syncing: true })
    const result = await store.getState().drainSync()
    expect(pullStream).not.toHaveBeenCalled()
    expect(drainStream).not.toHaveBeenCalled()
    // Issue #64: this is the re-entrancy guard, distinct from a real Drive
    // outage — Settings must not tell the user "Drive is busy" for a
    // same-tab double-tap.
    expect(result).toEqual({ outcome: 'busy', uploaded: 0, pulled: 0, perStream: [] })
  })

  it('returns busy when a concurrent call already holds the cross-tab sync lock', async () => {
    // Issue #50: the bare `syncing` flag has a TOCTOU gap — there's an
    // `await` (getValidAccessToken) between checking it and setting it, so
    // two calls can both pass the flag check before either flips it. The
    // `navigator.locks` lock has no such gap: it's held from the moment the
    // first call is granted it, before its token lookup even starts.
    let releaseToken: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      releaseToken = resolve
    })
    getValidAccessToken.mockImplementation(async () => {
      await blocked
      return 'tok'
    })
    const store = await freshStore()
    const first = store.getState().drainSync()
    // Give the lock callback a turn to run and register as the holder, while
    // the token lookup above is still pending.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().syncing).toBe(false) // the TOCTOU window: not set yet

    const second = await store.getState().drainSync()
    expect(second).toEqual({ outcome: 'busy', uploaded: 0, pulled: 0, perStream: [] })

    releaseToken()
    const firstResult = await first
    expect(firstResult.outcome).not.toBe('busy')
  })

  it('pulls then drains every registered stream, in registry order', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    await store.getState().drainSync()

    // Third arg is the store's progress-emitting callback (src/store/syncProgress).
    expect(pullStream.mock.calls).toEqual(STREAMS.map((s) => ['tok', s, expect.any(Function)]))
    expect(drainStream.mock.calls).toEqual(STREAMS.map((s) => ['tok', s, expect.any(Function)]))
    // Per stream, its pull always precedes its push.
    STREAMS.forEach((_, i) => {
      expect(pullStream.mock.invocationCallOrder[i]).toBeLessThan(
        drainStream.mock.invocationCallOrder[i],
      )
    })
    expect(store.getState().syncing).toBe(false)
  })

  it('sums uploaded/pulled across streams and reports per-stream results', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    pullStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'timelog' ? { outcome: 'pulled', pulled: 2 } : { outcome: 'idle', pulled: 0 },
    )
    drainStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'settings'
        ? { outcome: 'drained', uploaded: 1 }
        : { outcome: 'drained', uploaded: 3 },
    )
    const store = await freshStore()
    const result = await store.getState().drainSync()
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
    getValidAccessToken.mockResolvedValue('tok')
    pullStream.mockResolvedValue({ outcome: 'reconnect', pulled: 0 })
    const store = await freshStore()
    const result = await store.getState().drainSync()

    // The first stream's pull died with an auth error: nothing else is tried.
    expect(pullStream).toHaveBeenCalledTimes(1)
    expect(pullStream).toHaveBeenCalledWith('tok', STREAMS[0], expect.any(Function))
    expect(drainStream).not.toHaveBeenCalled()
    expect(store.getState().driveConnection).toBe('expired')
    expect(result.outcome).toBe('reconnect')
    expect(result.perStream).toEqual(
      STREAMS.map((stream) => ({ stream, outcome: 'reconnect', uploaded: 0, pulled: 0 })),
    )
  })

  it('a drain reconnect mid-loop aborts the streams after it', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    drainStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'assistant-chats'
        ? { outcome: 'reconnect', uploaded: 0 }
        : { outcome: 'drained', uploaded: 1 },
    )
    const store = await freshStore()
    const result = await store.getState().drainSync()

    // settings + assistant-chats ran; timelog never got pulled or pushed.
    expect(pullStream).toHaveBeenCalledTimes(2)
    expect(drainStream).toHaveBeenCalledTimes(2)
    expect(pullStream).not.toHaveBeenCalledWith('tok', 'timelog')
    expect(store.getState().driveConnection).toBe('expired')
    expect(result.outcome).toBe('reconnect')
    expect(result.perStream).toEqual([
      { stream: 'settings', outcome: 'drained', uploaded: 1, pulled: 0 },
      { stream: 'assistant-chats', outcome: 'reconnect', uploaded: 0, pulled: 0 },
      { stream: 'timelog', outcome: 'reconnect', uploaded: 0, pulled: 0 },
    ])
  })

  it('a quota outcome mid-loop aborts the streams after it without touching driveConnection', async () => {
    // Issue #88: a full Drive must never present as an auth problem — the
    // token is fine, so the reconnect pill (driveConnection) must stay put.
    getValidAccessToken.mockResolvedValue('tok')
    connectionState.mockResolvedValue('connected')
    drainStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'assistant-chats'
        ? { outcome: 'quota', uploaded: 0, error: 'Drive 403: storageQuotaExceeded' }
        : { outcome: 'drained', uploaded: 1 },
    )
    const store = await freshStore()
    const result = await store.getState().drainSync()

    expect(pullStream).toHaveBeenCalledTimes(2)
    expect(drainStream).toHaveBeenCalledTimes(2)
    expect(pullStream).not.toHaveBeenCalledWith('tok', 'timelog', expect.any(Function))
    expect(store.getState().driveConnection).toBe('disconnected') // untouched
    expect(store.getState().driveQuotaExceeded).toBe(true)
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

  it('clears a stale driveQuotaExceeded once a later cycle runs clean', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    drainStream.mockResolvedValueOnce({ outcome: 'quota', uploaded: 0, error: 'full' })
    const store = await freshStore()
    await store.getState().drainSync()
    expect(store.getState().driveQuotaExceeded).toBe(true)

    drainStream.mockResolvedValue({ outcome: 'drained', uploaded: 1 })
    await store.getState().drainSync()
    expect(store.getState().driveQuotaExceeded).toBe(false)
  })

  it('retry-later on one stream does not block the others', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    pullStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'settings' ? { outcome: 'retry-later', pulled: 0 } : { outcome: 'idle', pulled: 0 },
    )
    const store = await freshStore()
    const result = await store.getState().drainSync()

    // Every stream still got its full pull+push cycle.
    expect(pullStream).toHaveBeenCalledTimes(STREAMS.length)
    expect(drainStream).toHaveBeenCalledTimes(STREAMS.length)
    expect(result.outcome).toBe('retry-later')
    expect(result.perStream[0].outcome).toBe('retry-later')
    expect(result.perStream[1].outcome).toBe('idle')
    expect(result.perStream[2].outcome).toBe('idle')
  })

  it('an error on one stream does not block the others and surfaces lastError', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    drainStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'settings'
        ? { outcome: 'error', uploaded: 0, error: 'Drive full' }
        : { outcome: 'drained', uploaded: 2 },
    )
    const store = await freshStore()
    const result = await store.getState().drainSync()

    expect(pullStream).toHaveBeenCalledTimes(STREAMS.length)
    expect(drainStream).toHaveBeenCalledTimes(STREAMS.length)
    expect(store.getState().lastError).toMatch(/Drive full/)
    expect(result.outcome).toBe('error')
    expect(result.error).toBe('Drive full')
    expect(result.uploaded).toBe(4)
  })

  it('reports a pull error even when every push succeeds', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    pullStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'timelog'
        ? { outcome: 'error', pulled: 0, error: 'record parse failed' }
        : { outcome: 'idle', pulled: 0 },
    )
    drainStream.mockResolvedValue({ outcome: 'drained', uploaded: 1 })
    const store = await freshStore()
    const result = await store.getState().drainSync()
    expect(store.getState().lastError).toMatch(/record parse failed/)
    expect(result.outcome).toBe('error')
    expect(result.error).toBe('record parse failed')
    expect(result.uploaded).toBe(3)
  })

  it('persists a pull error in lastSyncResult (issue #67): no sync row records it, but the cycle result survives a reload', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    pullStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'timelog'
        ? { outcome: 'error', pulled: 0, error: 'record parse failed' }
        : { outcome: 'idle', pulled: 0 },
    )
    const store = await freshStore()
    await store.getState().drainSync()

    // In-memory state reflects the cycle immediately.
    expect(store.getState().lastSyncResult?.outcome).toBe('error')
    expect(store.getState().lastSyncResult?.perStream).toContainEqual(
      expect.objectContaining({ stream: 'timelog', error: 'record parse failed' }),
    )

    // Simulate a relaunch: fresh module graph, re-read from IndexedDB only.
    const persisted = await persistedLastSyncResult()
    expect(persisted?.outcome).toBe('error')
    expect(persisted?.perStream).toContainEqual(
      expect.objectContaining({ stream: 'timelog', outcome: 'error', error: 'record parse failed' }),
    )
    expect(persisted?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // init() picks the persisted result back up on the next boot.
    const reopened = await freshStore()
    await reopened.getState().init()
    expect(reopened.getState().lastSyncResult?.outcome).toBe('error')
  })

  it('stamps lastSyncAt only for streams whose own cycle was clean', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    drainStream.mockImplementation(async (_t: string, stream: string) =>
      stream === 'timelog'
        ? { outcome: 'error', uploaded: 0, error: 'boom' }
        : { outcome: 'drained', uploaded: 1 },
    )
    const store = await freshStore()
    await store.getState().drainSync()

    expect(await lastSyncAtOf('settings')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await lastSyncAtOf('assistant-chats')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await lastSyncAtOf('timelog')).toBeUndefined()
  })

  it('stamps every stream after a fully clean cycle (idle streams included)', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    const result = await store.getState().drainSync()
    expect(result.outcome).toBe('idle')
    for (const stream of STREAMS) {
      expect(await lastSyncAtOf(stream)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('does not stamp any lastSyncAt when the first pull asks to reconnect', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    pullStream.mockResolvedValue({ outcome: 'reconnect', pulled: 0 })
    const store = await freshStore()
    await store.getState().drainSync()
    for (const stream of STREAMS) {
      expect(await lastSyncAtOf(stream)).toBeUndefined()
    }
  })
})

describe('syncProgress (live detail during drainSync)', () => {
  it('is null before and after a cycle, including the no-token/re-entrant early returns', async () => {
    const store = await freshStore()
    expect(store.getState().syncProgress).toBeNull()
    await store.getState().drainSync() // no token -> reconnect, early return
    expect(store.getState().syncProgress).toBeNull()

    getValidAccessToken.mockResolvedValue('tok')
    await store.getState().drainSync()
    expect(store.getState().syncProgress).toBeNull()
  })

  it('is live while a cycle is in flight and reflects emitted events', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    let releasePull: (() => void) | undefined
    pullStream.mockImplementation(
      async (
        _t: string,
        stream: string,
        onProgress: (e: { kind: string; stream: string; delta: number }) => void,
      ) => {
        if (stream === STREAMS[0]) {
          onProgress({ kind: 'pull-progress', stream, delta: 4 })
          await new Promise<void>((resolve) => (releasePull = resolve))
        }
        return { outcome: 'idle', pulled: stream === STREAMS[0] ? 4 : 0 }
      },
    )
    const store = await freshStore()
    const cyclePromise = store.getState().drainSync()

    // Yield a couple of microtask turns so the loop reaches the first pull.
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().syncing).toBe(true)
    const mid = store.getState().syncProgress
    expect(mid).toMatchObject({
      phase: 'pulling',
      stream: STREAMS[0],
      streamsTotal: STREAMS.length,
      pulled: 4,
    })

    releasePull?.()
    await cyclePromise
    expect(store.getState().syncing).toBe(false)
    expect(store.getState().syncProgress).toBeNull()
  })

  it('reaches uploading with a determinate total once drainStream reports upload-start', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    let releaseDrain: (() => void) | undefined
    drainStream.mockImplementation(
      async (
        _t: string,
        stream: string,
        onProgress: (e: { kind: string; stream: string; itemsTotal?: number }) => void,
      ) => {
        if (stream === STREAMS[0]) {
          onProgress({ kind: 'upload-start', stream, itemsTotal: 7 })
          await new Promise<void>((resolve) => (releaseDrain = resolve))
        }
        return { outcome: 'drained', uploaded: stream === STREAMS[0] ? 7 : 0 }
      },
    )
    const store = await freshStore()
    const cyclePromise = store.getState().drainSync()

    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().syncProgress).toMatchObject({
      phase: 'uploading',
      stream: STREAMS[0],
      itemsTotal: 7,
      itemsDone: 0,
    })

    releaseDrain?.()
    await cyclePromise
    expect(store.getState().syncProgress).toBeNull()
  })
})

describe('globalSyncSummary', () => {
  it('is null-lastSyncAt and empty before anything ever synced', async () => {
    const store = await freshStore()
    await store.getState().refresh()
    expect(store.getState().globalSyncSummary).toEqual({
      pending: 0,
      errors: 0,
      lastSyncAt: null,
    })
  })

  it('sums pending and errors across streams', async () => {
    const store = await freshStore()
    const { appendCapture, getSyncStatuses, putSyncStatus } = await import('./events')
    await appendCapture({ stream: 'timelog', capturedAt: '2026-08-02T09:00:00-04:00', attachments: [] })
    const settingsEvent = await appendCapture({
      stream: 'settings',
      capturedAt: '2026-08-02T09:01:00-04:00',
      attachments: [],
    })
    const row = (await getSyncStatuses('settings')).get(settingsEvent.id)
    await putSyncStatus({ ...row!, status: 'error', error: 'boom' })

    await store.getState().refresh()
    const summary = store.getState().globalSyncSummary
    expect(summary.pending).toBe(2)
    expect(summary.errors).toBe(1)
    expect(summary.lastError).toBe('boom')
    expect(summary.lastSyncAt).toBeNull()
  })

  it('lastSyncAt is the oldest per-stream stamp once every stream has synced', async () => {
    const store = await freshStore()
    const { setLastSyncAt } = await import('./events')
    await setLastSyncAt('settings', '2026-08-02T10:00:00-04:00')
    await setLastSyncAt('assistant-chats', '2026-08-01T09:00:00-04:00')
    await setLastSyncAt('timelog', '2026-08-02T11:00:00-04:00')
    await store.getState().refresh()
    expect(store.getState().globalSyncSummary.lastSyncAt).toBe('2026-08-01T09:00:00-04:00')
  })

  it('lastSyncAt is null while any stream has never synced', async () => {
    const store = await freshStore()
    const { setLastSyncAt } = await import('./events')
    await setLastSyncAt('timelog', '2026-08-02T11:00:00-04:00')
    await setLastSyncAt('settings', '2026-08-02T10:00:00-04:00')
    // assistant-chats never synced
    await store.getState().refresh()
    expect(store.getState().globalSyncSummary.lastSyncAt).toBeNull()
  })

  it('is refreshed by drainSync', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    await store.getState().drainSync()
    expect(store.getState().globalSyncSummary.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(store.getState().globalSyncSummary.pending).toBe(0)
  })
})

describe('connectDrive', () => {
  it('connects and marks connected without contacting Drive for a sync', async () => {
    connect.mockResolvedValue({ accessToken: 'tok', expiresAt: Date.now() + 3600_000 })
    // After connect the token is valid; connectionState reflects that.
    connectionState.mockResolvedValue('connected')
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    await store.getState().connectDrive()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(store.getState().driveConnection).toBe('connected')
    // Sync is manual-only: connecting must not pull or drain by itself.
    expect(pullStream).not.toHaveBeenCalled()
    expect(drainStream).not.toHaveBeenCalled()
  })
})

describe('disconnectDrive', () => {
  it('revokes the stored token and marks disconnected', async () => {
    getStoredToken.mockResolvedValue({ accessToken: 'tok' })
    const store = await freshStore()
    await store.getState().disconnectDrive()
    expect(disconnect).toHaveBeenCalledWith('tok')
    expect(store.getState().driveConnection).toBe('disconnected')
  })
})
