/** UI-facing zustand store: caches folded entries + settings, delegates writes to repos. */
import { create } from 'zustand'
import type { AmendPatch, CaptureEvent, Entry, GeoLocation } from '../contract/types'
import {
  appendAmend,
  appendCapture,
  appendRevoke,
  getLastSyncAt,
  getLastSyncResult,
  getSyncStatuses,
  listAllSyncStatuses,
  listEntries,
  setLastSyncAt,
  setLastSyncResult,
  summarizeSyncStatuses,
  wipeAll,
  wipeCaches,
  type NewAttachment,
  type PersistedSyncResult,
} from './events'
import { reclaimStreamBlobs } from './blobGc'
import { deletePlace, listPlaces, savePlace, type Place } from './places'
import {
  getSettings,
  getStreamSettings,
  saveSettings,
  saveStreamSettings,
  type AppSettings,
  type StreamSettings,
} from './settings'
import type { SyncStatusRow } from './db'
import {
  estimateLocalSpace,
  measureAppSpace,
  type AppSpace,
  type LocalSpaceEstimate,
} from './space'
import { toLocalIso } from '../contract/time'
import { connectionState, getValidAccessToken, type DriveConnection } from '../drive/token'
import { connect, disconnect } from '../drive/auth'
import { getStoredToken } from '../drive/token'
import { drainStream } from '../drive/queue'
import { pullStream } from '../drive/pull'
import { runSyncCycle, type SyncResult } from '../drive/syncCycle'
import { allSyncStreams } from '../streams/registry'
import { reduceSyncProgress, type SyncProgress, type SyncProgressEvent } from './syncProgress'

// Re-exported so existing consumers (e.g. `settings/SettingsScreen.tsx`) can
// keep importing sync-result types from the store without knowing the sync
// engine itself now lives in `drive/syncCycle` (issue #63).
export type { SyncResult, StreamSyncResult, SyncOutcome } from '../drive/syncCycle'

/** Web Locks name serializing `drainSync` across every tab/window on this origin (issue #50). */
const SYNC_LOCK_NAME = 'capture:sync'

/**
 * Aggregate local sync state across every registered stream, for the Settings
 * status line: pending/error counts summed over all streams' sync rows, and
 * the *oldest* per-stream lastSyncAt — the conservative "everything is synced
 * as of" moment. Null when any stream has never completed a clean cycle.
 */
export interface GlobalSyncSummary {
  pending: number
  errors: number
  lastError?: string
  lastSyncAt: string | null
}

/**
 * Pending/error rollup + oldest lastSyncAt over all registered streams.
 * Reads the `sync` object store exactly once (`listAllSyncStatuses`) and
 * buckets rows by stream in memory, rather than the previous `1 + N` shape
 * (a `getSyncStatuses` per stream) — the by-stream index added for
 * `getSyncStatuses`/`listPendingSync` (issue #63) makes each of those calls
 * cheap on its own, but this rollup fans out across *every* registered
 * stream on every `refresh()` (after each capture/amend/revoke, and on
 * every `visibilitychange`), so one indexed query beats N of them.
 * `lastSyncAt` stamps still cost one `meta` point-read per stream — cheap
 * keyed gets, not scans, so left as-is.
 */
async function summarizeGlobalSync(): Promise<GlobalSyncSummary> {
  const streams = allSyncStreams()
  const [allRows, stamps] = await Promise.all([
    listAllSyncStatuses(),
    Promise.all(streams.map((stream) => getLastSyncAt(stream))),
  ])
  const byStream = new Map<string, SyncStatusRow[]>()
  for (const row of allRows) {
    const bucket = byStream.get(row.stream)
    if (bucket) bucket.push(row)
    else byStream.set(row.stream, [row])
  }
  const rows = streams.flatMap((stream) => byStream.get(stream) ?? [])
  const lastSyncAt = stamps.every((at): at is string => at !== undefined)
    ? stamps.reduce((oldest, at) => (at < oldest ? at : oldest))
    : null
  return { ...summarizeSyncStatuses(rows), lastSyncAt }
}

interface AppState {
  /** True once init() has settled; App dismisses the boot splash on it. */
  ready: boolean
  currentStreamId: string
  entries: Entry[]
  syncStatuses: Map<string, SyncStatusRow>
  /** When the current stream's last clean pull+push cycle completed; null = never. */
  lastSyncAt: string | null
  /** Aggregate pending/errors/lastSyncAt across all registered streams (Settings). */
  globalSyncSummary: GlobalSyncSummary
  places: Place[]
  appSettings: AppSettings
  streamSettings: StreamSettings
  /** Last failed write, as a short human message; App shows it as a toast. */
  lastError: string | null
  /** Drive auth state, drives the reconnect pill + Settings (SPEC §8.2). */
  driveConnection: DriveConnection
  /**
   * True when the most recent sync cycle stopped because Drive reported
   * `storageQuotaExceeded` (403, SPEC §8.4.5) — Drive is full. Distinct from
   * `driveConnection`: the token is fine, so the reconnect pill must never
   * show for this (issue #88, that used to loop reconnect forever on a full
   * Drive). Reset to false at the start of every cycle and re-set only if
   * that cycle hits quota again, so it self-clears once the user frees space.
   */
  driveQuotaExceeded: boolean
  /** True while a drain is in flight, so the UI can show progress / disable Sync. */
  syncing: boolean
  /**
   * Live detail for the sync cycle in flight — which stream, pull vs. push,
   * how far along. Null whenever `syncing` is false; built up during
   * `drainSync` by `reduceSyncProgress` from the progress events `pullStream`/
   * `drainStream` emit, and cleared when the cycle ends. Never persisted.
   */
  syncProgress: SyncProgress | null
  /** Origin-level usage/quota from storage.estimate(); null = unsupported/unloaded. */
  localSpace: LocalSpaceEstimate | null
  /** Byte breakdown of the app's own IndexedDB data; null until refreshSpace(). */
  appSpace: AppSpace | null
  /**
   * The last full sync-cycle attempt, persisted (issue #67) so a pull error —
   * which never writes a sync row — is still visible in Settings after the
   * 6 s error toast is gone or the app has been relaunched. Null before the
   * first cycle this install has ever run.
   */
  lastSyncResult: PersistedSyncResult | null

  refresh: (streamId?: string) => Promise<void>
  loadPlaces: () => Promise<void>
  loadSettings: () => Promise<void>
  refreshConnection: () => Promise<void>
  /**
   * Reclaim GC-eligible blobs (issue #53 — fold-hidden and durably uploaded,
   * see `store/blobGc.ts`) across every registered stream, then re-measure
   * local storage (origin estimate + app breakdown). No network: the GC
   * sweep only reads local events/sync-rows and deletes local blobs.
   */
  refreshSpace: () => Promise<void>
  init: () => Promise<void>
  clearError: () => void

  /** Request a Drive token from a user gesture (SPEC §8.3). Does not sync. */
  connectDrive: () => Promise<void>
  disconnectDrive: () => Promise<void>
  /**
   * One full sync cycle over *every* registered stream (`allSyncStreams()`)
   * if a valid token exists — capture streams and system streams alike, since
   * system streams are never the on-screen stream. Per stream: pull the
   * remote log first (so pushes append after everything other devices
   * committed), then drain the upload queue. Failure isolation: a
   * 'reconnect' or 'quota' on any stream aborts the rest of the cycle (the
   * token is dead, or Drive is full, for every stream alike; the skipped
   * streams are marked with that same outcome in `perStream`), while
   * 'retry-later'/'error' on one stream never blocks the others. Sync is
   * manual-only: the sole caller is the "Sync now" button in Settings, so
   * Drive is contacted only on an explicit user ask. Returns the worst-of
   * aggregate outcome with summed counts and per-stream detail; a
   * missing/expired token yields 'reconnect' and a re-entrant call yields
   * 'busy' (issue #64 — distinct from a real Drive-side 'retry-later', so
   * Settings can tell "you double-tapped" from "Drive is having an outage").
   * Each stream's clean cycle persists its own lastSyncAt.
   *
   * Re-entrancy (issue #50): concurrent calls are serialized by a
   * `navigator.locks` lock (`SYNC_LOCK_NAME`) that spans every tab/window on
   * this origin, not just the in-memory `syncing` flag (which is per-tab and
   * — because of the `await` between checking it and setting it — was even
   * racy within one tab). A call that finds the lock held returns 'busy'
   * immediately instead of queuing or running concurrently; this closes the
   * gap that let two drains mint divergent Drive file ids for the same
   * contract filename. Where `navigator.locks` is unavailable, the in-memory
   * flag is the sole (best-effort, same-tab-only) guard.
   *
   * While in flight, `syncProgress` is kept live (via `reduceSyncProgress`,
   * `src/store/syncProgress`) from the progress events `pullStream`/
   * `drainStream` emit plus this loop's own per-stream boundaries; it is
   * cleared back to null when the cycle ends.
   */
  drainSync: () => Promise<SyncResult>

  capture: (input: {
    capturedAt: string
    location?: GeoLocation
    attachments: NewAttachment[]
  }) => Promise<CaptureEvent>
  revoke: (targets: string[]) => Promise<void>
  amend: (input: {
    targets: string[]
    patch?: AmendPatch
    attachments?: NewAttachment[]
  }) => Promise<void>
  addPlace: (place: Place) => Promise<void>
  removePlace: (id: string) => Promise<void>
  updateSettings: (settings: AppSettings) => Promise<void>
  updateStreamSettings: (settings: StreamSettings) => Promise<void>
  wipe: () => Promise<void>
}

export const useAppStore = create<AppState>()((set, get) => {
  // Write actions run through guard: failures set lastError (surfaced as a
  // toast in App) and re-throw for callers that await. M2's reconnect pill
  // builds on this channel.
  const guard =
    <A extends unknown[], R>(label: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args)
      } catch (err) {
        set({ lastError: `${label}: ${err instanceof Error ? err.message : String(err)}` })
        throw err
      }
    }

  // Stamps and persists the just-finished sync cycle (issue #67), and mirrors
  // it into in-memory state so Settings re-renders without a reload. Only
  // called for a cycle that actually ran (not the "already syncing" or
  // "no token" short-circuits, which are already durably reflected by
  // `syncing`/`driveConnection`).
  const persistSyncResult = async (result: SyncResult): Promise<void> => {
    const persisted: PersistedSyncResult = { at: toLocalIso(new Date()), ...result }
    await setLastSyncResult(persisted)
    set({ lastSyncResult: persisted })
  }

  return {
    ready: false,
    currentStreamId: 'timelog',
    entries: [],
    syncStatuses: new Map(),
    places: [],
    appSettings: {
      locationEnabled: true,
      enrichmentEnabled: false,
      assistantEnabled: false,
      assistantModel: 'gpt-oss:20b',
    },
    streamSettings: { maxClipSec: 60, keepAudioLocally: true },
    lastError: null,
    driveConnection: 'disconnected',
    driveQuotaExceeded: false,
    syncing: false,
    syncProgress: null,
    lastSyncAt: null,
    globalSyncSummary: { pending: 0, errors: 0, lastSyncAt: null },
    localSpace: null,
    appSpace: null,
    lastSyncResult: null,

    refresh: async (streamId) => {
      const stream = streamId ?? get().currentStreamId
      const [entries, syncStatuses, lastSyncAt, globalSyncSummary] = await Promise.all([
        listEntries(stream),
        getSyncStatuses(stream),
        getLastSyncAt(stream),
        summarizeGlobalSync(),
      ])
      set({
        currentStreamId: stream,
        entries,
        syncStatuses,
        lastSyncAt: lastSyncAt ?? null,
        globalSyncSummary,
      })
    },

    loadPlaces: async () => {
      set({ places: await listPlaces() })
    },

    loadSettings: async () => {
      const [appSettings, streamSettings] = await Promise.all([
        getSettings(),
        getStreamSettings(get().currentStreamId),
      ])
      set({ appSettings, streamSettings })
    },

    refreshConnection: async () => {
      set({ driveConnection: await connectionState() })
    },

    refreshSpace: async () => {
      for (const stream of allSyncStreams()) await reclaimStreamBlobs(stream)
      const [localSpace, appSpace] = await Promise.all([estimateLocalSpace(), measureAppSpace()])
      set({ localSpace, appSpace })
    },

    init: async () => {
      try {
        // Local-only status computation: entries, sync rows, lastSyncAt, and
        // the stored token's expiry. Sync itself is manual ("Sync now"). The
        // persisted lastSyncResult only ever changes from drainSync() in this
        // same session, so a one-time read here (rather than in refresh()) is
        // enough to surface it after a relaunch (issue #67).
        const [, , , , lastSyncResult] = await Promise.all([
          get().refresh(),
          get().loadPlaces(),
          get().loadSettings(),
          get().refreshConnection(),
          getLastSyncResult(),
        ])
        set({ lastSyncResult: lastSyncResult ?? null })
      } finally {
        // Even a failed boot must lift the splash so the error is visible.
        set({ ready: true })
      }
    },

    clearError: () => set({ lastError: null }),

    connectDrive: guard('Could not connect Google', async () => {
      await connect()
      set({ driveConnection: await connectionState() })
    }),

    disconnectDrive: guard('Could not disconnect Google', async () => {
      const token = await getStoredToken()
      await disconnect(token?.accessToken)
      set({ driveConnection: 'disconnected' })
    }),

    drainSync: async () => {
      // Cheap same-tab fast path; not load-bearing for correctness (the lock
      // below is), just avoids a pointless lock-acquisition attempt for the
      // common "I know I'm already syncing" case.
      if (get().syncing) return { outcome: 'busy', uploaded: 0, pulled: 0, perStream: [] }

      const runCycle = async (): Promise<SyncResult> => {
        const token = await getValidAccessToken()
        if (!token) {
          // No usable token: reflect expiry so the reconnect pill can appear.
          await get().refreshConnection()
          return { outcome: 'reconnect', uploaded: 0, pulled: 0, perStream: [] }
        }
        // Emits a progress event through the pure reducer (src/store/syncProgress)
        // and stores the resulting snapshot; passed straight through to
        // pullStream/drainStream as their onProgress callback.
        const emitProgress = (event: SyncProgressEvent) =>
          set((s) => ({ syncProgress: reduceSyncProgress(s.syncProgress, event) }))
        set({ syncing: true, syncProgress: null })
        emitProgress({ kind: 'cycle-start', streamsTotal: allSyncStreams().length })
        try {
          // The actual pull-then-push loop, failure isolation, worst-of
          // outcome ranking, and per-stream lastSyncAt stamping are pure
          // orchestration living in drive/syncCycle.ts (issue #63) — this
          // action now only supplies the token + the effectful deps and
          // mirrors the result into store state.
          const { result, reconnect, quotaExceeded } = await runSyncCycle(token, allSyncStreams(), {
            pull: pullStream,
            drain: drainStream,
            setLastSyncAt,
            now: () => toLocalIso(new Date()),
            onProgress: emitProgress,
          })
          if (reconnect) set({ driveConnection: 'expired' })
          // Always set (not just on quota): a clean cycle must clear a stale
          // true left over from an earlier full-Drive cycle once space frees
          // up and "Sync now" runs clean again.
          set({ driveQuotaExceeded: quotaExceeded })
          if (result.outcome === 'error' && result.error) {
            set({ lastError: `Sync failed: ${result.error}` })
          }
          // Re-read local state; pulled system-stream events can change
          // settings, so the in-memory settings cache reloads too.
          await get().refresh()
          await get().loadSettings()
          await persistSyncResult(result)
          return result
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          set({ lastError: `Sync failed: ${message}` })
          const result: SyncResult = {
            outcome: 'error',
            uploaded: 0,
            pulled: 0,
            error: message,
            perStream: [],
          }
          await persistSyncResult(result)
          return result
        } finally {
          emitProgress({ kind: 'cycle-done' })
          // The cycle is over; live detail is only meaningful while syncing.
          // The final SyncResult (returned above) already carries the summary
          // the UI shows afterwards (Settings' syncResultLabel).
          set({ syncing: false, syncProgress: null })
        }
      }

      // Cross-tab + intra-tab mutual exclusion (issue #50): `navigator.locks`
      // serializes every caller sharing this origin (tabs, windows, this
      // same call site re-entered) with no gap between "is it free" and
      // "claim it" the way the bare `syncing` flag above has. `ifAvailable:
      // true` makes a call that finds the lock held resolve immediately with
      // 'busy' instead of queuing behind the holder — a concurrent "Sync
      // now" must never silently run later, it must say so now. Falls back
      // to the flag-only guard where the API is unavailable (very old
      // browsers) — same-tab-only, best-effort, exactly the pre-fix behavior.
      const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
      if (!locks) return runCycle()
      return locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, (lock) =>
        lock
          ? runCycle()
          : Promise.resolve<SyncResult>({ outcome: 'busy', uploaded: 0, pulled: 0, perStream: [] }),
      )
    },

    capture: guard(
      'Could not save entry',
      async (input: {
        capturedAt: string
        location?: GeoLocation
        attachments: NewAttachment[]
      }) => {
        const event = await appendCapture({ stream: get().currentStreamId, ...input })
        // No eager upload: the entry stays queued locally until "Sync now".
        await get().refresh()
        return event
      },
    ),

    revoke: guard('Could not delete entry', async (targets: string[]) => {
      await appendRevoke({ stream: get().currentStreamId, targets })
      await get().refresh()
    }),

    amend: guard(
      'Could not update entry',
      async (input: { targets: string[]; patch?: AmendPatch; attachments?: NewAttachment[] }) => {
        await appendAmend({ stream: get().currentStreamId, ...input })
        await get().refresh()
      },
    ),

    addPlace: guard('Could not save place', async (place: Place) => {
      await savePlace(place)
      await get().loadPlaces()
    }),

    removePlace: guard('Could not remove place', async (id: string) => {
      await deletePlace(id)
      await get().loadPlaces()
    }),

    updateSettings: guard('Could not save settings', async (settings: AppSettings) => {
      await saveSettings(settings)
      set({ appSettings: settings })
    }),

    updateStreamSettings: guard('Could not save settings', async (settings: StreamSettings) => {
      await saveStreamSettings(get().currentStreamId, settings)
      set({ streamSettings: settings })
    }),

    wipe: guard('Could not wipe data', async () => {
      // Best-effort revoke the Google grant first (issue #65) — a wipe is a
      // privacy reset, so the OAuth consent must not outlive it. Runs before
      // wipeAll so a mid-wipe failure still leaves the token cleared.
      const token = await getStoredToken()
      await disconnect(token?.accessToken)
      await wipeAll()
      // SW Cache Storage (Nominatim addresses, OSM tiles) is not part of the
      // IndexedDB log wipeAll clears; drop it too or a "wiped" device still
      // holds a reconstructible location history.
      await wipeCaches()
      set({ driveConnection: 'disconnected' })
      // refreshSpace included so the Settings storage line never shows the
      // pre-wipe number (it used to be measured once on mount and go stale).
      await Promise.all([get().refresh(), get().loadPlaces(), get().refreshSpace()])
    }),
  }
})
