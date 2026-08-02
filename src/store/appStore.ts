/** UI-facing zustand store: caches folded entries + settings, delegates writes to repos. */
import { create } from 'zustand'
import type { AmendPatch, CaptureEvent, Entry, GeoLocation } from '../contract/types'
import {
  appendAmend,
  appendCapture,
  appendRevoke,
  getLastSyncAt,
  getSyncStatuses,
  listEntries,
  setLastSyncAt,
  summarizeSyncStatuses,
  wipeAll,
  type NewAttachment,
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
import { drainStream, type DrainOutcome } from '../drive/queue'
import { pullStream } from '../drive/pull'
import { allSyncStreams } from '../streams/registry'

/** One stream's slice of a sync cycle: its pull (Drive → local) then push. */
export interface StreamSyncResult {
  stream: string
  outcome: DrainOutcome
  uploaded: number
  pulled: number
  error?: string
}

/**
 * Combined result of one sync cycle across every registered stream
 * (`allSyncStreams()`): worst-of outcome, summed counts, per-stream detail.
 */
export interface SyncResult {
  outcome: DrainOutcome
  uploaded: number
  pulled: number
  error?: string
  perStream: StreamSyncResult[]
}

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

/** Pending/error rollup + oldest lastSyncAt over all registered streams. */
async function summarizeGlobalSync(): Promise<GlobalSyncSummary> {
  const perStream = await Promise.all(
    allSyncStreams().map(async (stream) => {
      const [statuses, lastSyncAt] = await Promise.all([
        getSyncStatuses(stream),
        getLastSyncAt(stream),
      ])
      return { statuses, lastSyncAt }
    }),
  )
  const rows = perStream.flatMap((s) => [...s.statuses.values()])
  const stamps = perStream.map((s) => s.lastSyncAt)
  const lastSyncAt = stamps.every((at): at is string => at !== undefined)
    ? stamps.reduce((oldest, at) => (at < oldest ? at : oldest))
    : null
  return { ...summarizeSyncStatuses(rows), lastSyncAt }
}

/** Worst-of ordering so one cycle reports its most actionable outcome. */
const OUTCOME_RANK: Record<DrainOutcome, number> = {
  idle: 0,
  drained: 1,
  'retry-later': 2,
  reconnect: 3,
  error: 4,
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
  /** True while a drain is in flight, so the UI can show progress / disable Sync. */
  syncing: boolean
  /** Origin-level usage/quota from storage.estimate(); null = unsupported/unloaded. */
  localSpace: LocalSpaceEstimate | null
  /** Byte breakdown of the app's own IndexedDB data; null until refreshSpace(). */
  appSpace: AppSpace | null

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
   * 'reconnect' on any stream aborts the rest of the cycle (the token is
   * dead for every stream; the skipped streams are marked 'reconnect' in
   * `perStream`), while 'retry-later'/'error' on one stream never blocks the
   * others. Sync is manual-only: the sole caller is the "Sync now" button in
   * Settings, so Drive is contacted only on an explicit user ask. Returns
   * the worst-of aggregate outcome with summed counts and per-stream detail;
   * a missing/expired token yields 'reconnect' and a re-entrant call yields
   * 'retry-later'. Each stream's clean cycle persists its own lastSyncAt.
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
    syncing: false,
    lastSyncAt: null,
    globalSyncSummary: { pending: 0, errors: 0, lastSyncAt: null },
    localSpace: null,
    appSpace: null,

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
        // the stored token's expiry. Sync itself is manual ("Sync now").
        await Promise.all([
          get().refresh(),
          get().loadPlaces(),
          get().loadSettings(),
          get().refreshConnection(),
        ])
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
      if (get().syncing) return { outcome: 'retry-later', uploaded: 0, pulled: 0, perStream: [] }
      const token = await getValidAccessToken()
      if (!token) {
        // No usable token: reflect expiry so the reconnect pill can appear.
        await get().refreshConnection()
        return { outcome: 'reconnect', uploaded: 0, pulled: 0, perStream: [] }
      }
      set({ syncing: true })
      try {
        const perStream: StreamSyncResult[] = []
        let aborted = false
        for (const stream of allSyncStreams()) {
          if (aborted) {
            // The token is dead for every stream — don't burn more calls;
            // mark the skipped streams so the UI can show they got no chance.
            perStream.push({ stream, outcome: 'reconnect', uploaded: 0, pulled: 0 })
            continue
          }
          // Pull before push: local appends then land after everything the
          // remote log already has, and a restored device rehydrates first.
          const pull = await pullStream(token, stream)
          if (pull.outcome === 'reconnect') {
            perStream.push({ stream, outcome: 'reconnect', uploaded: 0, pulled: pull.pulled })
            aborted = true
            continue
          }
          const push = await drainStream(token, stream)
          if (push.outcome === 'reconnect') aborted = true

          const pullOutcome: DrainOutcome = pull.outcome === 'pulled' ? 'drained' : pull.outcome
          const outcome =
            OUTCOME_RANK[pullOutcome] > OUTCOME_RANK[push.outcome] ? pullOutcome : push.outcome
          const error = push.error ?? pull.error
          // This stream's clean cycle (no reconnect/retry/error) marks *its*
          // log synced; a failure elsewhere in the loop never blocks it.
          if (outcome === 'idle' || outcome === 'drained') {
            await setLastSyncAt(stream, toLocalIso(new Date()))
          }
          perStream.push({
            stream,
            outcome,
            uploaded: push.uploaded,
            pulled: pull.pulled,
            ...(error ? { error } : {}),
          })
        }
        if (aborted) set({ driveConnection: 'expired' })

        // Aggregate: worst-of outcome, summed counts, first stream error.
        const outcome = perStream.reduce<DrainOutcome>(
          (worst, r) => (OUTCOME_RANK[r.outcome] > OUTCOME_RANK[worst] ? r.outcome : worst),
          'idle',
        )
        const uploaded = perStream.reduce((n, r) => n + r.uploaded, 0)
        const pulled = perStream.reduce((n, r) => n + r.pulled, 0)
        const error = perStream.find((r) => r.error !== undefined)?.error
        if (outcome === 'error' && error) set({ lastError: `Sync failed: ${error}` })
        // Re-read local state; pulled system-stream events can change
        // settings, so the in-memory settings cache reloads too.
        await get().refresh()
        await get().loadSettings()
        return { outcome, uploaded, pulled, ...(error ? { error } : {}), perStream }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({ lastError: `Sync failed: ${message}` })
        return { outcome: 'error', uploaded: 0, pulled: 0, error: message, perStream: [] }
      } finally {
        set({ syncing: false })
      }
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
      await wipeAll()
      // refreshSpace included so the Settings storage line never shows the
      // pre-wipe number (it used to be measured once on mount and go stale).
      await Promise.all([get().refresh(), get().loadPlaces(), get().refreshSpace()])
    }),
  }
})
