import { describe, expect, it } from 'vitest'
import type { Attachment } from '../contract/types'
import { groupAttachments } from './attachmentGroups'

const AUDIO: Attachment = { kind: 'audio', file: '000041_x.m4a', mimeType: 'audio/mp4', durationSec: 3 }
const AUDIO2: Attachment = { kind: 'audio', file: '000041_x2.m4a', mimeType: 'audio/mp4', durationSec: 5 }
const TRANSCRIPT: Attachment = {
  kind: 'text',
  file: '000041_x_note.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x.m4a',
}
const NOTE: Attachment = { kind: 'text', file: '000041_x_note2.txt', mimeType: 'text/plain' }
const PHOTO: Attachment = { kind: 'photo', file: '000041_x_photo.jpg', mimeType: 'image/jpeg' }
const PHOTO2: Attachment = { kind: 'photo', file: '000041_x_photo2.jpg', mimeType: 'image/jpeg' }
const CAPTION: Attachment = {
  kind: 'text',
  file: '000041_x_note3.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x_photo.jpg',
}
const CAPTION2: Attachment = {
  kind: 'text',
  file: '000041_x_note4.txt',
  mimeType: 'text/plain',
  derivedFrom: '000041_x_photo2.jpg',
}

describe('groupAttachments', () => {
  it('returns all-empty groups for no attachments', () => {
    expect(groupAttachments([])).toEqual({
      transcripts: [],
      notes: [],
      audio: [],
      photoGroups: [],
      orphanCaptions: [],
    })
  })

  it('classifies transcripts (audio-derived), notes (underived), and captions (photo-derived)', () => {
    const groups = groupAttachments([AUDIO, TRANSCRIPT, NOTE, PHOTO, CAPTION])
    expect(groups.transcripts).toEqual([TRANSCRIPT])
    expect(groups.notes).toEqual([NOTE])
    expect(groups.audio).toEqual([AUDIO])
    expect(groups.photoGroups).toEqual([{ photo: PHOTO, captions: [CAPTION] }])
    expect(groups.orphanCaptions).toEqual([])
  })

  it('pairs each photo with only its own captions, preserving attachment order', () => {
    const groups = groupAttachments([PHOTO, PHOTO2, CAPTION2, CAPTION])
    expect(groups.photoGroups).toEqual([
      { photo: PHOTO, captions: [CAPTION] },
      { photo: PHOTO2, captions: [CAPTION2] },
    ])
  })

  it('leaves a photo without captions as an empty pairing', () => {
    const groups = groupAttachments([PHOTO])
    expect(groups.photoGroups).toEqual([{ photo: PHOTO, captions: [] }])
  })

  it('keeps captions whose photo was removed as orphans, not paired rows', () => {
    const groups = groupAttachments([CAPTION, PHOTO2, CAPTION2])
    expect(groups.photoGroups).toEqual([{ photo: PHOTO2, captions: [CAPTION2] }])
    expect(groups.orphanCaptions).toEqual([CAPTION])
  })

  it('returns all audio clips in order (the card header plays the first)', () => {
    const groups = groupAttachments([AUDIO, AUDIO2])
    expect(groups.audio).toEqual([AUDIO, AUDIO2])
  })
})
