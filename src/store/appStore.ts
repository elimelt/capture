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

  refresh: (streamId?: string) => Promise<void>
  loadPlaces: () => Promise<void>
  loadSettings: () => Promise<void>

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

export const useAppStore = create<AppState>()((set, get) => ({
  currentStreamId: 'timelog',
  entries: [],
  syncStatuses: new Map(),
  places: [],
  appSettings: { locationEnabled: true },
  streamSettings: { maxClipSec: 60, keepAudioLocally: true },

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

  capture: async (input) => {
    const event = await appendCapture({ stream: get().currentStreamId, ...input })
    await get().refresh()
    return event
  },

  revoke: async (targets) => {
    await appendRevoke({ stream: get().currentStreamId, targets })
    await get().refresh()
  },

  amend: async (input) => {
    await appendAmend({ stream: get().currentStreamId, ...input })
    await get().refresh()
  },

  addPlace: async (place) => {
    await savePlace(place)
    await get().loadPlaces()
  },

  removePlace: async (id) => {
    await deletePlace(id)
    await get().loadPlaces()
  },

  updateSettings: async (settings) => {
    await saveSettings(settings)
    set({ appSettings: settings })
  },

  updateStreamSettings: async (settings) => {
    await saveStreamSettings(get().currentStreamId, settings)
    set({ streamSettings: settings })
  },

  wipe: async () => {
    await wipeAll()
    await Promise.all([get().refresh(), get().loadPlaces()])
  },
}))
