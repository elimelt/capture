/**
 * Pure sync-progress model (owner directive: "syncing has GOT to have a
 * progress indicator"). `appStore.drainSync` loops pull-then-push over every
 * registered stream (`allSyncStreams()`); this module turns the typed
 * progress events that loop and the drive engine (`src/drive/pull`,
 * `src/drive/queue`) emit along the way into one `SyncProgress` snapshot, via
 * a pure reducer, plus pure formatters for the UI. No React, no store, no
 * IndexedDB — trivially unit-testable, and never persisted (it describes only
 * the sync cycle currently in flight).
 *
 * Emission boundaries (deliberately coarse — never per-line/per-byte):
 * - `appStore.drainSync` itself emits `cycle-start` once, then `stream-start`
 *   / `stream-done` around each stream's pull-then-push pair — it already
 *   owns that loop, so `src/drive/pull`/`src/drive/queue` don't need to know
 *   about cross-stream position.
 * - `pullStream` emits `pull-progress` once per imported partition (cold-start
 *   walk or changes-feed page) — a page of events, not a per-event tick.
 * - `drainStream` emits `upload-start` once (the pending count for the
 *   stream) and `upload-progress` once per committed batch (a lone record or
 *   a whole segment) — never per file inside a batch.
 */

/** One boundary the sync machinery reports as it works. */
export type SyncProgressEvent =
  | { kind: 'cycle-start'; streamsTotal: number }
  | { kind: 'stream-start'; stream: string }
  | { kind: 'pull-progress'; stream: string; delta: number }
  | { kind: 'upload-start'; stream: string; itemsTotal: number }
  | { kind: 'upload-progress'; stream: string; delta: number }
  | { kind: 'stream-done'; stream: string }
  | { kind: 'cycle-done' }

export type SyncPhase = 'idle' | 'pulling' | 'uploading' | 'done'

/**
 * A snapshot of one sync cycle in progress. `stream` is the stream currently
 * being pulled/pushed (null before the first `stream-start` or after
 * `cycle-done`). `itemsTotal` is null while unknown — pull has no cheap
 * upfront count, so pull phases are always indeterminate; upload phases
 * become determinate the moment `upload-start` reports the pending count.
 * `pulled`/`uploaded` are cycle-wide running totals, not per-stream.
 */
export interface SyncProgress {
  phase: SyncPhase
  stream: string | null
  streamsDone: number
  streamsTotal: number
  itemsDone: number
  itemsTotal: number | null
  pulled: number
  uploaded: number
}

/** The state before any cycle has started; also the safe fallback for a stray event. */
export function emptySyncProgress(): SyncProgress {
  return {
    phase: 'idle',
    stream: null,
    streamsDone: 0,
    streamsTotal: 0,
    itemsDone: 0,
    itemsTotal: null,
    pulled: 0,
    uploaded: 0,
  }
}

/**
 * The pure reducer: one event in, one new snapshot out. Never mutates `prev`.
 * A `prev` of null is treated as `emptySyncProgress()` — defensive, not a
 * contract any caller should rely on; `appStore.drainSync` always opens a
 * cycle with `cycle-start` before any other event can reach this reducer.
 */
export function reduceSyncProgress(
  prev: SyncProgress | null,
  event: SyncProgressEvent,
): SyncProgress {
  const state = prev ?? emptySyncProgress()
  switch (event.kind) {
    case 'cycle-start':
      return { ...emptySyncProgress(), phase: 'pulling', streamsTotal: event.streamsTotal }
    case 'stream-start':
      return { ...state, phase: 'pulling', stream: event.stream, itemsDone: 0, itemsTotal: null }
    case 'pull-progress':
      return { ...state, pulled: state.pulled + event.delta }
    case 'upload-start':
      return { ...state, phase: 'uploading', itemsDone: 0, itemsTotal: event.itemsTotal }
    case 'upload-progress':
      return {
        ...state,
        itemsDone: state.itemsDone + event.delta,
        uploaded: state.uploaded + event.delta,
      }
    case 'stream-done':
      return { ...state, streamsDone: state.streamsDone + 1 }
    case 'cycle-done':
      return { ...state, phase: 'done', stream: null }
  }
}

/** "assistant-chats" -> "Assistant Chats". No registry lookup — stays a pure string transform so this module has zero dependencies. */
export function prettyStreamName(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Fraction in [0, 1] for a determinate progress bar, or null when the phase
 * is indeterminate (nothing to show but motion): `idle`/`pulling` never have
 * a cheap upfront total, and `uploading` is indeterminate until `upload-start`
 * reports one. `done` is always full.
 */
export function syncProgressFraction(p: SyncProgress): number | null {
  if (p.phase === 'done') return 1
  if (p.phase === 'uploading' && p.itemsTotal !== null && p.itemsTotal > 0) {
    return Math.min(1, p.itemsDone / p.itemsTotal)
  }
  return null
}

/** Human label, e.g. "Uploading 3 of 12 · Timelog" or "Checking Settings for changes (2 of 3)". */
export function formatSyncProgress(p: SyncProgress): string {
  switch (p.phase) {
    case 'idle':
      return 'Preparing to sync…'
    case 'pulling': {
      const position = p.streamsTotal > 0 ? ` (${p.streamsDone + 1} of ${p.streamsTotal})` : ''
      const stream = p.stream ? prettyStreamName(p.stream) : 'changes'
      return `Checking ${stream} for changes${position}`
    }
    case 'uploading': {
      const suffix = p.stream ? ` · ${prettyStreamName(p.stream)}` : ''
      return p.itemsTotal !== null
        ? `Uploading ${p.itemsDone} of ${p.itemsTotal}${suffix}`
        : `Uploading${suffix}`
    }
    case 'done': {
      const parts: string[] = []
      if (p.uploaded > 0) parts.push(p.uploaded === 1 ? '1 uploaded' : `${p.uploaded} uploaded`)
      if (p.pulled > 0) parts.push(p.pulled === 1 ? '1 pulled' : `${p.pulled} pulled`)
      return parts.length > 0 ? `Synced — ${parts.join(' · ')}` : 'Already up to date'
    }
  }
}
