/**
 * Pure view-model for the entry card (#78, revised by #102): decides what
 * the card's *always-visible* content is, so `EntryCard` can render a quiet
 * default state (time / context / content / actions) without embedding
 * those decisions in JSX. No I/O, no React — unit-tested directly
 * (cardView.test.ts). Builds on the existing `groupAttachments`; this module
 * never re-derives grouping semantics, it only picks/orders among them.
 *
 * #102 core inversion: the card no longer has a content-hiding "collapsed"
 * state — every attachment is always rendered somewhere (`primaryText`/
 * `primaryAudio` drive the header's layout choice, `photoGroups` drives the
 * thumbnail grid, and `EntryCard` mounts the rest — extra clips, extra
 * notes/transcripts, orphan captions — unconditionally via `AttachmentBody`).
 * Only actions (add/edit/delete, behind a "+" menu) and related memories
 * (behind their own small reveal) are ever hidden; nothing attachment-shaped
 * is. `extraCount` (the old "+N hidden" hint) is gone along with the content
 * it used to count as hidden.
 */
import type { Attachment, Entry } from '../contract/types'
import type { AttachmentGroups, PhotoGroup } from './attachmentGroups'
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
   *
   * This is purely a *layout* signal now (which text leads, and whether the
   * header's compact waveform or the full-width audio-only one applies) —
   * it does not gate visibility. Any additional transcripts/notes render
   * too, just after this one (`EntryCard`'s unconditional `AttachmentBody`).
   */
  primaryText?: { file: string; authorship: Authorship }
  /** The clip that plays from the card header (first audio attachment). */
  primaryAudio?: Attachment
  /** Whether the header shows a place-label/address string. */
  collapsedShowsLocation: boolean
  /**
   * Every photo attachment, paired with its own captions, in capture order
   * (#102) — the source for the card's always-visible thumbnail grid.
   * Pass-through of `groups.photoGroups`; kept on the view-model (rather
   * than making every caller re-derive it from `groupAttachments`) since
   * "what does the card's photo grid render" is exactly the kind of
   * collapsed-rendering decision this module owns.
   */
  photoGroups: PhotoGroup[]
}

export function cardViewModel(entry: Entry, groups: AttachmentGroups): CardViewModel {
  // Transcript wins over note: it's the entry's own spoken content.
  const primary = groups.transcripts[0] ?? groups.notes[0]
  const primaryAudio = groups.audio[0]
  return {
    primaryText: primary ? { file: primary.file, authorship: authorship(primary) } : undefined,
    primaryAudio,
    collapsedShowsLocation: Boolean(entry.location?.placeLabel ?? entry.location?.address),
    photoGroups: groups.photoGroups,
  }
}
