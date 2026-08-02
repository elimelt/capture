/**
 * Pure edit-sheet planning for pseudo-entries (SPEC §3.6): turn a rendered
 * PseudoEntry into an editable draft, and diff an edited draft back into the
 * minimal OverlayPatch to append. The no-op guard is the key invariant: an
 * unedited draft yields `undefined`, so closing the sheet without changes
 * never materializes an (empty) overlay.
 */
import { toLocalIso } from '../../contract/time'
import type { PseudoEntry } from './pseudoEntry'
import type { OverlayPatch } from './types'

/** The edit sheet's working copy of a pseudo-entry's editable fields. */
export interface OverlayDraft {
  title: string
  note: string
  /** Local-offset ISO-8601, as in OverlayPatch. */
  startAt: string
  endAt: string
}

export function draftFromPseudoEntry(entry: PseudoEntry): OverlayDraft {
  return {
    title: entry.title,
    note: entry.note ?? '',
    startAt: toLocalIso(new Date(entry.startMs)),
    endAt: toLocalIso(new Date(entry.endMs)),
  }
}

/**
 * The minimal patch that turns `original` into `edited`, or `undefined` when
 * nothing changed (the no-op guard). Only edited fields enter the patch, so
 * untouched fields keep tracking the live calendar event. Emptying the title
 * or note maps to the field's `clearX` (drop the override / remove the note)
 * rather than an empty-string value.
 */
export function overlayPatchFromDraft(
  original: OverlayDraft,
  edited: OverlayDraft,
): OverlayPatch | undefined {
  const patch: OverlayPatch = {}
  const title = edited.title.trim()
  if (title !== original.title.trim()) {
    if (title === '') patch.clearTitle = true
    else patch.title = title
  }
  const note = edited.note.trim()
  if (note !== original.note.trim()) {
    if (note === '') patch.clearNote = true
    else patch.note = note
  }
  if (edited.startAt !== original.startAt) patch.startAt = edited.startAt
  if (edited.endAt !== original.endAt) patch.endAt = edited.endAt
  return Object.keys(patch).length > 0 ? patch : undefined
}

/** The patch that flips a pseudo-entry's day-view visibility. */
export function toggleHidden(entry: PseudoEntry): OverlayPatch {
  return { hidden: !entry.hidden }
}
