/**
 * Pure formatting helpers for the Settings "Diagnostics" section (issue #67):
 * the last full sync-cycle attempt is persisted (`store/events.ts`
 * getLastSyncResult/setLastSyncResult) specifically because pull failures
 * never write a sync row, so without this the only trace of a failing pull
 * was a 6 s truncated toast. Kept here as pure functions over the persisted
 * shape so the formatting logic is unit-testable without a DOM.
 */
import type { PersistedSyncResult } from '../store/events'

/**
 * One line per stream that needs attention: it errored, or it was skipped
 * because an earlier stream in the cycle hit `reconnect` (the token died for
 * the rest of the cycle — SPEC drainSync doc). Streams that finished cleanly
 * are omitted so the list stays focused on what actually needs a look.
 */
export function notableStreamLines(result: PersistedSyncResult): string[] {
  return result.perStream
    .filter((s) => s.error !== undefined || s.outcome === 'reconnect')
    .map((s) => `${s.stream}: ${s.outcome}${s.error ? ` — ${s.error}` : ''}`)
}

/** One-line summary of the whole cycle: outcome plus counts, when any. */
export function lastSyncAttemptSummary(result: PersistedSyncResult): string {
  const parts = [`Last attempt: ${result.outcome}`]
  if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`)
  if (result.pulled > 0) parts.push(`${result.pulled} pulled`)
  return parts.join(' · ')
}
