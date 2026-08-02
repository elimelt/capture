/**
 * Edge case tests for filenames — validates the invariants that filename
 * sort order equals log order, and that id/seq parsing is robust.
 */
import { describe, expect, it } from 'vitest'
import {
  attachmentFileName,
  eventRecordName,
  idOfRecordName,
  padSeq,
  partitionOf,
  seqOfFilename,
  tsForFilename,
} from './filenames'
import type { LogEvent } from './types'

function makeEvent(seq: number, id: string, loggedAt: string): Pick<LogEvent, 'seq' | 'loggedAt' | 'id'> {
  return { seq, id, loggedAt }
}

describe('filename sort order equals log order invariant', () => {
  it('earlier seq sorts before later seq', () => {
    const a = eventRecordName(makeEvent(1, 'aaaaaa', '2026-08-02T10:00:00-04:00'))
    const b = eventRecordName(makeEvent(2, 'aaaaaa', '2026-08-02T09:00:00-04:00'))
    expect(a < b).toBe(true)
  })

  it('same seq but different ids still sort predictably', () => {
    const t = '2026-08-02T10:00:00-04:00'
    const a = eventRecordName(makeEvent(1, 'aaaaaa', t))
    const b = eventRecordName(makeEvent(1, 'zzzzzz', t))
    // Names differ by timestamp position, then id; both are deterministic
    expect(a < b).toBe(true)
  })

  it('seq padding handles large seq numbers', () => {
    expect(padSeq(1)).toBe('000001')
    expect(padSeq(999999)).toBe('999999')
    expect(padSeq(1000000)).toBe('1000000') // 7 digits, still valid
    expect(padSeq(9999999)).toBe('9999999')
  })

  it('seqOfFilename parses back correctly for any seq size', () => {
    expect(seqOfFilename('000001_x_y.json')).toBe(1)
    expect(seqOfFilename('999999_x_y.json')).toBe(999999)
    expect(seqOfFilename('1000000_x_y.json')).toBe(1000000)
    expect(seqOfFilename('9999999_x_y.json')).toBe(9999999)
  })

  it('10 random events sort in seq order', () => {
    const events = [7, 3, 9, 1, 5, 2, 8, 4, 6, 10].map((seq) =>
      makeEvent(seq, `id${seq}xxx`, `2026-08-02T${String(seq).padStart(2, '0')}:00:00-04:00`),
    )
    const names = events.map(eventRecordName).sort()
    const seqs = names.map(seqOfFilename)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('idOfRecordName parsing', () => {
  it('extracts id from a valid record name', () => {
    expect(idOfRecordName('000001_2026-08-02T09-00-00-0400_abc123.json')).toBe('abc123')
    expect(idOfRecordName('999999_2026-08-02T09-00-00-0400_xyz789.json')).toBe('xyz789')
  })

  it('returns null for attachment filenames', () => {
    expect(idOfRecordName('000001_2026-08-02T09-00-00-0400_abc123.m4a')).toBeNull()
    expect(idOfRecordName('000001_2026-08-02T09-00-00-0400_abc123_note.txt')).toBeNull()
    expect(idOfRecordName('000001_2026-08-02T09-00-00-0400_abc123_photo.jpg')).toBeNull()
    // JSON text attachments (system-stream payloads) end in .json like event
    // records do; the _note suffix must keep them out of pull discovery.
    expect(idOfRecordName('000001_2026-08-02T09-00-00-0400_abc123_note.json')).toBeNull()
    expect(idOfRecordName('000001_2026-08-02T09-00-00-0400_abc123_note2.json')).toBeNull()
  })

  it('returns null for foreign files', () => {
    expect(idOfRecordName('notes.txt')).toBeNull()
    expect(idOfRecordName('random-file.json')).toBeNull()
    expect(idOfRecordName('.DS_Store')).toBeNull()
  })

  it('returns null for folder names', () => {
    expect(idOfRecordName('2026-08-02')).toBeNull()
    expect(idOfRecordName('log')).toBeNull()
  })

  it('requires alphanumeric lowercase id', () => {
    expect(idOfRecordName('000001_x_ABC123.json')).toBeNull() // uppercase
    expect(idOfRecordName('000001_x_ab-cd.json')).toBeNull() // hyphen
  })
})

describe('tsForFilename timestamp sanitization', () => {
  it('replaces colons with hyphens', () => {
    expect(tsForFilename('2026-08-02T09:04:11-04:00')).toBe('2026-08-02T09-04-11-0400')
  })

  it('handles positive UTC offsets', () => {
    expect(tsForFilename('2026-08-02T09:04:11+05:30')).toBe('2026-08-02T09-04-11+0530')
  })

  it('handles Z suffix (UTC)', () => {
    // Z doesn't have the ±HH:MM pattern, so it stays as-is after colon replacement
    expect(tsForFilename('2026-08-02T09:04:11Z')).toBe('2026-08-02T09-04-11Z')
  })
})

describe('partitionOf date extraction', () => {
  it('extracts local date from loggedAt', () => {
    expect(partitionOf({ loggedAt: '2026-08-02T09:04:11-04:00' })).toBe('2026-08-02')
    expect(partitionOf({ loggedAt: '2026-12-31T23:59:59+00:00' })).toBe('2026-12-31')
  })

  it('works with Z suffix', () => {
    expect(partitionOf({ loggedAt: '2026-01-15T12:00:00Z' })).toBe('2026-01-15')
  })
})

describe('attachmentFileName', () => {
  it('generates correct extensions for known mime types', () => {
    const base = '000001_x_aaaaaa'
    expect(attachmentFileName(base, 'audio', 'audio/mp4')).toBe('000001_x_aaaaaa.m4a')
    expect(attachmentFileName(base, 'audio', 'audio/webm')).toBe('000001_x_aaaaaa.webm')
    expect(attachmentFileName(base, 'audio', 'audio/mpeg')).toBe('000001_x_aaaaaa.mp3')
    expect(attachmentFileName(base, 'text', 'text/plain')).toBe('000001_x_aaaaaa_note.txt')
    expect(attachmentFileName(base, 'photo', 'image/jpeg')).toBe('000001_x_aaaaaa_photo.jpg')
    expect(attachmentFileName(base, 'photo', 'image/png')).toBe('000001_x_aaaaaa_photo.png')
    expect(attachmentFileName(base, 'photo', 'image/heic')).toBe('000001_x_aaaaaa_photo.heic')
    expect(attachmentFileName(base, 'text', 'application/json')).toBe('000001_x_aaaaaa_note.json')
  })

  it('round-trips application/json text attachments (system-stream payloads)', () => {
    // JSON payload attachments (settings / assistant-chat events) must not
    // fall back to .bin: the Drive tree stays legible as .json.
    const name = attachmentFileName('000007_x_bbbbbb', 'text', 'application/json')
    expect(name.endsWith('.json')).toBe(true)
    expect(name).toBe('000007_x_bbbbbb_note.json')
    expect(attachmentFileName('base', 'text', 'application/json; charset=utf-8')).toBe(
      'base_note.json',
    )
  })

  it('uses .bin for unknown mime types', () => {
    expect(attachmentFileName('base', 'audio', 'audio/unknown')).toBe('base.bin')
  })

  it('handles mime type parameters', () => {
    expect(attachmentFileName('base', 'audio', 'audio/mp4; codecs=mp4a.40.2')).toBe('base.m4a')
  })

  it('numbers multiple attachments of the same kind', () => {
    const base = '000001_x_aaaaaa'
    expect(attachmentFileName(base, 'photo', 'image/jpeg', 0)).toBe('000001_x_aaaaaa_photo.jpg')
    expect(attachmentFileName(base, 'photo', 'image/jpeg', 1)).toBe('000001_x_aaaaaa_photo2.jpg')
    expect(attachmentFileName(base, 'photo', 'image/jpeg', 2)).toBe('000001_x_aaaaaa_photo3.jpg')
  })
})
