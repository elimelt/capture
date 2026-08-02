import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPushSubscription,
  subscribeToPush,
  vapidKeyToApplicationServerKey,
} from './push'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('vapidKeyToApplicationServerKey', () => {
  it('decodes plain base64url', () => {
    expect(Array.from(vapidKeyToApplicationServerKey('AQID'))).toEqual([1, 2, 3])
  })

  it('re-pads keys whose length is not a multiple of four', () => {
    // 'AQI' is the unpadded base64 of [0x01, 0x02].
    expect(Array.from(vapidKeyToApplicationServerKey('AQI'))).toEqual([1, 2])
  })

  it('maps the url-safe alphabet (- and _) back to + and /', () => {
    // '__8' unpadded url-safe base64 → '//8=' → [0xff, 0xff]
    expect(Array.from(vapidKeyToApplicationServerKey('__8'))).toEqual([255, 255])
    // '-_8' → '+/8=' → [0xfb, 0xff]
    expect(Array.from(vapidKeyToApplicationServerKey('-_8'))).toEqual([251, 255])
  })
})

describe('getPushSubscription', () => {
  it('returns null without a service-worker registration', async () => {
    vi.stubGlobal('navigator', {})
    expect(await getPushSubscription()).toBeNull()
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve(undefined) },
    })
    expect(await getPushSubscription()).toBeNull()
  })

  it('returns the registration’s current subscription', async () => {
    const sub = { endpoint: 'https://push.example/abc' }
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(sub) } }),
      },
    })
    expect(await getPushSubscription()).toBe(sub)
  })

  it('turns a pushManager failure into null', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          Promise.resolve({
            pushManager: { getSubscription: () => Promise.reject(new Error('nope')) },
          }),
      },
    })
    expect(await getPushSubscription()).toBeNull()
  })
})

describe('subscribeToPush', () => {
  it('returns null when push is unavailable', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({}) },
    })
    expect(await subscribeToPush('AQID')).toBeNull()
  })

  it('subscribes user-visible-only with the decoded VAPID key', async () => {
    const sub = { endpoint: 'https://push.example/new' }
    const subscribe = vi.fn((_options: unknown) => Promise.resolve(sub))
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: () => Promise.resolve({ pushManager: { subscribe } }) },
    })
    expect(await subscribeToPush('AQID')).toBe(sub)
    expect(subscribe).toHaveBeenCalledTimes(1)
    const options = subscribe.mock.calls[0]![0] as {
      userVisibleOnly: boolean
      applicationServerKey: ArrayBuffer
    }
    expect(options.userVisibleOnly).toBe(true)
    expect(Array.from(new Uint8Array(options.applicationServerKey))).toEqual([1, 2, 3])
  })
})
