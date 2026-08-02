/**
 * Shared in-memory fake for the Drive REST client (`../client`), assembled
 * as a superset of what used to be three independently hand-rolled fakes
 * (issue #70): bootstrap.test's node store (create/find), queue.test's
 * upload-order recording, failure injection, and 409-on-pregenerated-id
 * semantics, and pull.test's full journal-backed changes feed (cursors,
 * trash, appProperties). Consolidated so a client-contract change (e.g.
 * protocol v2 batched segments, #24) is mirrored in one place instead of
 * three, and so a fake drifting from `client.ts`'s actual contract is
 * caught once instead of silently testing the wrong thing wherever the
 * drift wasn't mirrored.
 *
 * Usage (see bootstrap.test.ts / queue.test.ts / pull.test.ts):
 *
 *   import { driveClientMock, fakeDrive, setActiveFakeDrive, type FakeDrive } from './testing/fakeDrive'
 *
 *   vi.mock('../client', driveClientMock) // must stay a literal top-level
 *                                          // call for vi.mock's hoisting
 *
 *   let drive: FakeDrive
 *   beforeEach(() => {
 *     drive = fakeDrive()
 *     setActiveFakeDrive(drive)
 *   })
 *
 * `setActiveFakeDrive` exists because the client mock forwards every call to
 * whichever `FakeDrive` instance is currently "active" — each test's
 * `beforeEach` swaps in a fresh one so tests never share upload
 * history/journal state.
 */
import { vi, type Mock } from 'vitest'

// Deliberately NOT a static `import { DriveError, FOLDER_MIME } from '../client'`:
// this module is imported (for `fakeDrive`/`setActiveFakeDrive`) by test files
// that also `vi.mock('../client' /* relative to them */, ...)`, and a static
// import of the very module being mocked, from a module the mock's own
// factory transitively depends on, deadlocks on load (the factory would need
// to read this module's exports before this module has finished
// initializing). Instead, `fakeDrive()`'s methods throw the module-local
// `FakeHttpError` below, and `driveClientMock()` (which legitimately needs
// `../client` inside its factory, where a circular reference is fine because
// the factory itself runs lazily) translates it into the *real* `DriveError`
// — so callers' `err instanceof DriveError` checks against the actual,
// unmocked class still pass. `FOLDER_MIME`'s value is stable enough to inline
// rather than import.
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Fake methods throw this instead of the real `DriveError` (see above); the
 * client mock translates it at the boundary. */
class FakeHttpError extends Error {
  status: number
  /** Mirrors `DriveError.reason` (Drive's `error.errors[0].reason`, e.g.
   * `storageQuotaExceeded`) so quota/rate-limit classification tests can
   * exercise the fake without depending on the real class. */
  reason?: string
  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

function throwHttp(status: number, message: string, reason?: string): never {
  throw new FakeHttpError(status, message, reason)
}

export interface FakeNode {
  id: string
  name: string
  parentId: string
  mimeType: string
  content?: string | Blob
  trashed?: boolean
  appProperties?: Record<string, string>
}

interface JournalEntry {
  fileId: string
  removed?: boolean
}

export interface FakeUploadArgs {
  name: string
  parentId: string
  mimeType?: string
  body?: Blob | string
  fileId?: string
  appProperties?: Record<string, string>
}

export interface FakeDrive {
  nodes: FakeNode[]
  /** Upload order of *successful* uploads only (queue.test's drain-order assertions). */
  uploadOrder: string[]
  /** Low-level node creation, journaled by default (pull.test's changes feed). */
  add(
    name: string,
    parentId: string,
    mimeType: string,
    content?: string | Blob,
    opts?: { quiet?: boolean; trashed?: boolean; appProperties?: Record<string, string> },
  ): string
  /** Journal a metadata-only change entry for an existing node. */
  touch(fileId: string): void
  /** Journal a removal (permanent delete / lost visibility). */
  remove(fileId: string): void
  /** Fail every upload with this HTTP status (and optional Drive `reason`
   * code, e.g. `storageQuotaExceeded`) until cleared (`null`). */
  failNext(status: number | null, reason?: string): void
  /** Fail every upload of exactly this file name, forever, regardless of
   * `failNext` — simulates one deterministically-poison row while its
   * neighbors succeed. */
  failName(name: string | null, status?: number): void
  /** Fail every call of this Drive-read surface until cleared (`null`). */
  fail(on: 'list' | 'read' | 'changes' | null, status?: number): void
  /** Simulate a Google-account switch for subsequent tokens. */
  setUser(id: string): void
  findFile: Mock<(t: string, a: { name: string; parentId: string; mimeType?: string }) => Promise<string | null>>
  createFolder: Mock<
    (t: string, name: string, parentId: string, appProperties?: Record<string, string>) => Promise<string>
  >
  uploadFile: Mock<(t: string, a: FakeUploadArgs) => Promise<string>>
  updateFileContent: Mock<(t: string, id: string, mimeType: string, body: Blob | string) => Promise<void>>
  generateIds: Mock<(t: string, count: number) => Promise<string[]>>
  listChildren: Mock<
    (t: string, parentId: string) => Promise<{ id: string; name: string; mimeType: string }[]>
  >
  readFileText: Mock<(t: string, id: string) => Promise<string>>
  readFileBlob: Mock<(t: string, id: string) => Promise<Blob>>
  getFileMetadata: Mock<
    (t: string, id: string) => Promise<{ id: string; name: string; mimeType: string; parents: string[] }>
  >
  getStartPageToken: Mock<(t: string) => Promise<string>>
  listChanges: Mock<
    (
      t: string,
      pageToken: string,
    ) => Promise<{
      changes: { fileId: string; removed?: boolean; file?: Record<string, unknown> }[]
      newStartPageToken: string
    }>
  >
  getAboutUser: Mock<(t: string) => Promise<{ permissionId: string }>>
}

export function fakeDrive(): FakeDrive {
  const nodes: FakeNode[] = []
  const journal: JournalEntry[] = []
  const uploadOrder: string[] = []
  let n = 0
  let idGen = 0
  let failWith: { status: number; reason?: string } | null = null
  let failNameWith: { name: string; status: number } | null = null
  let failOn: 'list' | 'read' | 'changes' | null = null
  let failStatus = 500
  let user = 'user-A'

  const byId = (id: string) => nodes.find((f) => f.id === id)
  const changeOf = ({ fileId, removed }: JournalEntry) => {
    if (removed) return { fileId, removed: true }
    const f = byId(fileId)!
    return {
      fileId,
      file: {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        ...(f.trashed ? { trashed: true } : {}),
        parents: [f.parentId],
        ...(f.appProperties ? { appProperties: f.appProperties } : {}),
      },
    }
  }

  const add: FakeDrive['add'] = (name, parentId, mimeType, content, opts = {}) => {
    const id = `node-${n++}`
    nodes.push({
      id,
      name,
      parentId,
      mimeType,
      content,
      ...(opts.trashed ? { trashed: true } : {}),
      ...(opts.appProperties ? { appProperties: opts.appProperties } : {}),
    })
    if (!opts.quiet) journal.push({ fileId: id })
    return id
  }

  return {
    nodes,
    uploadOrder,
    add,
    touch(fileId) {
      journal.push({ fileId })
    },
    remove(fileId) {
      journal.push({ fileId, removed: true })
    },
    failNext(status, reason) {
      failWith = status === null ? null : { status, ...(reason ? { reason } : {}) }
    },
    failName(name, status = 400) {
      failNameWith = name === null ? null : { name, status }
    },
    fail(on, status = 500) {
      failOn = on
      failStatus = status
    },
    setUser(id) {
      user = id
    },

    findFile: vi.fn(
      async (_t: string, a: { name: string; parentId: string; mimeType?: string }) =>
        nodes.find(
          (f) =>
            f.name === a.name &&
            f.parentId === a.parentId &&
            (!a.mimeType || f.mimeType === a.mimeType),
        )?.id ?? null,
    ),
    createFolder: vi.fn(
      async (
        _t: string,
        name: string,
        parentId: string,
        appProperties?: Record<string, string>,
      ) => add(name, parentId, FOLDER_MIME, undefined, { appProperties }),
    ),
    uploadFile: vi.fn(async (_t: string, a: FakeUploadArgs) => {
      if (failNameWith && a.name === failNameWith.name) {
        throwHttp(failNameWith.status, 'boom-name')
      }
      if (failWith) throwHttp(failWith.status, 'boom', failWith.reason)
      // Mirror the real client's contract: re-uploading a pre-generated id
      // that already landed yields 409 upstream, which uploadFile swallows
      // and reports as success without creating anything.
      if (a.fileId && nodes.some((f) => f.id === a.fileId)) return a.fileId
      const id = a.fileId ?? add(a.name, a.parentId, a.mimeType ?? '', a.body, {
        appProperties: a.appProperties,
      })
      if (a.fileId) {
        // Node wasn't created by `add` above (id was pre-supplied) — do so now.
        nodes.push({
          id,
          name: a.name,
          parentId: a.parentId,
          mimeType: a.mimeType ?? '',
          ...(a.body !== undefined ? { content: a.body } : {}),
          ...(a.appProperties ? { appProperties: a.appProperties } : {}),
        })
        journal.push({ fileId: id })
      }
      uploadOrder.push(a.name)
      return id
    }),
    updateFileContent: vi.fn(async (_t: string, id: string, _mimeType: string, body: Blob | string) => {
      const node = byId(id)
      if (!node) throwHttp(404, 'not found')
      node!.content = body
    }),
    generateIds: vi.fn(async (_t: string, count: number) =>
      Array.from({ length: count }, () => `gen-${idGen++}`),
    ),
    listChildren: vi.fn(async (_t: string, parentId: string) => {
      if (failOn === 'list') throwHttp(failStatus, 'boom')
      return nodes
        .filter((f) => f.parentId === parentId && !f.trashed)
        .map(({ id, name, mimeType }) => ({ id, name, mimeType }))
    }),
    readFileText: vi.fn(async (_t: string, id: string) => {
      if (failOn === 'read') throwHttp(failStatus, 'boom')
      const c = byId(id)?.content
      return typeof c === 'string' ? c : ((await (c as Blob | undefined)?.text()) ?? '')
    }),
    readFileBlob: vi.fn(async (_t: string, id: string) => {
      if (failOn === 'read') throwHttp(failStatus, 'boom')
      const c = byId(id)?.content
      return typeof c === 'string' ? new Blob([c]) : (c ?? new Blob())
    }),
    getFileMetadata: vi.fn(async (_t: string, id: string) => {
      const f = byId(id)
      if (!f) throwHttp(404, 'not found')
      return { id: f.id, name: f.name, mimeType: f.mimeType, parents: [f.parentId] }
    }),
    getStartPageToken: vi.fn(async (_t: string) => String(journal.length)),
    listChanges: vi.fn(async (_t: string, pageToken: string) => {
      if (failOn === 'changes') throwHttp(failStatus, 'boom')
      return {
        changes: journal.slice(Number(pageToken)).map(changeOf),
        newStartPageToken: String(journal.length),
      }
    }),
    getAboutUser: vi.fn(async (_t: string) => ({ permissionId: user })),
  }
}

let active: FakeDrive | undefined

/** Swap in the `FakeDrive` instance the client mock forwards calls to. */
export function setActiveFakeDrive(drive: FakeDrive): void {
  active = drive
}

function current(): FakeDrive {
  if (!active) {
    throw new Error('fakeDrive: call setActiveFakeDrive() in a beforeEach before using the client')
  }
  return active
}

/**
 * Builds the mocked `../client` module: every export forwards to whichever
 * `FakeDrive` is currently active, translating a fake's `FakeHttpError` into
 * the *real* `DriveError` class at the boundary (`actual`, from
 * `vi.importActual`, is fetched here — safe because this factory runs lazily,
 * unlike a static top-level import) so SUT code's `err instanceof DriveError`
 * checks see the genuine class. Returns a plain object rather than calling
 * `vi.mock` itself — `vi.mock`'s hoisting only recognizes a literal top-level
 * call in the file that needs the mock, so each test file still writes its
 * own one-line `vi.mock('../client', () => driveClientMock())` (see
 * bootstrap.test.ts / queue.test.ts / pull.test.ts); what's shared here is
 * the ~200 lines of fake behavior behind it, not this wiring.
 */
export async function driveClientMock(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import('../client')>('../client')
  const forward =
    <A extends unknown[]>(call: (...a: A) => Promise<unknown>) =>
    async (...a: A) => {
      try {
        return await call(...a)
      } catch (err) {
        if (err instanceof FakeHttpError) {
          throw new actual.DriveError(err.status, err.message, err.reason)
        }
        throw err
      }
    }
  return {
    ...actual,
    findFile: forward((...a: [string, never]) => current().findFile(...a)),
    createFolder: forward((...a: [string, string, string]) => current().createFolder(...a)),
    uploadFile: forward((...a: [string, never]) => current().uploadFile(...a)),
    updateFileContent: forward((...a: [string, string, string, Blob | string]) => current().updateFileContent(...a)),
    generateIds: forward((...a: [string, number]) => current().generateIds(...a)),
    listChildren: forward((...a: [string, string]) => current().listChildren(...a)),
    readFileText: forward((...a: [string, string]) => current().readFileText(...a)),
    readFileBlob: forward((...a: [string, string]) => current().readFileBlob(...a)),
    getFileMetadata: forward((...a: [string, string]) => current().getFileMetadata(...a)),
    getStartPageToken: forward((...a: [string]) => current().getStartPageToken(...a)),
    listChanges: forward((...a: [string, string]) => current().listChanges(...a)),
    getAboutUser: forward((...a: [string]) => current().getAboutUser(...a)),
  }
}
