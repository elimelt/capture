import { describe, expect, it } from 'vitest'
import {
  BUILTIN_STREAMS,
  SYSTEM_STREAMS,
  TIMELOG_STREAM,
  allSyncStreams,
  getStream,
} from './registry'

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

describe('allSyncStreams', () => {
  it('includes every system stream and every builtin stream', () => {
    const streams = allSyncStreams()
    for (const id of SYSTEM_STREAMS) expect(streams).toContain(id)
    for (const s of BUILTIN_STREAMS) expect(streams).toContain(s.id)
  })

  it('has a stable order: system streams first, then builtin streams', () => {
    expect(allSyncStreams()).toEqual(['settings', 'assistant-chats', 'timelog'])
    // Stable across calls — the sync loop's iteration order is deterministic.
    expect(allSyncStreams()).toEqual(allSyncStreams())
  })

  it('contains no duplicates', () => {
    const streams = allSyncStreams()
    expect(new Set(streams).size).toBe(streams.length)
  })

  it('system streams are not capture streams (no StreamDefinition)', () => {
    for (const id of SYSTEM_STREAMS) {
      expect(() => getStream(id)).toThrow(`Unknown stream: ${id}`)
    }
  })
})
