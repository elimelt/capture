import { describe, expect, it } from 'vitest'
import { newEventId } from './ids'

describe('newEventId', () => {
  it('produces 6-char base36 ids', () => {
    for (let i = 0; i < 100; i++) {
      expect(newEventId()).toMatch(/^[0-9a-z]{6}$/)
    }
  })

  it('produces distinct ids across many calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(newEventId())
    expect(ids.size).toBe(1000)
  })
})
