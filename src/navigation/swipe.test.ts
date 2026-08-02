import { describe, expect, it } from 'vitest'
import { adjacentTabPath, getSwipeDirection } from './swipe'

describe('getSwipeDirection', () => {
  it('requires the minimum horizontal distance', () => {
    expect(getSwipeDirection(0, 0, 63, 0)).toBeNull()
    expect(getSwipeDirection(100, 0, 36, 0)).toBe('left')
  })

  it('rejects vertical and mostly vertical drags', () => {
    expect(getSwipeDirection(0, 0, 100, 100)).toBeNull()
    expect(getSwipeDirection(0, 0, 80, 70)).toBeNull()
  })

  it('supports both natural directions', () => {
    expect(getSwipeDirection(100, 0, 20, 2)).toBe('left')
    expect(getSwipeDirection(20, 0, 100, 2)).toBe('right')
  })
})

describe('adjacentTabPath', () => {
  const tabs = ['/', '/day', '/chat', '/settings']

  it('moves to the neighboring visible tab and stops at the edges', () => {
    expect(adjacentTabPath('/', tabs, 'left')).toBe('/day')
    expect(adjacentTabPath('/day/2026-08-02', tabs, 'right')).toBe('/')
    expect(adjacentTabPath('/', tabs, 'right')).toBeNull()
    expect(adjacentTabPath('/settings', tabs, 'left')).toBeNull()
  })

  it('does not navigate an unknown route', () => {
    expect(adjacentTabPath('/missing', tabs, 'left')).toBeNull()
  })
})
