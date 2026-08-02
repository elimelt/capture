/**
 * Edge case tests for fold() — validates determinism and correctness under
 * adversarial conditions: seq collisions, concurrent amends, reordering, etc.
 */
import { describe, expect, it } from 'vitest'
import type { AmendEvent, CaptureEvent } from './types'
import { EVENT_SCHEMA } from './types'
import { compareEvents, fold } from './fold'

const STREAM = 'timelog'
const TZ = 'America/New_York'

function cap(
  seq: number,
  id: string,
  loggedAt: string,
  capturedAt = loggedAt,
  extra: Partial<CaptureEvent> = {},
): CaptureEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'capture',
    id,
    seq,
    stream: STREAM,
    loggedAt,
    deviceTz: TZ,
    capturedAt,
    attachments: [],
    ...extra,
  }
}

function amend(
  seq: number,
  id: string,
  loggedAt: string,
  targets: string[],
  patch?: AmendEvent['patch'],
): AmendEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'amend',
    id,
    seq,
    stream: STREAM,
    loggedAt,
    deviceTz: TZ,
    targets,
    ...(patch ? { patch } : {}),
  }
}

describe('compareEvents total ordering', () => {
  it('orders by seq first', () => {
    const a = cap(1, 'aaaaaa', '2026-08-02T10:00:00-04:00')
    const b = cap(2, 'bbbbbb', '2026-08-02T09:00:00-04:00')
    expect(compareEvents(a, b)).toBeLessThan(0)
    expect(compareEvents(b, a)).toBeGreaterThan(0)
  })

  it('breaks seq ties by loggedAt', () => {
    const a = cap(1, 'zzzzzz', '2026-08-02T09:00:00-04:00')
    const b = cap(1, 'aaaaaa', '2026-08-02T10:00:00-04:00')
    expect(compareEvents(a, b)).toBeLessThan(0)
    expect(compareEvents(b, a)).toBeGreaterThan(0)
  })

  it('breaks seq+loggedAt ties by id', () => {
    const t = '2026-08-02T09:00:00-04:00'
    const a = cap(1, 'aaaaaa', t)
    const b = cap(1, 'zzzzzz', t)
    expect(compareEvents(a, b)).toBeLessThan(0)
    expect(compareEvents(b, a)).toBeGreaterThan(0)
  })

  it('returns 0 for identical events', () => {
    const a = cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00')
    expect(compareEvents(a, a)).toBe(0)
  })

  it('is transitive', () => {
    const a = cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00')
    const b = cap(1, 'bbbbbb', '2026-08-02T09:00:00-04:00')
    const c = cap(1, 'cccccc', '2026-08-02T09:00:00-04:00')
    expect(compareEvents(a, b)).toBeLessThan(0)
    expect(compareEvents(b, c)).toBeLessThan(0)
    expect(compareEvents(a, c)).toBeLessThan(0)
  })

  it('is antisymmetric', () => {
    const a = cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00')
    const b = cap(2, 'bbbbbb', '2026-08-02T09:00:00-04:00')
    const cmp = compareEvents(a, b)
    expect(compareEvents(b, a)).toBe(-cmp)
  })
})

describe('fold determinism with seq collisions (Design C)', () => {
  it('produces identical results regardless of input order', () => {
    // Simulate two devices offline-minting the same seq
    const device1 = cap(1, 'dev1ev', '2026-08-02T09:00:00-04:00')
    const device2 = cap(1, 'dev2ev', '2026-08-02T09:05:00-04:00')
    const amend1 = amend(2, 'am1xxx', '2026-08-02T09:10:00-04:00', ['dev1ev'], {
      capturedAt: '2026-08-02T08:00:00-04:00',
    })

    const orderings = [
      [device1, device2, amend1],
      [device2, device1, amend1],
      [amend1, device1, device2],
      [amend1, device2, device1],
      [device1, amend1, device2],
      [device2, amend1, device1],
    ]

    const results = orderings.map((events) => fold(events))

    // All orderings should produce identical output
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0])
    }
  })

  it('applies concurrent amends from different devices in loggedAt order', () => {
    const capture = cap(1, 'target', '2026-08-02T09:00:00-04:00')
    // Two devices amend the same target with colliding seq
    const amendA = amend(2, 'aaaaaa', '2026-08-02T10:00:00-04:00', ['target'], {
      capturedAt: '2026-08-02T08:00:00-04:00',
    })
    const amendB = amend(2, 'bbbbbb', '2026-08-02T11:00:00-04:00', ['target'], {
      capturedAt: '2026-08-02T07:00:00-04:00',
    })

    // Later loggedAt (amendB) should win
    const entries = fold([capture, amendA, amendB])
    expect(entries[0].capturedAt).toBe('2026-08-02T07:00:00-04:00')

    // Same result regardless of input order
    expect(fold([amendB, amendA, capture])[0].capturedAt).toBe('2026-08-02T07:00:00-04:00')
  })

  it('breaks loggedAt ties by id for concurrent amends', () => {
    const t = '2026-08-02T10:00:00-04:00'
    const capture = cap(1, 'target', '2026-08-02T09:00:00-04:00')
    const amendA = amend(2, 'aaaaaa', t, ['target'], { capturedAt: '2026-08-02T08:00:00-04:00' })
    const amendB = amend(2, 'zzzzzz', t, ['target'], { capturedAt: '2026-08-02T07:00:00-04:00' })

    // Later id (zzzzzz > aaaaaa) should win
    const entries = fold([capture, amendA, amendB])
    expect(entries[0].capturedAt).toBe('2026-08-02T07:00:00-04:00')
  })
})
