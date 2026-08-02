import { describe, expect, it } from 'vitest'
import type { AmendEvent, Attachment, CaptureEvent, RevokeEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { isTranscript, pendingTranscriptions } from './plan'

const STREAM = 'timelog'
const TZ = 'America/New_York'
const AT = '2026-08-02T09:04:11-04:00'

const audio = (file: string): Attachment => ({ kind: 'audio', file, mimeType: 'audio/mp4' })
const transcript = (file: string, derivedFrom: string): Attachment => ({
  kind: 'text',
  file,
  mimeType: 'text/plain',
  derivedFrom,
})
const note = (file: string): Attachment => ({ kind: 'text', file, mimeType: 'text/plain' })

function cap(seq: number, id: string, attachments: Attachment[]): CaptureEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'capture',
    id,
    seq,
    stream: STREAM,
    loggedAt: AT,
    deviceTz: TZ,
    capturedAt: AT,
    attachments,
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
    loggedAt: AT,
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
    loggedAt: AT,
    deviceTz: TZ,
    targets,
  }
}

describe('isTranscript', () => {
  it('is true for text derived from another attachment', () => {
    expect(isTranscript(transcript('000002_x_note.txt', '000001_x.m4a'))).toBe(true)
  })

  it('is false for user-typed text and for non-text kinds', () => {
    expect(isTranscript(note('000002_x_note.txt'))).toBe(false)
    expect(isTranscript(audio('000001_x.m4a'))).toBe(false)
  })
})

describe('pendingTranscriptions', () => {
  const a = audio('000001_x.m4a')

  it('reports untranscribed audio with entryId, stream, and attachment', () => {
    const events = [cap(1, 'aaaaaa', [a])]
    expect(pendingTranscriptions(events)).toEqual([
      { entryId: 'aaaaaa', stream: STREAM, audio: a },
    ])
  })

  it('excludes audio with a derived text attachment on the same capture', () => {
    const events = [cap(1, 'aaaaaa', [a, transcript('000001_x_note.txt', a.file)])]
    expect(pendingTranscriptions(events)).toEqual([])
  })

  it('excludes audio transcribed via a later amend', () => {
    const events = [
      cap(1, 'aaaaaa', [a]),
      amend(2, ['aaaaaa'], undefined, [transcript('000002_y_note.txt', a.file)]),
    ]
    expect(pendingTranscriptions(events)).toEqual([])
  })

  it('excludes audio whose transcript was later removed (everDerived is history-aware)', () => {
    const t = transcript('000002_y_note.txt', a.file)
    const events = [
      cap(1, 'aaaaaa', [a]),
      amend(2, ['aaaaaa'], undefined, [t]),
      amend(3, ['aaaaaa'], { removeAttachments: [t.file] }),
    ]
    expect(pendingTranscriptions(events)).toEqual([])
  })

  it('excludes audio whose transcript was edited (replacement keeps derivedFrom)', () => {
    const t = transcript('000002_y_note.txt', a.file)
    const edited = transcript('000003_z_note.txt', a.file)
    const events = [
      cap(1, 'aaaaaa', [a]),
      amend(2, ['aaaaaa'], undefined, [t]),
      amend(3, ['aaaaaa'], { removeAttachments: [t.file] }, [edited]),
    ]
    expect(pendingTranscriptions(events)).toEqual([])
  })

  it('excludes audio on revoked entries', () => {
    const events = [cap(1, 'aaaaaa', [a]), revoke(2, ['aaaaaa'])]
    expect(pendingTranscriptions(events)).toEqual([])
  })

  it('excludes audio removed via removeAttachments', () => {
    const events = [cap(1, 'aaaaaa', [a]), amend(2, ['aaaaaa'], { removeAttachments: [a.file] })]
    expect(pendingTranscriptions(events)).toEqual([])
  })

  it('reports only the untranscribed one of two audio attachments', () => {
    const b = audio('000001_x_2.m4a')
    const events = [
      cap(1, 'aaaaaa', [a, b]),
      amend(2, ['aaaaaa'], undefined, [transcript('000002_y_note.txt', a.file)]),
    ]
    expect(pendingTranscriptions(events)).toEqual([
      { entryId: 'aaaaaa', stream: STREAM, audio: b },
    ])
  })

  it('does not count a user-typed note as a transcript', () => {
    const events = [cap(1, 'aaaaaa', [a]), amend(2, ['aaaaaa'], undefined, [note('000002_y_note.txt')])]
    expect(pendingTranscriptions(events)).toEqual([
      { entryId: 'aaaaaa', stream: STREAM, audio: a },
    ])
  })
})
