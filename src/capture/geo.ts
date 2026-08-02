/** Location snapshot at capture (SPEC §7): concurrent, best-effort, never throws. */
import type { GeoLocation } from '../contract/types'
import { matchPlace } from '../places/match'
import type { Place } from '../store/places'

/** Default detection radius for a user-named place (metres). */
export const DEFAULT_PLACE_RADIUS_M = 50

/** Coerce a string-backed radius field to metres: default when empty/invalid, floor 10. */
export function coerceRadiusM(input: string): number {
  return Math.max(10, Math.round(Number(input) || DEFAULT_PLACE_RADIUS_M))
}

/**
 * True when a just-captured location should prompt "name this place" (§3.4):
 * a coordinate was captured but matched no existing place (no placeLabel).
 */
export function needsPlacePrompt(
  location: GeoLocation | undefined,
  locationEnabled: boolean,
): boolean {
  return locationEnabled && !!location && !location.placeLabel
}

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
