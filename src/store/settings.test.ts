import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDbCache } from './db'
import { getSettings, getStreamSettings, saveSettings, saveStreamSettings } from './settings'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('app settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual({ locationEnabled: true })
  })

  it('round-trips saved settings', async () => {
    await saveSettings({ locationEnabled: false })
    expect(await getSettings()).toEqual({ locationEnabled: false })
  })

  it('merges a partial stored object over defaults', async () => {
    const db = await getDb()
    await db.put('meta', {}, 'settings:app')
    expect(await getSettings()).toEqual({ locationEnabled: true })
  })
})

describe('stream settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getStreamSettings('timelog')).toEqual({ maxClipSec: 60, keepAudioLocally: true })
  })

  it('round-trips saved settings per stream', async () => {
    await saveStreamSettings('timelog', { maxClipSec: 90, keepAudioLocally: false })
    expect(await getStreamSettings('timelog')).toEqual({ maxClipSec: 90, keepAudioLocally: false })
  })

  it('keeps settings independent between streams', async () => {
    await saveStreamSettings('timelog', { maxClipSec: 30, keepAudioLocally: false })
    await saveStreamSettings('meals', { maxClipSec: 120, keepAudioLocally: true })
    expect(await getStreamSettings('timelog')).toEqual({ maxClipSec: 30, keepAudioLocally: false })
    expect(await getStreamSettings('meals')).toEqual({ maxClipSec: 120, keepAudioLocally: true })
  })
})
