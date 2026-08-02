/**
 * Pure planning core for the per-entry edit sheet (SPEC §3.3, §4.1). A draft
 * holds the editable envelope fields — capture date, wall-clock time, and
 * staged attachment removals — and `draftPatch` translates a saved draft into
 * a single amend patch. Append-only by construction: the output is an
 * `AmendPatch` for one new `amend` event; nothing in the log is mutated.
 */
import type { AmendPatch, Entry } from '../contract/types'
import { civilTimeOf, localDateOf, zonedIso } from '../contract/time'

export interface EntryEditDraft {
  /** Calendar date "YYYY-MM-DD" of capturedAt, in the entry's own zone. */
  date: string
  /** Wall-clock time "HH:mm" of capturedAt, in the entry's own zone. */
  time: string
  /** Attachment files staged for removal (patch.removeAttachments on save). */
  removeFiles: string[]
}

/**
 * The draft the edit sheet opens with: current values, nothing staged. Both
 * fields read the timestamp's own civil fields (pure slices), so they always
 * describe one consistent instant in the ENTRY's zone — never a mix of the
 * string's date with the device zone's time, which would corrupt saves for
 * entries captured in another timezone.
 */
export function draftFromEntry(entry: Entry): EntryEditDraft {
  return {
    date: localDateOf(entry.capturedAt),
    time: civilTimeOf(entry.capturedAt),
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
 * (callers append no event for a no-op edit — in particular, open-then-save
 * never amends, whatever zone the entry was captured in). Date/time changes
 * recompose `capturedAt` in the entry's own `deviceTz` (seconds zeroed,
 * DST-resolved offset), so an edit made from another timezone moves exactly
 * the wall time the sheet displayed and preserves the entry's zone; removals
 * are filtered to files the entry currently shows, so a stale draft can't
 * name unknown files.
 */
export function draftPatch(entry: Entry, draft: EntryEditDraft): AmendPatch | null {
  const patch: AmendPatch = {}
  const base = draftFromEntry(entry)
  if (draft.date !== base.date || draft.time !== base.time) {
    patch.capturedAt = zonedIso(draft.date, draft.time, entry.deviceTz)
  }
  const present = new Set(entry.attachments.map((a) => a.file))
  const removals = [...new Set(draft.removeFiles)].filter((f) => present.has(f))
  if (removals.length > 0) patch.removeAttachments = removals
  return Object.keys(patch).length > 0 ? patch : null
}
