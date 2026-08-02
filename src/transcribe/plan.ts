/**
 * Pure planning for transcription: which audio attachments still need a
 * transcript. Derived entirely from the folded entries — a transcript is a
 * text attachment whose derivedFrom points at its source audio file — so
 * there is no separate job table to keep consistent.
 */
import type { Attachment, Entry } from '../contract/types'

export interface PendingTranscription {
  entryId: string
  stream: string
  audio: Attachment
}

/** Machine transcript, as opposed to a user-typed note. */
export function isTranscript(a: Attachment): boolean {
  return a.kind === 'text' && a.derivedFrom !== undefined
}

export function pendingTranscriptions(entries: readonly Entry[]): PendingTranscription[] {
  const pending: PendingTranscription[] = []
  for (const entry of entries) {
    if (entry.revoked) continue
    const transcribed = new Set(
      entry.attachments.filter(isTranscript).map((a) => a.derivedFrom),
    )
    for (const a of entry.attachments) {
      if (a.kind === 'audio' && !transcribed.has(a.file)) {
        pending.push({ entryId: entry.id, stream: entry.stream, audio: a })
      }
    }
  }
  return pending
}
