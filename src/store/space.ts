/**
 * Local storage-space accounting for the Settings "Data" section (SPEC §4.3).
 *
 * Two complementary numbers, because neither alone is honest:
 *
 * - `estimateLocalSpace()` — origin-level usage/quota from
 *   `navigator.storage.estimate()`. This covers everything the origin stores
 *   (IndexedDB *including* its structural overhead, plus service-worker
 *   caches such as OSM tiles and fonts), so it is the truthful "space this
 *   app occupies on the device" figure — but browsers pad/round it and it
 *   cannot be broken down.
 * - `measureAppSpace()` — what the app itself keeps in IndexedDB, measured
 *   from the rows: log events at their canonical serialized size (the exact
 *   bytes each occupies as a Drive file — SPEC §5.1), attachment blobs at
 *   `Blob.size`, and persisted assistant chats. By design this excludes
 *   IndexedDB overhead and service-worker caches; the origin estimate covers
 *   those.
 *
 * Everything degrades gracefully: a missing or rejecting
 * `navigator.storage.estimate` yields `null`, never a throw.
 */
import { serializeEvent } from '../contract/serialize'
import type { LogEvent } from '../contract/types'
import { getDb, type StoredChatRow } from './db'

/** Origin-level usage/quota; fields absent when the browser omits them. */
export interface LocalSpaceEstimate {
  usageBytes?: number
  quotaBytes?: number
}

/** Byte breakdown of the app's own IndexedDB data. */
export interface AppSpace {
  eventCount: number
  /** Canonical serialized size of the local log (its size as Drive files). */
  eventBytes: number
  blobCount: number
  /** Attachment blobs (audio clips, photos) — usually the dominant share. */
  blobBytes: number
  chatCount: number
  chatBytes: number
  /** eventBytes + blobBytes + chatBytes. */
  totalBytes: number
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Adaptive decimal-unit formatting (1 KB = 1000 B, matching how Drive and
 * desktop OSes report storage). One decimal below 10 so small values never
 * collapse to "0.0 MB"; whole numbers above. Non-finite/negative → "0 B".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  let i = 0
  let v = bytes
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  let rounded = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10
  // Rounding can carry into the next unit (999_500 B → "1000 KB" → "1 MB").
  if (rounded >= 1000 && i < UNITS.length - 1) {
    rounded = 1
    i++
  }
  return `${rounded} ${UNITS[i]}`
}

/**
 * Origin usage/quota via `navigator.storage.estimate()`; `null` when the API
 * is unavailable (older WebKit, node tests) or the call fails.
 */
export async function estimateLocalSpace(): Promise<LocalSpaceEstimate | null> {
  const storage = globalThis.navigator?.storage
  if (typeof storage?.estimate !== 'function') return null
  try {
    const est = await storage.estimate()
    return {
      ...(est.usage !== undefined ? { usageBytes: est.usage } : {}),
      ...(est.quota !== undefined ? { quotaBytes: est.quota } : {}),
    }
  } catch {
    return null
  }
}

const encoder = new TextEncoder()

/** Pure aggregation over store rows; `measureAppSpace` feeds it from IndexedDB. */
export function summarizeAppSpace(
  events: readonly LogEvent[],
  blobs: readonly { blob: Blob }[],
  chats: readonly StoredChatRow[],
): AppSpace {
  let eventBytes = 0
  for (const event of events) eventBytes += encoder.encode(serializeEvent(event)).length
  let blobBytes = 0
  for (const row of blobs) blobBytes += row.blob.size
  let chatBytes = 0
  for (const chat of chats) chatBytes += encoder.encode(JSON.stringify(chat)).length
  return {
    eventCount: events.length,
    eventBytes,
    blobCount: blobs.length,
    blobBytes,
    chatCount: chats.length,
    chatBytes,
    totalBytes: eventBytes + blobBytes + chatBytes,
  }
}

/** Measure the app's own IndexedDB data (one read-only transaction). */
export async function measureAppSpace(): Promise<AppSpace> {
  const db = await getDb()
  const tx = db.transaction(['events', 'blobs', 'chats'])
  const [events, blobs, chats] = await Promise.all([
    tx.objectStore('events').getAll(),
    tx.objectStore('blobs').getAll(),
    tx.objectStore('chats').getAll(),
  ])
  await tx.done
  return summarizeAppSpace(events, blobs, chats)
}
