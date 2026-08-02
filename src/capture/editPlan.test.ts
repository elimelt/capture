import { describe, expect, it } from 'vitest'
import type { Attachment, Entry } from '../contract/types'
import { draftFromEntry, draftPatch, toggleRemoval } from './editPlan'

// Node's process, typed locally to keep node types out of the app tsconfig.
declare const process: { env: Record<string, string | undefined> }

// Must be set before any Date is used by the code under test.
process.env.TZ = 'America/New_York'

const AUDIO: Attachment = { kind: 'audio', file: '000041_x.m4a', mimeType: 'audio/mp4', durationSec: 3 }
const NOTE: Attachment = { kind: 'text', file: '000041_x_note.txt', mimeType: 'text/plain' }

function entry(extra: Partial<Entry> = {}): Entry {
  return {
    id: 'a1b2c3',
    seq: 41,
    stream: 'timelog',
    loggedAt: '2026-08-02T09:04:11-04:00',
    capturedAt: '2026-08-02T09:04:11-04:00',
    deviceTz: 'America/New_York',
    attachments: [AUDIO, NOTE],
    lastEventSeq: 41,
    revoked: false,
    ...extra,
  }
}

// An entry captured in Tokyo, opened for editing on the (New York) device.
const TOKYO = {
  loggedAt: '2026-08-03T00:30:00+09:00',
  capturedAt: '2026-08-03T00:30:00+09:00',
  deviceTz: 'Asia/Tokyo',
}

describe('draftFromEntry', () => {
  it('reads the current date and wall-clock time with nothing staged', () => {
    expect(draftFromEntry(entry())).toEqual({
      date: '2026-08-02',
      time: '09:04',
      removeFiles: [],
    })
  })

  it("shows a consistent date+time pair in the ENTRY's zone, not the device's", () => {
    // Device zone (America/New_York) would read this instant as Aug 2,
    // 11:30 — mixing that time with the string's Aug 3 date corrupted
    // cross-timezone edits. Both fields must come from the entry's zone.
    expect(draftFromEntry(entry(TOKYO))).toEqual({
      date: '2026-08-03',
      time: '00:30',
      removeFiles: [],
    })
  })
})

describe('toggleRemoval', () => {
  it('stages and unstages a file without mutating the draft', () => {
    const d0 = draftFromEntry(entry())
    const d1 = toggleRemoval(d0, AUDIO.file)
    expect(d1.removeFiles).toEqual([AUDIO.file])
    expect(d0.removeFiles).toEqual([])
    const d2 = toggleRemoval(d1, NOTE.file)
    expect(d2.removeFiles).toEqual([AUDIO.file, NOTE.file])
    expect(toggleRemoval(d2, AUDIO.file).removeFiles).toEqual([NOTE.file])
  })
})

describe('draftPatch', () => {
  it('returns null for an unchanged draft (no no-op amend)', () => {
    const e = entry()
    expect(draftPatch(e, draftFromEntry(e))).toBeNull()
  })

  it('moves the entry to another day, keeping the wall time', () => {
    const e = entry()
    const patch = draftPatch(e, { ...draftFromEntry(e), date: '2026-08-01' })
    expect(patch).toEqual({ capturedAt: '2026-08-01T09:04:00-04:00' })
  })

  it('changes the time of day on the same date', () => {
    const e = entry()
    const patch = draftPatch(e, { ...draftFromEntry(e), time: '14:30' })
    expect(patch).toEqual({ capturedAt: '2026-08-02T14:30:00-04:00' })
  })

  it('combines a date move, time change, and removals into one patch', () => {
    const e = entry()
    const draft = { date: '2026-08-01', time: '22:15', removeFiles: [NOTE.file] }
    expect(draftPatch(e, draft)).toEqual({
      capturedAt: '2026-08-01T22:15:00-04:00',
      removeAttachments: [NOTE.file],
    })
  })

  it('emits removals alone without touching capturedAt', () => {
    const e = entry()
    const patch = draftPatch(e, { ...draftFromEntry(e), removeFiles: [AUDIO.file] })
    expect(patch).toEqual({ removeAttachments: [AUDIO.file] })
  })

  it('drops removals of files the entry does not show and dedupes', () => {
    const e = entry()
    const draft = {
      ...draftFromEntry(e),
      removeFiles: ['ghost.txt', NOTE.file, NOTE.file],
    }
    expect(draftPatch(e, draft)).toEqual({ removeAttachments: [NOTE.file] })
  })

  it('returns null when the only staged removals are unknown files', () => {
    const e = entry()
    expect(draftPatch(e, { ...draftFromEntry(e), removeFiles: ['ghost.txt'] })).toBeNull()
  })

  it('recomposes capturedAt across a DST boundary with the new offset', () => {
    const e = entry()
    const patch = draftPatch(e, { ...draftFromEntry(e), date: '2026-01-15' })
    expect(patch).toEqual({ capturedAt: '2026-01-15T09:04:00-05:00' })
  })

  it('open-then-save of a cross-timezone entry is a no-op (null, no amend)', () => {
    const e = entry(TOKYO)
    expect(draftPatch(e, draftFromEntry(e))).toBeNull()
  })

  it("date-only edit keeps the wall time and offset of the ENTRY's zone", () => {
    // Editing from New York must move the Tokyo entry by whole Tokyo days:
    // same 00:30 wall time, same +09:00 offset — never re-rendered into the
    // device zone.
    const e = entry(TOKYO)
    const patch = draftPatch(e, { ...draftFromEntry(e), date: '2026-08-02' })
    expect(patch).toEqual({ capturedAt: '2026-08-02T00:30:00+09:00' })
  })

  it("time-only edit round-trips through the entry's own offset", () => {
    const e = entry(TOKYO)
    const patch = draftPatch(e, { ...draftFromEntry(e), time: '01:45' })
    expect(patch).toEqual({ capturedAt: '2026-08-03T01:45:00+09:00' })
  })
})
