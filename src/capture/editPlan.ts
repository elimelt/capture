/**
 * Pure planning core for the per-entry edit sheet (SPEC §3.3, §4.1). A draft
 * holds the editable envelope fields — capture date, wall-clock time, and
 * staged attachment removals — and `draftPatch` translates a saved draft into
 * a single amend patch. Append-only by construction: the output is an
 * `AmendPatch` for one new `amend` event; nothing in the log is mutated.
 */
import type { AmendPatch, Entry } from '../contract/types'
import { localDateOf, localTimeOf, withDateIso, withTimeOfDayIso } from '../contract/time'

export interface EntryEditDraft {
  /** Local calendar date "YYYY-MM-DD" of capturedAt. */
  date: string
  /** Device-local wall-clock time "HH:mm" of capturedAt. */
  time: string
  /** Attachment files staged for removal (patch.removeAttachments on save). */
  removeFiles: string[]
}

/** The draft the edit sheet opens with: current values, nothing staged. */
export function draftFromEntry(entry: Entry): EntryEditDraft {
  return {
    date: localDateOf(entry.capturedAt),
    time: localTimeOf(entry.capturedAt),
    removeFiles: [],
  }
}

/** Stage or unstage one attachment file for removal (pure toggle). */
export function toggleRemoval(draft: EntryEditDraft, file: string): EntryEditDraft {
  const removeFiles = draft.removeFiles.includes(file)
    ? draft.removeFiles.filter((f) => f !== file)
    : [...draft.removeFiles, file]
  return { ...draft, removeFiles }
}

/**
 * The amend patch a saved draft implies, or null when it changes nothing
 * (callers append no event for a no-op edit). Date/time changes recompose
 * `capturedAt` (seconds zeroed, matching the inline time picker); removals
 * are filtered to files the entry currently shows, so a stale draft can't
 * name unknown files.
 */
export function draftPatch(entry: Entry, draft: EntryEditDraft): AmendPatch | null {
  const patch: AmendPatch = {}
  const base = draftFromEntry(entry)
  if (draft.date !== base.date || draft.time !== base.time) {
    patch.capturedAt = withTimeOfDayIso(withDateIso(entry.capturedAt, draft.date), draft.time)
  }
  const present = new Set(entry.attachments.map((a) => a.file))
  const removals = [...new Set(draft.removeFiles)].filter((f) => present.has(f))
  if (removals.length > 0) patch.removeAttachments = removals
  return Object.keys(patch).length > 0 ? patch : null
}
