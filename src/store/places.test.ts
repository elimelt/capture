import { beforeEach, describe, expect, it } from 'vitest'
import { getDb, resetDbCache } from './db'
import { deletePlace, listPlaces, savePlace, type Place } from './places'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

const home: Place = { id: 'p1', name: 'Home', lat: 40.7, lng: -74, radiusM: 100 }

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('places repo', () => {
  it('lists no places initially', async () => {
    expect(await listPlaces()).toEqual([])
  })

  it('round-trips a saved place', async () => {
    await savePlace(home)
    expect(await listPlaces()).toEqual([home])
  })

  it('overwrites a place saved with the same id', async () => {
    await savePlace(home)
    await savePlace({ ...home, name: 'Office', radiusM: 50 })
    expect(await listPlaces()).toEqual([{ ...home, name: 'Office', radiusM: 50 }])
  })

  it('deletes a place by id', async () => {
    await savePlace(home)
    await deletePlace(home.id)
    expect(await listPlaces()).toEqual([])
  })

  it('treats deleting an unknown id as a no-op', async () => {
    await savePlace(home)
    await deletePlace('missing')
    expect(await listPlaces()).toEqual([home])
  })
})
