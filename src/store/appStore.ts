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
  wipeAll,
  type NewAttachment,
} from './events'
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

/** Combined result of one sync cycle: pull (Drive → local) then push. */
export interface SyncResult {
  outcome: DrainOutcome
  uploaded: number
  pulled: number
  error?: string
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
  /** When the last full pull+push cycle completed cleanly; null = never synced. */
  lastSyncAt: string | null
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
  /** Re-measure local storage (origin estimate + app breakdown). No network. */
  refreshSpace: () => Promise<void>
  init: () => Promise<void>
  clearError: () => void

  /** Request a Drive token from a user gesture (SPEC §8.3). Does not sync. */
  connectDrive: () => Promise<void>
  disconnectDrive: () => Promise<void>
  /**
   * One full sync cycle if a valid token exists: pull the remote log first
   * (so pushes append after everything other devices committed), then drain
   * the upload queue. Sync is manual-only: the sole caller is the "Sync now"
   * button in Settings, so Drive is contacted only on an explicit user ask.
   * Returns the combined outcome so "Sync now" can report it; a
   * missing/expired token yields 'reconnect' and a re-entrant call yields
   * 'retry-later'. A clean cycle persists lastSyncAt.
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
    appSettings: { locationEnabled: true, assistantEnabled: false, assistantModel: 'gpt-oss:20b' },
    streamSettings: { maxClipSec: 60, keepAudioLocally: true },
    lastError: null,
    driveConnection: 'disconnected',
    syncing: false,
    lastSyncAt: null,
    localSpace: null,
    appSpace: null,

    refresh: async (streamId) => {
      const stream = streamId ?? get().currentStreamId
      const [entries, syncStatuses, lastSyncAt] = await Promise.all([
        listEntries(stream),
        getSyncStatuses(stream),
        getLastSyncAt(stream),
      ])
      set({ currentStreamId: stream, entries, syncStatuses, lastSyncAt: lastSyncAt ?? null })
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
      if (get().syncing) return { outcome: 'retry-later', uploaded: 0, pulled: 0 }
      const token = await getValidAccessToken()
      if (!token) {
        // No usable token: reflect expiry so the reconnect pill can appear.
        await get().refreshConnection()
        return { outcome: 'reconnect', uploaded: 0, pulled: 0 }
      }
      set({ syncing: true })
      try {
        // Pull before push: local appends then land after everything the
        // remote log already has, and a restored device rehydrates first.
        const pull = await pullStream(token, get().currentStreamId)
        if (pull.outcome === 'reconnect') {
          set({ driveConnection: 'expired' })
          await get().refresh()
          return { outcome: 'reconnect', uploaded: 0, pulled: pull.pulled }
        }
        const push = await drainStream(token, get().currentStreamId)
        if (push.outcome === 'reconnect') set({ driveConnection: 'expired' })

        const pullOutcome: DrainOutcome = pull.outcome === 'pulled' ? 'drained' : pull.outcome
        const outcome =
          OUTCOME_RANK[pullOutcome] > OUTCOME_RANK[push.outcome] ? pullOutcome : push.outcome
        const error = push.error ?? pull.error
        if (outcome === 'error' && error) set({ lastError: `Sync failed: ${error}` })
        // A fully clean cycle (no reconnect/retry/error) marks the log synced.
        if (outcome === 'idle' || outcome === 'drained') {
          await setLastSyncAt(get().currentStreamId, toLocalIso(new Date()))
        }
        await get().refresh()
        return { outcome, uploaded: push.uploaded, pulled: pull.pulled, ...(error ? { error } : {}) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set({ lastError: `Sync failed: ${message}` })
        return { outcome: 'error', uploaded: 0, pulled: 0, error: message }
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
