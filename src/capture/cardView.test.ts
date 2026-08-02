import { describe, expect, it } from 'vitest'
import type { Attachment, Entry } from '../contract/types'
import { groupAttachments } from './attachmentGroups'
import { cardViewModel } from './cardView'

const AUDIO: Attachment = { kind: 'audio', file: '000041_x.m4a', mimeType: 'audio/mp4', durationSec: 3 }
const TRANSCRIPT: Attachment = {
  kind: 'text',
  file: '000041_x_note.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x.m4a',
}
const NOTE: Attachment = { kind: 'text', file: '000041_x_note2.txt', mimeType: 'text/plain' }
const PHOTO: Attachment = { kind: 'photo', file: '000041_x_photo.jpg', mimeType: 'image/jpeg' }
const CAPTION: Attachment = {
  kind: 'text',
  file: '000041_x_note3.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x_photo.jpg',
}

function entry(extra: Partial<Entry> = {}): Entry {
  return {
    id: 'a1b2c3',
    seq: 41,
    stream: 'timelog',
    loggedAt: '2026-08-02T09:04:11-04:00',
    capturedAt: '2026-08-02T09:04:11-04:00',
    deviceTz: 'America/New_York',
    attachments: [],
    lastEventSeq: 41,
    revoked: false,
    ...extra,
  }
}

function vmOf(e: Entry) {
  return cardViewModel(e, groupAttachments(e.attachments))
}

describe('cardViewModel', () => {
  it('returns an all-empty model for an entry with no attachments or location', () => {
    expect(vmOf(entry())).toEqual({
      primaryText: undefined,
      primaryAudio: undefined,
      collapsedShowsLocation: false,
      photoGroups: [],
    })
  })

  it('prefers a transcript over a note as primary text', () => {
    const vm = vmOf(entry({ attachments: [AUDIO, TRANSCRIPT, NOTE] }))
    expect(vm.primaryText).toEqual({ file: TRANSCRIPT.file, authorship: 'spoken' })
  })

  it('falls back to the first note when there is no transcript', () => {
    const vm = vmOf(entry({ attachments: [NOTE] }))
    expect(vm.primaryText).toEqual({ file: NOTE.file, authorship: 'authored' })
  })

  it('yields primaryText undefined and the audio as primary for an audio-only entry', () => {
    const vm = vmOf(entry({ attachments: [AUDIO] }))
    expect(vm.primaryText).toBeUndefined()
    expect(vm.primaryAudio).toEqual(AUDIO)
  })

  it('yields both primaryText and primaryAudio when an entry has a transcript', () => {
    const vm = vmOf(entry({ attachments: [AUDIO, TRANSCRIPT] }))
    expect(vm.primaryText).toEqual({ file: TRANSCRIPT.file, authorship: 'spoken' })
    expect(vm.primaryAudio).toEqual(AUDIO)
  })

  it('exposes every photo for the always-visible collapsed grid, paired with its caption (#102)', () => {
    // Nothing is hidden behind expansion any more: PHOTO + CAPTION must
    // surface on the view-model even though AUDIO/TRANSCRIPT are already
    // primary — the "extraCount" concept (attachments hidden until
    // expansion) is gone along with the content it used to count.
    const vm = vmOf(entry({ attachments: [AUDIO, TRANSCRIPT, PHOTO, CAPTION] }))
    expect(vm.photoGroups).toEqual([{ photo: PHOTO, captions: [CAPTION] }])
  })

  it('photo grid ordering is deterministic — capture order, not insertion order of captions', () => {
    const photo2: Attachment = { kind: 'photo', file: '000041_x_photo2.jpg', mimeType: 'image/jpeg' }
    const caption2: Attachment = {
      kind: 'text',
      file: '000041_x_note4.txt',
      mimeType: 'text/plain',
      derivedFrom: photo2.file,
    }
    // Attachments arrive in the order they were captured/amended: PHOTO
    // first, its caption later, then a second photo, then its caption.
    const vm = vmOf(entry({ attachments: [PHOTO, CAPTION, photo2, caption2] }))
    expect(vm.photoGroups.map((g) => g.photo.file)).toEqual([PHOTO.file, photo2.file])
    expect(vm.photoGroups).toEqual([
      { photo: PHOTO, captions: [CAPTION] },
      { photo: photo2, captions: [caption2] },
    ])
  })

  it('pairs a captionless photo with an empty captions array rather than omitting it', () => {
    const vm = vmOf(entry({ attachments: [PHOTO] }))
    expect(vm.photoGroups).toEqual([{ photo: PHOTO, captions: [] }])
  })

  it('yields an empty photoGroups array for an entry with no photos', () => {
    const vm = vmOf(entry({ attachments: [AUDIO, TRANSCRIPT, NOTE] }))
    expect(vm.photoGroups).toEqual([])
  })

  it('reports collapsedShowsLocation true for a place label', () => {
    const vm = vmOf(entry({ location: { lat: 1, lng: 2, accuracyM: 5, placeLabel: 'Home' } }))
    expect(vm.collapsedShowsLocation).toBe(true)
  })

  it('reports collapsedShowsLocation true for an address with no place label', () => {
    const vm = vmOf(entry({ location: { lat: 1, lng: 2, accuracyM: 5, address: '123 Main St' } }))
    expect(vm.collapsedShowsLocation).toBe(true)
  })

  it('reports collapsedShowsLocation false for a bare coordinate', () => {
    const vm = vmOf(entry({ location: { lat: 1, lng: 2, accuracyM: 5 } }))
    expect(vm.collapsedShowsLocation).toBe(false)
  })

  it('reports collapsedShowsLocation false with no location at all', () => {
    expect(vmOf(entry()).collapsedShowsLocation).toBe(false)
  })
})
