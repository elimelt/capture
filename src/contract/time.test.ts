import { describe, expect, it } from 'vitest'
import {
  addMinutesIso,
  civilTimeOf,
  deviceTz,
  localDateOf,
  localTimeOf,
  toLocalIso,
  withTimeOfDayIso,
  zonedIso,
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

describe('civilTimeOf', () => {
  it("returns the string's own wall-clock time, not the device zone's", () => {
    // Harness TZ is America/New_York; the entry was captured in Tokyo.
    expect(civilTimeOf('2026-08-03T00:30:00+09:00')).toBe('00:30')
    expect(civilTimeOf('2026-08-02T09:04:11-04:00')).toBe('09:04')
  })

  it('pairs with localDateOf to describe one consistent civil instant', () => {
    const iso = '2026-08-03T00:30:00+09:00'
    expect(localDateOf(iso)).toBe('2026-08-03')
    expect(civilTimeOf(iso)).toBe('00:30')
    // The device-zone reading of the same instant is a *different* civil
    // pair (Aug 2, 11:30 EDT) — the bug class this helper exists to avoid.
    expect(localTimeOf(iso)).toBe('11:30')
  })
})

describe('zonedIso', () => {
  it('renders the given wall time with the zone-correct offset', () => {
    expect(zonedIso('2026-08-03', '00:30', 'Asia/Tokyo')).toBe('2026-08-03T00:30:00+09:00')
    expect(zonedIso('2026-08-02', '09:04', 'America/New_York')).toBe('2026-08-02T09:04:00-04:00')
    expect(zonedIso('2026-01-15', '09:04', 'America/New_York')).toBe('2026-01-15T09:04:00-05:00')
  })

  it('keeps wall time when a date move crosses a DST boundary', () => {
    // Same picked wall time, summer vs winter: the offset adjusts, the
    // civil fields do not.
    expect(zonedIso('2026-08-02', '12:00', 'America/New_York')).toBe('2026-08-02T12:00:00-04:00')
    expect(zonedIso('2026-01-15', '12:00', 'America/New_York')).toBe('2026-01-15T12:00:00-05:00')
  })

  it('is independent of the device zone', () => {
    // Harness TZ is America/New_York; the target zone is not.
    expect(zonedIso('2026-06-01', '08:00', 'Europe/Berlin')).toBe('2026-06-01T08:00:00+02:00')
    expect(zonedIso('2026-12-01', '08:00', 'Europe/Berlin')).toBe('2026-12-01T08:00:00+01:00')
  })

  it('resolves DST-skipped and ambiguous wall times deterministically', () => {
    // 2026-03-08 02:30 does not exist in America/New_York (spring forward);
    // 2026-11-01 01:30 occurs twice (fall back). Both must yield a stable,
    // valid contract timestamp carrying the picked civil fields.
    expect(zonedIso('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T02:30:00-04:00')
    expect(zonedIso('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T01:30:00-04:00')
  })

  it('round-trips with the civil readers', () => {
    const iso = zonedIso('2026-08-03', '00:30', 'Asia/Tokyo')
    expect(localDateOf(iso)).toBe('2026-08-03')
    expect(civilTimeOf(iso)).toBe('00:30')
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
