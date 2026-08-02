import { describe, expect, it } from 'vitest'
import type { GeoLocation } from '../contract/types'
import { locationName, placeCardModel } from './placeCardModel'

function loc(extra: Partial<GeoLocation> = {}): GeoLocation {
  return { lat: 37.8044, lng: -122.2712, accuracyM: 12, ...extra }
}

describe('placeCardModel', () => {
  it('placeLabel wins as the title, with the address as a subtitle', () => {
    const model = placeCardModel(loc({ placeLabel: 'Home', address: '123 Main St' }))
    expect(model).toEqual({ title: 'Home', subtitle: 'near 123 Main St' })
  })

  it('a place label with no address has no subtitle', () => {
    const model = placeCardModel(loc({ placeLabel: 'Home' }))
    expect(model).toEqual({ title: 'Home', subtitle: undefined })
  })

  it('an address alone becomes the "near <address>" title, with no subtitle', () => {
    const model = placeCardModel(loc({ address: '456 Oak Ave' }))
    expect(model).toEqual({ title: 'near 456 Oak Ave', subtitle: undefined })
  })

  it('a bare coordinate (no label, no address) gets a generic title', () => {
    const model = placeCardModel(loc())
    expect(model).toEqual({ title: 'Location captured', subtitle: undefined })
  })

  it('never leaks raw coordinates into the title or subtitle', () => {
    const cases = [
      loc({ placeLabel: 'Home', address: '123 Main St' }),
      loc({ placeLabel: 'Home' }),
      loc({ address: '456 Oak Ave' }),
      loc(),
    ]
    for (const location of cases) {
      const { title, subtitle } = placeCardModel(location)
      expect(title).not.toMatch(/\d+\.\d{3,}/)
      expect(subtitle ?? '').not.toMatch(/\d+\.\d{3,}/)
    }
  })
})

describe('locationName', () => {
  it('prefers placeLabel over address', () => {
    expect(locationName(loc({ placeLabel: 'Home', address: '123 Main St' }))).toBe('Home')
  })

  it('falls back to "near <address>" with no placeLabel', () => {
    expect(locationName(loc({ address: '123 Main St' }))).toBe('near 123 Main St')
  })

  it('is undefined for a bare coordinate', () => {
    expect(locationName(loc())).toBeUndefined()
  })
})
