import { describe, expect, it } from 'vitest'
import {
  compareOverlayEvents,
  foldOverlay,
  indexOverlaysByTarget,
  overlayKey,
} from './fold'
import type {
  CalendarEventRef,
  OverlayAmendEvent,
  OverlayBaseSnapshot,
  OverlayCreateEvent,
  OverlayPatch,
  OverlayRevokeEvent,
} from './types'
import { OVERLAY_SCHEMA, OVERLAY_STREAM } from './types'

const TZ = 'America/New_York'
const TARGET: CalendarEventRef = { calendarId: 'primary@example.com', eventId: 'ev1' }
const SNAPSHOT: OverlayBaseSnapshot = {
  summary: 'Standup',
  startMs: 1_000,
  endMs: 2_000,
  allDay: false,
}

function ov(
  seq: number,
  id: string,
  loggedAt: string,
  patch: OverlayPatch = {},
  target: CalendarEventRef = TARGET,
): OverlayCreateEvent {
  return {
    schema: OVERLAY_SCHEMA,
    type: 'overlay',
    id,
    seq,
    stream: OVERLAY_STREAM,
    loggedAt,
    deviceTz: TZ,
    target,
    baseSnapshot: SNAPSHOT,
    patch,
  }
}

function am(
  seq: number,
  id: string,
  loggedAt: string,
  targets: string[],
  patch?: OverlayPatch,
): OverlayAmendEvent {
  return {
    schema: OVERLAY_SCHEMA,
    type: 'amend',
    id,
    seq,
    stream: OVERLAY_STREAM,
    loggedAt,
    deviceTz: TZ,
    targets,
    ...(patch ? { patch } : {}),
  }
}

function rev(seq: number, id: string, loggedAt: string, targets: string[]): OverlayRevokeEvent {
  return {
    schema: OVERLAY_SCHEMA,
    type: 'revoke',
    id,
    seq,
    stream: OVERLAY_STREAM,
    loggedAt,
    deviceTz: TZ,
    targets,
  }
}

const T = (h: number) => `2026-08-02T${String(h).padStart(2, '0')}:00:00-04:00`

describe('foldOverlay create/amend/revoke', () => {
  it('folds a bare create into a state with its patch', () => {
    const states = foldOverlay([ov(1, 'aaaaaa', T(9), { title: 'Renamed' })])
    expect(states).toEqual([
      {
        id: 'aaaaaa',
        target: TARGET,
        baseSnapshot: SNAPSHOT,
        patch: { title: 'Renamed' },
        lastEventSeq: 1,
        revoked: false,
      },
    ])
  })

  it('normalizes clearX out of a create patch (value wins, clears drop)', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { title: 'Renamed', clearTitle: true, clearNote: true }),
    ])
    expect(states[0].patch).toEqual({ title: 'Renamed' })
  })

  it('applies amends and bumps lastEventSeq', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { title: 'Renamed' }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { note: 'brought donuts' }),
    ])
    expect(states[0].patch).toEqual({ title: 'Renamed', note: 'brought donuts' })
    expect(states[0].lastEventSeq).toBe(2)
  })

  it('tolerates an amend without a patch', () => {
    const states = foldOverlay([ov(1, 'aaaaaa', T(9), { title: 'X' }), am(2, 'bbbbbb', T(10), ['aaaaaa'])])
    expect(states[0].patch).toEqual({ title: 'X' })
    expect(states[0].lastEventSeq).toBe(2)
  })

  it('drops revoked overlays by default and flags them with includeRevoked', () => {
    const events = [ov(1, 'aaaaaa', T(9), { title: 'X' }), rev(2, 'bbbbbb', T(10), ['aaaaaa'])]
    expect(foldOverlay(events)).toEqual([])
    const kept = foldOverlay(events, { includeRevoked: true })
    expect(kept).toHaveLength(1)
    expect(kept[0].revoked).toBe(true)
    expect(kept[0].lastEventSeq).toBe(2)
  })

  it('ignores amends and revokes on a revoked overlay (no-op)', () => {
    const states = foldOverlay(
      [
        ov(1, 'aaaaaa', T(9), { title: 'X' }),
        rev(2, 'bbbbbb', T(10), ['aaaaaa']),
        am(3, 'cccccc', T(11), ['aaaaaa'], { title: 'too late' }),
        rev(4, 'dddddd', T(12), ['aaaaaa']),
      ],
      { includeRevoked: true },
    )
    expect(states[0].patch).toEqual({ title: 'X' })
    expect(states[0].lastEventSeq).toBe(2) // later no-ops leave it untouched
  })

  it('ignores amends and revokes on unknown targets', () => {
    const states = foldOverlay([
      am(1, 'aaaaaa', T(9), ['ghosts'], { title: 'X' }),
      rev(2, 'bbbbbb', T(10), ['ghosts']),
      ov(3, 'cccccc', T(11), {}),
    ])
    expect(states).toHaveLength(1)
    expect(states[0].id).toBe('cccccc')
  })

  it('applies one amend to multiple targets', () => {
    const other: CalendarEventRef = { calendarId: 'primary@example.com', eventId: 'ev2' }
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), {}),
      ov(2, 'bbbbbb', T(9), {}, other),
      am(3, 'cccccc', T(10), ['aaaaaa', 'bbbbbb'], { hidden: true }),
    ])
    expect(states.map((s) => s.patch)).toEqual([{ hidden: true }, { hidden: true }])
  })
})

describe('field-wise patch merge across amends', () => {
  const create = ov(1, 'aaaaaa', T(9), { title: 'Renamed' })

  it('a later amend on one field never clobbers earlier overrides on others', () => {
    const states = foldOverlay([
      create,
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { note: 'a note' }),
      am(3, 'cccccc', T(11), ['aaaaaa'], { startAt: T(8), endAt: T(9) }),
      am(4, 'dddddd', T(12), ['aaaaaa'], { hidden: true }),
    ])
    expect(states[0].patch).toEqual({
      title: 'Renamed',
      note: 'a note',
      startAt: T(8),
      endAt: T(9),
      hidden: true,
    })
  })

  it('a later value overwrites the same field', () => {
    const states = foldOverlay([
      create,
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { title: 'Renamed again' }),
    ])
    expect(states[0].patch).toEqual({ title: 'Renamed again' })
  })

  it('hidden false unhides after hidden true', () => {
    const states = foldOverlay([
      create,
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { hidden: true }),
      am(3, 'cccccc', T(11), ['aaaaaa'], { hidden: false }),
    ])
    expect(states[0].patch.hidden).toBe(false)
  })

  it('startAt and endAt merge independently', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { startAt: T(8) }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { endAt: T(11) }),
    ])
    expect(states[0].patch).toEqual({ startAt: T(8), endAt: T(11) })
  })
})

describe('clearX vs value precedence', () => {
  it('clearTitle removes a prior title override', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { title: 'X', note: 'kept' }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { clearTitle: true }),
    ])
    expect(states[0].patch).toEqual({ note: 'kept' })
  })

  it('clearNote removes a prior note', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { title: 'kept', note: 'X' }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { clearNote: true }),
    ])
    expect(states[0].patch).toEqual({ title: 'kept' })
  })

  it('clearTime removes both time overrides', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { startAt: T(8), endAt: T(9), title: 'kept' }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { clearTime: true }),
    ])
    expect(states[0].patch).toEqual({ title: 'kept' })
  })

  it('a value beats its clear sibling within the same amend, per field', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), {}),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { title: 'wins', clearTitle: true }),
      am(3, 'cccccc', T(11), ['aaaaaa'], { note: 'wins too', clearNote: true }),
    ])
    expect(states[0].patch).toEqual({ title: 'wins', note: 'wins too' })
  })

  it('clearTime is ignored when startAt or endAt is present in the same amend', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { startAt: T(7), endAt: T(8) }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { startAt: T(6), clearTime: true }),
    ])
    // startAt wins; the prior endAt override survives because clearTime was ignored.
    expect(states[0].patch).toEqual({ startAt: T(6), endAt: T(8) })
  })

  it('clears on one field do not disturb values set for another in the same amend', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { title: 'old', note: 'old' }),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { title: 'new', clearNote: true }),
    ])
    expect(states[0].patch).toEqual({ title: 'new' })
  })

  it('clearing a field that was never set is a no-op', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), {}),
      am(2, 'bbbbbb', T(10), ['aaaaaa'], { clearTitle: true, clearNote: true, clearTime: true }),
    ])
    expect(states[0].patch).toEqual({})
  })
})

describe('ordering and determinism (seq → loggedAt → id)', () => {
  it('compareOverlayEvents orders by seq, then loggedAt, then id', () => {
    const a = ov(1, 'zzzzzz', T(10))
    const b = ov(2, 'aaaaaa', T(9))
    expect(compareOverlayEvents(a, b)).toBeLessThan(0)
    const c = ov(1, 'zzzzzz', T(9))
    const d = ov(1, 'aaaaaa', T(10))
    expect(compareOverlayEvents(c, d)).toBeLessThan(0)
    const e = ov(1, 'aaaaaa', T(9))
    const f = ov(1, 'zzzzzz', T(9))
    expect(compareOverlayEvents(e, f)).toBeLessThan(0)
    expect(compareOverlayEvents(e, e)).toBe(0)
  })

  it('folds identically regardless of input order', () => {
    const create = ov(1, 'target', T(9), { title: 'X' })
    const amend = am(2, 'ammend', T(10), ['target'], { note: 'n' })
    const revokeOther = rev(3, 'revoke', T(11), ['nobody'])
    const orderings = [
      [create, amend, revokeOther],
      [amend, create, revokeOther],
      [revokeOther, amend, create],
      [amend, revokeOther, create],
      [create, revokeOther, amend],
      [revokeOther, create, amend],
    ]
    const results = orderings.map((events) => foldOverlay(events))
    for (let i = 1; i < results.length; i++) expect(results[i]).toEqual(results[0])
  })

  it('resolves colliding seqs by loggedAt then id (two-device amends)', () => {
    const create = ov(1, 'target', T(9), {})
    const amendA = am(2, 'aaaaaa', T(10), ['target'], { title: 'from A' })
    const amendB = am(2, 'bbbbbb', T(11), ['target'], { title: 'from B' })
    expect(foldOverlay([create, amendA, amendB])[0].patch.title).toBe('from B')
    expect(foldOverlay([amendB, amendA, create])[0].patch.title).toBe('from B')

    const amendC = am(2, 'zzzzzz', T(10), ['target'], { title: 'from C' })
    // Same seq and loggedAt: higher id wins.
    expect(foldOverlay([create, amendA, amendC])[0].patch.title).toBe('from C')
  })
})

describe('overlayKey / indexOverlaysByTarget', () => {
  it('keys by calendarId::eventId', () => {
    expect(overlayKey(TARGET)).toBe('primary@example.com::ev1')
    expect(overlayKey({ ...TARGET, recurringEventId: 'series' })).toBe(
      'primary@example.com::ev1',
    )
  })

  it('indexes states by target, later state winning duplicates', () => {
    const states = foldOverlay([
      ov(1, 'aaaaaa', T(9), { title: 'first' }),
      ov(2, 'bbbbbb', T(10), { title: 'second' }),
    ])
    const index = indexOverlaysByTarget(states)
    expect(index.size).toBe(1)
    expect(index.get(overlayKey(TARGET))?.id).toBe('bbbbbb')
  })
})
