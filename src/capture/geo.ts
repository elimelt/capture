/** Location snapshot at capture (SPEC §7): concurrent, best-effort, never throws. */
import type { GeoLocation } from '../contract/types'
import { matchPlace } from '../places/match'
import type { Place } from '../store/places'

/** Default detection radius for a user-named place (metres). */
export const DEFAULT_PLACE_RADIUS_M = 50

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

/** Shared geolocation call behind both `snapshotLocation` and `locateCurrent`. */
function getCurrentLocation(places: Place[]): Promise<GeoLocation | undefined> {
  if (!('geolocation' in navigator)) return Promise.resolve(undefined)
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

/**
 * Passive capture-time snapshot (§7): silent and gated by the `locationEnabled`
 * setting, since capture stamps a coordinate on every entry without the user
 * asking each time. Never surfaces an error — a denial or timeout just means
 * no location on this entry.
 */
export function snapshotLocation(
  places: Place[],
  locationEnabled: boolean,
): Promise<GeoLocation | undefined> {
  if (!locationEnabled) return Promise.resolve(undefined)
  return getCurrentLocation(places)
}

/** Why an explicit `locateCurrent()` call didn't return a location. */
export type LocateFailureReason = 'unsupported' | 'failed'

export type LocateResult =
  | { ok: true; location: GeoLocation }
  | { ok: false; reason: LocateFailureReason }

/**
 * Explicit "use current location" request (#59): unlike `snapshotLocation`,
 * this always attempts geolocation regardless of the passive-capture
 * `locationEnabled` toggle — an explicit tap is deliberate user intent, not
 * ambient stamping, and the browser still gates the actual permission prompt
 * either way, so honoring the tap is not a privacy regression. Distinguishes
 * *why* it failed so the caller can show feedback instead of a silent no-op.
 */
export async function locateCurrent(places: Place[]): Promise<LocateResult> {
  if (!('geolocation' in navigator)) return { ok: false, reason: 'unsupported' }
  const location = await getCurrentLocation(places)
  return location ? { ok: true, location } : { ok: false, reason: 'failed' }
}
