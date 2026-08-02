import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function setup() {
  const db = await import('../store/db')
  const token = await import('./token')
  return { ...db, ...token }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const NOW = 1_000_000_000_000

describe('token storage', () => {
  it('round-trips and clears a stored token', async () => {
    const s = await setup()
    expect(await s.getStoredToken()).toBeUndefined()
    await s.saveToken({ accessToken: 'abc', expiresAt: NOW })
    expect(await s.getStoredToken()).toEqual({ accessToken: 'abc', expiresAt: NOW })
    await s.clearToken()
    expect(await s.getStoredToken()).toBeUndefined()
  })
})

describe('tokenValid', () => {
  it('is false for a missing token', async () => {
    const s = await setup()
    expect(s.tokenValid(undefined, NOW)).toBe(false)
  })

  it('treats a token expiring within the skew window as invalid', async () => {
    const s = await setup()
    expect(s.tokenValid({ accessToken: 'a', expiresAt: NOW + 30_000 }, NOW)).toBe(false)
    expect(s.tokenValid({ accessToken: 'a', expiresAt: NOW + 120_000 }, NOW)).toBe(true)
  })
})

describe('getValidAccessToken', () => {
  it('returns the token only while valid', async () => {
    const s = await setup()
    await s.saveToken({ accessToken: 'live', expiresAt: NOW + 120_000 })
    expect(await s.getValidAccessToken(NOW)).toBe('live')
    expect(await s.getValidAccessToken(NOW + 200_000)).toBeUndefined()
  })
})

describe('connectionState', () => {
  it('reports disconnected / expired / connected', async () => {
    const s = await setup()
    expect(await s.connectionState(NOW)).toBe('disconnected')
    await s.saveToken({ accessToken: 'a', expiresAt: NOW - 1 })
    expect(await s.connectionState(NOW)).toBe('expired')
    await s.saveToken({ accessToken: 'a', expiresAt: NOW + 120_000 })
    expect(await s.connectionState(NOW)).toBe('connected')
  })
})
