import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Place } from '../store/places'
import { needsPlacePrompt, snapshotLocation } from './geo'

const home: Place = { id: 'p1', name: 'Home', lat: 40.7, lng: -74, radiusM: 100 }

const position = (latitude: number, longitude: number, accuracy: number) =>
  ({ coords: { latitude, longitude, accuracy } }) as GeolocationPosition

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('snapshotLocation', () => {
  it('resolves undefined without touching geolocation when location is disabled', async () => {
    const getCurrentPosition = vi.fn()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    expect(await snapshotLocation([], false)).toBeUndefined()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('resolves undefined when navigator has no geolocation', async () => {
    vi.stubGlobal('navigator', {})
    expect(await snapshotLocation([], true)).toBeUndefined()
  })

  it('returns coords with rounded accuracy and placeLabel inside a place radius', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) => ok(position(40.7, -74, 12.4)),
      },
    })
    expect(await snapshotLocation([home], true)).toEqual({
      lat: 40.7,
      lng: -74,
      accuracyM: 12,
      placeLabel: 'Home',
    })
  })

  it('omits placeLabel when no place matches', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) => ok(position(51.5, -0.1, 8.7)),
      },
    })
    const loc = await snapshotLocation([home], true)
    expect(loc).toEqual({ lat: 51.5, lng: -0.1, accuracyM: 9 })
    expect(loc).not.toHaveProperty('placeLabel')
  })

  it('resolves undefined on geolocation error', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) =>
          err({ code: 1, message: 'denied' } as GeolocationPositionError),
      },
    })
    expect(await snapshotLocation([home], true)).toBeUndefined()
  })

  it('resolves undefined when getCurrentPosition throws synchronously', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: () => {
          throw new Error('boom')
        },
      },
    })
    expect(await snapshotLocation([home], true)).toBeUndefined()
  })
})

describe('needsPlacePrompt', () => {
  const at = { lat: 40.7, lng: -74, accuracyM: 12 }

  it('prompts for an unlabelled location when location is enabled', () => {
    expect(needsPlacePrompt(at, true)).toBe(true)
  })

  it('never prompts when location is disabled or absent', () => {
    expect(needsPlacePrompt(at, false)).toBe(false)
    expect(needsPlacePrompt(undefined, true)).toBe(false)
  })

  it('never prompts when the location already matched a place', () => {
    expect(needsPlacePrompt({ ...at, placeLabel: 'Home' }, true)).toBe(false)
  })
})
