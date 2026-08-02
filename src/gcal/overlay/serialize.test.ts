import { describe, expect, it } from 'vitest'
import { parseOverlayEvent, serializeOverlayEvent } from './serialize'
import type { OverlayAmendEvent, OverlayCreateEvent, OverlayRevokeEvent } from './types'
import { OVERLAY_SCHEMA, OVERLAY_STREAM } from './types'

const TZ = 'America/New_York'

const CREATE: OverlayCreateEvent = {
  schema: OVERLAY_SCHEMA,
  type: 'overlay',
  id: 'a1b2c3',
  seq: 7,
  stream: OVERLAY_STREAM,
  loggedAt: '2026-08-02T09:04:11-04:00',
  deviceTz: TZ,
  target: {
    calendarId: 'primary@example.com',
    eventId: 'ev1_20260802T130000Z',
    recurringEventId: 'ev1',
  },
  baseSnapshot: {
    summary: 'Standup',
    startMs: 1785675600000,
    endMs: 1785679200000,
    allDay: false,
    updated: '2026-08-01T12:00:00.000Z',
  },
  patch: {
    title: 'Standup (ran long)',
    note: 'demo day',
    startAt: '2026-08-02T09:00:00-04:00',
    endAt: '2026-08-02T10:30:00-04:00',
    hidden: false,
  },
}

const AMEND: OverlayAmendEvent = {
  schema: OVERLAY_SCHEMA,
  type: 'amend',
  id: 'd4e5f6',
  seq: 8,
  stream: OVERLAY_STREAM,
  loggedAt: '2026-08-02T09:06:00-04:00',
  deviceTz: TZ,
  targets: ['a1b2c3'],
  patch: { clearTitle: true, clearNote: true, clearTime: true, hidden: true },
}

const REVOKE: OverlayRevokeEvent = {
  schema: OVERLAY_SCHEMA,
  type: 'revoke',
  id: 'g7h8i9',
  seq: 9,
  stream: OVERLAY_STREAM,
  loggedAt: '2026-08-02T09:07:30-04:00',
  deviceTz: TZ,
  targets: ['a1b2c3'],
}

describe('serializeOverlayEvent golden files (SPEC §5.6)', () => {
  it('serializes an overlay create byte-for-byte', () => {
    expect(serializeOverlayEvent(CREATE)).toBe(`{
  "schema": "capture.calendar-overlay.v1",
  "type": "overlay",
  "id": "a1b2c3",
  "seq": 7,
  "stream": "calendar-overlay",
  "loggedAt": "2026-08-02T09:04:11-04:00",
  "deviceTz": "America/New_York",
  "target": {
    "calendarId": "primary@example.com",
    "eventId": "ev1_20260802T130000Z",
    "recurringEventId": "ev1"
  },
  "baseSnapshot": {
    "summary": "Standup",
    "startMs": 1785675600000,
    "endMs": 1785679200000,
    "allDay": false,
    "updated": "2026-08-01T12:00:00.000Z"
  },
  "patch": {
    "title": "Standup (ran long)",
    "note": "demo day",
    "startAt": "2026-08-02T09:00:00-04:00",
    "endAt": "2026-08-02T10:30:00-04:00",
    "hidden": false
  }
}
`)
  })

  it('serializes an all-clears amend byte-for-byte', () => {
    expect(serializeOverlayEvent(AMEND)).toBe(`{
  "schema": "capture.calendar-overlay.v1",
  "type": "amend",
  "id": "d4e5f6",
  "seq": 8,
  "stream": "calendar-overlay",
  "loggedAt": "2026-08-02T09:06:00-04:00",
  "deviceTz": "America/New_York",
  "targets": [
    "a1b2c3"
  ],
  "patch": {
    "clearTitle": true,
    "clearNote": true,
    "clearTime": true,
    "hidden": true
  }
}
`)
  })

  it('serializes a revoke byte-for-byte', () => {
    expect(serializeOverlayEvent(REVOKE)).toBe(`{
  "schema": "capture.calendar-overlay.v1",
  "type": "revoke",
  "id": "g7h8i9",
  "seq": 9,
  "stream": "calendar-overlay",
  "loggedAt": "2026-08-02T09:07:30-04:00",
  "deviceTz": "America/New_York",
  "targets": [
    "a1b2c3"
  ]
}
`)
  })

  it('serializes a minimal create (no optional fields, empty patch)', () => {
    const minimal: OverlayCreateEvent = {
      ...CREATE,
      target: { calendarId: 'primary@example.com', eventId: 'ev2' },
      baseSnapshot: { summary: 'Lunch', startMs: 1, endMs: 2, allDay: true },
      patch: {},
    }
    expect(serializeOverlayEvent(minimal)).toBe(`{
  "schema": "capture.calendar-overlay.v1",
  "type": "overlay",
  "id": "a1b2c3",
  "seq": 7,
  "stream": "calendar-overlay",
  "loggedAt": "2026-08-02T09:04:11-04:00",
  "deviceTz": "America/New_York",
  "target": {
    "calendarId": "primary@example.com",
    "eventId": "ev2"
  },
  "baseSnapshot": {
    "summary": "Lunch",
    "startMs": 1,
    "endMs": 2,
    "allDay": true
  },
  "patch": {}
}
`)
  })
})

describe('parseOverlayEvent round-trips', () => {
  it('round-trips each event type', () => {
    expect(parseOverlayEvent(serializeOverlayEvent(CREATE))).toEqual(CREATE)
    expect(parseOverlayEvent(serializeOverlayEvent(AMEND))).toEqual(AMEND)
    expect(parseOverlayEvent(serializeOverlayEvent(REVOKE))).toEqual(REVOKE)
  })

  it('round-trips an amend without a patch', () => {
    const e: OverlayAmendEvent = { ...AMEND }
    delete e.patch
    const parsed = parseOverlayEvent(serializeOverlayEvent(e))
    expect(parsed).toEqual(e)
    expect('patch' in parsed).toBe(false)
  })

  it('omits optional target/snapshot fields entirely when absent', () => {
    const e: OverlayCreateEvent = {
      ...CREATE,
      target: { calendarId: 'c', eventId: 'e' },
      baseSnapshot: { summary: 's', startMs: 1, endMs: 2, allDay: false },
    }
    const wire = serializeOverlayEvent(e)
    expect(wire).not.toContain('recurringEventId')
    expect(wire).not.toContain('updated')
    expect(parseOverlayEvent(wire)).toEqual(e)
  })

  it('omits each clearX from the wire when its value is present', () => {
    const e: OverlayAmendEvent = {
      ...AMEND,
      patch: {
        title: 'kept',
        clearTitle: true,
        note: 'kept',
        clearNote: true,
        startAt: '2026-08-02T09:00:00-04:00',
        clearTime: true,
      },
    }
    const parsed = parseOverlayEvent(serializeOverlayEvent(e)) as OverlayAmendEvent
    expect(parsed.patch).toEqual({
      title: 'kept',
      note: 'kept',
      startAt: '2026-08-02T09:00:00-04:00',
    })
  })

  it('keeps clearTime only when both startAt and endAt are absent', () => {
    const withEnd: OverlayAmendEvent = {
      ...AMEND,
      patch: { endAt: '2026-08-02T10:00:00-04:00', clearTime: true },
    }
    expect((parseOverlayEvent(serializeOverlayEvent(withEnd)) as OverlayAmendEvent).patch).toEqual(
      { endAt: '2026-08-02T10:00:00-04:00' },
    )
    const alone: OverlayAmendEvent = { ...AMEND, patch: { clearTime: true } }
    expect((parseOverlayEvent(serializeOverlayEvent(alone)) as OverlayAmendEvent).patch).toEqual({
      clearTime: true,
    })
  })
})

describe('parseOverlayEvent validation', () => {
  it('rejects a wrong schema', () => {
    const bad = serializeOverlayEvent(CREATE).replace(
      'capture.calendar-overlay.v1',
      'capture.event.v1',
    )
    expect(() => parseOverlayEvent(bad)).toThrow(/schema/)
  })

  it('rejects an unknown type', () => {
    const bad = serializeOverlayEvent(REVOKE).replace('"revoke"', '"delete"')
    expect(() => parseOverlayEvent(bad)).toThrow(/unknown type/)
  })

  it('rejects non-JSON and non-object input', () => {
    expect(() => parseOverlayEvent('nope')).toThrow(/not valid JSON/)
    expect(() => parseOverlayEvent('[]')).toThrow(/not a JSON object/)
    expect(() => parseOverlayEvent('null')).toThrow(/not a JSON object/)
  })

  it('rejects each missing or non-string envelope field', () => {
    for (const key of ['id', 'stream', 'loggedAt', 'deviceTz'] as const) {
      const missing: Record<string, unknown> = { ...REVOKE }
      delete missing[key]
      expect(() => parseOverlayEvent(JSON.stringify(missing))).toThrow(
        new RegExp(`missing or invalid ${key}`),
      )
      expect(() => parseOverlayEvent(JSON.stringify({ ...REVOKE, [key]: 42 }))).toThrow(
        new RegExp(key),
      )
    }
  })

  it('rejects a non-number seq', () => {
    const bad = serializeOverlayEvent(REVOKE).replace('"seq": 9', '"seq": "9"')
    expect(() => parseOverlayEvent(bad)).toThrow(/missing or invalid seq/)
  })

  it('rejects a create missing target, baseSnapshot, or patch', () => {
    for (const key of ['target', 'baseSnapshot', 'patch'] as const) {
      const bad: Record<string, unknown> = { ...CREATE }
      delete bad[key]
      expect(() => parseOverlayEvent(JSON.stringify(bad))).toThrow(
        new RegExp(`missing or invalid ${key}`),
      )
    }
  })

  it('rejects bad target and snapshot field types', () => {
    expect(() =>
      parseOverlayEvent(JSON.stringify({ ...CREATE, target: { eventId: 'e' } })),
    ).toThrow(/target\.calendarId/)
    expect(() =>
      parseOverlayEvent(JSON.stringify({ ...CREATE, target: { calendarId: 'c' } })),
    ).toThrow(/target\.eventId/)
    const snap = CREATE.baseSnapshot
    expect(() =>
      parseOverlayEvent(JSON.stringify({ ...CREATE, baseSnapshot: { ...snap, summary: 1 } })),
    ).toThrow(/baseSnapshot\.summary/)
    expect(() =>
      parseOverlayEvent(JSON.stringify({ ...CREATE, baseSnapshot: { ...snap, startMs: 'x' } })),
    ).toThrow(/baseSnapshot\.startMs/)
    expect(() =>
      parseOverlayEvent(JSON.stringify({ ...CREATE, baseSnapshot: { ...snap, endMs: 'x' } })),
    ).toThrow(/baseSnapshot\.endMs/)
    expect(() =>
      parseOverlayEvent(JSON.stringify({ ...CREATE, baseSnapshot: { ...snap, allDay: 'no' } })),
    ).toThrow(/baseSnapshot\.allDay/)
  })

  it('rejects amend and revoke without a targets array', () => {
    for (const event of [AMEND, REVOKE]) {
      const bad: Record<string, unknown> = { ...event }
      delete bad.targets
      expect(() => parseOverlayEvent(JSON.stringify(bad))).toThrow(/missing or invalid targets/)
    }
  })
})
