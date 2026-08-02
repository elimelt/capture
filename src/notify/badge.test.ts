import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyAppBadge, badgeCount } from './badge'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('badgeCount', () => {
  it('sums named sources', () => {
    expect(badgeCount({ pendingSync: 3 })).toBe(3)
    expect(badgeCount({ pendingSync: 3, transcriptsReady: 2 })).toBe(5)
  })

  it('is 0 with no sources', () => {
    expect(badgeCount({})).toBe(0)
  })

  it('ignores negative, NaN and non-finite counts', () => {
    expect(badgeCount({ a: -4, b: Number.NaN, c: Number.POSITIVE_INFINITY })).toBe(0)
    expect(badgeCount({ a: -4, b: 2 })).toBe(2)
  })

  it('floors fractional counts', () => {
    expect(badgeCount({ a: 2.9 })).toBe(2)
  })
})

describe('applyAppBadge', () => {
  it('sets the badge for a positive count', async () => {
    const setAppBadge = vi.fn(() => Promise.resolve())
    const clearAppBadge = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    await applyAppBadge(4)
    expect(setAppBadge).toHaveBeenCalledWith(4)
    expect(clearAppBadge).not.toHaveBeenCalled()
  })

  it('clears the badge for zero', async () => {
    const setAppBadge = vi.fn(() => Promise.resolve())
    const clearAppBadge = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })
    await applyAppBadge(0)
    expect(clearAppBadge).toHaveBeenCalled()
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it('no-ops without the Badging API (and without a navigator at all)', async () => {
    vi.stubGlobal('navigator', {})
    await expect(applyAppBadge(2)).resolves.toBeUndefined()
    vi.stubGlobal('navigator', undefined)
    await expect(applyAppBadge(2)).resolves.toBeUndefined()
  })

  it('swallows a rejecting setAppBadge (badging is cosmetic)', async () => {
    vi.stubGlobal('navigator', {
      setAppBadge: () => Promise.reject(new Error('denied')),
    })
    await expect(applyAppBadge(1)).resolves.toBeUndefined()
  })
})
