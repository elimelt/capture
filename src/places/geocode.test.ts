import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, resetDbCache } from '../store/db'
import { geocacheKey, reverseGeocode, shortAddress } from './geocode'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    impl(String(input)),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Back-date a cached cell's `cachedAt` in place, to simulate TTL expiry without waiting. */
async function ageCacheEntry(lat: number, lng: number, ageMs: number): Promise<void> {
  const db = await getDb()
  const key = geocacheKey(lat, lng)
  const row = await db.get('geocache', key)
  if (!row) throw new Error(`no cached row for ${key}`)
  await db.put('geocache', { ...row, cachedAt: new Date(Date.now() - ageMs).toISOString() })
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shortAddress', () => {
  it('prefers road + area over display_name', () => {
    expect(
      shortAddress({
        address: { road: 'Main St', city: 'Cambridge', county: 'Middlesex' },
        display_name: 'Main St, Cambridge, Middlesex, MA, USA',
      }),
    ).toBe('Main St, Cambridge')
  })

  it('falls back to the first two display_name parts when address has nothing usable', () => {
    expect(shortAddress({ display_name: 'Open Ocean, International Waters, Earth' })).toBe(
      'Open Ocean, International Waters',
    )
  })

  it('returns undefined when nothing is usable', () => {
    expect(shortAddress({})).toBeUndefined()
  })
})

describe('reverseGeocode', () => {
  it('caches a hit and never re-fetches within the TTL', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ address: { road: 'Main St', city: 'Cambridge' } }),
    )
    const first = await reverseGeocode(42.373, -71.11)
    expect(first).toBe('Main St, Cambridge')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = await reverseGeocode(42.373, -71.11)
    expect(second).toBe('Main St, Cambridge')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never sets a Referer header (browsers forbid it; would be a silent no-op)', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ address: { road: 'Main St' } }))
    await reverseGeocode(1, 1)
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers.Referer).toBeUndefined()
  })

  it('caches a negative result so a dead cell is not hit on every call', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}))
    expect(await reverseGeocode(2, 2)).toBeUndefined()
    expect(await reverseGeocode(2, 2)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches a negative result once its (shorter) TTL expires', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}))
    await reverseGeocode(3, 3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await ageCacheEntry(3, 3, 25 * 60 * 60 * 1000) // > 24h negative TTL
    await reverseGeocode(3, 3)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('re-fetches a positive result once the (longer) TTL expires', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ address: { road: 'Main St' } }))
    await reverseGeocode(4, 4)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await ageCacheEntry(4, 4, 91 * 24 * 60 * 60 * 1000) // > 90d positive TTL
    await reverseGeocode(4, 4)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent lookups of the same cell into one network call', async () => {
    // The resolver is created eagerly (not inside the fetch impl) so resolving
    // it doesn't race the throttle's delayed invocation of `fetch`.
    let resolveFetch: (r: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchMock = stubFetch(() => pending)
    const p1 = reverseGeocode(5, 5)
    const p2 = reverseGeocode(5, 5)
    resolveFetch(jsonResponse({ address: { road: 'Shared St' } }))
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe('Shared St')
    expect(b).toBe('Shared St')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never throws: network failure resolves to undefined', async () => {
    stubFetch(() => {
      throw new Error('offline')
    })
    await expect(reverseGeocode(6, 6)).resolves.toBeUndefined()
  })

  it('never throws: a non-OK response resolves to undefined', async () => {
    stubFetch(() => jsonResponse({}, 503))
    await expect(reverseGeocode(7, 7)).resolves.toBeUndefined()
  })
})

describe('geocacheKey', () => {
  it('rounds to the configured cell precision', () => {
    expect(geocacheKey(42.373123, -71.109876)).toBe('42.3731,-71.1099')
  })
})
