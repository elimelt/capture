/**
 * Edge case tests for serialize/parseEvent — validates byte stability,
 * round-trip correctness, and error handling for malformed inputs.
 */
import { describe, expect, it } from 'vitest'
import type { AmendEvent, CaptureEvent, RevokeEvent } from './types'
import { EVENT_SCHEMA } from './types'
import { parseEvent, serializeEvent } from './serialize'

const BASE_CAPTURE: CaptureEvent = {
  schema: EVENT_SCHEMA,
  type: 'capture',
  id: 'aaaaaa',
  seq: 1,
  stream: 'timelog',
  loggedAt: '2026-08-02T09:00:00-04:00',
  deviceTz: 'America/New_York',
  capturedAt: '2026-08-02T09:00:00-04:00',
  attachments: [],
}

describe('serializeEvent byte stability', () => {
  it('produces deterministic output for the same event', () => {
    const json1 = serializeEvent(BASE_CAPTURE)
    const json2 = serializeEvent(BASE_CAPTURE)
    expect(json1).toBe(json2)
  })

  it('produces deterministic output regardless of object property order', () => {
    // Create same event with different property insertion order
    const event1: CaptureEvent = {
      schema: EVENT_SCHEMA,
      type: 'capture',
      id: 'aaaaaa',
      seq: 1,
      stream: 'timelog',
      loggedAt: '2026-08-02T09:00:00-04:00',
      deviceTz: 'America/New_York',
      capturedAt: '2026-08-02T09:00:00-04:00',
      attachments: [],
    }
    const event2: CaptureEvent = {
      deviceTz: 'America/New_York',
      attachments: [],
      capturedAt: '2026-08-02T09:00:00-04:00',
      id: 'aaaaaa',
      loggedAt: '2026-08-02T09:00:00-04:00',
      schema: EVENT_SCHEMA,
      seq: 1,
      stream: 'timelog',
      type: 'capture',
    }
    expect(serializeEvent(event1)).toBe(serializeEvent(event2))
  })

  it('ends with a trailing newline', () => {
    const json = serializeEvent(BASE_CAPTURE)
    expect(json.endsWith('\n')).toBe(true)
    expect(json.endsWith('\n\n')).toBe(false)
  })

  it('uses 2-space indentation', () => {
    const json = serializeEvent(BASE_CAPTURE)
    expect(json).toContain('\n  "')
    expect(json).not.toContain('\t')
  })

  it('maintains fixed key order for envelope fields', () => {
    const json = serializeEvent(BASE_CAPTURE)
    const schemaPos = json.indexOf('"schema"')
    const typePos = json.indexOf('"type"')
    const idPos = json.indexOf('"id"')
    const seqPos = json.indexOf('"seq"')
    const streamPos = json.indexOf('"stream"')
    const loggedAtPos = json.indexOf('"loggedAt"')
    const deviceTzPos = json.indexOf('"deviceTz"')

    expect(schemaPos).toBeLessThan(typePos)
    expect(typePos).toBeLessThan(idPos)
    expect(idPos).toBeLessThan(seqPos)
    expect(seqPos).toBeLessThan(streamPos)
    expect(streamPos).toBeLessThan(loggedAtPos)
    expect(loggedAtPos).toBeLessThan(deviceTzPos)
  })
})

describe('parseEvent/serializeEvent round-trip', () => {
  it('round-trips a capture event', () => {
    const event: CaptureEvent = {
      ...BASE_CAPTURE,
      location: { lat: 40.7, lng: -74.0, accuracyM: 10, placeLabel: 'Office', address: 'NYC' },
      attachments: [
        { kind: 'audio', file: '000001_x.m4a', mimeType: 'audio/mp4', durationSec: 3.5 },
        { kind: 'text', file: '000001_x_note.txt', mimeType: 'text/plain', derivedFrom: '000001_x.m4a' },
      ],
    }
    expect(parseEvent(serializeEvent(event))).toEqual(event)
  })

  it('round-trips an amend event with all patch fields', () => {
    const event: AmendEvent = {
      schema: EVENT_SCHEMA,
      type: 'amend',
      id: 'bbbbbb',
      seq: 2,
      stream: 'timelog',
      loggedAt: '2026-08-02T10:00:00-04:00',
      deviceTz: 'America/New_York',
      targets: ['aaaaaa'],
      patch: {
        capturedAt: '2026-08-02T08:00:00-04:00',
        location: { lat: 40.7, lng: -74.0, accuracyM: 5 },
        removeAttachments: ['old.m4a'],
      },
      attachments: [{ kind: 'text', file: 'new_note.txt', mimeType: 'text/plain' }],
    }
    expect(parseEvent(serializeEvent(event))).toEqual(event)
  })

  it('round-trips a revoke event', () => {
    const event: RevokeEvent = {
      schema: EVENT_SCHEMA,
      type: 'revoke',
      id: 'cccccc',
      seq: 3,
      stream: 'timelog',
      loggedAt: '2026-08-02T11:00:00-04:00',
      deviceTz: 'America/New_York',
      targets: ['aaaaaa', 'bbbbbb'],
    }
    expect(parseEvent(serializeEvent(event))).toEqual(event)
  })

  it('drops clearLocation when location is present (precedence rule)', () => {
    const event: AmendEvent = {
      schema: EVENT_SCHEMA,
      type: 'amend',
      id: 'dddddd',
      seq: 4,
      stream: 'timelog',
      loggedAt: '2026-08-02T12:00:00-04:00',
      deviceTz: 'America/New_York',
      targets: ['aaaaaa'],
      patch: {
        location: { lat: 40.7, lng: -74.0, accuracyM: 5 },
        clearLocation: true, // Should be dropped from wire
      },
    }
    const json = serializeEvent(event)
    expect(json).not.toContain('clearLocation')
    // The parsed event won't have clearLocation
    const parsed = parseEvent(json)
    expect((parsed as AmendEvent).patch?.clearLocation).toBeUndefined()
  })
})

describe('parseEvent error handling', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseEvent('{')).toThrow('invalid event record: not valid JSON')
  })

  it('rejects non-object JSON', () => {
    expect(() => parseEvent('"hello"')).toThrow('invalid event record: not a JSON object')
    expect(() => parseEvent('[]')).toThrow('invalid event record: not a JSON object')
    expect(() => parseEvent('null')).toThrow('invalid event record: not a JSON object')
  })

  it('rejects wrong schema', () => {
    const bad = JSON.stringify({ schema: 'wrong.v1', type: 'capture' })
    expect(() => parseEvent(bad)).toThrow('schema must be "capture.event.v1"')
  })

  it('rejects unknown type', () => {
    const bad = JSON.stringify({ schema: EVENT_SCHEMA, type: 'unknown' })
    expect(() => parseEvent(bad)).toThrow('unknown type')
  })

  it('rejects missing envelope fields', () => {
    const base = { schema: EVENT_SCHEMA, type: 'capture', seq: 1 }
    expect(() => parseEvent(JSON.stringify(base))).toThrow('missing or invalid id')
  })
})
