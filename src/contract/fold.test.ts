import { describe, expect, it } from 'vitest'
import type { AmendEvent, Attachment, CaptureEvent, RevokeEvent } from './types'
import { EVENT_SCHEMA } from './types'
import { fold } from './fold'
import { parseEvent, serializeEvent } from './serialize'

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

  it('clears the location via patch.clearLocation', () => {
    const loc = { lat: 40.7, lng: -74, accuracyM: 10, placeLabel: 'Office' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', { location: loc }),
      amend(2, ['aaaaaa'], { clearLocation: true }),
    ]
    expect(fold(events)[0].location).toBeUndefined()
  })

  it('prefers patch.location over clearLocation when both are present', () => {
    const loc = { lat: 40.7, lng: -74, accuracyM: 10 }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      amend(2, ['aaaaaa'], { location: loc, clearLocation: true }),
    ]
    expect(fold(events)[0].location).toEqual(loc)
  })

  it('appends amend attachments to the target entry', () => {
    const note: Attachment = { kind: 'text', file: '000002_x_note.txt', mimeType: 'text/plain' }
    const audio: Attachment = { kind: 'audio', file: '000001_x.m4a', mimeType: 'audio/mp4' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', { attachments: [audio] }),
      amend(2, ['aaaaaa'], undefined, [note]),
    ]
    expect(fold(events)[0].attachments).toEqual([audio, note])
    expect(fold(events)[0].attachmentLoggedAt).toEqual({
      [audio.file]: '2026-08-02T09:00:00-04:00',
      [note.file]: '2026-08-02T12:00:00-04:00',
    })
  })

  it('hides attachments named in patch.removeAttachments', () => {
    const note: Attachment = { kind: 'text', file: '000002_x_note.txt', mimeType: 'text/plain' }
    const photo: Attachment = { kind: 'photo', file: '000001_x_photo.jpg', mimeType: 'image/jpeg' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', { attachments: [photo] }),
      amend(2, ['aaaaaa'], undefined, [note]),
      amend(3, ['aaaaaa'], { removeAttachments: [photo.file] }),
    ]
    expect(fold(events)[0].attachments).toEqual([note])
  })

  it('applies removals before additions within one amend (note edit)', () => {
    const old: Attachment = { kind: 'text', file: '000001_x_note.txt', mimeType: 'text/plain' }
    const edited: Attachment = { kind: 'text', file: '000002_y_note.txt', mimeType: 'text/plain' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', { attachments: [old] }),
      amend(2, ['aaaaaa'], { removeAttachments: [old.file] }, [edited]),
    ]
    expect(fold(events)[0].attachments).toEqual([edited])
  })

  it('ignores removal of an unknown attachment file', () => {
    const note: Attachment = { kind: 'text', file: '000001_x_note.txt', mimeType: 'text/plain' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', { attachments: [note] }),
      amend(2, ['aaaaaa'], { removeAttachments: ['no-such-file.txt'] }),
    ]
    expect(fold(events)[0].attachments).toEqual([note])
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

  it('ignores a revoke targeting an unknown id', () => {
    const events = [cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'), revoke(2, ['zzzzzz'])]
    const entries = fold(events)
    expect(entries).toHaveLength(1)
    expect(entries[0].revoked).toBe(false)
    expect(entries[0].lastEventSeq).toBe(1)
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

  it('breaks equal-capturedAt ties by seq', () => {
    const t = '2026-08-02T09:00:00-04:00'
    const events = [cap(2, 'bbbbbb', t), cap(3, 'cccccc', t), cap(1, 'aaaaaa', t)]
    expect(fold(events).map((e) => e.id)).toEqual(['aaaaaa', 'bbbbbb', 'cccccc'])
  })

  it('breaks a cross-device seq collision by loggedAt then id (Design C)', () => {
    // Two devices offline-minted seq 1; identity is the id, seq is a hint.
    const early = cap(1, 'zzzzzz', '2026-08-02T09:00:00-04:00')
    const late = cap(1, 'aaaaaa', '2026-08-02T10:00:00-04:00')
    const entries = fold([late, early])
    expect(entries.map((e) => e.id)).toEqual(['zzzzzz', 'aaaaaa'])
    // Same seq, same capturedAt → final order falls back to id.
    const t = '2026-08-02T09:00:00-04:00'
    expect(fold([cap(1, 'bbbbbb', t), cap(1, 'aaaaaa', t)]).map((e) => e.id)).toEqual([
      'aaaaaa',
      'bbbbbb',
    ])
  })

  it('applies colliding-seq amends in loggedAt order (last writer wins)', () => {
    const a1: AmendEvent = {
      ...amend(2, ['aaaaaa'], { capturedAt: '2026-08-02T08:00:00-04:00' }),
      id: 'amend1',
      loggedAt: '2026-08-02T11:00:00-04:00',
    }
    const a2: AmendEvent = {
      ...amend(2, ['aaaaaa'], { capturedAt: '2026-08-02T07:00:00-04:00' }),
      id: 'amend2',
      loggedAt: '2026-08-02T12:00:00-04:00',
    }
    const events = [a2, cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'), a1]
    // Later loggedAt wins despite identical seq and shuffled input order.
    expect(fold(events)[0].capturedAt).toBe('2026-08-02T07:00:00-04:00')
  })

  it('applies one amend to all listed targets', () => {
    const loc = { lat: 40.7, lng: -74, accuracyM: 10 }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      cap(2, 'bbbbbb', '2026-08-02T10:00:00-04:00'),
      amend(3, ['aaaaaa', 'bbbbbb'], { location: loc }),
    ]
    const entries = fold(events)
    expect(entries.map((e) => e.location)).toEqual([loc, loc])
    expect(entries.map((e) => e.lastEventSeq)).toEqual([3, 3])
  })

  it('applies one revoke to all listed targets', () => {
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      cap(2, 'bbbbbb', '2026-08-02T10:00:00-04:00'),
      cap(3, 'cccccc', '2026-08-02T11:00:00-04:00'),
      revoke(4, ['aaaaaa', 'cccccc']),
    ]
    expect(fold(events).map((e) => e.id)).toEqual(['bbbbbb'])
  })

  it('folds identically when events arrive out of seq order', () => {
    const note: Attachment = { kind: 'text', file: '000003_x_note.txt', mimeType: 'text/plain' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
      cap(2, 'bbbbbb', '2026-08-02T10:00:00-04:00'),
      amend(3, ['aaaaaa'], undefined, [note]),
      revoke(4, ['bbbbbb']),
    ]
    const shuffled = [events[3], events[2], events[0], events[1]]
    expect(fold(shuffled)).toEqual(fold(events))
    expect(fold(shuffled).map((e) => e.id)).toEqual(['aaaaaa'])
    expect(fold(shuffled)[0].attachments).toEqual([note])
  })

  it('applies an amend imported before its target capture (out-of-order pull)', () => {
    // A pull can hand importEvents the amend record before the capture it
    // targets; the fold's total order — not arrival order — decides.
    const events = [
      amend(2, ['aaaaaa'], { capturedAt: '2026-08-02T08:40:00-04:00' }),
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00'),
    ]
    expect(fold(events)[0].capturedAt).toBe('2026-08-02T08:40:00-04:00')
  })

  it('folds identically after a serialize/parse round-trip (sync wire format)', () => {
    // Amendments sync through Drive as ordinary event records; a reader that
    // folds the parsed bytes must converge on the same entries.
    const note: Attachment = { kind: 'text', file: '000003_x_note.txt', mimeType: 'text/plain' }
    const events = [
      cap(1, 'aaaaaa', '2026-08-02T09:00:00-04:00', {
        location: { lat: 40.7, lng: -74, accuracyM: 25, placeLabel: 'Office' },
        attachments: [{ kind: 'audio', file: '000001_x.m4a', mimeType: 'audio/mp4', durationSec: 3 }],
      }),
      cap(2, 'bbbbbb', '2026-08-02T10:00:00-04:00'),
      amend(3, ['aaaaaa'], { capturedAt: '2026-08-02T08:40:00-04:00' }, [note]),
      amend(4, ['aaaaaa'], { clearLocation: true, removeAttachments: ['000001_x.m4a'] }),
      revoke(5, ['bbbbbb']),
    ]
    const wire = events.map((e) => parseEvent(serializeEvent(e)))
    expect(fold(wire, { includeRevoked: true })).toEqual(fold(events, { includeRevoked: true }))
    const folded = fold(wire)
    expect(folded.map((e) => e.id)).toEqual(['aaaaaa'])
    expect(folded[0].capturedAt).toBe('2026-08-02T08:40:00-04:00')
    expect(folded[0].location).toBeUndefined()
    expect(folded[0].attachments).toEqual([note])
  })
})
