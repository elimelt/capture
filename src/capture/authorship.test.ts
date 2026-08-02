import { describe, expect, it } from 'vitest'
import type { Attachment } from '../contract/types'
import { authorship } from './authorship'

const NOTE: Attachment = { kind: 'text', file: '000041_x_note.txt', mimeType: 'text/plain' }
const TRANSCRIPT: Attachment = {
  kind: 'text',
  file: '000041_x_note2.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x.m4a',
}
const CAPTION: Attachment = {
  kind: 'text',
  file: '000041_x_note3.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x_photo.jpg',
}
const AUDIO: Attachment = { kind: 'audio', file: '000041_x.m4a', mimeType: 'audio/mp4' }
const PHOTO: Attachment = { kind: 'photo', file: '000041_x_photo.jpg', mimeType: 'image/jpeg' }

describe('authorship', () => {
  it('classifies a user-typed note (no derivedFrom) as authored', () => {
    expect(authorship(NOTE)).toBe('authored')
  })

  it('classifies an audio-derived transcript as spoken, not derived', () => {
    expect(authorship(TRANSCRIPT)).toBe('spoken')
  })

  it('classifies a photo-derived caption as derived', () => {
    expect(authorship(CAPTION)).toBe('derived')
  })

  it('is exhaustive over attachment shapes with/without derivedFrom (kind ignored except via isCaption)', () => {
    // Non-text kinds have no dedicated "derived text" rendering today, but
    // the classifier must still be total: absent derivedFrom is always
    // authored regardless of kind, and a present-but-non-photo-derived
    // source is spoken (isCaption requires kind: 'text').
    expect(authorship(AUDIO)).toBe('authored')
    expect(authorship(PHOTO)).toBe('authored')
    expect(authorship({ ...AUDIO, derivedFrom: '000041_x_other.m4a' })).toBe('spoken')
    expect(authorship({ ...PHOTO, derivedFrom: '000041_x_photo2.jpg' })).toBe('spoken')
  })

  it('pinned invariant: identical text bodies differing only in derivedFrom classify differently', () => {
    // Same file/kind/mimeType — the only difference is derivedFrom — so any
    // future heuristic on text content would be a regression this test
    // would not catch, but a regression on derivedFrom itself would.
    const base = { kind: 'text', file: 'x.txt', mimeType: 'text/plain' } as const
    const authored: Attachment = { ...base }
    const spoken: Attachment = { ...base, derivedFrom: 'x.m4a' }
    const derived: Attachment = { ...base, derivedFrom: 'x_photo.jpg' }
    expect(authorship(authored)).toBe('authored')
    expect(authorship(spoken)).toBe('spoken')
    expect(authorship(derived)).toBe('derived')
    expect(new Set([authorship(authored), authorship(spoken), authorship(derived)]).size).toBe(3)
  })

  it('preserves class across an edit that keeps derivedFrom (onEditText invariant)', () => {
    const editedTranscript: Attachment = { ...TRANSCRIPT, file: 'new-file.txt' }
    expect(authorship(editedTranscript)).toBe('spoken')
    const editedCaption: Attachment = { ...CAPTION, file: 'new-file2.txt' }
    expect(authorship(editedCaption)).toBe('derived')
  })

  it('an orphan caption (source photo removed) is still derived — classification never depends on sibling presence', () => {
    // groupAttachments treats a caption whose photo was removed as an
    // "orphan", but that's a grouping/pairing concern, not authorship: the
    // text is still machine inference regardless of whether its source
    // photo is still attached.
    expect(authorship(CAPTION)).toBe('derived')
  })
})
