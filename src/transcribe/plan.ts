/**
 * Pure planning for transcription: which audio attachments still need a
 * transcript. Works over the raw event history, not just the folded view:
 * audio counts as transcribed if *any* text attachment was ever derived from
 * it — even one the user later edited or removed — so user changes to a
 * transcript are never clobbered by re-transcription.
 */
import { fold } from '../contract/fold'
import type { Attachment, LogEvent } from '../contract/types'

export interface PendingTranscription {
  entryId: string
  stream: string
  audio: Attachment
}

/** Machine transcript, as opposed to a user-typed note. */
export function isTranscript(a: Attachment): boolean {
  return a.kind === 'text' && a.derivedFrom !== undefined
}

export function pendingTranscriptions(events: readonly LogEvent[]): PendingTranscription[] {
  const everDerived = new Set<string>()
  for (const e of events) {
    if (e.type === 'revoke') continue
    for (const a of e.attachments ?? []) {
      if (a.kind === 'text' && a.derivedFrom !== undefined) everDerived.add(a.derivedFrom)
    }
  }
  const pending: PendingTranscription[] = []
  for (const entry of fold(events)) {
    for (const a of entry.attachments) {
      if (a.kind === 'audio' && !everDerived.has(a.file)) {
        pending.push({ entryId: entry.id, stream: entry.stream, audio: a })
      }
    }
  }
  return pending
}
