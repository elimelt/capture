import { getDb, type Place } from './db'

export type { Place }

export async function listPlaces(): Promise<Place[]> {
  const db = await getDb()
  return db.getAll('places')
}

export async function savePlace(place: Place): Promise<void> {
  const db = await getDb()
  await db.put('places', place)
}

export async function deletePlace(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('places', id)
}
