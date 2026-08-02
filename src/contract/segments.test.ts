import { describe, expect, it } from 'vitest'
import { parseSegment, serializeSegment } from './segments'
import { serializeEvent, serializeEventLine } from './serialize'
import type { CaptureEvent, LogEvent, RevokeEvent } from './types'
import { EVENT_SCHEMA } from './types'

const capture: CaptureEvent = {
  schema: EVENT_SCHEMA,
  type: 'capture',
  id: 'f1a2b3',
  seq: 44,
  stream: 'timelog',
  loggedAt: '2026-08-02T18:02:33-04:00',
  deviceTz: 'America/New_York',
  capturedAt: '2026-08-02T18:02:33-04:00',
  attachments: [
    {
      kind: 'audio',
      file: '000044_2026-08-02T18-02-33-0400_f1a2b3.m4a',
      mimeType: 'audio/mp4',
      durationSec: 3.2,
    },
  ],
}

const revoke: RevokeEvent = {
  schema: EVENT_SCHEMA,
  type: 'revoke',
  id: 'a9c8d7',
  seq: 45,
  stream: 'timelog',
  loggedAt: '2026-08-02T18:04:01-04:00',
  deviceTz: 'America/New_York',
  targets: ['f1a2b3'],
}

describe('serializeEventLine', () => {
  it('is the compact single-line rendering of the exact record JSON (golden)', () => {
    expect(serializeEventLine(revoke)).toBe(
      '{"schema":"capture.event.v1","type":"revoke","id":"a9c8d7","seq":45,' +
        '"stream":"timelog","loggedAt":"2026-08-02T18:04:01-04:00",' +
        '"deviceTz":"America/New_York","targets":["f1a2b3"]}\n',
    )
  })

  it('carries the same JSON document as serializeEvent', () => {
    for (const e of [capture, revoke] as LogEvent[]) {
      expect(JSON.parse(serializeEventLine(e))).toEqual(JSON.parse(serializeEvent(e)))
    }
  })
})

describe('serializeSegment', () => {
  it('concatenates newline-terminated lines in log order (golden)', () => {
    const bytes = serializeSegment([revoke, capture]) // deliberately unsorted
    expect(bytes).toBe(serializeEventLine(capture) + serializeEventLine(revoke))
    expect(bytes.endsWith('\n')).toBe(true)
    expect(bytes.split('\n')).toHaveLength(3) // 2 lines + trailing ''
  })

  it('rejects an empty segment', () => {
    expect(() => serializeSegment([])).toThrow(/no events/)
  })
})

describe('parseSegment', () => {
  it('round-trips serializeSegment', () => {
    expect(parseSegment(serializeSegment([capture, revoke]))).toEqual([capture, revoke])
  })

  it('tolerates a missing final newline', () => {
    const bytes = serializeSegment([capture, revoke])
    expect(parseSegment(bytes.slice(0, -1))).toEqual([capture, revoke])
  })

  it('fails the whole segment on one malformed line, with its line number', () => {
    const bytes = serializeEventLine(capture) + '{nope\n' + serializeEventLine(revoke)
    expect(() => parseSegment(bytes)).toThrow(/invalid segment line 2/)
  })

  it('fails on a structurally invalid (but well-formed JSON) line', () => {
    const bytes = serializeEventLine(capture) + '{"schema":"other.v9"}\n'
    expect(() => parseSegment(bytes)).toThrow(/invalid segment line 2/)
  })

  it('rejects an empty body', () => {
    expect(() => parseSegment('')).toThrow(/empty/)
    expect(() => parseSegment('\n')).toThrow(/invalid segment/)
  })
})
