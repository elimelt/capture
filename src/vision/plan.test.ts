import { describe, expect, it } from 'vitest'
import type { AmendEvent, Attachment, CaptureEvent, RevokeEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { isCaption, pendingCaptions } from './plan'

const STREAM = 'timelog'
const TZ = 'America/New_York'
const AT = '2026-08-02T09:04:11-04:00'

const photo = (file: string): Attachment => ({ kind: 'photo', file, mimeType: 'image/jpeg' })
const caption = (file: string, derivedFrom: string): Attachment => ({
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

describe('isCaption', () => {
  it('is true for text derived from a photo attachment', () => {
    expect(isCaption(caption('000002_x_note.txt', '000001_x_photo.jpg'))).toBe(true)
    expect(isCaption(caption('000002_x_note.txt', '000001_x_photo2.jpg'))).toBe(true)
  })

  it('is false for transcripts (derived from audio), notes, and non-text kinds', () => {
    expect(isCaption(caption('000002_x_note.txt', '000001_x.m4a'))).toBe(false)
    expect(isCaption(note('000002_x_note.txt'))).toBe(false)
    expect(isCaption(photo('000001_x_photo.jpg'))).toBe(false)
  })
})

describe('pendingCaptions', () => {
  const p = photo('000001_x_photo.jpg')

  it('reports uncaptioned photos with entryId, stream, and attachment', () => {
    const events = [cap(1, 'aaaaaa', [p])]
    expect(pendingCaptions(events)).toEqual([{ entryId: 'aaaaaa', stream: STREAM, photo: p }])
  })

  it('excludes photos with a derived text attachment on the same capture', () => {
    const events = [cap(1, 'aaaaaa', [p, caption('000001_x_note.txt', p.file)])]
    expect(pendingCaptions(events)).toEqual([])
  })

  it('excludes photos captioned via a later amend', () => {
    const events = [
      cap(1, 'aaaaaa', [p]),
      amend(2, ['aaaaaa'], undefined, [caption('000002_y_note.txt', p.file)]),
    ]
    expect(pendingCaptions(events)).toEqual([])
  })

  it('excludes photos whose caption was later removed (everDerived is history-aware)', () => {
    const c = caption('000002_y_note.txt', p.file)
    const events = [
      cap(1, 'aaaaaa', [p]),
      amend(2, ['aaaaaa'], undefined, [c]),
      amend(3, ['aaaaaa'], { removeAttachments: [c.file] }),
    ]
    expect(pendingCaptions(events)).toEqual([])
  })

  it('excludes photos on revoked entries', () => {
    const events = [cap(1, 'aaaaaa', [p]), revoke(2, ['aaaaaa'])]
    expect(pendingCaptions(events)).toEqual([])
  })

  it('excludes photos removed via removeAttachments', () => {
    const events = [cap(1, 'aaaaaa', [p]), amend(2, ['aaaaaa'], { removeAttachments: [p.file] })]
    expect(pendingCaptions(events)).toEqual([])
  })

  it('reports only the uncaptioned one of two photos', () => {
    const q = photo('000001_x_photo2.jpg')
    const events = [
      cap(1, 'aaaaaa', [p, q]),
      amend(2, ['aaaaaa'], undefined, [caption('000002_y_note.txt', p.file)]),
    ]
    expect(pendingCaptions(events)).toEqual([{ entryId: 'aaaaaa', stream: STREAM, photo: q }])
  })

  it('does not treat a user note or an audio transcript as captioning a photo', () => {
    const events = [
      cap(1, 'aaaaaa', [p, { kind: 'audio', file: '000001_x.m4a', mimeType: 'audio/mp4' } as Attachment]),
      amend(2, ['aaaaaa'], undefined, [note('000002_y_note.txt')]),
      amend(3, ['aaaaaa'], undefined, [caption('000003_z_note.txt', '000001_x.m4a')]),
    ]
    expect(pendingCaptions(events)).toEqual([{ entryId: 'aaaaaa', stream: STREAM, photo: p }])
  })
})
