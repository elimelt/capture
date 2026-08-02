import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './appStore'
import { getDb, resetDbCache } from './db'
import { getSettings, getStreamSettings } from './settings'
import type { Place } from './places'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

const AT = '2026-08-02T09:04:11-04:00'
const audioAttachment = () => ({
  kind: 'audio' as const,
  blob: new Blob(['hi'], { type: 'text/plain' }),
  mimeType: 'audio/mp4',
  durationSec: 3.2,
})
const home: Place = { id: 'p1', name: 'Home', lat: 40.7, lng: -74, radiusM: 100 }

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
  useAppStore.setState({
    currentStreamId: 'timelog',
    entries: [],
    syncStatuses: new Map(),
    places: [],
    lastError: null,
    lastSyncAt: null,
    appSettings: {
      locationEnabled: true,
      enrichmentEnabled: false,
      assistantEnabled: false,
      assistantModel: 'gpt-oss:20b',
    },
    streamSettings: { maxClipSec: 60, keepAudioLocally: true },
    localSpace: null,
    appSpace: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capture', () => {
  it('appends a capture event and refreshes entries and sync statuses', async () => {
    const event = await useAppStore.getState().capture({ capturedAt: AT, attachments: [] })
    const state = useAppStore.getState()
    expect(state.entries.map((e) => e.id)).toContain(event.id)
    expect(state.syncStatuses.get(event.id)?.status).toBe('queued')
  })
})

describe('amend', () => {
  it('updates the folded entry with patch.capturedAt', async () => {
    const event = await useAppStore.getState().capture({ capturedAt: AT, attachments: [] })
    await useAppStore
      .getState()
      .amend({ targets: [event.id], patch: { capturedAt: '2026-08-02T08:30:00-04:00' } })
    const { entries } = useAppStore.getState()
    expect(entries).toHaveLength(1)
    expect(entries[0].capturedAt).toBe('2026-08-02T08:30:00-04:00')
  })

  it('hides an attachment via patch.removeAttachments', async () => {
    const event = await useAppStore
      .getState()
      .capture({ capturedAt: AT, attachments: [audioAttachment()] })
    const file = event.attachments[0].file
    await useAppStore
      .getState()
      .amend({ targets: [event.id], patch: { removeAttachments: [file] } })
    expect(useAppStore.getState().entries[0].attachments).toEqual([])
  })
})

describe('revoke', () => {
  it('removes the entry from entries', async () => {
    const event = await useAppStore.getState().capture({ capturedAt: AT, attachments: [] })
    await useAppStore.getState().revoke([event.id])
    expect(useAppStore.getState().entries).toEqual([])
  })
})

describe('refresh', () => {
  it('switches currentStreamId', async () => {
    await useAppStore.getState().refresh('meals')
    expect(useAppStore.getState().currentStreamId).toBe('meals')
  })
})

describe('settings actions', () => {
  it('updateSettings persists and updates state', async () => {
    const next = {
      locationEnabled: false,
      enrichmentEnabled: true,
      assistantEnabled: true,
      assistantModel: 'gemma3:27b',
    }
    await useAppStore.getState().updateSettings(next)
    expect(useAppStore.getState().appSettings).toEqual(next)
    expect(await getSettings()).toEqual(next)
  })

  it('updateStreamSettings persists for the current stream and updates state', async () => {
    await useAppStore.getState().updateStreamSettings({ maxClipSec: 90, keepAudioLocally: false })
    expect(useAppStore.getState().streamSettings).toEqual({ maxClipSec: 90, keepAudioLocally: false })
    expect(await getStreamSettings('timelog')).toEqual({ maxClipSec: 90, keepAudioLocally: false })
  })
})

describe('clearError', () => {
  it('clears lastError', () => {
    useAppStore.setState({ lastError: 'boom' })
    useAppStore.getState().clearError()
    expect(useAppStore.getState().lastError).toBeNull()
  })
})

describe('wipe', () => {
  it('empties entries and places', async () => {
    await useAppStore.getState().capture({ capturedAt: AT, attachments: [] })
    await useAppStore.getState().addPlace(home)
    await useAppStore.getState().wipe()
    const state = useAppStore.getState()
    expect(state.entries).toEqual([])
    expect(state.places).toEqual([])
  })

  it('also disconnects Drive and clears every Cache Storage bucket (#65)', async () => {
    useAppStore.setState({ driveConnection: 'connected' })
    const deleted: string[] = []
    const fakeCaches = {
      keys: async () => ['nominatim', 'osm-tiles'],
      delete: async (key: string) => {
        deleted.push(key)
        return true
      },
    }
    // @ts-expect-error -- test double for the Cache Storage API, absent in node
    globalThis.caches = fakeCaches
    try {
      await useAppStore.getState().wipe()
    } finally {
      // @ts-expect-error -- restore the ambient (unavailable) state
      delete globalThis.caches
    }
    expect(useAppStore.getState().driveConnection).toBe('disconnected')
    expect(deleted.sort()).toEqual(['nominatim', 'osm-tiles'])
  })
})

describe('space accounting', () => {
  it('refreshSpace captures the origin estimate and the app-data breakdown', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 4321, quota: 5_000_000 }) },
    })
    await useAppStore.getState().capture({ capturedAt: AT, attachments: [audioAttachment()] })
    await useAppStore.getState().refreshSpace()
    const state = useAppStore.getState()
    expect(state.localSpace).toEqual({ usageBytes: 4321, quotaBytes: 5_000_000 })
    expect(state.appSpace?.eventCount).toBe(1)
    expect(state.appSpace?.blobBytes).toBe(2) // the 'hi' audio blob
  })

  it('degrades to a null estimate when storage.estimate is unsupported', async () => {
    vi.stubGlobal('navigator', {})
    await useAppStore.getState().refreshSpace()
    const state = useAppStore.getState()
    expect(state.localSpace).toBeNull()
    expect(state.appSpace).not.toBeNull()
  })

  it('wipe re-measures space so the Settings display cannot go stale', async () => {
    // Regression: usage used to be measured once on Settings mount, so the
    // number on screen survived "Wipe local data" unchanged.
    await useAppStore.getState().capture({ capturedAt: AT, attachments: [audioAttachment()] })
    await useAppStore.getState().refreshSpace()
    expect(useAppStore.getState().appSpace?.totalBytes).toBeGreaterThan(0)
    await useAppStore.getState().wipe()
    expect(useAppStore.getState().appSpace?.totalBytes).toBe(0)
  })
})

describe('guard', () => {
  it('sets lastError and rejects when a write fails', async () => {
    ;(await getDb()).close()
    await expect(
      useAppStore.getState().capture({ capturedAt: AT, attachments: [] }),
    ).rejects.toThrow()
    expect(useAppStore.getState().lastError).toMatch(/^Could not save entry: /)
  })
})
