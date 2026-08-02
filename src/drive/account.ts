/**
 * Google-account identity binding for account-bound local caches (SPEC §8.4,
 * §8.5). The tree id cache (tree.ts), the per-stream changes cursors
 * (changes.ts), and pre-generated upload file ids (ids.ts pool + sync-row
 * `fileIds`) are only meaningful on the account that minted them; after an
 * account switch they would point at the *old* account's files. We therefore
 * bind local state to the account's stable `user.permissionId` (about.get —
 * one cheap request per token per session, memoized) persisted in the `meta`
 * store: a fresh token whose id matches keeps every cache warm; a mismatch
 * discards all account-bound state exactly as if this device had never
 * bootstrapped — no error surfaced, the next sync just pays the normal
 * re-bootstrap/full-walk cost — and stores the new identity. A first-ever
 * grant (no stored identity, e.g. upgrading from an app version predating the
 * binding) binds without discarding. The binding deliberately survives
 * disconnect/reconnect: reconnecting the same account must stay free.
 */
import { getDb } from '../store/db'
import { stripPendingFileIds } from '../store/events'
import { getAboutUser } from './client'
import { clearAllChangesTokens } from './changes'
import { resetIdPool } from './ids'
import { clearTree } from './tree'

const ACCOUNT_KEY = 'drive:account'

/** The permissionId the local caches are bound to, if any grant ever completed. */
export async function getStoredAccountId(): Promise<string | undefined> {
  const db = await getDb()
  return (await db.get('meta', ACCOUNT_KEY)) as string | undefined
}

export async function saveAccountId(id: string): Promise<void> {
  const db = await getDb()
  await db.put('meta', id, ACCOUNT_KEY)
}

/** The access token already verified this session — one about.get per token. */
let verifiedAccessToken: string | undefined

/**
 * Verify that `token` belongs to the account the local caches are bound to,
 * discarding all account-bound state (tree cache, changes cursors, pooled and
 * sync-row pre-generated file ids) and re-binding when it does not. Callers
 * gate every read of account-bound state on this (bootstrap.ensureTree,
 * pullStream, drainStream). Returns true iff a switch was detected and the
 * caches were discarded, so callers holding pre-read account-bound rows know
 * to re-read. Throws DriveError on about.get failure, which the callers
 * already classify (401/403 → reconnect, 429/5xx → retry-later).
 */
export async function ensureAccountBound(token: string): Promise<boolean> {
  if (token === verifiedAccessToken) return false
  const { permissionId } = await getAboutUser(token)
  const stored = await getStoredAccountId()
  const switched = stored !== undefined && stored !== permissionId
  if (switched) {
    await clearTree()
    await clearAllChangesTokens()
    await stripPendingFileIds()
    resetIdPool()
  }
  if (stored !== permissionId) await saveAccountId(permissionId)
  verifiedAccessToken = token
  return switched
}

/** Test hook: forget the per-session verification memo. */
export function resetAccountMemo(): void {
  verifiedAccessToken = undefined
}
