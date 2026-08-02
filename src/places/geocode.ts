/**
 * Reverse geocoding (SPEC §7): coordinates → a short "near …" address.
 * Best-effort and never throws. Nominatim's usage policy requires caching
 * and ≤1 req/sec, so results are cached in IndexedDB by a rounded cell key
 * and network calls are serialized behind a shared 1s throttle.
 */
import { getDb } from '../store/db'
import { toLocalIso } from '../contract/time'

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse'
// Identify the app per policy (stock UA / no identity may be blocked).
const APP_REFERER = 'timebox-pwa'
// ~4 decimals ≈ 11m: fine enough to distinguish addresses, coarse enough
// that nearby captures share a cell and reuse one cached lookup.
const CELL_DECIMALS = 4
const MIN_INTERVAL_MS = 1100

/** Rounded "lat,lng" cache cell for a coordinate. */
export function geocacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(CELL_DECIMALS)},${lng.toFixed(CELL_DECIMALS)}`
}

/**
 * Compress a Nominatim address object into a short label like
 * "Main St, Cambridge". Falls back to display_name's first parts.
 */
export function shortAddress(data: {
  address?: Record<string, string>
  display_name?: string
}): string | undefined {
  const a = data.address
  if (a) {
    const road = a.road ?? a.pedestrian ?? a.footway ?? a.neighbourhood
    const area = a.city ?? a.town ?? a.village ?? a.suburb ?? a.county
    const parts = [road, area].filter(Boolean)
    if (parts.length > 0) return parts.join(', ')
  }
  if (data.display_name) return data.display_name.split(',').slice(0, 2).join(',').trim()
  return undefined
}

let lastCallAt = 0
let chain: Promise<unknown> = Promise.resolve()

/** Serialize network calls so we never exceed ~1 req/sec across the app. */
function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCallAt = Date.now()
    return fn()
  })
  // Keep the chain alive regardless of individual failures.
  chain = run.catch(() => undefined)
  return run
}

async function readCache(key: string): Promise<string | undefined> {
  try {
    const db = await getDb()
    return (await db.get('geocache', key))?.address
  } catch {
    return undefined
  }
}

async function writeCache(key: string, address: string): Promise<void> {
  try {
    const db = await getDb()
    await db.put('geocache', { key, address, cachedAt: toLocalIso(new Date()) })
  } catch {
    // Cache write failures are non-fatal.
  }
}

/**
 * Reverse-geocode a coordinate to a short address, cached by cell. Returns
 * undefined on any failure (offline, blocked, throttled). Never throws.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | undefined> {
  const key = geocacheKey(lat, lng)
  const cached = await readCache(key)
  if (cached !== undefined) return cached

  try {
    const address = await throttle(async () => {
      const url =
        `${ENDPOINT}?format=jsonv2&zoom=18&addressdetails=1` +
        `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`
      const res = await fetch(url, {
        headers: { Accept: 'application/json', Referer: APP_REFERER },
      })
      if (!res.ok) return undefined
      return shortAddress(await res.json())
    })
    if (address) await writeCache(key, address)
    return address
  } catch {
    return undefined
  }
}
