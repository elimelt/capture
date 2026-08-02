/**
 * Reverse geocoding (SPEC §7): coordinates → a short "near …" address.
 * Best-effort and never throws. Nominatim's usage policy requires caching,
 * ≤1 req/sec, and identifying the calling application, so: results are
 * cached in IndexedDB by a rounded cell key with a TTL; network calls are
 * serialized behind a shared 1s throttle; concurrent lookups of the same
 * cell share one in-flight request instead of racing.
 *
 * Identification: browsers treat `Referer` and `User-Agent` as forbidden
 * request headers — script cannot set either, so there is no way to attach
 * a custom app identity to the request. The browser's own default referrer
 * policy (`strict-origin-when-cross-origin`) already sends this app's
 * origin as the `Referer` on every request, which is what Nominatim's
 * policy means by "a valid HTTP Referer identifying the application" for
 * browser-based clients; we rely on that rather than pretending to set one.
 */
import { getDb } from '../store/db'
import { toLocalIso } from '../contract/time'

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse'
// ~4 decimals ≈ 11m: fine enough to distinguish addresses, coarse enough
// that nearby captures share a cell and reuse one cached lookup.
const CELL_DECIMALS = 4
const MIN_INTERVAL_MS = 1100
// Matches the workbox `osm-tiles`-adjacent cache layer's TTL for this endpoint
// (vite.config.ts) so both layers expire together.
const POSITIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000
// A cell with no resolvable address (open water, sparse data) is retried
// sooner than a hit — the coverage may improve, and it's cheap to recheck.
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

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

/** A cache lookup result: `undefined` means "no usable entry, go fetch". */
type CacheHit = { address: string | undefined }

async function readCache(key: string): Promise<CacheHit | undefined> {
  try {
    const db = await getDb()
    const row = await db.get('geocache', key)
    if (!row) return undefined
    const ttl = row.address ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
    if (Date.now() - new Date(row.cachedAt).getTime() > ttl) return undefined
    return { address: row.address }
  } catch {
    return undefined
  }
}

async function writeCache(key: string, address: string | undefined): Promise<void> {
  try {
    const db = await getDb()
    await db.put('geocache', { key, address, cachedAt: toLocalIso(new Date()) })
  } catch {
    // Cache write failures are non-fatal.
  }
}

// Lookups in flight, keyed by cell, so two concurrent captures in the same
// cell share one Nominatim request instead of both missing the cache and
// racing the throttle chain independently.
const inFlight = new Map<string, Promise<string | undefined>>()

/**
 * Reverse-geocode a coordinate to a short address, cached by cell. Returns
 * undefined on any failure (offline, blocked, throttled) or when Nominatim
 * has no address for the cell. Never throws.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | undefined> {
  const key = geocacheKey(lat, lng)
  const cached = await readCache(key)
  if (cached !== undefined) return cached.address

  const existing = inFlight.get(key)
  if (existing) return existing

  const lookup = (async () => {
    try {
      const address = await throttle(async () => {
        const url =
          `${ENDPOINT}?format=jsonv2&zoom=18&addressdetails=1` +
          `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        if (!res.ok) return undefined
        return shortAddress(await res.json())
      })
      await writeCache(key, address)
      return address
    } catch {
      return undefined
    }
  })()
  inFlight.set(key, lookup)
  try {
    return await lookup
  } finally {
    inFlight.delete(key)
  }
}
