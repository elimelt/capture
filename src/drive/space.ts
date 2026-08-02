/**
 * Read-only Drive storage accounting for the Settings "Data" section
 * (SPEC §4.3). Deliberately self-contained — its own small fetch helper
 * mirroring client.ts's conventions — so it can evolve independently of the
 * upload/pull primitives; only the `DriveError` classification is shared.
 *
 * Two numbers per check:
 * - the account-wide quota from `about.get?fields=storageQuota` (`drive.file`
 *   is a sufficient scope); `limit` is absent on unlimited plans, and Drive
 *   returns int64s as strings.
 * - this app's own footprint, by summing `quotaBytesUsed` over a paginated
 *   `files.list`: under `drive.file` the listing only ever contains files the
 *   app created, so the sum is exactly the app's Drive usage.
 *
 * Callers fetch on demand (a tap in Settings) — never on a timer.
 */
import { DriveError } from './client'

const API = 'https://www.googleapis.com/drive/v3'

export interface DriveSpace {
  /** Account-wide bytes used (all of Drive, not just this app). */
  usageBytes: number
  /** Account quota in bytes; absent = unlimited plan. */
  limitBytes?: number
  /** Bytes used by files this app created (everything drive.file can see). */
  appBytes: number
}

/** GET a Drive JSON endpoint, classifying failures as DriveError (client.ts). */
async function getJson<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error?.message) detail = body.error.message
    } catch {
      // Non-JSON error body; the status alone is enough to classify.
    }
    throw new DriveError(res.status, `Drive ${res.status}: ${detail}`)
  }
  return (await res.json()) as T
}

/** Sum of `quotaBytesUsed` over every non-trashed file the app can see. */
async function sumAppBytes(token: string): Promise<number> {
  let total = 0
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: 'trashed = false',
      fields: 'nextPageToken, files(quotaBytesUsed)',
      pageSize: '1000',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await getJson<{
      nextPageToken?: string
      files?: { quotaBytesUsed?: string }[]
    }>(token, `${API}/files?${params}`)
    for (const file of data.files ?? []) total += Number(file.quotaBytesUsed ?? 0)
    pageToken = data.nextPageToken
  } while (pageToken)
  return total
}

/** One on-demand Drive storage check: account quota + this app's footprint. */
export async function fetchDriveSpace(token: string): Promise<DriveSpace> {
  const [about, appBytes] = await Promise.all([
    getJson<{ storageQuota?: { limit?: string; usage?: string } }>(
      token,
      `${API}/about?fields=storageQuota`,
    ),
    sumAppBytes(token),
  ])
  const quota = about.storageQuota
  return {
    usageBytes: Number(quota?.usage ?? 0),
    ...(quota?.limit !== undefined ? { limitBytes: Number(quota.limit) } : {}),
    appBytes,
  }
}
