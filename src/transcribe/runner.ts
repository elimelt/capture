/**
 * Background transcription drain. Capture stays instant and offline-first;
 * this runs after the fact, posting each untranscribed audio attachment to
 * the transcription service and appending the result as an amend event with
 * a derivedFrom text attachment (append-only — the transcript flows to
 * Drive with everything else once M2 lands).
 *
 * A thin binding of `src/enrich/runner.ts`'s shared drain engine onto this
 * pipeline's plan/API/live-text store (the only things that legitimately
 * differ from src/vision/runner.ts — see that module's doc comment and
 * issue #51 for why the shared engine exists). All failure handling
 * (backoff, permanent-vs-transient classification, the circuit breaker, the
 * pull-race re-plan guard, skip-marker persistence) lives there.
 *
 * While a transcription streams, partial text is published to the transient
 * `liveTranscripts` store (keyed by source audio file) for the entry card;
 * only the final, complete transcript is ever appended to the log.
 *
 * Enrichment is fully opt-in (owner policy, issue #89): this runner
 * early-returns unless `AppSettings.enrichmentEnabled` is on, independent of
 * whatever gate the caller (src/App.tsx) applies, so a future caller can't
 * accidentally send audio to transcribe.elimelt.com by skipping the check.
 */
import { createEnrichmentRunner } from '../enrich/runner'
import { liveTranscripts } from '../store/livetext'
import { transcribeAudio } from './api'
import { pendingTranscriptions, type PendingTranscription } from './plan'

const runner = createEnrichmentRunner<PendingTranscription>({
  skipPrefix: 'transcribe:skip:',
  plan: pendingTranscriptions,
  sourceOf: (item) => item.audio,
  targetOf: (item) => ({ entryId: item.entryId, stream: item.stream }),
  callApi: (blob, item, onPartial) => transcribeAudio(blob, item.audio.mimeType, onPartial),
  liveStore: liveTranscripts,
})

/**
 * Transcribes every eligible pending audio attachment; returns how many
 * amend events were appended (caller refreshes the store if > 0).
 * Re-entrant calls coalesce onto the in-flight drain.
 */
export const drainTranscriptions = runner.drain

/**
 * Pure drain-gate predicate: the drain may run only while online *and* the
 * user has opted into automatic enrichment. Exported so the gate is testable
 * without touching IndexedDB or the network.
 */
export const shouldDrain = runner.shouldDrain

/** Every audio file permanently skipped (with reason + when) — diagnostics
 * for Settings (issue #55). */
export const listSkippedTranscriptions = runner.listSkipped

/** Clears an audio file's skip marker and in-session backoff so the next
 * drain retries it (Settings "retry" affordance — issue #55). */
export const retryTranscription = runner.retry
