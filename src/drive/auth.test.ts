import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A controllable stand-in for the GIS oauth2 token client. */
function stubGis() {
  let lastCallback: ((resp: unknown) => void) | undefined
  const requestAccessToken = vi.fn((_overrides?: { prompt?: string }) => {})
  const client = {
    set callback(cb: (resp: unknown) => void) {
      lastCallback = cb
    },
    get callback() {
      return lastCallback as (resp: unknown) => void
    },
    requestAccessToken,
  }
  const initTokenClient = vi.fn((_config: { scope: string }) => client)
  const revoke = vi.fn((_token: string, done?: () => void) => done?.())
  vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient, revoke } } })
  return {
    initTokenClient,
    requestAccessToken,
    revoke,
    fire: (resp: unknown) => lastCallback?.(resp),
  }
}

async function load() {
  return import('./auth')
}
async function tokenStore() {
  return import('./token')
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connect', () => {
  it('persists the token and resolves with an expiry derived from expires_in', async () => {
    const gis = stubGis()
    const auth = await load()
    const now = 1_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const promise = auth.connect()
    // requestAccessToken is invoked synchronously after client init resolves.
    await vi.waitFor(() => expect(gis.requestAccessToken).toHaveBeenCalled())
    gis.fire({ access_token: 'tok-123', expires_in: 3600 })

    const token = await promise
    expect(token).toEqual({ accessToken: 'tok-123', expiresAt: now + 3600_000 })

    const store = await tokenStore()
    expect(await store.getStoredToken()).toEqual(token)
  })

  it('requests drive.file scope and reuses a single token client', async () => {
    const gis = stubGis()
    const auth = await load()

    const p1 = auth.connect()
    await vi.waitFor(() => expect(gis.requestAccessToken).toHaveBeenCalledTimes(1))
    gis.fire({ access_token: 'a', expires_in: 3600 })
    await p1

    const p2 = auth.connect('consent')
    await vi.waitFor(() => expect(gis.requestAccessToken).toHaveBeenCalledTimes(2))
    gis.fire({ access_token: 'b', expires_in: 3600 })
    await p2

    expect(gis.initTokenClient).toHaveBeenCalledTimes(1)
    expect(gis.initTokenClient.mock.calls[0][0].scope).toBe(auth.DRIVE_SCOPE)
    expect(gis.requestAccessToken).toHaveBeenLastCalledWith({ prompt: 'consent' })
  })

  it('rejects when GIS returns an error', async () => {
    const gis = stubGis()
    const auth = await load()

    const promise = auth.connect()
    await vi.waitFor(() => expect(gis.requestAccessToken).toHaveBeenCalled())
    gis.fire({ error: 'access_denied', error_description: 'user declined' })

    await expect(promise).rejects.toThrow('user declined')
  })
})

describe('disconnect', () => {
  it('revokes at Google and clears the local token', async () => {
    const gis = stubGis()
    const auth = await load()
    const store = await tokenStore()
    await store.saveToken({ accessToken: 'live', expiresAt: Date.now() + 3600_000 })

    await auth.disconnect('live')

    expect(gis.revoke).toHaveBeenCalledWith('live', expect.any(Function))
    expect(await store.getStoredToken()).toBeUndefined()
  })

  it('still clears locally when no token is passed', async () => {
    stubGis()
    const auth = await load()
    const store = await tokenStore()
    await store.saveToken({ accessToken: 'live', expiresAt: Date.now() + 3600_000 })

    await auth.disconnect()
    expect(await store.getStoredToken()).toBeUndefined()
  })
})
