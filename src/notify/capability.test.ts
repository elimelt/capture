import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectCapability,
  readEnvironment,
  requestNotificationPermission,
  type NotifyEnvironment,
} from './capability'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fully-capable installed-app environment; tests override what they probe. */
function env(overrides: Partial<NotifyEnvironment> = {}): NotifyEnvironment {
  return {
    hasNotification: true,
    permission: 'default',
    hasServiceWorker: true,
    hasPushManager: true,
    hasSetAppBadge: true,
    isIos: false,
    isStandalone: true,
    ...overrides,
  }
}

describe('detectCapability', () => {
  it('maps permission to prompt / granted / denied when the API exists', () => {
    expect(detectCapability(env({ permission: 'default' })).state).toBe('prompt')
    expect(detectCapability(env({ permission: 'granted' })).state).toBe('granted')
    expect(detectCapability(env({ permission: 'denied' })).state).toBe('denied')
  })

  it('reads a missing Notification API on an iOS browser tab as needs-install', () => {
    // iOS exposes Notification only to Home Screen web apps, so this is the
    // "add to Home Screen" hint case, not a hard unsupported.
    const c = detectCapability(env({ hasNotification: false, isIos: true, isStandalone: false }))
    expect(c.state).toBe('needs-install')
  })

  it('reads a missing API on an *installed* iOS app as unsupported (pre-16.4)', () => {
    const c = detectCapability(env({ hasNotification: false, isIos: true, isStandalone: true }))
    expect(c.state).toBe('unsupported')
  })

  it('reads a missing API off-iOS as unsupported (install would not help)', () => {
    const c = detectCapability(env({ hasNotification: false, isIos: false, isStandalone: false }))
    expect(c.state).toBe('unsupported')
  })

  it('exposes canBadge whenever setAppBadge exists, independent of permission', () => {
    // The badge only *renders* on iOS after permission is granted, but the
    // API being present is what the Settings copy keys off.
    expect(detectCapability(env({ hasSetAppBadge: true, permission: 'default' })).canBadge).toBe(
      true,
    )
    expect(detectCapability(env({ hasSetAppBadge: false })).canBadge).toBe(false)
  })

  it('gates canNotify on granted permission plus a service worker', () => {
    expect(detectCapability(env({ permission: 'granted' })).canNotify).toBe(true)
    expect(detectCapability(env({ permission: 'default' })).canNotify).toBe(false)
    expect(
      detectCapability(env({ permission: 'granted', hasServiceWorker: false })).canNotify,
    ).toBe(false)
  })

  it('gates canSubscribePush on granted + service worker + PushManager', () => {
    expect(detectCapability(env({ permission: 'granted' })).canSubscribePush).toBe(true)
    expect(
      detectCapability(env({ permission: 'granted', hasPushManager: false })).canSubscribePush,
    ).toBe(false)
    expect(detectCapability(env({ permission: 'denied' })).canSubscribePush).toBe(false)
  })
})

describe('readEnvironment', () => {
  it('captures a granted installed-iPhone environment', () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
      standalone: true,
      serviceWorker: {},
      setAppBadge: () => Promise.resolve(),
    })
    expect(readEnvironment()).toEqual({
      hasNotification: true,
      permission: 'granted',
      hasServiceWorker: true,
      hasPushManager: true,
      hasSetAppBadge: true,
      isIos: true,
      isStandalone: true,
    })
  })

  it('captures an iOS Safari tab: no Notification, not standalone → needs-install', () => {
    vi.stubGlobal('Notification', undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
      // no standalone flag, no setAppBadge, no serviceWorker exposure needed
    })
    const e = readEnvironment()
    expect(e.hasNotification).toBe(false)
    expect(e.permission).toBeUndefined()
    expect(e.isIos).toBe(true)
    expect(e.isStandalone).toBe(false)
    expect(detectCapability(e).state).toBe('needs-install')
  })

  it('detects iPadOS masquerading as macOS via multitouch', () => {
    vi.stubGlobal('Notification', undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      maxTouchPoints: 5,
    })
    expect(readEnvironment().isIos).toBe(true)
  })

  it('does not flag a real Mac (no touch points) as iOS', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      maxTouchPoints: 0,
    })
    expect(readEnvironment().isIos).toBe(false)
  })

  it('reads display-mode: standalone via matchMedia when the iOS flag is absent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15)' })
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === '(display-mode: standalone)',
    }))
    expect(readEnvironment().isStandalone).toBe(true)
  })

  it('survives a bare environment (no navigator, no matchMedia) as unsupported', () => {
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('Notification', undefined)
    const e = readEnvironment()
    expect(e).toEqual({
      hasNotification: false,
      hasServiceWorker: false,
      hasPushManager: false,
      hasSetAppBadge: false,
      isIos: false,
      isStandalone: false,
    })
    expect(detectCapability(e).state).toBe('unsupported')
  })
})

describe('requestNotificationPermission', () => {
  it('returns undefined when the Notification API is missing', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(await requestNotificationPermission()).toBeUndefined()
  })

  it('resolves the permission the browser returns', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () => Promise.resolve('granted' as NotificationPermission),
    })
    expect(await requestNotificationPermission()).toBe('granted')
  })

  it('swallows a rejecting requestPermission into undefined', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () => Promise.reject(new Error('nope')),
    })
    expect(await requestNotificationPermission()).toBeUndefined()
  })
})
