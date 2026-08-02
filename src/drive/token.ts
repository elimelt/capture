/**
 * Access-token persistence (SPEC §8.2). No backend ⇒ no refresh tokens: GIS
 * hands us a ~1h access token that we mirror to IndexedDB so a relaunch
 * within the hour reuses it (accepted, documented risk — §9.2). Renewal
 * itself needs a user gesture and lives in auth.ts; this module is the pure,
 * testable storage + expiry layer the rest of drive/ reads.
 */
import { getDb } from '../store/db'
import { DRIVE_TOKEN_KEY as TOKEN_KEY } from '../store/metaKeys'

/** Treat a token as expired a minute early so an in-flight drain never 401s. */
const SKEW_MS = 60_000

export interface DriveToken {
  accessToken: string
  /** Epoch ms at which the access token expires. */
  expiresAt: number
}

/** Connection state for the reconnect pill (SPEC §8.2). */
export type DriveConnection = 'connected' | 'expired' | 'disconnected'

export async function getStoredToken(): Promise<DriveToken | undefined> {
  const db = await getDb()
  return (await db.get('meta', TOKEN_KEY)) as DriveToken | undefined
}

export async function saveToken(token: DriveToken): Promise<void> {
  const db = await getDb()
  await db.put('meta', token, TOKEN_KEY)
}

export async function clearToken(): Promise<void> {
  const db = await getDb()
  await db.delete('meta', TOKEN_KEY)
}

export function tokenValid(
  token: DriveToken | undefined,
  now = Date.now(),
): token is DriveToken {
  return token !== undefined && token.expiresAt - SKEW_MS > now
}

/** The stored access token if present and unexpired, else undefined. */
export async function getValidAccessToken(now = Date.now()): Promise<string | undefined> {
  const token = await getStoredToken()
  return tokenValid(token, now) ? token.accessToken : undefined
}

export async function connectionState(now = Date.now()): Promise<DriveConnection> {
  const token = await getStoredToken()
  if (token === undefined) return 'disconnected'
  return tokenValid(token, now) ? 'connected' : 'expired'
}
