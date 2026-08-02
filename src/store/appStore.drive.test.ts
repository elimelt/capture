import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allSyncStreams } from '../streams/registry'

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

async function freshStore() {
  vi.resetModules()
  const { useAppStore } = await import('./appStore')
  return useAppStore
}

beforeEach(() => {
  // Fresh IndexedDB per test: per-stream lastSyncAt stamps must not leak
  // between tests now that the loop always covers the same fixed stream set.
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.clearAllMocks()
  connectionState.mockResolvedValue('disconnected')
  getValidAccessToken.mockResolvedValue(undefined)
  getStoredToken.mockResolvedValue(undefined)
  drainStream.mockResolvedValue({ outcome: 'idle', uploaded: 0 })
  pullStream.mockResolvedValue({ outcome: 'idle', pulled: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function lastSyncAtOf(stream: string): Promise<string | undefined> {
  const { getLastSyncAt } = await import('./events')
  return getLastSyncAt(stream)
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

  it('returns retry-later when a drain is already in flight', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    store.setState({ syncing: true })
    const result = await store.getState().drainSync()
    expect(pullStream).not.toHaveBeenCalled()
    expect(drainStream).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'retry-later', uploaded: 0, pulled: 0, perStream: [] })
  })

  it('pulls then drains every registered stream, in registry order', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    await store.getState().drainSync()

    expect(pullStream.mock.calls).toEqual(STREAMS.map((s) => ['tok', s]))
    expect(drainStream.mock.calls).toEqual(STREAMS.map((s) => ['tok', s]))
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
    expect(pullStream).toHaveBeenCalledWith('tok', STREAMS[0])
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
