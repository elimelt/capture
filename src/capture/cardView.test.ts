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
      extraCount: 0,
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

  it('counts exactly the attachments hidden behind expansion', () => {
    // TRANSCRIPT is primary text, AUDIO is primary audio — both surfaced
    // collapsed. PHOTO + CAPTION are only revealed on expansion.
    const vm = vmOf(entry({ attachments: [AUDIO, TRANSCRIPT, PHOTO, CAPTION] }))
    expect(vm.extraCount).toBe(2)
  })

  it('extraCount is zero when every attachment is the primary text/audio', () => {
    const vm = vmOf(entry({ attachments: [AUDIO, TRANSCRIPT] }))
    expect(vm.extraCount).toBe(0)
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
