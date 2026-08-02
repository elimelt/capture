import { afterEach, describe, expect, it, vi } from 'vitest'
import { showAppNotification } from './local'

afterEach(() => {
  vi.unstubAllGlobals()
})

function grantedNotification() {
  vi.stubGlobal('Notification', { permission: 'granted' })
}

describe('showAppNotification', () => {
  it('shows via the service-worker registration when permission is granted', async () => {
    grantedNotification()
    const showNotification = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) },
    })
    expect(
      await showAppNotification({ title: 'Capture', body: '2 transcripts ready', tag: 'enrich' }),
    ).toBe(true)
    expect(showNotification).toHaveBeenCalledWith('Capture', {
      body: '2 transcripts ready',
      tag: 'enrich',
    })
  })

  it('omits body/tag from options when not provided', async () => {
    grantedNotification()
    const showNotification = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ showNotification }) },
    })
    await showAppNotification({ title: 'Capture' })
    expect(showNotification).toHaveBeenCalledWith('Capture', {})
  })

  it('returns false when the Notification API is missing', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(await showAppNotification({ title: 'x' })).toBe(false)
  })

  it('returns false when permission is not granted', async () => {
    vi.stubGlobal('Notification', { permission: 'default' })
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ showNotification: vi.fn() }) },
    })
    expect(await showAppNotification({ title: 'x' })).toBe(false)
  })

  it('returns false without a service-worker container or registration', async () => {
    grantedNotification()
    vi.stubGlobal('navigator', {})
    expect(await showAppNotification({ title: 'x' })).toBe(false)
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve(undefined) },
    })
    expect(await showAppNotification({ title: 'x' })).toBe(false)
  })

  it('returns false when showNotification itself fails', async () => {
    grantedNotification()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({ showNotification: () => Promise.reject(new Error('nope')) }),
      },
    })
    expect(await showAppNotification({ title: 'x' })).toBe(false)
  })
})
