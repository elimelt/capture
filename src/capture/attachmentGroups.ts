/**
 * Pure grouping of an entry's attachments for card rendering (B7): splits
 * text into machine transcripts / user notes / photo captions, pairs each
 * photo with the captions derived from it (thumbnail + caption render as one
 * row), and keeps captions whose source photo was removed as standalone
 * text. No I/O — unit-tested directly (attachmentGroups.test.ts).
 */
import type { Attachment } from '../contract/types'
import { isCaption } from '../vision/plan'

export interface PhotoGroup {
  photo: Attachment
  /** Captions machine-derived from this photo (usually zero or one). */
  captions: Attachment[]
}

export interface AttachmentGroups {
  /** Machine transcripts (text derived from audio) — the spoken content. */
  transcripts: Attachment[]
  /** User-typed notes (text without derivedFrom). */
  notes: Attachment[]
  /** All audio clips, in order; the first waveform appears in the card header. */
  audio: Attachment[]
  /** Each photo paired with its derived captions, in attachment order. */
  photoGroups: PhotoGroup[]
  /** Captions whose source photo is no longer on the entry. */
  orphanCaptions: Attachment[]
}

export function groupAttachments(attachments: Attachment[]): AttachmentGroups {
  const captions = attachments.filter(isCaption)
  const photos = attachments.filter((a) => a.kind === 'photo')
  const photoFiles = new Set(photos.map((p) => p.file))
  return {
    transcripts: attachments.filter(
      (a) => a.kind === 'text' && a.derivedFrom !== undefined && !isCaption(a),
    ),
    notes: attachments.filter((a) => a.kind === 'text' && a.derivedFrom === undefined),
    audio: attachments.filter((a) => a.kind === 'audio'),
    photoGroups: photos.map((photo) => ({
      photo,
      captions: captions.filter((c) => c.derivedFrom === photo.file),
    })),
    orphanCaptions: captions.filter(
      (c) => c.derivedFrom === undefined || !photoFiles.has(c.derivedFrom),
    ),
  }
}
