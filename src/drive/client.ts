/**
 * Google Drive API v3 over plain fetch + Bearer token (SPEC §8.1 — no gapi).
 * Only the primitives the upload engine needs: find a file/folder by name in
 * a parent, create a folder, upload file content (multipart, or resumable for
 * blobs > 5 MB), and read a file back. All writes stay under timebox/, which
 * drive.file scope both permits and confines us to.
 */

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** SPEC §8.4: resumable upload for anything > 5 MB (rare audio, some photos). */
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024

/** A Drive HTTP failure, classified for the queue's retry policy (§8.4). */
export class DriveError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'DriveError'
    this.status = status
  }
  /** 401/403 → token invalid or scope missing: stop and reconnect. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
  /** 429/5xx → transient: back off and retry. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res
  let detail = res.statusText
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body.error?.message) detail = body.error.message
  } catch {
    // Non-JSON error body; the status alone is enough to classify.
  }
  throw new DriveError(res.status, `Drive ${res.status}: ${detail}`)
}

/** Escape a value for use inside a Drive query-string literal. */
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export interface FindArgs {
  name: string
  parentId: string
  /** Pass FOLDER_MIME to find a folder specifically. */
  mimeType?: string
}

/** The id of the matching file/folder, or null if none exists. */
export async function findFile(
  token: string,
  { name, parentId, mimeType }: FindArgs,
): Promise<string | null> {
  const clauses = [`name = '${esc(name)}'`, `'${esc(parentId)}' in parents`, 'trashed = false']
  if (mimeType) clauses.push(`mimeType = '${esc(mimeType)}'`)
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id)',
    pageSize: '1',
  })
  const res = await ensureOk(await fetch(`${API}/files?${params}`, { headers: bearer(token) }))
  const data = (await res.json()) as { files?: { id: string }[] }
  return data.files?.[0]?.id ?? null
}

export async function createFolder(
  token: string,
  name: string,
  parentId: string,
  appProperties?: Record<string, string>,
): Promise<string> {
  const res = await ensureOk(
    await fetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        parents: [parentId],
        mimeType: FOLDER_MIME,
        ...(appProperties ? { appProperties } : {}),
      }),
    }),
  )
  return ((await res.json()) as { id: string }).id
}

/**
 * Mint Drive file ids client-side (`files.generateIds`). A pre-generated id
 * persisted before an upload makes the upload idempotent: retrying the same
 * id yields 409, which `uploadFile` treats as success (already uploaded).
 * Note: pre-generated ids work for blob files only — never folders.
 */
export async function generateIds(token: string, count: number): Promise<string[]> {
  const params = new URLSearchParams({
    count: String(count),
    space: 'drive',
    fields: 'ids',
  })
  const res = await ensureOk(
    await fetch(`${API}/files/generateIds?${params}`, { headers: bearer(token) }),
  )
  return ((await res.json()) as { ids: string[] }).ids
}

export interface UploadArgs {
  name: string
  parentId: string
  mimeType: string
  body: Blob | string
  /** Pre-generated id (files.generateIds); makes the upload an idempotent PUT-like op. */
  fileId?: string
  /** App-private metadata set at creation time (free) for files.list/changes discovery. */
  appProperties?: Record<string, string>
}

/**
 * Upload a new file, choosing multipart or resumable by size. Returns its id.
 * When `fileId` is a pre-generated id, a 409 means a previous attempt already
 * created this exact file — that is success, and the id is returned as-is.
 */
export async function uploadFile(token: string, args: UploadArgs): Promise<string> {
  const size = typeof args.body === 'string' ? new Blob([args.body]).size : args.body.size
  try {
    return size > RESUMABLE_THRESHOLD
      ? await uploadResumable(token, args)
      : await uploadMultipart(token, args)
  } catch (err) {
    if (args.fileId && err instanceof DriveError && err.status === 409) return args.fileId
    throw err
  }
}

function uploadMeta(args: UploadArgs): string {
  return JSON.stringify({
    name: args.name,
    parents: [args.parentId],
    ...(args.fileId ? { id: args.fileId } : {}),
    ...(args.appProperties ? { appProperties: args.appProperties } : {}),
  })
}

async function uploadMultipart(token: string, args: UploadArgs): Promise<string> {
  const boundary = `tb-${crypto.randomUUID()}`
  const meta = uploadMeta(args)
  // multipart/related: metadata part, then the media part. Let the Blob carry
  // the Content-Type so fetch emits the matching boundary automatically.
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${args.mimeType}\r\n\r\n`,
      args.body,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  )
  const res = await ensureOk(
    await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: bearer(token),
      body,
    }),
  )
  return ((await res.json()) as { id: string }).id
}

async function uploadResumable(token: string, args: UploadArgs): Promise<string> {
  const init = await ensureOk(
    await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json; charset=UTF-8' },
      body: uploadMeta(args),
    }),
  )
  const sessionUrl = init.headers.get('location')
  if (!sessionUrl) throw new DriveError(init.status, 'resumable upload: no session URL returned')
  const blob =
    typeof args.body === 'string' ? new Blob([args.body], { type: args.mimeType }) : args.body
  const res = await ensureOk(
    await fetch(sessionUrl, { method: 'PUT', headers: { 'Content-Type': args.mimeType }, body: blob }),
  )
  return ((await res.json()) as { id: string }).id
}

/** Read a file's contents as text (checkpoint/results read-back — §5.4). */
export async function readFileText(token: string, fileId: string): Promise<string> {
  const res = await ensureOk(
    await fetch(`${API}/files/${fileId}?alt=media`, { headers: bearer(token) }),
  )
  return res.text()
}

/** Read a file's contents as a Blob (attachment pull — §8.4). */
export async function readFileBlob(token: string, fileId: string): Promise<Blob> {
  const res = await ensureOk(
    await fetch(`${API}/files/${fileId}?alt=media`, { headers: bearer(token) }),
  )
  return res.blob()
}

/** One child of a folder listing (name-sortable for log order — §5.1). */
export interface DriveChild {
  id: string
  name: string
  mimeType: string
}

/**
 * List every non-trashed child of a folder, following pagination. Used by the
 * pull path to enumerate log/ partitions and their files: since filenames lead
 * with the zero-padded seq (§5.1), the names alone answer "everything after N"
 * without opening a file.
 */
export async function listChildren(token: string, parentId: string): Promise<DriveChild[]> {
  const children: DriveChild[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${esc(parentId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: '1000',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await ensureOk(await fetch(`${API}/files?${params}`, { headers: bearer(token) }))
    const data = (await res.json()) as { nextPageToken?: string; files?: DriveChild[] }
    if (data.files) children.push(...data.files)
    pageToken = data.nextPageToken
  } while (pageToken)
  return children
}

/**
 * Overwrite an existing file's media in place, leaving its name/parents alone.
 * Used to update the app-owned config.json (the target-calendar selection —
 * §5.3); the immutable log/ is never touched this way (§5.5).
 */
export async function updateFileContent(
  token: string,
  fileId: string,
  mimeType: string,
  body: Blob | string,
): Promise<void> {
  const blob = typeof body === 'string' ? new Blob([body], { type: mimeType }) : body
  await ensureOk(
    await fetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { ...bearer(token), 'Content-Type': mimeType },
      body: blob,
    }),
  )
}
