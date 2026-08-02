/**
 * Pure view-model for the collapsed vs. expanded entry card (#78): decides
 * what the collapsed card's primary content is, so `EntryCard` can render a
 * quiet default state (time / context / content / play / overflow) without
 * embedding that decision in JSX. No I/O, no React — unit-tested directly
 * (cardView.test.ts). Builds on the existing `groupAttachments`; this module
 * never re-derives grouping semantics, it only picks a primary among them.
 */
import type { Attachment, Entry } from '../contract/types'
import type { AttachmentGroups } from './attachmentGroups'
import { authorship, type Authorship } from './authorship'

export interface CardViewModel {
  /**
   * The card's primary text representation: the first machine transcript,
   * else the first user note. Undefined when the entry has neither (e.g. an
   * audio-only or photo-only entry). `authorship` is always `'authored'` or
   * `'spoken'` here — a photo caption is never chosen as primary text (see
   * `groups.transcripts`/`groups.notes` below) — but is typed as the full
   * `Authorship` union so callers compose against the one classification
   * (#80) rather than re-deriving it from a raw `derivedFrom` string.
   */
  primaryText?: { file: string; authorship: Authorship }
  /** The clip that plays from the card header (first audio attachment). */
  primaryAudio?: Attachment
  /** Whether the collapsed header shows a place-label/address string. */
  collapsedShowsLocation: boolean
  /**
   * Count of attachments not surfaced by the collapsed card (everything but
   * `primaryText` and `primaryAudio`) — drives the overflow affordance's
   * "+N" hint. Purely an attachment count; the expanded-only actions
   * (edit/delete/etc.) are not attachments and are not counted here.
   */
  extraCount: number
}

export function cardViewModel(entry: Entry, groups: AttachmentGroups): CardViewModel {
  // Transcript wins over note: it's the entry's own spoken content.
  const primary = groups.transcripts[0] ?? groups.notes[0]
  const primaryAudio = groups.audio[0]
  const shownFiles = new Set<string>()
  if (primary) shownFiles.add(primary.file)
  if (primaryAudio) shownFiles.add(primaryAudio.file)
  return {
    primaryText: primary ? { file: primary.file, authorship: authorship(primary) } : undefined,
    primaryAudio,
    collapsedShowsLocation: Boolean(entry.location?.placeLabel ?? entry.location?.address),
    extraCount: entry.attachments.filter((a) => !shownFiles.has(a.file)).length,
  }
}
