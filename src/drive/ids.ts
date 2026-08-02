/**
 * Pre-generated Drive file-id allocator over `files.generateIds`. Ids are
 * fetched in batches and handed out one upload at a time, so minting costs
 * one request per BATCH_SIZE files instead of one find-before-upload GET per
 * file. The pool is in-memory only: unused ids are simply forgotten on
 * reload (Drive never reserves them), while ids that have been *assigned* to
 * a specific upload are persisted on the sync row (store/db.ts `fileIds`)
 * before the upload starts — that persisted id is what makes a retried
 * upload idempotent (409 = already created = success; see client.uploadFile).
 */
import { generateIds } from './client'

/** One generateIds request covers this many future uploads. */
export const BATCH_SIZE = 10

let pool: string[] = []

/** Take `count` pre-generated ids, refilling the pool in batches as needed. */
export async function allocateIds(token: string, count: number): Promise<string[]> {
  while (pool.length < count) {
    pool.push(...(await generateIds(token, Math.max(BATCH_SIZE, count - pool.length))))
  }
  return pool.splice(0, count)
}

/** Test hook: forget any pooled ids. */
export function resetIdPool(): void {
  pool = []
}
