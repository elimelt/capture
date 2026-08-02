import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the drive layer so these tests exercise only the store's wiring:
// gesture → connect → drain, and the no-token / reconnect branches.
const connect = vi.fn()
const disconnect = vi.fn()
const drainStream = vi.fn()
const getValidAccessToken = vi.fn<() => Promise<string | undefined>>()
const connectionState = vi.fn<() => Promise<'connected' | 'expired' | 'disconnected'>>()
const getStoredToken = vi.fn<() => Promise<{ accessToken: string } | undefined>>()

vi.mock('../drive/auth', () => ({ connect, disconnect }))
vi.mock('../drive/queue', () => ({ drainStream }))
vi.mock('../drive/token', () => ({
  getValidAccessToken,
  connectionState,
  getStoredToken,
}))

async function freshStore() {
  vi.resetModules()
  const { useAppStore } = await import('./appStore')
  return useAppStore
}

beforeEach(() => {
  vi.clearAllMocks()
  connectionState.mockResolvedValue('disconnected')
  getValidAccessToken.mockResolvedValue(undefined)
  getStoredToken.mockResolvedValue(undefined)
  drainStream.mockResolvedValue({ outcome: 'drained', uploaded: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('drainSync', () => {
  it('no-ops without a token and refreshes connection state', async () => {
    connectionState.mockResolvedValue('expired')
    const store = await freshStore()
    await store.getState().drainSync()
    expect(drainStream).not.toHaveBeenCalled()
    expect(store.getState().driveConnection).toBe('expired')
  })

  it('drains with a valid token', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    await store.getState().drainSync()
    expect(drainStream).toHaveBeenCalledWith('tok', 'timelog')
    expect(store.getState().syncing).toBe(false)
  })

  it('flips to expired when the drainer asks to reconnect', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    drainStream.mockResolvedValue({ outcome: 'reconnect', uploaded: 0 })
    const store = await freshStore()
    await store.getState().drainSync()
    expect(store.getState().driveConnection).toBe('expired')
  })

  it('surfaces a drain error as lastError', async () => {
    getValidAccessToken.mockResolvedValue('tok')
    drainStream.mockResolvedValue({ outcome: 'error', uploaded: 0, error: 'Drive full' })
    const store = await freshStore()
    await store.getState().drainSync()
    expect(store.getState().lastError).toMatch(/Drive full/)
  })
})

describe('connectDrive', () => {
  it('connects, marks connected, and drains', async () => {
    connect.mockResolvedValue({ accessToken: 'tok', expiresAt: Date.now() + 3600_000 })
    // After connect the token is valid; connectionState reflects that.
    connectionState.mockResolvedValue('connected')
    getValidAccessToken.mockResolvedValue('tok')
    const store = await freshStore()
    await store.getState().connectDrive()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(store.getState().driveConnection).toBe('connected')
    expect(drainStream).toHaveBeenCalledWith('tok', 'timelog')
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
