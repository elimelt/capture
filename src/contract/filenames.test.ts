import { describe, expect, it } from 'vitest'
import {
  attachmentFileName,
  eventBaseName,
  eventRecordName,
  idOfRecordName,
  padSeq,
  parseSegmentName,
  partitionOf,
  segmentFileName,
  seqOfFilename,
  tsForFilename,
} from './filenames'

const E = { seq: 41, loggedAt: '2026-08-02T09:04:11-04:00', id: 'a1b2c3' }
const BASE = '000041_2026-08-02T09-04-11-0400_a1b2c3'

describe('tsForFilename', () => {
  it('makes a local-offset ISO string filename-safe', () => {
    expect(tsForFilename('2026-08-02T09:04:11-04:00')).toBe('2026-08-02T09-04-11-0400')
  })

  it('handles positive offsets with minutes', () => {
    expect(tsForFilename('2026-08-02T09:04:11+05:30')).toBe('2026-08-02T09-04-11+0530')
  })
})

describe('padSeq', () => {
  it('left-pads to 6 digits', () => {
    expect(padSeq(41)).toBe('000041')
    expect(padSeq(1)).toBe('000001')
    expect(padSeq(123456)).toBe('123456')
  })
})

describe('eventBaseName / eventRecordName', () => {
  it('produce the SPEC §5.1 names for seq 41', () => {
    expect(eventBaseName(E)).toBe(BASE)
    expect(eventRecordName(E)).toBe(`${BASE}.json`)
  })
})

describe('attachmentFileName', () => {
  it('names a primary audio attachment', () => {
    expect(attachmentFileName(BASE, 'audio', 'audio/mp4')).toBe(`${BASE}.m4a`)
  })

  it('names a text note', () => {
    expect(attachmentFileName(BASE, 'text', 'text/plain')).toBe(`${BASE}_note.txt`)
  })

  it('disambiguates a second photo', () => {
    expect(attachmentFileName(BASE, 'photo', 'image/jpeg', 1)).toBe(`${BASE}_photo2.jpg`)
  })

  it('falls back to .bin for unknown mime types', () => {
    expect(attachmentFileName(BASE, 'audio', 'application/octet-stream')).toBe(`${BASE}.bin`)
  })

  it('ignores mime parameters after ";"', () => {
    expect(attachmentFileName(BASE, 'audio', 'audio/mp4;codecs=mp4a.40.2')).toBe(`${BASE}.m4a`)
    expect(attachmentFileName(BASE, 'audio', 'audio/webm;codecs=opus')).toBe(`${BASE}.webm`)
  })

  it('names a primary photo', () => {
    expect(attachmentFileName(BASE, 'photo', 'image/png')).toBe(`${BASE}_photo.png`)
  })

  it('disambiguates a second note', () => {
    expect(attachmentFileName(BASE, 'text', 'text/plain', 1)).toBe(`${BASE}_note2.txt`)
  })
})

describe('seqOfFilename', () => {
  it('round-trips the seq out of generated names', () => {
    expect(seqOfFilename(eventRecordName(E))).toBe(41)
    expect(seqOfFilename(attachmentFileName(BASE, 'audio', 'audio/mp4'))).toBe(41)
    expect(seqOfFilename(eventRecordName({ ...E, seq: 1 }))).toBe(1)
  })

  it('parses a seq past 6 digits (regression: split, not slice)', () => {
    expect(seqOfFilename('1000000_2026-08-02T09-04-11-0400_a1b2c3.json')).toBe(1000000)
  })

  it('parses the seq out of a secondary attachment name', () => {
    expect(seqOfFilename('000041_2026-08-02T09-04-11-0400_a1b2c3_note.txt')).toBe(41)
  })
})

describe('idOfRecordName', () => {
  it('round-trips the id out of a generated record name', () => {
    expect(idOfRecordName(eventRecordName(E))).toBe('a1b2c3')
  })

  it('rejects attachments and foreign files', () => {
    expect(idOfRecordName(attachmentFileName(BASE, 'audio', 'audio/mp4'))).toBeNull()
    expect(idOfRecordName(`${BASE}_note.txt`)).toBeNull()
    expect(idOfRecordName('notes.json')).toBeNull()
    expect(idOfRecordName('2026-08-02')).toBeNull()
  })
})

describe('partitionOf', () => {
  it('is the local date of loggedAt', () => {
    expect(partitionOf(E)).toBe('2026-08-02')
  })
})

const SEGMENT_EVENTS = [
  { seq: 44, loggedAt: '2026-08-02T18:02:33-04:00', id: 'f1a2b3' },
  { seq: 45, loggedAt: '2026-08-02T18:04:01-04:00', id: 'a9c8d7' },
  { seq: 46, loggedAt: '2026-08-02T18:05:10-04:00', id: 'b0c1d2' },
]
const SEGMENT = '000044-000046_2026-08-02T18-02-33-0400_f1a2b3.ndjson'

describe('segmentFileName (SPEC §5.7)', () => {
  it('produces the SPEC §5.7 name: seq range + first event ts + first event id', () => {
    expect(segmentFileName(SEGMENT_EVENTS)).toBe(SEGMENT)
  })

  it('takes the range extremes across all events (gaps allowed)', () => {
    expect(segmentFileName([SEGMENT_EVENTS[0], SEGMENT_EVENTS[2]])).toBe(
      '000044-000046_2026-08-02T18-02-33-0400_f1a2b3.ndjson',
    )
  })
})

describe('parseSegmentName', () => {
  it('round-trips a generated segment name', () => {
    expect(parseSegmentName(segmentFileName(SEGMENT_EVENTS))).toEqual({
      minSeq: 44,
      maxSeq: 46,
      firstId: 'f1a2b3',
    })
  })

  it('rejects records, attachments, and foreign files', () => {
    expect(parseSegmentName(eventRecordName(E))).toBeNull()
    expect(parseSegmentName(attachmentFileName(BASE, 'audio', 'audio/mp4'))).toBeNull()
    expect(parseSegmentName('notes.ndjson')).toBeNull()
    expect(parseSegmentName('2026-08-02')).toBeNull()
  })
})

describe('segments vs the v1 grammar', () => {
  it('a segment name is not a record name (v1 readers ignore it — SPEC §5.8)', () => {
    expect(idOfRecordName(SEGMENT)).toBeNull()
  })

  it('seqOfFilename reads a segment name as its min seq', () => {
    expect(seqOfFilename(SEGMENT)).toBe(44)
  })
})

describe('lexicographic sort invariant (SPEC §5.1, §5.7)', () => {
  it('name-sorted order equals seq order', () => {
    const seqs = [2, 10, 100]
    const names = seqs.map((seq) => eventRecordName({ ...E, seq }))
    const sorted = [...names].sort()
    expect(sorted.map(seqOfFilename)).toEqual(seqs)
    expect(sorted).toEqual(names)
  })

  it('a segment sorts at its min-seq position among records', () => {
    const names = [
      eventRecordName({ ...E, seq: 43 }),
      SEGMENT, // covers 44–46
      eventRecordName({ ...E, seq: 44 }), // same-seq record from another device
      eventRecordName({ ...E, seq: 47 }),
    ]
    expect([...names].sort()).toEqual(names)
    // The sorted listing yields non-decreasing seqs.
    const sortedSeqs = [...names].sort().map(seqOfFilename)
    expect(sortedSeqs).toEqual([...sortedSeqs].sort((a, b) => a - b))
  })
})
