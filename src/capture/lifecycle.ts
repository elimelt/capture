/**
 * Pure display-lifecycle mapping (#79). The design review's complaint:
 * "Queued" gets prime visual space on essentially every recent capture
 * (Drive sync is manual-only — SPEC §8.4 — so a fresh entry sits at
 * `queued` until the user taps "Sync now" in Settings), while the state the
 * user actually cares about — "is the app still understanding this?" — lived
 * nowhere on the card. This module maps the entry's *real* sync/enrichment
 * state to the language the review asked for: quiet while the app is still
 * working, invisible once it's merely waiting for a manual sync, and never
 * quieter when something has actually gone wrong.
 *
 * Non-goal (per #79): no new stored state, no changes to
 * `SyncStatus`/`SyncPhase` (`src/store/db.ts`) — this is a display mapping
 * over existing sync rows and enrichment plans. `entryLifecycle` is a pure
 * function of the two inputs the issue named, so it composes independently
 * of the concurrent `enrichmentEnabled` setting work: with enrichment
 * disabled there is simply never any pending audio/photo, so
 * `hasPendingEnrichment` is always false and every non-error entry reads
 * 'settled'.
 */
import type { Entry } from '../contract/types'
import type { SyncStatusRow } from '../store/db'
import { isTranscript } from '../transcribe/plan'
import { isCaption } from '../vision/plan'

export type EntryLifecycle = 'understanding' | 'settled' | 'failed'

/**
 * Maps an entry's real sync status and pending-enrichment flag to one
 * display lifecycle.
 *
 * Invariant: a sync `error` always maps to `'failed'`, regardless of
 * `hasPendingEnrichment` — real failures must never read quieter than the
 * old "Failed" badge (#79 req. 4). An absent sync row (an entry pulled from
 * Drive that was never queued locally — PR #90 removed backoff, not the
 * "never queued" case) is treated like a caught-up entry: `'understanding'`
 * while enrichment is still pending, else `'settled'`.
 */
export function entryLifecycle(
  sync: SyncStatusRow | undefined,
  hasPendingEnrichment: boolean,
): EntryLifecycle {
  if (sync?.status === 'error') return 'failed'
  return hasPendingEnrichment ? 'understanding' : 'settled'
}

/**
 * Display copy for a lifecycle. `null` for `'settled'` means render nothing
 * — a queued-for-manual-sync or already-uploaded entry with nothing pending
 * needs no chrome, exactly like the old SyncBadge's "uploaded" case, now
 * also covering "queued". `'understanding'` uses the design review's own
 * suggested word ("a subtle integrated processing state ('Organizing…')")
 * rather than "Listening…", since enrichment covers photo captioning as well
 * as audio transcription. `'failed'` keeps the exact prior copy — unchanged
 * semantics, not quieter.
 */
export function lifecycleLabel(lifecycle: EntryLifecycle): string | null {
  switch (lifecycle) {
    case 'understanding':
      return 'Organizing…'
    case 'failed':
      return 'Upload failed — will retry'
    case 'settled':
      return null
  }
}

/**
 * Whether an entry still has an audio or photo attachment with no machine
 * text derived from it yet — reusing the same `isTranscript`/`isCaption`
 * discriminators `pendingTranscriptions`/`pendingCaptions`
 * (`src/transcribe/plan.ts`, `src/vision/plan.ts`) apply, rather than
 * re-deriving "is this a transcript/caption" divergently.
 *
 * This evaluates the entry's current (folded) attachments, not the raw event
 * history those two functions walk. The difference only matters for the rare
 * case of a user deleting a transcript/caption after the fact — the plan
 * functions' "ever derived" check remembers that and never re-enriches,
 * while this synchronous, render-time check would read the entry as pending
 * again. Deliberately traded off: the card needs this to be computable from
 * an `Entry` alone (no event-log fetch per card), and it is exactly true
 * while a transcript/caption is still streaming in — the derived text has no
 * persisted attachment until the runner's amend lands — so one boolean
 * covers "pending" and "streaming" without a separate check against the
 * live-text stores (`src/store/livetext.ts`).
 */
export function hasPendingEnrichment(entry: Entry): boolean {
  const transcribed = new Set(entry.attachments.filter(isTranscript).map((a) => a.derivedFrom))
  const captioned = new Set(entry.attachments.filter(isCaption).map((a) => a.derivedFrom))
  return entry.attachments.some(
    (a) =>
      (a.kind === 'audio' && !transcribed.has(a.file)) ||
      (a.kind === 'photo' && !captioned.has(a.file)),
  )
}
