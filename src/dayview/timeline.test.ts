import { describe, expect, it } from 'vitest'
import type { Entry } from '../contract/types'
import type { CalEvent } from '../gcal/events'
import type { PseudoEntry } from '../gcal/overlay/pseudoEntry'
import { baseSnapshotOf, buildTimeline, groupTimeline } from './timeline'

function entry(id: string, capturedAt: string): Entry {
  return {
    id,
    seq: 1,
    stream: 'timelog',
    loggedAt: capturedAt,
    capturedAt,
    deviceTz: 'America/New_York',
    attachments: [],
    lastEventSeq: 1,
    revoked: false,
  }
}

function pseudo(id: string, startMs: number, over: Partial<PseudoEntry> = {}): PseudoEntry {
  return {
    id,
    target: { calendarId: 'cal@x', eventId: id },
    title: 'Event',
    startMs,
    endMs: startMs + 3_600_000,
    allDay: false,
    hidden: false,
    materialized: false,
    orphaned: false,
    dirty: 'clean',
    dirtyFields: [],
    ...over,
  }
}

const ms = (iso: string) => new Date(iso).getTime()

describe('buildTimeline', () => {
  it('interleaves real and pseudo entries by effective start ascending', () => {
    const e9 = entry('e9', '2026-08-02T09:30:00-04:00')
    const e13 = entry('e13', '2026-08-02T13:00:00-04:00')
    const p10 = pseudo('p10', ms('2026-08-02T10:00:00-04:00'))
    const p8 = pseudo('p8', ms('2026-08-02T08:00:00-04:00'))

    const items = buildTimeline([e9, e13], [p10, p8])
    expect(items.map(idOf)).toEqual(['p8', 'e9', 'p10', 'e13'])
  })

  it('uses the merged startMs for pseudo-entries (a patched time re-files the block)', () => {
    // The pseudo-entry's startMs is already the merge output; buildTimeline
    // must order by it, not by anything on the target event.
    const e = entry('e', '2026-08-02T09:00:00-04:00')
    const moved = pseudo('moved', ms('2026-08-02T11:00:00-04:00'), { materialized: true })
    expect(buildTimeline([e], [moved]).map(idOf)).toEqual(['e', 'moved'])
  })

  it('breaks start-time ties pseudo-first, then by id', () => {
    const at = '2026-08-02T09:00:00-04:00'
    const items = buildTimeline(
      [entry('e-b', at), entry('e-a', at)],
      [pseudo('p-b', ms(at)), pseudo('p-a', ms(at))],
    )
    expect(items.map(idOf)).toEqual(['p-a', 'p-b', 'e-a', 'e-b'])
  })

  it('handles either side empty', () => {
    expect(buildTimeline([], [])).toEqual([])
    const only = pseudo('p', ms('2026-08-02T08:00:00-04:00'))
    expect(buildTimeline([], [only]).map(idOf)).toEqual(['p'])
    const e = entry('e', '2026-08-02T08:00:00-04:00')
    expect(buildTimeline([e], []).map(idOf)).toEqual(['e'])
  })

  it('does not mutate its inputs', () => {
    const entries = [entry('e2', '2026-08-02T10:00:00-04:00'), entry('e1', '2026-08-02T09:00:00-04:00')]
    const before = entries.map((e) => e.id)
    buildTimeline(entries, [])
    expect(entries.map((e) => e.id)).toEqual(before)
  })
})

describe('groupTimeline', () => {
  it('groups consecutive real entries into runs and keeps pseudo-entries separate', () => {
    const items = buildTimeline(
      [
        entry('e1', '2026-08-02T09:00:00-04:00'),
        entry('e2', '2026-08-02T09:15:00-04:00'),
        entry('e3', '2026-08-02T12:00:00-04:00'),
      ],
      [pseudo('p1', ms('2026-08-02T10:00:00-04:00'))],
    )
    const groups = groupTimeline(items)
    expect(groups.map((g) => (g.kind === 'entries' ? g.entries.map((e) => e.id) : g.pseudo.id))).toEqual([
      ['e1', 'e2'],
      'p1',
      ['e3'],
    ])
  })

  it('returns no groups for an empty timeline', () => {
    expect(groupTimeline([])).toEqual([])
  })
})

describe('baseSnapshotOf', () => {
  const ev: CalEvent = {
    id: 'ev1',
    summary: 'Standup',
    startMs: 100,
    endMs: 200,
    allDay: false,
    updated: '2026-08-01T12:00:00.000Z',
  }

  it('freezes exactly the dirty-detection fields from the live event', () => {
    expect(baseSnapshotOf(ev)).toEqual({
      summary: 'Standup',
      startMs: 100,
      endMs: 200,
      allDay: false,
      updated: '2026-08-01T12:00:00.000Z',
    })
  })

  it('omits `updated` (not undefined-valued) when the fetch lacks it', () => {
    const { updated: _updated, ...withoutUpdated } = ev
    const snap = baseSnapshotOf(withoutUpdated)
    expect('updated' in snap).toBe(false)
  })
})

function idOf(item: ReturnType<typeof buildTimeline>[number]): string {
  return item.kind === 'entry' ? item.entry.id : item.pseudo.id
}
