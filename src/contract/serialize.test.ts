import { describe, expect, it } from 'vitest'
import type { AmendEvent, CaptureEvent, RevokeEvent } from './types'
import { EVENT_SCHEMA } from './types'
import { parseEvent, serializeEvent } from './serialize'

const STREAM = 'timelog'
const TZ = 'America/New_York'

const CAPTURE: CaptureEvent = {
  schema: EVENT_SCHEMA,
  type: 'capture',
  id: 'a1b2c3',
  seq: 41,
  stream: STREAM,
  loggedAt: '2026-08-02T09:04:11-04:00',
  deviceTz: TZ,
  capturedAt: '2026-08-02T09:04:11-04:00',
  location: { lat: 40.7128, lng: -74.006, accuracyM: 25, placeLabel: 'Office' },
  attachments: [
    {
      kind: 'audio',
      file: '000041_2026-08-02T09-04-11-0400_a1b2c3.m4a',
      mimeType: 'audio/mp4',
      durationSec: 3.2,
    },
  ],
}

const AMEND: AmendEvent = {
  schema: EVENT_SCHEMA,
  type: 'amend',
  id: 'd4e5f6',
  seq: 42,
  stream: STREAM,
  loggedAt: '2026-08-02T09:06:00-04:00',
  deviceTz: TZ,
  targets: ['a1b2c3'],
  patch: { capturedAt: '2026-08-02T08:40:00-04:00' },
}

/** Machine-derived transcript attached to a prior capture's audio. */
const TRANSCRIPT_AMEND: AmendEvent = {
  schema: EVENT_SCHEMA,
  type: 'amend',
  id: 'j1k2l3',
  seq: 44,
  stream: STREAM,
  loggedAt: '2026-08-02T09:08:00-04:00',
  deviceTz: TZ,
  targets: ['a1b2c3'],
  attachments: [
    {
      kind: 'text',
      file: '000044_2026-08-02T09-08-00-0400_j1k2l3_note.txt',
      mimeType: 'text/plain',
      derivedFrom: '000041_2026-08-02T09-04-11-0400_a1b2c3.m4a',
    },
  ],
}

/** Edited note: one amend removes the old text file and adds its replacement. */
const EDIT_AMEND: AmendEvent = {
  schema: EVENT_SCHEMA,
  type: 'amend',
  id: 'm4n5o6',
  seq: 45,
  stream: STREAM,
  loggedAt: '2026-08-02T09:09:00-04:00',
  deviceTz: TZ,
  targets: ['a1b2c3'],
  patch: { removeAttachments: ['000044_2026-08-02T09-08-00-0400_j1k2l3_note.txt'] },
  attachments: [
    {
      kind: 'text',
      file: '000045_2026-08-02T09-09-00-0400_m4n5o6_note.txt',
      mimeType: 'text/plain',
      derivedFrom: '000041_2026-08-02T09-04-11-0400_a1b2c3.m4a',
    },
  ],
}

const REVOKE: RevokeEvent = {
  schema: EVENT_SCHEMA,
  type: 'revoke',
  id: 'g7h8i9',
  seq: 43,
  stream: STREAM,
  loggedAt: '2026-08-02T09:07:30-04:00',
  deviceTz: TZ,
  targets: ['a1b2c3'],
}

describe('serializeEvent golden files (SPEC §5.2)', () => {
  it('serializes a capture event byte-for-byte', () => {
    expect(serializeEvent(CAPTURE)).toBe(`{
  "schema": "capture.event.v1",
  "type": "capture",
  "id": "a1b2c3",
  "seq": 41,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:04:11-04:00",
  "deviceTz": "America/New_York",
  "capturedAt": "2026-08-02T09:04:11-04:00",
  "location": {
    "lat": 40.7128,
    "lng": -74.006,
    "accuracyM": 25,
    "placeLabel": "Office"
  },
  "attachments": [
    {
      "kind": "audio",
      "file": "000041_2026-08-02T09-04-11-0400_a1b2c3.m4a",
      "mimeType": "audio/mp4",
      "durationSec": 3.2
    }
  ]
}
`)
  })

  it('serializes an amend event byte-for-byte', () => {
    expect(serializeEvent(AMEND)).toBe(`{
  "schema": "capture.event.v1",
  "type": "amend",
  "id": "d4e5f6",
  "seq": 42,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:06:00-04:00",
  "deviceTz": "America/New_York",
  "targets": [
    "a1b2c3"
  ],
  "patch": {
    "capturedAt": "2026-08-02T08:40:00-04:00"
  }
}
`)
  })

  it('serializes a transcript amend byte-for-byte (derivedFrom last)', () => {
    expect(serializeEvent(TRANSCRIPT_AMEND)).toBe(`{
  "schema": "capture.event.v1",
  "type": "amend",
  "id": "j1k2l3",
  "seq": 44,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:08:00-04:00",
  "deviceTz": "America/New_York",
  "targets": [
    "a1b2c3"
  ],
  "attachments": [
    {
      "kind": "text",
      "file": "000044_2026-08-02T09-08-00-0400_j1k2l3_note.txt",
      "mimeType": "text/plain",
      "derivedFrom": "000041_2026-08-02T09-04-11-0400_a1b2c3.m4a"
    }
  ]
}
`)
  })

  it('serializes an edit amend byte-for-byte (removeAttachments in patch)', () => {
    expect(serializeEvent(EDIT_AMEND)).toBe(`{
  "schema": "capture.event.v1",
  "type": "amend",
  "id": "m4n5o6",
  "seq": 45,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:09:00-04:00",
  "deviceTz": "America/New_York",
  "targets": [
    "a1b2c3"
  ],
  "patch": {
    "removeAttachments": [
      "000044_2026-08-02T09-08-00-0400_j1k2l3_note.txt"
    ]
  },
  "attachments": [
    {
      "kind": "text",
      "file": "000045_2026-08-02T09-09-00-0400_m4n5o6_note.txt",
      "mimeType": "text/plain",
      "derivedFrom": "000041_2026-08-02T09-04-11-0400_a1b2c3.m4a"
    }
  ]
}
`)
  })

  it('serializes a revoke event byte-for-byte', () => {
    expect(serializeEvent(REVOKE)).toBe(`{
  "schema": "capture.event.v1",
  "type": "revoke",
  "id": "g7h8i9",
  "seq": 43,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:07:30-04:00",
  "deviceTz": "America/New_York",
  "targets": [
    "a1b2c3"
  ]
}
`)
  })
})

describe('parseEvent round-trips', () => {
  it('round-trips each event type', () => {
    expect(parseEvent(serializeEvent(CAPTURE))).toEqual(CAPTURE)
    expect(parseEvent(serializeEvent(AMEND))).toEqual(AMEND)
    expect(parseEvent(serializeEvent(TRANSCRIPT_AMEND))).toEqual(TRANSCRIPT_AMEND)
    expect(parseEvent(serializeEvent(EDIT_AMEND))).toEqual(EDIT_AMEND)
    expect(parseEvent(serializeEvent(REVOKE))).toEqual(REVOKE)
  })

  it('round-trips a capture without location', () => {
    const e: CaptureEvent = { ...CAPTURE, location: undefined }
    delete e.location
    const parsed = parseEvent(serializeEvent(e))
    expect(parsed).toEqual(e)
    expect('location' in parsed).toBe(false)
  })

  it('round-trips an amend without patch or attachments', () => {
    const e: AmendEvent = { ...AMEND }
    delete e.patch
    const parsed = parseEvent(serializeEvent(e))
    expect(parsed).toEqual(e)
    expect('patch' in parsed).toBe(false)
    expect('attachments' in parsed).toBe(false)
  })

  it('round-trips an amend with removeAttachments and a location patch', () => {
    const e: AmendEvent = {
      ...AMEND,
      patch: {
        location: { lat: 40.7, lng: -74, accuracyM: 10 },
        removeAttachments: ['000041_2026-08-02T09-04-11-0400_a1b2c3.m4a'],
      },
    }
    expect(parseEvent(serializeEvent(e))).toEqual(e)
  })
})

describe('parseEvent validation', () => {
  it('rejects a wrong schema', () => {
    const bad = serializeEvent(CAPTURE).replace('capture.event.v1', 'capture.event.v2')
    expect(() => parseEvent(bad)).toThrow(/schema/)
  })

  it('rejects an unknown type', () => {
    const bad = serializeEvent(REVOKE).replace('"revoke"', '"delete"')
    expect(() => parseEvent(bad)).toThrow(/unknown type/)
  })

  it('rejects a missing required field', () => {
    const bad = serializeEvent(REVOKE).replace('  "loggedAt": "2026-08-02T09:07:30-04:00",\n', '')
    expect(() => parseEvent(bad)).toThrow(/loggedAt/)
  })

  it('rejects non-JSON and non-object input', () => {
    expect(() => parseEvent('not json')).toThrow(/invalid event record: not valid JSON/)
    expect(() => parseEvent('[]')).toThrow(/invalid event record: not a JSON object/)
    expect(() => parseEvent('null')).toThrow(/not a JSON object/)
    expect(() => parseEvent('"capture"')).toThrow(/not a JSON object/)
  })

  it('rejects each missing or non-string envelope field', () => {
    for (const key of ['id', 'stream', 'loggedAt', 'deviceTz'] as const) {
      const missing: Record<string, unknown> = { ...REVOKE }
      delete missing[key]
      expect(() => parseEvent(JSON.stringify(missing))).toThrow(new RegExp(`missing or invalid ${key}`))
      expect(() => parseEvent(JSON.stringify({ ...REVOKE, [key]: 42 }))).toThrow(new RegExp(key))
    }
  })

  it('rejects a non-number seq', () => {
    const bad = serializeEvent(REVOKE).replace('"seq": 43', '"seq": "43"')
    expect(() => parseEvent(bad)).toThrow(/missing or invalid seq/)
  })

  it('rejects a capture without capturedAt', () => {
    const bad: Record<string, unknown> = { ...CAPTURE }
    delete bad.capturedAt
    expect(() => parseEvent(JSON.stringify(bad))).toThrow(/missing or invalid capturedAt/)
  })

  it('rejects a capture without an attachments array', () => {
    const bad: Record<string, unknown> = { ...CAPTURE }
    delete bad.attachments
    expect(() => parseEvent(JSON.stringify(bad))).toThrow(/missing or invalid attachments/)
  })

  it('rejects amend and revoke without a targets array', () => {
    for (const event of [AMEND, REVOKE]) {
      const bad: Record<string, unknown> = { ...event }
      delete bad.targets
      expect(() => parseEvent(JSON.stringify(bad))).toThrow(/missing or invalid targets/)
    }
  })
})
