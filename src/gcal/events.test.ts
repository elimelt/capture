import { describe, expect, it } from 'vitest'
import { dayRange, parseEvent, parseEvents, sortEvents, type RawEvent } from './events'

describe('parseEvent', () => {
  it('normalizes a timed event to epoch-ms and keeps the link', () => {
    const ev = parseEvent({
      id: 'e1',
      summary: '  Work  ',
      htmlLink: 'https://calendar.google.com/e1',
      start: { dateTime: '2026-08-02T09:04:00-04:00' },
      end: { dateTime: '2026-08-02T12:30:00-04:00' },
    })
    expect(ev).toEqual({
      id: 'e1',
      summary: 'Work',
      htmlLink: 'https://calendar.google.com/e1',
      startMs: new Date('2026-08-02T09:04:00-04:00').getTime(),
      endMs: new Date('2026-08-02T12:30:00-04:00').getTime(),
      allDay: false,
    })
  })

  it('treats a date-only event as all-day at local midnight', () => {
    const ev = parseEvent({ id: 'e2', start: { date: '2026-08-02' }, end: { date: '2026-08-03' } })
    expect(ev?.allDay).toBe(true)
    expect(ev?.startMs).toBe(new Date('2026-08-02T00:00:00').getTime())
    expect(ev?.summary).toBe('(no title)')
  })

  it('drops cancelled, id-less, and time-less events', () => {
    expect(parseEvent({ id: 'x', status: 'cancelled', start: { dateTime: 'now' } })).toBeNull()
    expect(parseEvent({ start: { dateTime: '2026-08-02T09:00:00Z' } })).toBeNull()
    expect(parseEvent({ id: 'y' })).toBeNull()
  })

  it('omits htmlLink when absent', () => {
    const ev = parseEvent({
      id: 'e3',
      summary: 'Lunch',
      start: { dateTime: '2026-08-02T12:00:00Z' },
      end: { dateTime: '2026-08-02T13:00:00Z' },
    })
    expect(ev).not.toBeNull()
    expect('htmlLink' in (ev as object)).toBe(false)
  })

  it('threads updated and recurringEventId through when present (§3.6 overlays)', () => {
    const ev = parseEvent({
      id: 'e4_20260802T130000Z',
      summary: 'Standup',
      updated: '2026-08-01T12:00:00.000Z',
      recurringEventId: 'e4',
      start: { dateTime: '2026-08-02T09:00:00-04:00' },
      end: { dateTime: '2026-08-02T09:15:00-04:00' },
    })
    expect(ev?.updated).toBe('2026-08-01T12:00:00.000Z')
    expect(ev?.recurringEventId).toBe('e4')
  })

  it('omits updated and recurringEventId when absent', () => {
    const ev = parseEvent({
      id: 'e5',
      start: { dateTime: '2026-08-02T12:00:00Z' },
      end: { dateTime: '2026-08-02T13:00:00Z' },
    })
    expect('updated' in (ev as object)).toBe(false)
    expect('recurringEventId' in (ev as object)).toBe(false)
  })
})

describe('parseEvents + sortEvents', () => {
  const raw: RawEvent[] = [
    { id: 'b', start: { dateTime: '2026-08-02T12:00:00Z' }, end: { dateTime: '2026-08-02T13:00:00Z' } },
    { id: 'gone', status: 'cancelled', start: { dateTime: '2026-08-02T08:00:00Z' } },
    { id: 'a', start: { dateTime: '2026-08-02T09:00:00Z' }, end: { dateTime: '2026-08-02T10:00:00Z' } },
  ]

  it('parses out the unusable ones and orders by start', () => {
    const ids = sortEvents(parseEvents(raw)).map((e) => e.id)
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('dayRange', () => {
  it('spans one local calendar day at wall-clock midnight boundaries', () => {
    const { timeMin, timeMax } = dayRange('2026-08-02')
    expect(timeMin.startsWith('2026-08-02T00:00:00')).toBe(true)
    expect(timeMax.startsWith('2026-08-03T00:00:00')).toBe(true)
  })
})
