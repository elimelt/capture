/**
 * Changes-feed cursor persistence (SPEC §8.5). The pull engine discovers new
 * remote events through `changes.list`, resuming from a cursor persisted in
 * the IndexedDB `meta` store — one key per stream, since each stream's pull
 * consumes the account-wide feed independently. Like the tree cache, the
 * cursor is advisory and self-healing: a missing, expired (410), or
 * otherwise unusable cursor (e.g. after switching Google accounts — the
 * cursor is account-bound) just means one full listing walk, after which a
 * fresh cursor is minted and persisted.
 */
import { getDb } from '../store/db'

const CHANGES_KEY = (stream: string) => `drive:changes:${stream}`

/** The persisted changes.list cursor for a stream, if one exists. */
export async function getChangesToken(stream: string): Promise<string | undefined> {
  const db = await getDb()
  return (await db.get('meta', CHANGES_KEY(stream))) as string | undefined
}

export async function saveChangesToken(stream: string, token: string): Promise<void> {
  const db = await getDb()
  await db.put('meta', token, CHANGES_KEY(stream))
}

export async function clearChangesToken(stream: string): Promise<void> {
  const db = await getDb()
  await db.delete('meta', CHANGES_KEY(stream))
}
