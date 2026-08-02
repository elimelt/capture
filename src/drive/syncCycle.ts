/**
 * Multi-stream sync cycle orchestration (issue #63): pull-then-push per
 * registered stream, worst-of outcome ranking, account-wide failure
 * isolation (a 'reconnect' or 'quota' aborts the streams after it), and
 * per-stream lastSyncAt stamping. This is Drive-protocol orchestration, not
 * UI state — extracted out of `store/appStore.ts`'s `drainSync` action so it
 * is unit-testable without zustand and reusable anywhere a future caller
 * (a background/periodic sync, a CLI replay) needs the same cycle without
 * the UI store. `appStore.drainSync` now owns only token acquisition, the
 * re-entrancy guard (in-memory flag + cross-tab `navigator.locks`), `set()`
 * calls reflecting this module's result, and the post-cycle `refresh()`.
 *
 * `runSyncCycle` is pure orchestration over injected `pull`/`drain`/
 * `setLastSyncAt` functions (so tests supply fakes instead of mocking
 * `drive/pull`/`drive/queue` modules) — see `syncCycle.test.ts`.
 */
import type { SyncProgressEvent } from '../store/syncProgress'
import type { DrainOutcome, DrainResult } from './queue'
import type { PullResult } from './pull'

/** One stream's slice of a sync cycle: its pull (Drive → local) then push. */
export interface StreamSyncResult {
  stream: string
  outcome: DrainOutcome
  uploaded: number
  pulled: number
  error?: string
}

/**
 * The aggregate cycle result's outcome space: every per-stream `DrainOutcome`
 * plus `'busy'` — a cycle-level-only outcome no stream ever reports itself.
 * `'busy'` means the re-entrancy guard (`appStore.drainSync`) rejected this
 * call outright before any stream ran; it is distinct from `'retry-later'`
 * (a real Drive-side 429/5xx backoff after streams *did* run) so Settings
 * can tell "you double-tapped" from "Drive is having an outage" (issue #64).
 */
export type SyncOutcome = DrainOutcome | 'busy'

/**
 * Combined result of one sync cycle across every registered stream: worst-of
 * outcome, summed counts, per-stream detail.
 */
export interface SyncResult {
  outcome: SyncOutcome
  uploaded: number
  pulled: number
  error?: string
  perStream: StreamSyncResult[]
}

/** Worst-of ordering so one cycle reports its most actionable outcome. */
export const OUTCOME_RANK: Record<DrainOutcome, number> = {
  idle: 0,
  drained: 1,
  'retry-later': 2,
  quota: 3,
  reconnect: 4,
  error: 5,
}

export interface SyncCycleDeps {
  pull: (
    token: string,
    stream: string,
    onProgress: (event: SyncProgressEvent) => void,
  ) => Promise<PullResult>
  drain: (
    token: string,
    stream: string,
    onProgress: (event: SyncProgressEvent) => void,
  ) => Promise<DrainResult>
  /** Persists the moment a stream's own cycle came back clean (idle/drained). */
  setLastSyncAt: (stream: string, at: string) => Promise<void>
  /** The stamp to persist for a clean stream; injected for deterministic tests. */
  now: () => string
  /** Forwarded straight through to `pull`/`drain` as their progress callback. */
  onProgress?: (event: SyncProgressEvent) => void
}

/**
 * Outcome of one full cycle, plus the two account-wide conditions the caller
 * (`appStore.drainSync`) mirrors into `driveConnection`/`driveQuotaExceeded`.
 * These are carried separately from `result.outcome` because that field is
 * the *worst-of* outcome across every stream: a stream that errored before
 * the abort can outrank (`OUTCOME_RANK`) the reconnect/quota that caused the
 * abort, so the aggregate outcome alone cannot tell the caller whether to
 * flip the reconnect pill or the quota flag.
 */
export interface SyncCycleOutcome {
  result: SyncResult
  /** An account-wide 'reconnect' (dead token) stopped the cycle early. */
  reconnect: boolean
  /** An account-wide 'quota' (Drive full) stopped the cycle early. */
  quotaExceeded: boolean
}

/**
 * Run one pull-then-push cycle over `streams`, in order. Pull before push
 * per stream: local appends then land after everything the remote log
 * already has, and a restored device rehydrates first. A 'reconnect' or
 * 'quota' from any stream's pull/push is account-wide — the token is dead,
 * or Drive is full, for every stream alike — so the remaining streams are
 * skipped (marked with that same outcome) rather than burning more calls
 * that would fail identically; a 'retry-later'/'error' on one stream never
 * blocks the others. Each stream whose own outcome is clean ('idle' or
 * 'drained') gets its own `setLastSyncAt` stamp, independent of the rest.
 */
export async function runSyncCycle(
  token: string,
  streams: readonly string[],
  deps: SyncCycleDeps,
): Promise<SyncCycleOutcome> {
  const emitProgress = deps.onProgress ?? ((): void => {})
  const perStream: StreamSyncResult[] = []
  let abortOutcome: 'reconnect' | 'quota' | null = null

  for (const stream of streams) {
    if (abortOutcome) {
      perStream.push({ stream, outcome: abortOutcome, uploaded: 0, pulled: 0 })
      emitProgress({ kind: 'stream-start', stream })
      emitProgress({ kind: 'stream-done', stream })
      continue
    }
    emitProgress({ kind: 'stream-start', stream })
    const pull = await deps.pull(token, stream, emitProgress)
    if (pull.outcome === 'reconnect') {
      perStream.push({ stream, outcome: 'reconnect', uploaded: 0, pulled: pull.pulled })
      emitProgress({ kind: 'stream-done', stream })
      abortOutcome = 'reconnect'
      continue
    }
    const push = await deps.drain(token, stream, emitProgress)
    if (push.outcome === 'reconnect') abortOutcome = 'reconnect'
    else if (push.outcome === 'quota') abortOutcome = 'quota'
    emitProgress({ kind: 'stream-done', stream })

    const pullOutcome: DrainOutcome = pull.outcome === 'pulled' ? 'drained' : pull.outcome
    const outcome =
      OUTCOME_RANK[pullOutcome] > OUTCOME_RANK[push.outcome] ? pullOutcome : push.outcome
    const error = push.error ?? pull.error
    // This stream's clean cycle (no reconnect/retry/error) marks *its* log
    // synced; a failure elsewhere in the loop never blocks it.
    if (outcome === 'idle' || outcome === 'drained') {
      await deps.setLastSyncAt(stream, deps.now())
    }
    perStream.push({
      stream,
      outcome,
      uploaded: push.uploaded,
      pulled: pull.pulled,
      ...(error ? { error } : {}),
    })
  }

  // Aggregate: worst-of outcome, summed counts, first stream error.
  const outcome = perStream.reduce<DrainOutcome>(
    (worst, r) => (OUTCOME_RANK[r.outcome] > OUTCOME_RANK[worst] ? r.outcome : worst),
    'idle',
  )
  const uploaded = perStream.reduce((n, r) => n + r.uploaded, 0)
  const pulled = perStream.reduce((n, r) => n + r.pulled, 0)
  const error = perStream.find((r) => r.error !== undefined)?.error

  return {
    result: { outcome, uploaded, pulled, ...(error ? { error } : {}), perStream },
    reconnect: abortOutcome === 'reconnect',
    quotaExceeded: abortOutcome === 'quota',
  }
}
