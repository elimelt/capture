/** UI-facing zustand store: caches folded entries + settings, delegates writes to repos. */
import { create } from 'zustand'
import type { AmendPatch, CaptureEvent, Entry, GeoLocation } from '../contract/types'
import {
  appendAmend,
  appendCapture,
  appendRevoke,
  getSyncStatuses,
  listEntries,
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

interface AppState {
  currentStreamId: string
  entries: Entry[]
  syncStatuses: Map<number, SyncStatusRow>
  places: Place[]
  appSettings: AppSettings
  streamSettings: StreamSettings
  /** Last failed write, as a short human message; App shows it as a toast. */
  lastError: string | null

  refresh: (streamId?: string) => Promise<void>
  loadPlaces: () => Promise<void>
  loadSettings: () => Promise<void>
  init: () => Promise<void>
  clearError: () => void

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
    currentStreamId: 'timelog',
    entries: [],
    syncStatuses: new Map(),
    places: [],
    appSettings: { locationEnabled: true },
    streamSettings: { maxClipSec: 60, keepAudioLocally: true },
    lastError: null,

    refresh: async (streamId) => {
      const stream = streamId ?? get().currentStreamId
      const [entries, syncStatuses] = await Promise.all([
        listEntries(stream),
        getSyncStatuses(stream),
      ])
      set({ currentStreamId: stream, entries, syncStatuses })
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

    init: async () => {
      await Promise.all([get().refresh(), get().loadPlaces(), get().loadSettings()])
    },

    clearError: () => set({ lastError: null }),

    capture: guard(
      'Could not save entry',
      async (input: {
        capturedAt: string
        location?: GeoLocation
        attachments: NewAttachment[]
      }) => {
        const event = await appendCapture({ stream: get().currentStreamId, ...input })
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
      await Promise.all([get().refresh(), get().loadPlaces()])
    }),
  }
})
