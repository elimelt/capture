import { describe, expect, it } from 'vitest'
import type { Place } from '../store/db'
import { haversineM, matchPlace } from './match'

function place(id: string, lat: number, lng: number, radiusM: number): Place {
  return { id, name: id, lat, lng, radiusM }
}

describe('haversineM', () => {
  it('is zero for identical points', () => {
    expect(haversineM({ lat: 40.7, lng: -74 }, { lat: 40.7, lng: -74 })).toBe(0)
  })

  it('is ~111,195 m per degree of latitude at the equator', () => {
    const d = haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })
    expect(d).toBeGreaterThan(111_195 * 0.99)
    expect(d).toBeLessThan(111_195 * 1.01)
  })

  it('is symmetric', () => {
    const a = { lat: 40.7128, lng: -74.006 }
    const b = { lat: 40.72, lng: -74.01 }
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6)
  })
})

describe('matchPlace', () => {
  // ~0.001° latitude ≈ 111 m.
  const home = place('home', 40.7, -74.0, 150)

  it('matches a point inside the radius', () => {
    expect(matchPlace([home], 40.701, -74.0)?.id).toBe('home')
  })

  it('does not match a point outside the radius', () => {
    expect(matchPlace([home], 40.703, -74.0)).toBeUndefined()
  })

  it('picks the nearest of two overlapping places', () => {
    const near = place('near', 40.7005, -74.0, 500)
    const far = place('far', 40.702, -74.0, 500)
    expect(matchPlace([far, near], 40.7, -74.0)?.id).toBe('near')
  })

  it('returns undefined for an empty list', () => {
    expect(matchPlace([], 40.7, -74.0)).toBeUndefined()
  })
})
