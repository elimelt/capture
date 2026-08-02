/**
 * Shared drain engine for the enrichment pipelines (src/transcribe,
 * src/vision — issue #51). The two pipelines were 90% copy-paste siblings
 * that had already diverged in behavior (the vision runner was missing the
 * post-API re-plan guard, causing duplicate captions); this factory holds
 * every piece of drain machinery that must behave identically across
 * pipelines — backoff, skip markers, live-text lifecycle, the pull-race
 * re-plan guard, failure classification, and a per-drain circuit breaker —
 * so that class of divergence can't recur. Each pipeline's `runner.ts`
 * becomes a thin binding of `plan` / `sourceOf` / `targetOf` / `callApi` /
 * `liveStore` (the only things that legitimately differ) onto
 * `createEnrichmentRunner`.
 *
 * Failure handling (see src/enrich/error.ts for the taxonomy):
 *
 * - **Offline**: drain returns 0 immediately, no IndexedDB touched.
 * - **Retryable** (`classifyFailure(err).retryable`): in-memory exponential
 *   backoff per source file, reset on app relaunch (issue #60 — HTTP 4xx
 *   rejections and local decode failures are *not* retryable and skip
 *   immediately instead of burning the retry budget every session forever).
 * - **Host-down** (`classifyFailure(err).hostDown`, a subset of retryable —
 *   network failure or request timeout): trips a per-drain circuit breaker
 *   so the rest of *this* drain's items are left pending rather than each
 *   serially burning its own request timeout against a stalled host
 *   (issue #62). Per-file backoff still applies to the item that failed.
 * - **Permanent**: a skip marker `{ reason, at }` is written to the
 *   IndexedDB `meta` store under `<skipPrefix><file>` so the file is never
 *   retried, across sessions — inspectable via `listSkipped()` and
 *   reversible via `retry()` (issue #55).
 * - **Missing local blob**: *deferred*, not skipped — issue #55: a source
 *   kept in Drive but pruned locally after upload (`keepAudioLocally`,
 *   `src/drive/queue.ts`) is indistinguishable from one never downloaded at
 *   all, and the correct behavior for both is "try again once a blob is
 *   local", not "never transcribe this on this device". No network call is
 *   made while deferred, so this costs nothing but an IndexedDB read per
 *   drain.
 * - **Success**: one amend appended, backoff state cleared. Before
 *   appending, the plan is re-run against the just-refreshed event log and
 *   the result is dropped if the source no longer needs one — a sync pull
 *   may have imported another device's result while the API call was in
 *   flight (at-most-once enrichment globally; this is the guard issue #51
 *   is about).
 */
import type { Attachment, LogEvent } from '../contract/types'
import { getDb } from '../store/db'
import { appendAmend, getBlob, listEvents } from '../store/events'
import type { LiveTextStore } from '../store/livetext'
import { getSettings } from '../store/settings'
import { classifyFailure, describeFailure } from './error'

const MAX_ATTEMPTS_PER_SESSION = 5
const BACKOFF_BASE_MS = 15_000

/** Persisted shape of a permanent skip marker (issue #55: reason + when,
 * instead of a bare `true`, so the state is inspectable). Older markers
 * written before this change are a bare `true`; both are honored. */
export interface SkipRecord {
  reason: string
  at: string
}

export interface SkippedItem extends SkipRecord {
  file: string
}

export interface EnrichmentTarget {
  entryId: string
  stream: string
}

export interface EnrichmentRunnerConfig<T> {
  /** Prefix for this pipeline's skip markers in the `meta` store, e.g.
   * `'transcribe:skip:'` — combined with the source file for the key. */
  skipPrefix: string
  /** Pure plan: which items still need enrichment, over the raw event log. */
  plan: (events: readonly LogEvent[]) => T[]
  /** The source attachment (audio/photo) a pending item is derived from. */
  sourceOf: (item: T) => Attachment
  /** The entry + stream an amend for this item should target. */
  targetOf: (item: T) => EnrichmentTarget
  /** Calls the external service; resolves the enrichment text (may be `''`
   * — a valid, non-retryable "nothing to say"), publishing streamed
   * partials via `onPartial`. Throw `EnrichmentError` (src/enrich/error.ts)
   * for a classified failure, or any other `Error` (treated as retryable,
   * not host-down). */
  callApi: (blob: Blob, item: T, onPartial: (text: string) => void) => Promise<string>
  /** Transient live-text store for this pipeline (`liveTranscripts` /
   * `liveCaptions`, src/store/livetext.ts). */
  liveStore: LiveTextStore
}

export interface EnrichmentRunner {
  /** Runs one drain over `streamId`; returns how many amend events were
   * appended. Re-entrant calls coalesce onto the in-flight drain. */
  drain(streamId: string): Promise<number>
  /** Pure drain-gate predicate: online && enrichment opted in. */
  shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean
  /** Every file this runner has permanently skipped, with why and when
   * (diagnostics — issue #55). */
  listSkipped(): Promise<SkippedItem[]>
  /** Clears a file's skip marker and in-session backoff so the very next
   * drain retries it (Settings "retry" affordance — issue #55). */
  retry(file: string): Promise<void>
}

function isSkipRecord(v: unknown): v is SkipRecord {
  return typeof v === 'object' && v !== null && 'reason' in v && 'at' in v
}

export function createEnrichmentRunner<T>(config: EnrichmentRunnerConfig<T>): EnrichmentRunner {
  /** In-memory retry state per source file: exponential backoff within a
   * session; reset on app relaunch (by design — see module doc). */
  const retryState = new Map<string, { attempts: number; nextAt: number }>()
  let draining: Promise<number> | null = null

  function skipKey(file: string): string {
    return `${config.skipPrefix}${file}`
  }

  async function skipRecord(file: string): Promise<SkipRecord | undefined> {
    const db = await getDb()
    const v = await db.get('meta', skipKey(file))
    if (v === undefined) return undefined
    if (isSkipRecord(v)) return v
    // Legacy marker (a bare `true`) predates recorded reasons.
    return { reason: 'unknown', at: '' }
  }

  async function markSkipped(file: string, reason: string): Promise<void> {
    const db = await getDb()
    const record: SkipRecord = { reason, at: new Date().toISOString() }
    await db.put('meta', record, skipKey(file))
  }

  function eligible(file: string): boolean {
    const s = retryState.get(file)
    if (!s) return true
    return s.attempts < MAX_ATTEMPTS_PER_SESSION && Date.now() >= s.nextAt
  }

  function recordFailure(file: string): void {
    const attempts = (retryState.get(file)?.attempts ?? 0) + 1
    retryState.set(file, {
      attempts,
      nextAt: Date.now() + BACKOFF_BASE_MS * 2 ** (attempts - 1),
    })
  }

  function shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean {
    return online && enrichmentEnabled
  }

  function drain(streamId: string): Promise<number> {
    draining ??= run(streamId).finally(() => {
      draining = null
    })
    return draining
  }

  async function run(streamId: string): Promise<number> {
    // Offline check first and synchronous, so an offline drain never
    // touches IndexedDB at all — matches the "returns 0 immediately" contract.
    if (!navigator.onLine) return 0
    const { enrichmentEnabled } = await getSettings()
    if (!shouldDrain(navigator.onLine, enrichmentEnabled)) return 0
    const events = await listEvents(streamId)
    const pending = config.plan(events)
    // Sweep live text from earlier attempts: anything no longer pending has
    // its persisted result visible by now (or was dropped), so the
    // transient copy is stale.
    config.liveStore.sweep(new Set(pending.map((p) => config.sourceOf(p).file)))
    let appended = 0
    // Per-drain circuit breaker (issue #62): once one item's failure looks
    // like a down/unreachable host rather than a per-request rejection, the
    // rest of this drain's items share that host and would fail identically
    // — stop attempting them and let per-file backoff handle the retry on a
    // later drain, instead of each burning its own request timeout in serial.
    let hostDown = false
    for (const item of pending) {
      if (hostDown) break
      const file = config.sourceOf(item).file
      if (!eligible(file) || (await skipRecord(file)) !== undefined) continue
      try {
        const blob = await getBlob(file)
        if (!blob) {
          // Deferred, not skipped — see module doc: this may be a source
          // never kept locally, or one pruned after upload; either way a
          // later drain retries for free once a blob is available.
          continue
        }
        // Partial text streams into the live store for the entry card; it
        // is display-only and never persisted. Only the resolved final
        // text reaches the log below — a mid-stream failure lands in the
        // catch, which clears the partial and classifies as usual.
        const text = await config.callApi(blob, item, (partial) => config.liveStore.set(file, partial))
        if (text === '') {
          config.liveStore.clear(file)
          await markSkipped(file, 'empty-result')
          continue
        }
        // A sync pull may have imported another device's result while the
        // API call was in flight; re-plan against the current log and drop
        // the result if this source no longer needs one (at-most-once
        // enrichment globally).
        const stillPending = config.plan(await listEvents(streamId))
        if (!stillPending.some((p) => config.sourceOf(p).file === file)) {
          config.liveStore.clear(file)
          retryState.delete(file)
          continue
        }
        const { entryId, stream } = config.targetOf(item)
        await appendAmend({
          stream,
          targets: [entryId],
          attachments: [
            {
              kind: 'text',
              blob: new Blob([text], { type: 'text/plain' }),
              mimeType: 'text/plain',
              derivedFrom: file,
            },
          ],
        })
        // The final live text stays in the live store until the next
        // drain sweeps it, so the card never flashes empty between the
        // amend landing and the store refresh that reveals it.
        retryState.delete(file)
        appended++
      } catch (err) {
        config.liveStore.clear(file)
        const failure = classifyFailure(err)
        if (!failure.retryable) {
          await markSkipped(file, describeFailure(err))
        } else {
          recordFailure(file)
          if (failure.hostDown) hostDown = true
        }
      }
    }
    return appended
  }

  async function listSkipped(): Promise<SkippedItem[]> {
    const db = await getDb()
    const keys = await db.getAllKeys('meta')
    const out: SkippedItem[] = []
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(config.skipPrefix)) continue
      const record = await skipRecord(key.slice(config.skipPrefix.length))
      if (record) out.push({ file: key.slice(config.skipPrefix.length), ...record })
    }
    return out
  }

  async function retry(file: string): Promise<void> {
    const db = await getDb()
    await db.delete('meta', skipKey(file))
    retryState.delete(file)
  }

  return { drain, shouldDrain, listSkipped, retry }
}
