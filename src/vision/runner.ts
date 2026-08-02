/**
 * Background captioning drain, the photo twin of transcribe/runner.ts — a
 * thin binding of `src/enrich/runner.ts`'s shared drain engine onto this
 * pipeline's plan/API/live-text store. Capture stays instant and
 * offline-first; this runs after the fact, posting each uncaptioned photo to
 * the vision model and appending the result as an amend event with a
 * derivedFrom text attachment (append-only — the caption flows to Drive
 * with everything else).
 *
 * This pipeline previously duplicated the transcribe runner's drain loop by
 * hand and the copy diverged (issue #51): it was missing the post-API
 * re-plan guard that drops a result if a sync pull imported another
 * device's caption mid-flight, which could cause duplicate captions on a
 * photo. Binding onto the shared engine means that guard (and every other
 * piece of failure handling — backoff, permanent-vs-transient
 * classification, the per-drain circuit breaker) now lives in exactly one
 * place for both pipelines.
 *
 * While a caption streams, partial text is published to the transient
 * `liveCaptions` store (keyed by source photo file) for the entry card;
 * only the final, complete caption is ever appended to the log.
 *
 * Enrichment is fully opt-in (owner policy, issue #89): this runner
 * early-returns unless `AppSettings.enrichmentEnabled` is on, independent of
 * whatever gate the caller (src/App.tsx) applies, so a future caller can't
 * accidentally send a photo to llm.elimelt.com by skipping the check.
 */
import { createEnrichmentRunner } from '../enrich/runner'
import { liveCaptions } from '../store/livetext'
import { skipKeyPrefix } from '../store/metaKeys'
import { captionPhoto } from './api'
import { pendingCaptions, type PendingCaption } from './plan'

const runner = createEnrichmentRunner<PendingCaption>({
  skipPrefix: skipKeyPrefix('caption'),
  plan: pendingCaptions,
  sourceOf: (item) => item.photo,
  targetOf: (item) => ({ entryId: item.entryId, stream: item.stream }),
  callApi: (blob, _item, onPartial) => captionPhoto(blob, onPartial),
  liveStore: liveCaptions,
})

/**
 * Captions every eligible pending photo attachment; returns how many amend
 * events were appended (caller refreshes the store if > 0). Re-entrant calls
 * coalesce onto the in-flight drain.
 */
export const drainCaptions = runner.drain

/**
 * Pure drain-gate predicate: the drain may run only while online *and* the
 * user has opted into automatic enrichment. Exported so the gate is testable
 * without touching IndexedDB or the network.
 */
export const shouldDrain = runner.shouldDrain

/** Every photo file permanently skipped (with reason + when) — diagnostics
 * for Settings (issue #55). */
export const listSkippedCaptions = runner.listSkipped

/** Clears a photo file's skip marker and in-session backoff so the next
 * drain retries it (Settings "retry" affordance — issue #55). */
export const retryCaption = runner.retry
