import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
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
    appSettings: { locationEnabled: true, assistantEnabled: false, assistantModel: 'gpt-oss:20b' },
    streamSettings: { maxClipSec: 60, keepAudioLocally: true },
  })
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
    const next = { locationEnabled: false, assistantEnabled: true, assistantModel: 'gemma3:27b' }
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
