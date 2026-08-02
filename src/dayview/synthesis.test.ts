import { describe, expect, it } from 'vitest'
import type { Entry } from '../contract/types'
import { daySynthesis, synthesisInputHash } from './synthesis'

function entry(id: string, over: Partial<Entry> = {}): Entry {
  return {
    id,
    seq: 1,
    stream: 'timelog',
    loggedAt: '2026-08-02T09:00:00-04:00',
    capturedAt: '2026-08-02T09:00:00-04:00',
    deviceTz: 'America/New_York',
    attachments: [],
    lastEventSeq: 1,
    revoked: false,
    ...over,
  }
}

describe('daySynthesis', () => {
  it('returns an empty artifact for an empty day', () => {
    expect(daySynthesis([])).toEqual({ moments: 0, places: 0, statLine: '' })
  })

  it('counts moments and omits the places segment when nothing has a place label', () => {
    const result = daySynthesis([entry('a'), entry('b'), entry('c')])
    expect(result).toEqual({ moments: 3, places: 0, statLine: '3 moments' })
  })

  it('singularizes a one-moment day', () => {
    expect(daySynthesis([entry('a')]).statLine).toBe('1 moment')
  })

  it('counts distinct place labels, not entries with a location', () => {
    const entries = [
      entry('a', { location: { lat: 1, lng: 1, accuracyM: 10, placeLabel: 'Home' } }),
      entry('b', { location: { lat: 1, lng: 1, accuracyM: 10, placeLabel: 'Home' } }),
      entry('c', { location: { lat: 2, lng: 2, accuracyM: 10, placeLabel: 'Office' } }),
    ]
    expect(daySynthesis(entries)).toEqual({ moments: 3, places: 2, statLine: '3 moments · 2 places' })
  })

  it('excludes entries with a bare coordinate (no placeLabel) from the places count', () => {
    const entries = [
      entry('a', { location: { lat: 1, lng: 1, accuracyM: 10 } }),
      entry('b', { location: { lat: 2, lng: 2, accuracyM: 10, placeLabel: 'Office' } }),
    ]
    expect(daySynthesis(entries)).toEqual({ moments: 2, places: 1, statLine: '2 moments · 1 place' })
  })

  it('singularizes a one-place day', () => {
    const entries = [entry('a', { location: { lat: 1, lng: 1, accuracyM: 10, placeLabel: 'Home' } })]
    expect(daySynthesis(entries).statLine).toBe('1 moment · 1 place')
  })
})

describe('synthesisInputHash', () => {
  it('is stable under entry reordering', () => {
    const entries = [entry('a'), entry('b'), entry('c')]
    const texts = [
      { id: 'a', textLength: 5 },
      { id: 'b', textLength: 10 },
      { id: 'c', textLength: 0 },
    ]
    const h1 = synthesisInputHash(entries, texts)
    const h2 = synthesisInputHash([...entries].reverse(), [...texts].reverse())
    expect(h1).toBe(h2)
  })

  it('changes when an entry is amended (its folded text length changes)', () => {
    const entries = [entry('a')]
    const before = synthesisInputHash(entries, [{ id: 'a', textLength: 5 }])
    const after = synthesisInputHash(entries, [{ id: 'a', textLength: 6 }])
    expect(before).not.toBe(after)
  })

  it('changes when an entry is added or revoked (removed from the list)', () => {
    const texts = [
      { id: 'a', textLength: 5 },
      { id: 'b', textLength: 5 },
    ]
    const withBoth = synthesisInputHash([entry('a'), entry('b')], texts)
    const withOne = synthesisInputHash([entry('a')], texts)
    expect(withBoth).not.toBe(withOne)
  })

  it('is deterministic for a fixed input', () => {
    const entries = [entry('a'), entry('b')]
    const texts = [
      { id: 'a', textLength: 3 },
      { id: 'b', textLength: 7 },
    ]
    expect(synthesisInputHash(entries, texts)).toBe(synthesisInputHash(entries, texts))
  })

  it('treats an entry missing from the texts input as length 0', () => {
    const entries = [entry('a')]
    expect(synthesisInputHash(entries, [])).toBe(synthesisInputHash(entries, [{ id: 'a', textLength: 0 }]))
  })

  it('is the empty-day hash for an empty entry list regardless of texts', () => {
    expect(synthesisInputHash([], [])).toBe(synthesisInputHash([], [{ id: 'ghost', textLength: 99 }]))
  })
})
