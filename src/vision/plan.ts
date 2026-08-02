/**
 * Pure planning for photo captioning: which photo attachments still need a
 * caption. Mirrors transcribe/plan.ts and works over the raw event history,
 * not just the folded view: a photo counts as captioned if *any* text
 * attachment was ever derived from it — even one the user later edited or
 * removed — so user changes to a caption are never clobbered by re-captioning.
 */
import { fold } from '../contract/fold'
import type { Attachment, LogEvent } from '../contract/types'

export interface PendingCaption {
  entryId: string
  stream: string
  photo: Attachment
}

/**
 * Attachment filenames are machine-generated (contract/filenames.ts), so the
 * `_photo` suffix is a reliable discriminator for photo files.
 */
export function isPhotoFile(file: string): boolean {
  return /_photo\d*\./.test(file)
}

/** Machine caption of a photo, as opposed to an audio transcript or typed note. */
export function isCaption(a: Attachment): boolean {
  return a.kind === 'text' && a.derivedFrom !== undefined && isPhotoFile(a.derivedFrom)
}

export function pendingCaptions(events: readonly LogEvent[]): PendingCaption[] {
  const everDerived = new Set<string>()
  for (const e of events) {
    if (e.type === 'revoke') continue
    for (const a of e.attachments ?? []) {
      if (a.kind === 'text' && a.derivedFrom !== undefined) everDerived.add(a.derivedFrom)
    }
  }
  const pending: PendingCaption[] = []
  for (const entry of fold(events)) {
    for (const a of entry.attachments) {
      if (a.kind === 'photo' && !everDerived.has(a.file)) {
        pending.push({ entryId: entry.id, stream: entry.stream, photo: a })
      }
    }
  }
  return pending
}
