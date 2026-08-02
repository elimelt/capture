import { describe, expect, it } from 'vitest'
import { BUILTIN_STREAMS, TIMELOG_STREAM, getStream } from './registry'

describe('getStream', () => {
  it('returns TIMELOG_STREAM for timelog', () => {
    expect(getStream('timelog')).toBe(TIMELOG_STREAM)
  })

  it('throws for an unknown id', () => {
    expect(() => getStream('meals')).toThrow('Unknown stream: meals')
  })
})

describe('BUILTIN_STREAMS', () => {
  it('contains the timelog stream', () => {
    expect(BUILTIN_STREAMS).toContain(TIMELOG_STREAM)
  })
})
