import { describe, expect, it } from 'vitest'
import type { AmendEvent, Attachment, CaptureEvent, RevokeEvent } from './types'
import { EVENT_SCHEMA } from './types'
import { fold } from './fold'

const STREAM = 'timelog'
const TZ = 'America/New_York'

function cap(seq: number, id: string, capturedAt: string, extra: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'capture',
    id,
    seq,
    stream: STREAM,
    loggedAt: capturedAt,
    deviceTz: TZ,
    capturedAt,
    attachments: [],
    ...extra,
  }
}

function amend(
  seq: number,
  targets: string[],
  patch?: AmendEvent['patch'],
  attachments?: Attachment[],
): AmendEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'amend',
    id: `am${seq}`,
    seq,
    stream: STREAM,
    loggedAt: '2026-08-02T12:00:00-04:00',
    deviceTz: TZ,
    targets,
    ...(patch ? { patch } : {}),
    ...(attachments ? { attachments } : {}),
  }
}

function revoke(seq: number, targets: string[]): RevokeEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'revoke',
    id: `rv${seq}`,
    seq,
    stream: STREAM,
    loggedAt: '2026-08-02T12:00:00-04:00',
    deviceTz: TZ,
    targets,
  }
}

describe('fold', () => {
  it('returns captures sorted by capturedAt', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T10:00:00-04:00'),
      cap(2, 'bbbbbb', '2026-08-02T08:00:00-04:00'),
      cap(3, 'cccccc', '2026-08-02T09:00:00-04:00'),
    ]
    expect(fold(events).map((e) => e.id)).toEqual(['bbbbbb', 'cccccc', 'aaaaaa'])
  })

  it('applies amend patches to capturedAt and location', () => {
    const loc = { lat: 40.7, lng: -74, accuracyM: 10, placeLabel: 'Office' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      amend(2, ['aaaaaa'], { capturedAt: '2026-08-02T08:45:00-04:00', location: loc }),
    ]
    const [entry] = fold(events)
    expect(entry.capturedAt).toBe('2026-08-02T08:45:00-04:00')
    expect(entry.location).toEqual(loc)
    expect(entry.seq).toBe(1)
  })

  it('appends amend attachments to the target entry', () => {
    const note: Attachment = { kind: 'text', file: '000002_x_note.txt', mimeType: 'text/plain' }
    const audio: Attachment = { kind: 'audio', file: '000001_x.m4a', mimeType: 'audio/mp4' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', { attachments: [audio] }),
      amend(2, ['aaaaaa'], undefined, [note]),
    ]
    expect(fold(events)[0].attachments).toEqual([audio, note])
  })

  it('drops revoked entries', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      cap(2, 'bbbbbb', '2026-08-02T10:00:00-04:00'),
      revoke(3, ['aaaaaa']),
    ]
    expect(fold(events).map((e) => e.id)).toEqual(['bbbbbb'])
  })

  it('flags instead of drops with includeRevoked', () => {
    const events = [cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'), revoke(2, ['aaaaaa'])]
    const entries = fold(events, { includeRevoked: true })
    expect(entries).toHaveLength(1)
    expect(entries[0].revoked).toBe(true)
    expect(entries[0].lastEventSeq).toBe(2)
  })

  it('ignores an amend after a revoke', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      revoke(2, ['aaaaaa']),
      amend(3, ['aaaaaa'], { capturedAt: '2026-08-02T07:00:00-04:00' }),
    ]
    const [entry] = fold(events, { includeRevoked: true })
    expect(entry.capturedAt).toBe('2026-08-02T09:00:00-04:00')
    expect(entry.lastEventSeq).toBe(2)
  })

  it('ignores an amend targeting an unknown id', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      amend(2, ['zzzzzz'], { capturedAt: '2026-08-02T07:00:00-04:00' }),
    ]
    const entries = fold(events)
    expect(entries).toHaveLength(1)
    expect(entries[0].capturedAt).toBe('2026-08-02T09:00:00-04:00')
    expect(entries[0].lastEventSeq).toBe(1)
  })

  it('applies multiple amends in seq order (last wins)', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      amend(3, ['aaaaaa'], { capturedAt: '2026-08-02T09:30:00-04:00' }),
      amend(2, ['aaaaaa'], { capturedAt: '2026-08-02T09:15:00-04:00' }),
    ]
    const [entry] = fold(events)
    expect(entry.capturedAt).toBe('2026-08-02T09:30:00-04:00')
    expect(entry.lastEventSeq).toBe(3)
  })

  it('orders entries by effective (amended) capturedAt', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      cap(2, 'bbbbbb', '2026-08-02T10:00:00-04:00'),
      amend(3, ['aaaaaa'], { capturedAt: '2026-08-02T11:00:00-04:00' }),
    ]
    expect(fold(events).map((e) => e.id)).toEqual(['bbbbbb', 'aaaaaa'])
  })
})
