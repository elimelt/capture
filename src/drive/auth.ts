/**
 * Google Identity Services token-flow wrapper (SPEC §8.2/§8.3). No backend ⇒
 * no refresh tokens: `initTokenClient` → `requestAccessToken()` yields a ~1h
 * access token, renewable only from a user gesture. We mirror it to IndexedDB
 * (token.ts) so a relaunch within the hour reuses it, and expose a small,
 * gesture-driven `connect()` the reconnect pill / Settings / Sync all call.
 *
 * The GIS script is loaded from index.html; this module only depends on the
 * global `google.accounts.oauth2` surface, declared minimally below (no types
 * package). Everything else about auth state lives in token.ts.
 */
import { GOOGLE_CLIENT_ID } from '../config'
import { clearToken, saveToken, type DriveToken } from './token'

/** Only what we touch of the GIS oauth2 token-client surface. */
interface TokenResponse {
  access_token?: string
  expires_in?: string | number
  error?: string
  error_description?: string
}
interface TokenClient {
  callback: (resp: TokenResponse) => void
  requestAccessToken(overrides?: { prompt?: string }): void
}
interface GisOauth2 {
  initTokenClient(config: {
    client_id: string
    scope: string
    prompt?: string
    callback: (resp: TokenResponse) => void
  }): TokenClient
  revoke(accessToken: string, done?: () => void): void
}
declare global {
  // GIS attaches itself to the global object; typed here since we ship no
  // @types for it. Read via globalThis so it resolves in the browser and in
  // the node test environment alike.
  // eslint-disable-next-line no-var
  var google: { accounts?: { oauth2?: GisOauth2 } } | undefined
}

/** drive.file only: the app can see and touch only files it creates (§5.5). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** Resolves once the GIS script (loaded in index.html) is on `window`. */
function waitForGis(timeoutMs = 10_000): Promise<GisOauth2> {
  const oauth2 = globalThis.google?.accounts?.oauth2
  if (oauth2) return Promise.resolve(oauth2)
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const ready = globalThis.google?.accounts?.oauth2
      if (ready) return resolve(ready)
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('Google Identity Services failed to load'))
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

let client: TokenClient | undefined

async function getClient(): Promise<{ oauth2: GisOauth2; client: TokenClient }> {
  const oauth2 = await waitForGis()
  client ??= oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    // Overridden per-request; a default keeps the client valid before first use.
    callback: () => {},
  })
  return { oauth2, client }
}

/**
 * Request a Drive access token. MUST be called from a user gesture (§8.3).
 * `prompt: ''` lets GIS skip the account chooser when it safely can, so the
 * reconnect pill renews quietly; pass `prompt: 'consent'` to force the chooser.
 * On success the token is persisted and returned.
 */
export async function connect(prompt = ''): Promise<DriveToken> {
  const { client: tokenClient } = await getClient()
  return new Promise<DriveToken>((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error || !resp.access_token) {
        reject(new Error(resp.error_description || resp.error || 'authorization failed'))
        return
      }
      const expiresInSec = Number(resp.expires_in ?? 3600)
      const token: DriveToken = {
        accessToken: resp.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
      }
      void saveToken(token).then(() => resolve(token), reject)
    }
    try {
      tokenClient.requestAccessToken(prompt ? { prompt } : undefined)
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** Revoke at Google (best-effort) and drop the local token — the Settings "Disconnect". */
export async function disconnect(accessToken?: string): Promise<void> {
  if (accessToken) {
    try {
      const oauth2 = await waitForGis(2_000)
      await new Promise<void>((resolve) => oauth2.revoke(accessToken, resolve))
    } catch {
      // GIS unavailable or revoke failed: still clear locally so we look disconnected.
    }
  }
  await clearToken()
}
