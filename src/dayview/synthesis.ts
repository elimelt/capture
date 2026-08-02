/**
 * Deterministic day synthesis (#82): a pure fold over the day's entries into
 * the always-on stat line — "N moments · M places" — plus a stable input
 * hash used to key the derived-prose cache (useDaySynthesis.ts). No I/O, no
 * `Date.now()`/`Math.random()`; entries are already the folded, date-filtered
 * list the caller (DayScreen) computed, and this module never re-filters by
 * date itself.
 */
import type { Entry } from '../contract/types'

export interface DaySynthesis {
  moments: number
  /** Count of distinct `location.placeLabel`s among the entries. */
  places: number
  /** "N moments · M places", omitting the places segment when zero; empty
   *  string for an empty day (DayScreen renders nothing in that case). */
  statLine: string
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** Pure fold: counts + the rendered stat line. Never throws. */
export function daySynthesis(entries: readonly Entry[]): DaySynthesis {
  const moments = entries.length
  const placeLabels = new Set<string>()
  for (const e of entries) {
    if (e.location?.placeLabel) placeLabels.add(e.location.placeLabel)
  }
  const places = placeLabels.size
  if (moments === 0) return { moments, places, statLine: '' }
  const segments = [plural(moments, 'moment')]
  if (places > 0) segments.push(plural(places, 'place'))
  return { moments, places, statLine: segments.join(' · ') }
}

/** Per-entry signal `synthesisInputHash` hashes: id + total folded text
 * length (sum of the entry's transcript/note text, the same content
 * `formatDigest` renders — never attachment counts or envelope metadata). */
export interface EntryTextSignal {
  id: string
  textLength: number
}

/**
 * Deterministic string hash (FNV-1a, 32-bit, hex) — stable across runs and
 * platforms, compact enough for a cache key. Not cryptographic; collisions
 * are an acceptable cache-miss cost.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Cache-key input hash over the day's entry ids and folded text lengths
 * only — stable under reordering (sorted by id before hashing), changes
 * when an entry is added/removed/revoked (id set changes) or amended in a
 * way that changes its folded text length. Entries missing a matching
 * `texts` row are treated as length 0.
 */
export function synthesisInputHash(
  entries: readonly Entry[],
  texts: readonly EntryTextSignal[],
): string {
  const lengthById = new Map(texts.map((t) => [t.id, t.textLength]))
  const parts = entries
    .map((e) => `${e.id}:${lengthById.get(e.id) ?? 0}`)
    .sort()
  return fnv1a(parts.join('|'))
}
