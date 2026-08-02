import { describe, expect, it } from 'vitest'
import type { CalEvent } from '../events'
import { mergePseudoEntry } from './pseudoEntry'
import type { OverlayBaseSnapshot, OverlayPatch, OverlayState } from './types'

const CAL = 'primary@example.com'
// Local-time epoch ms so assertions are timezone-independent.
const ms = (time: string) => new Date(`2026-08-02T${time}:00`).getTime()

const BASE: CalEvent = {
  id: 'ev1',
  summary: 'Standup',
  htmlLink: 'https://calendar.google.com/ev1',
  startMs: ms('09:00'),
  endMs: ms('10:00'),
  allDay: false,
  updated: '2026-08-01T12:00:00.000Z',
}

/** A snapshot frozen from BASE (same field values). */
const SNAP: OverlayBaseSnapshot = {
  summary: BASE.summary,
  startMs: BASE.startMs,
  endMs: BASE.endMs,
  allDay: BASE.allDay,
  updated: BASE.updated,
}

function overlay(patch: OverlayPatch, over: Partial<OverlayState> = {}): OverlayState {
  return {
    id: 'ovl001',
    target: { calendarId: CAL, eventId: BASE.id },
    baseSnapshot: SNAP,
    patch,
    lastEventSeq: 1,
    revoked: false,
    ...over,
  }
}

/** BASE after an upstream edit in Google Calendar (updated stamp moves too). */
function movedBase(over: Partial<CalEvent>): CalEvent {
  return { ...BASE, ...over, updated: '2026-08-01T18:00:00.000Z' }
}

describe('mergePseudoEntry presence matrix', () => {
  it('returns null when neither base nor overlay exists', () => {
    expect(mergePseudoEntry(CAL, undefined, undefined)).toBeNull()
  })

  it('base only → plain unmaterialized entry with a cal: id', () => {
    expect(mergePseudoEntry(CAL, BASE, undefined)).toEqual({
      id: `cal:${CAL}:ev1`,
      target: { calendarId: CAL, eventId: 'ev1' },
      title: 'Standup',
      startMs: BASE.startMs,
      endMs: BASE.endMs,
      allDay: false,
      hidden: false,
      materialized: false,
      htmlLink: BASE.htmlLink,
      orphaned: false,
      dirty: 'clean',
      dirtyFields: [],
    })
  })

  it('base only carries recurringEventId into the target', () => {
    const entry = mergePseudoEntry(CAL, { ...BASE, recurringEventId: 'series1' }, undefined)
    expect(entry?.target).toEqual({ calendarId: CAL, eventId: 'ev1', recurringEventId: 'series1' })
  })

  it('overlay only → orphaned entry rendered from snapshot + patch', () => {
    const entry = mergePseudoEntry(CAL, undefined, overlay({ title: 'Renamed' }))
    expect(entry).toEqual({
      id: 'ovl001',
      target: { calendarId: CAL, eventId: 'ev1' },
      title: 'Renamed',
      startMs: SNAP.startMs,
      endMs: SNAP.endMs,
      allDay: false,
      hidden: false,
      materialized: true,
      overlayId: 'ovl001',
      orphaned: true,
      dirty: 'clean', // no live base to diff against
      dirtyFields: [],
    })
  })

  it('both → materialized entry keyed by the overlay id, with htmlLink', () => {
    const entry = mergePseudoEntry(CAL, BASE, overlay({}))
    expect(entry).toMatchObject({
      id: 'ovl001',
      overlayId: 'ovl001',
      materialized: true,
      orphaned: false,
      htmlLink: BASE.htmlLink,
    })
  })

  it('a revoked overlay is treated as absent', () => {
    const revoked = overlay({ title: 'gone' }, { revoked: true })
    expect(mergePseudoEntry(CAL, BASE, revoked)).toMatchObject({
      id: `cal:${CAL}:ev1`,
      title: 'Standup',
      materialized: false,
    })
    expect(mergePseudoEntry(CAL, undefined, revoked)).toBeNull()
  })
})

describe('merge rule: patch wins, else LIVE base wins (never the snapshot)', () => {
  it('untouched fields track the live base after an upstream edit', () => {
    const live = movedBase({ summary: 'Standup (moved)', startMs: ms('09:30'), endMs: ms('10:30') })
    const entry = mergePseudoEntry(CAL, live, overlay({ note: 'just a note' }))
    expect(entry?.title).toBe('Standup (moved)')
    expect(entry?.startMs).toBe(ms('09:30'))
    expect(entry?.endMs).toBe(ms('10:30'))
    expect(entry?.note).toBe('just a note')
  })

  it('patch values win over both snapshot and live base', () => {
    const live = movedBase({ summary: 'Upstream rename' })
    const entry = mergePseudoEntry(
      CAL,
      live,
      overlay({ title: 'My title', startAt: '2026-08-02T08:00:00', endAt: '2026-08-02T08:45:00' }),
    )
    expect(entry?.title).toBe('My title')
    expect(entry?.startMs).toBe(ms('08:00'))
    expect(entry?.endMs).toBe(ms('08:45'))
  })

  it('startAt and endAt override independently (the other side stays live)', () => {
    const entry = mergePseudoEntry(CAL, BASE, overlay({ startAt: '2026-08-02T08:00:00' }))
    expect(entry?.startMs).toBe(ms('08:00'))
    expect(entry?.endMs).toBe(BASE.endMs)
  })

  it('hidden reflects the effective patch', () => {
    expect(mergePseudoEntry(CAL, BASE, overlay({ hidden: true }))?.hidden).toBe(true)
    expect(mergePseudoEntry(CAL, BASE, overlay({ hidden: false }))?.hidden).toBe(false)
    expect(mergePseudoEntry(CAL, BASE, overlay({}))?.hidden).toBe(false)
  })

  it('note is omitted (not undefined-valued) when the patch has none', () => {
    const entry = mergePseudoEntry(CAL, BASE, overlay({}))
    expect(entry).not.toBeNull()
    expect('note' in (entry as object)).toBe(false)
  })
})

describe('dirty classification matrix', () => {
  it('patch neither / base unchanged → clean', () => {
    const entry = mergePseudoEntry(CAL, BASE, overlay({ note: 'n' }))
    expect(entry?.dirty).toBe('clean')
    expect(entry?.dirtyFields).toEqual([])
  })

  it('patch neither / base title changed → auto-merged, no dirty fields', () => {
    const entry = mergePseudoEntry(CAL, movedBase({ summary: 'New name' }), overlay({ note: 'n' }))
    expect(entry?.dirty).toBe('auto-merged')
    expect(entry?.dirtyFields).toEqual([])
    expect(entry?.title).toBe('New name')
  })

  it('patch neither / base time changed → auto-merged', () => {
    const entry = mergePseudoEntry(CAL, movedBase({ startMs: ms('11:00') }), overlay({}))
    expect(entry?.dirty).toBe('auto-merged')
  })

  it('patch title / base unchanged → clean', () => {
    const entry = mergePseudoEntry(CAL, BASE, overlay({ title: 'Mine' }))
    expect(entry?.dirty).toBe('clean')
    expect(entry?.dirtyFields).toEqual([])
  })

  it('patch title / base title changed → conflict on title, user value still renders', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ summary: 'Theirs' }),
      overlay({ title: 'Mine' }),
    )
    expect(entry?.dirty).toBe('conflict')
    expect(entry?.dirtyFields).toEqual(['title'])
    expect(entry?.title).toBe('Mine') // the badge is informational; the edit wins
  })

  it('patch title / base time changed (untouched field) → auto-merged', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ startMs: ms('11:00'), endMs: ms('12:00') }),
      overlay({ title: 'Mine' }),
    )
    expect(entry?.dirty).toBe('auto-merged')
    expect(entry?.dirtyFields).toEqual([])
    expect(entry?.startMs).toBe(ms('11:00')) // live time flows through
  })

  it('patch time / base time changed → conflict on time, patched time renders', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ startMs: ms('11:00') }),
      overlay({ startAt: '2026-08-02T08:00:00' }),
    )
    expect(entry?.dirty).toBe('conflict')
    expect(entry?.dirtyFields).toEqual(['time'])
    expect(entry?.startMs).toBe(ms('08:00'))
  })

  it('patch endAt only / base end changed → conflict on time', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ endMs: ms('12:00') }),
      overlay({ endAt: '2026-08-02T10:15:00' }),
    )
    expect(entry?.dirty).toBe('conflict')
    expect(entry?.dirtyFields).toEqual(['time'])
  })

  it('patch time / base title changed → auto-merged', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ summary: 'Theirs' }),
      overlay({ startAt: '2026-08-02T08:00:00' }),
    )
    expect(entry?.dirty).toBe('auto-merged')
    expect(entry?.dirtyFields).toEqual([])
  })

  it('patch both / both changed → conflict on both fields', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ summary: 'Theirs', startMs: ms('11:00') }),
      overlay({ title: 'Mine', startAt: '2026-08-02T08:00:00' }),
    )
    expect(entry?.dirty).toBe('conflict')
    expect(entry?.dirtyFields).toEqual(['title', 'time'])
  })

  it('patch both / only title changed → conflict on title only', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ summary: 'Theirs' }),
      overlay({ title: 'Mine', startAt: '2026-08-02T08:00:00' }),
    )
    expect(entry?.dirty).toBe('conflict')
    expect(entry?.dirtyFields).toEqual(['title'])
  })

  it('an allDay flip counts as a time change', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ allDay: true }),
      overlay({ startAt: '2026-08-02T08:00:00' }),
    )
    expect(entry?.dirtyFields).toEqual(['time'])
  })

  it('note and hidden patches never produce dirty fields', () => {
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ summary: 'Theirs', startMs: ms('11:00') }),
      overlay({ note: 'n', hidden: true }),
    )
    expect(entry?.dirty).toBe('auto-merged')
    expect(entry?.dirtyFields).toEqual([])
  })

  it('trusts the updated-stamp fast path: matching stamps mean unchanged base', () => {
    // Contrived: summary text differs but `updated` matches the snapshot's —
    // the fast path short-circuits the field diff.
    const entry = mergePseudoEntry(
      CAL,
      { ...BASE, summary: 'Different text, same updated stamp' },
      overlay({ title: 'Mine' }),
    )
    expect(entry?.dirty).toBe('clean')
  })

  it('falls back to field comparison when either updated stamp is missing', () => {
    const snapNoUpdated = { ...SNAP }
    delete snapNoUpdated.updated
    const entry = mergePseudoEntry(
      CAL,
      movedBase({ summary: 'Theirs' }),
      overlay({ title: 'Mine' }, { baseSnapshot: snapNoUpdated }),
    )
    expect(entry?.dirty).toBe('conflict')
  })
})

describe('day-grouping start (effective startMs)', () => {
  it('uses the patched date when the patch moves the entry to another day', () => {
    const entry = mergePseudoEntry(CAL, BASE, overlay({ startAt: '2026-08-03T09:00:00' }))
    expect(entry?.startMs).toBe(new Date('2026-08-03T09:00:00').getTime())
  })

  it('follows the live base date when time is untouched', () => {
    const live = movedBase({
      startMs: new Date('2026-08-03T09:00:00').getTime(),
      endMs: new Date('2026-08-03T10:00:00').getTime(),
    })
    const entry = mergePseudoEntry(CAL, live, overlay({ title: 'Mine' }))
    expect(entry?.startMs).toBe(live.startMs)
  })

  it('falls back to the snapshot start for orphans', () => {
    const entry = mergePseudoEntry(CAL, undefined, overlay({}))
    expect(entry?.startMs).toBe(SNAP.startMs)
  })
})
