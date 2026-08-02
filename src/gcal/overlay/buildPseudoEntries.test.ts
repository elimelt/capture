import { describe, expect, it } from 'vitest'
import type { CalEvent } from '../events'
import { buildPseudoEntries } from './buildPseudoEntries'
import type { OverlayPatch, OverlayState } from './types'

const CAL = 'primary@example.com'
const DATE = '2026-08-02'
const ms = (time: string, date = DATE) => new Date(`${date}T${time}:00`).getTime()

function ev(id: string, start: string, end: string, over: Partial<CalEvent> = {}): CalEvent {
  return { id, summary: id, startMs: ms(start), endMs: ms(end), allDay: false, ...over }
}

let nextOverlay = 0
function ovl(eventId: string, patch: OverlayPatch, over: Partial<OverlayState> = {}): OverlayState {
  return {
    id: `ovl${String(++nextOverlay).padStart(3, '0')}`,
    target: { calendarId: CAL, eventId },
    baseSnapshot: { summary: eventId, startMs: ms('09:00'), endMs: ms('10:00'), allDay: false },
    patch,
    lastEventSeq: 1,
    revoked: false,
    ...over,
  }
}

describe('buildPseudoEntries', () => {
  it('merges overlays into their events by eventId and keeps the rest plain', () => {
    const events = [ev('a', '09:00', '10:00'), ev('b', '11:00', '12:00')]
    const entries = buildPseudoEntries(CAL, events, [ovl('b', { title: 'Renamed' })], DATE)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ title: 'a', materialized: false })
    expect(entries[1]).toMatchObject({ title: 'Renamed', materialized: true })
  })

  it('sorts by effective start, so a time override reorders the day', () => {
    const events = [ev('a', '09:00', '10:00'), ev('b', '11:00', '12:00')]
    const entries = buildPseudoEntries(
      CAL,
      events,
      [ovl('b', { startAt: `${DATE}T08:00:00`, endAt: `${DATE}T08:30:00` })],
      DATE,
    )
    expect(entries.map((e) => e.target.eventId)).toEqual(['b', 'a'])
  })

  it('drops hidden entries, both matched and orphaned', () => {
    const events = [ev('a', '09:00', '10:00')]
    const overlays = [ovl('a', { hidden: true }), ovl('ghost', { hidden: true })]
    expect(buildPseudoEntries(CAL, events, overlays, DATE)).toEqual([])
  })

  it('ignores revoked overlays entirely', () => {
    const events = [ev('a', '09:00', '10:00')]
    const overlays = [ovl('a', { title: 'X' }, { revoked: true })]
    const entries = buildPseudoEntries(CAL, events, overlays, DATE)
    expect(entries[0]).toMatchObject({ title: 'a', materialized: false })
  })

  it('includes an unmatched overlay as orphaned only when its date matches', () => {
    const sameDay = ovl('gone1', {})
    const otherDay = ovl('gone2', {}, {
      baseSnapshot: {
        summary: 'gone2',
        startMs: ms('09:00', '2026-08-03'),
        endMs: ms('10:00', '2026-08-03'),
        allDay: false,
      },
    })
    const entries = buildPseudoEntries(CAL, [], [sameDay, otherDay], DATE)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ target: { calendarId: CAL, eventId: 'gone1' }, orphaned: true })
  })

  it("a patched start moves an orphan to the patch's date, not the snapshot's", () => {
    const movedHere = ovl('gone1', { startAt: `${DATE}T14:00:00-04:00` }, {
      baseSnapshot: {
        summary: 'gone1',
        startMs: ms('09:00', '2026-07-30'),
        endMs: ms('10:00', '2026-07-30'),
        allDay: false,
      },
    })
    const movedAway = ovl('gone2', { startAt: '2026-08-04T09:00:00-04:00' })
    const entries = buildPseudoEntries(CAL, [], [movedHere, movedAway], DATE)
    expect(entries.map((e) => e.target.eventId)).toEqual(['gone1'])
  })

  it('filters overlays to the fetched calendar (multi-calendar)', () => {
    const events = [ev('a', '09:00', '10:00')]
    const foreignMatch = ovl('a', { title: 'other calendar' }, {
      target: { calendarId: 'other@example.com', eventId: 'a' },
    })
    const foreignOrphan = ovl('gone', {}, {
      target: { calendarId: 'other@example.com', eventId: 'gone' },
    })
    const entries = buildPseudoEntries(CAL, events, [foreignMatch, foreignOrphan], DATE)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: 'a', materialized: false })
  })

  it('treats recurring instances independently (per-occurrence event ids)', () => {
    const events = [
      ev('series_inst1', '09:00', '10:00', { recurringEventId: 'series' }),
      ev('series_inst2', '11:00', '12:00', { recurringEventId: 'series' }),
    ]
    const entries = buildPseudoEntries(
      CAL,
      events,
      [ovl('series_inst1', { title: 'Only this one' })],
      DATE,
    )
    expect(entries[0]).toMatchObject({ title: 'Only this one', materialized: true })
    expect(entries[1]).toMatchObject({ title: 'series_inst2', materialized: false })
  })

  it('returns an empty list for no inputs', () => {
    expect(buildPseudoEntries(CAL, [], [], DATE)).toEqual([])
  })
})
