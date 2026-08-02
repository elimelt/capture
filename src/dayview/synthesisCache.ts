/**
 * Derived-data cache for the opt-in daily prose (#82). This is explicitly
 * NOT the append-only event log (SPEC §3.2 #5: derived state is separate and
 * rebuildable) — a cross-entry summary would go stale on every later
 * amend/revoke of the day's entries and would need amend churn just to track
 * that staleness. Instead it lives in the existing IndexedDB `meta`
 * key-value store (src/store/db.ts), one row per day keyed
 * `daySynthesis:<date>`, never synced, never read by the fold. A wipe loses
 * it; useDaySynthesis regenerates on the next explicit tap.
 *
 * The deterministic stat line itself is NOT cached — `daySynthesis` is cheap
 * enough to recompute every render and caching it would just be another
 * invalidation surface for zero benefit.
 */
import { getDb } from '../store/db'
import { daySynthesisKey } from '../store/metaKeys'

export interface DaySynthesisCacheEntry {
  date: string
  /** synthesisInputHash of the entries the prose was generated from; a
   *  cached row whose hash no longer matches the day's current entries is
   *  stale and must not be shown (useDaySynthesis treats it as a miss). */
  inputHash: string
  prose: string
  /** ISO local time the prose was generated. */
  generatedAt: string
}

/** Best-effort read; `undefined` on any failure (never throws). */
export async function readDaySynthesisCache(
  date: string,
): Promise<DaySynthesisCacheEntry | undefined> {
  try {
    const db = await getDb()
    return (await db.get('meta', daySynthesisKey(date))) as DaySynthesisCacheEntry | undefined
  } catch {
    return undefined
  }
}

/** Best-effort write; a failure just means the next open regenerates. */
export async function writeDaySynthesisCache(entry: DaySynthesisCacheEntry): Promise<void> {
  try {
    const db = await getDb()
    await db.put('meta', entry, daySynthesisKey(entry.date))
  } catch {
    // Cache write failures are non-fatal — same convention as geocode.ts.
  }
}
