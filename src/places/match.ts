/** Point-in-radius place matching (SPEC §3.4). Pure; no I/O. */
import type { Place } from '../store/db'

const EARTH_RADIUS_M = 6_371_000

export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Nearest place whose radius contains the point, or undefined. */
export function matchPlace(
  places: readonly Place[],
  lat: number,
  lng: number,
): Place | undefined {
  let best: Place | undefined
  let bestDist = Infinity
  for (const p of places) {
    const d = haversineM({ lat, lng }, p)
    if (d <= p.radiusM && d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best
}
