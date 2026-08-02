/** Location snapshot at capture (SPEC §7): concurrent, best-effort, never throws. */
import type { GeoLocation } from '../contract/types'
import { matchPlace } from '../places/match'
import type { Place } from '../store/places'

export function snapshotLocation(
  places: Place[],
  locationEnabled: boolean,
): Promise<GeoLocation | undefined> {
  if (!locationEnabled || !('geolocation' in navigator)) {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords
          const place = matchPlace(places, lat, lng)
          resolve({
            lat,
            lng,
            accuracyM: Math.round(accuracy),
            ...(place ? { placeLabel: place.name } : {}),
          })
        },
        () => resolve(undefined),
        { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: false },
      )
    } catch {
      resolve(undefined)
    }
  })
}
