import { describe, expect, it } from 'vitest'
import {
  addMinutesIso,
  deviceTz,
  localDateOf,
  localTimeOf,
  toLocalIso,
  withDateIso,
  withTimeOfDayIso,
} from './time'

// Node's process, typed locally to keep node types out of the app tsconfig.
declare const process: { env: Record<string, string | undefined> }

// Must be set before any Date is used by the code under test.
process.env.TZ = 'America/New_York'

const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/

describe('toLocalIso', () => {
  it('formats a summer instant in the local (EDT) offset', () => {
    expect(toLocalIso(new Date('2026-08-02T13:04:11Z'))).toBe('2026-08-02T09:04:11-04:00')
  })

  it('formats a winter instant in the local (EST) offset', () => {
    expect(toLocalIso(new Date('2026-01-15T17:00:00Z'))).toBe('2026-01-15T12:00:00-05:00')
  })

  it('pads single-digit month, day, and time fields', () => {
    expect(toLocalIso(new Date('2026-01-05T08:07:09Z'))).toBe('2026-01-05T03:07:09-05:00')
  })

  it('matches the contract shape and round-trips through new Date()', () => {
    const now = new Date()
    now.setMilliseconds(0)
    const iso = toLocalIso(now)
    expect(iso).toMatch(ISO_LOCAL)
    expect(new Date(iso).getTime()).toBe(now.getTime())
  })
})

describe('localDateOf', () => {
  it('returns the local calendar date part', () => {
    expect(localDateOf('2026-08-02T09:04:11-04:00')).toBe('2026-08-02')
    expect(localDateOf('2026-12-31T23:59:59+05:30')).toBe('2026-12-31')
  })
})

describe('addMinutesIso', () => {
  it('adds minutes preserving the original offset', () => {
    expect(addMinutesIso('2026-08-02T09:04:11-04:00', 10)).toBe('2026-08-02T09:14:11-04:00')
    expect(addMinutesIso('2026-08-02T09:04:11+05:30', 60)).toBe('2026-08-02T10:04:11+05:30')
  })

  it('crosses midnight forward', () => {
    expect(addMinutesIso('2026-08-02T23:55:00-04:00', 10)).toBe('2026-08-03T00:05:00-04:00')
  })

  it('handles negative minutes across midnight', () => {
    expect(addMinutesIso('2026-08-02T00:05:00-04:00', -10)).toBe('2026-08-01T23:55:00-04:00')
  })

  it('handles Z-suffixed input', () => {
    expect(addMinutesIso('2026-08-02T09:04:11Z', 30)).toBe('2026-08-02T09:34:11Z')
  })

  it('preserves the represented instant', () => {
    const out = addMinutesIso('2026-08-02T09:04:11-04:00', 90)
    expect(new Date(out).getTime()).toBe(
      new Date('2026-08-02T09:04:11-04:00').getTime() + 90 * 60_000,
    )
  })
})

describe('localTimeOf', () => {
  it('returns the device-local wall-clock time, zero-padded', () => {
    expect(localTimeOf('2026-08-02T09:04:11-04:00')).toBe('09:04')
    expect(localTimeOf('2026-08-02T23:59:59-04:00')).toBe('23:59')
  })

  it('renders a Z-suffixed instant in the device-local zone', () => {
    expect(localTimeOf('2026-08-02T13:04:11Z')).toBe('09:04')
  })
})

describe('withDateIso', () => {
  it('sets the calendar date and keeps the wall-clock time', () => {
    expect(withDateIso('2026-08-02T09:04:11-04:00', '2026-08-01')).toBe(
      '2026-08-01T09:04:11-04:00',
    )
  })

  it('keeps wall time across a DST boundary (offset adjusts)', () => {
    expect(withDateIso('2026-08-02T09:04:11-04:00', '2026-01-15')).toBe(
      '2026-01-15T09:04:11-05:00',
    )
    expect(withDateIso('2026-01-15T12:00:00-05:00', '2026-08-02')).toBe(
      '2026-08-02T12:00:00-04:00',
    )
  })

  it('is a no-op for the same date', () => {
    expect(withDateIso('2026-08-02T09:04:11-04:00', '2026-08-02')).toBe(
      '2026-08-02T09:04:11-04:00',
    )
  })

  it('handles month ends and zero-pads', () => {
    expect(withDateIso('2026-08-31T09:00:00-04:00', '2026-02-01')).toBe(
      '2026-02-01T09:00:00-05:00',
    )
  })
})

describe('withTimeOfDayIso', () => {
  it('sets the wall-clock time, zeroes seconds, and keeps the date', () => {
    expect(withTimeOfDayIso('2026-08-02T09:04:11-04:00', '14:30')).toBe('2026-08-02T14:30:00-04:00')
  })

  it('re-renders a Z-suffixed instant in the device-local zone', () => {
    expect(withTimeOfDayIso('2026-08-02T13:04:11Z', '08:05')).toBe('2026-08-02T08:05:00-04:00')
  })
})

describe('deviceTz', () => {
  it('returns a non-empty IANA zone string', () => {
    const tz = deviceTz()
    expect(typeof tz).toBe('string')
    expect(tz.length).toBeGreaterThan(0)
  })
})
