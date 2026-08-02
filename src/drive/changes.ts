/**
 * Changes-feed cursor persistence (SPEC §8.5). The pull engine discovers new
 * remote events through `changes.list`, resuming from a cursor persisted in
 * the IndexedDB `meta` store — one key per stream, since each stream's pull
 * consumes the account-wide feed independently. Like the tree cache, the
 * cursor is advisory and self-healing: a missing, expired (410), or
 * otherwise unusable cursor just means one full listing walk, after which a
 * fresh cursor is minted and persisted. Cursors are account-bound, so a
 * Google-account switch clears them all up front (account.ts) rather than
 * waiting for Drive to reject them.
 *
 * The persisted value is format-versioned (SPEC §5.8): a cursor advanced by
 * an engine that couldn't read some log-file grammar has skipped past those
 * files' changes for good, so bumping CURSOR_FORMAT declares every older
 * cursor unusable — the next pull walks the full listing once, importing
 * whatever the old engine ignored, then mints a fresh cursor.
 */
import { getDb } from '../store/db'

const CHANGES_PREFIX = 'drive:changes:'
const CHANGES_KEY = (stream: string) => `${CHANGES_PREFIX}${stream}`

/**
 * Format 2: this engine reads batched log segments (SPEC §5.7). A format-1
 * cursor — persisted as a bare token string — may have been advanced past
 * segment changes the v1 engine ignored, so it does not count.
 */
const CURSOR_FORMAT = 2

interface StoredCursor {
  format: number
  token: string
}

/** The persisted changes.list cursor for a stream, if a usable one exists. */
export async function getChangesToken(stream: string): Promise<string | undefined> {
  const db = await getDb()
  const stored = (await db.get('meta', CHANGES_KEY(stream))) as StoredCursor | string | undefined
  if (typeof stored === 'object' && stored !== null && stored.format === CURSOR_FORMAT) {
    return stored.token
  }
  return undefined
}

export async function saveChangesToken(stream: string, token: string): Promise<void> {
  const db = await getDb()
  const stored: StoredCursor = { format: CURSOR_FORMAT, token }
  await db.put('meta', stored, CHANGES_KEY(stream))
}

export async function clearChangesToken(stream: string): Promise<void> {
  const db = await getDb()
  await db.delete('meta', CHANGES_KEY(stream))
}

/**
 * Drop every stream's cursor at once — the account-switch discard
 * (account.ts). Cursors from the old account would be rejected by Drive and
 * self-heal anyway; clearing them here makes the cold start deliberate rather
 * than dependent on a 4xx round trip.
 */
export async function clearAllChangesTokens(): Promise<void> {
  const db = await getDb()
  for (const key of await db.getAllKeys('meta')) {
    if (key.startsWith(CHANGES_PREFIX)) await db.delete('meta', key)
  }
}
