import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A tiny in-memory Drive: folders/files addressed by (name, parentId). Lets us
 * assert bootstrap is idempotent (re-run creates nothing) and never clobbers
 * the mutable stubs it pre-creates.
 */
function fakeDrive() {
  interface Node {
    id: string
    name: string
    parentId: string
    isFolder: boolean
  }
  const nodes: Node[] = []
  let n = 0
  const find = (name: string, parentId: string) =>
    nodes.find((f) => f.name === name && f.parentId === parentId)

  const findFile = vi.fn(
    async (_t: string, a: { name: string; parentId: string; mimeType?: string }) =>
      find(a.name, a.parentId)?.id ?? null,
  )
  const createFolder = vi.fn(
    async (_t: string, name: string, parentId: string, _appProperties?: Record<string, string>) => {
      const id = `folder-${n++}`
      nodes.push({ id, name, parentId, isFolder: true })
      return id
    },
  )
  const uploadFile = vi.fn(
    async (_t: string, a: { name: string; parentId: string }) => {
      const id = `file-${n++}`
      nodes.push({ id, name: a.name, parentId: a.parentId, isFolder: false })
      return id
    },
  )
  let user = 'user-A'
  const getAboutUser = vi.fn(async (_t: string) => ({ permissionId: user }))
  return {
    nodes,
    find,
    findFile,
    createFolder,
    uploadFile,
    getAboutUser,
    /** Simulate a Google-account switch for subsequent tokens. */
    setUser(id: string) {
      user = id
    },
  }
}

let drive: ReturnType<typeof fakeDrive>

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return {
    ...actual,
    findFile: (...args: unknown[]) => drive.findFile(...(args as [string, never])),
    createFolder: (...args: unknown[]) => drive.createFolder(...(args as [string, string, string])),
    uploadFile: (...args: unknown[]) => drive.uploadFile(...(args as [string, never])),
    getAboutUser: (...args: unknown[]) => drive.getAboutUser(...(args as [string])),
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  drive = fakeDrive()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function load() {
  return import('./bootstrap')
}

describe('ensureTree', () => {
  it('creates the full tree once and caches ids', async () => {
    const { ensureTree } = await load()
    const tree = await ensureTree('tok', ['timelog'])

    expect(tree.rootId).toBeTruthy()
    expect(tree.streams.timelog.folderId).toBeTruthy()
    expect(tree.streams.timelog.logId).toBeTruthy()
    expect(tree.streams.timelog.resultsId).toBeTruthy()

    const names = drive.nodes.map((f) => f.name).sort()
    expect(names).toEqual(
      ['checkpoint.json', 'config.json', 'log', 'results', 'streams.json', 'timebox', 'timelog'].sort(),
    )

    const { getTree } = await import('./tree')
    expect(await getTree()).toEqual(tree)
  })

  it('is idempotent: a second run creates nothing new', async () => {
    const { ensureTree } = await load()
    await ensureTree('tok', ['timelog'])
    const createsAfterFirst = drive.createFolder.mock.calls.length
    const uploadsAfterFirst = drive.uploadFile.mock.calls.length

    await ensureTree('tok', ['timelog'])
    expect(drive.createFolder.mock.calls.length).toBe(createsAfterFirst)
    expect(drive.uploadFile.mock.calls.length).toBe(uploadsAfterFirst)
    expect(drive.nodes.filter((f) => f.name === 'timebox')).toHaveLength(1)
    expect(drive.nodes.filter((f) => f.name === 'checkpoint.json')).toHaveLength(1)
  })

  it('never re-uploads the mutable stubs when they already exist', async () => {
    const { ensureTree } = await load()
    await ensureTree('tok', ['timelog'])
    drive.uploadFile.mockClear()

    await ensureTree('tok', ['timelog'])
    const reuploaded = drive.uploadFile.mock.calls.map((c) => (c[1] as { name: string }).name)
    expect(reuploaded).not.toContain('config.json')
    expect(reuploaded).not.toContain('checkpoint.json')
    expect(reuploaded).not.toContain('streams.json')
  })

  it('tags created folders and files with appProperties', async () => {
    const { ensureTree } = await load()
    await ensureTree('tok', ['timelog'])

    const folderProps = new Map(drive.createFolder.mock.calls.map((c) => [c[1], c[3]]))
    expect(folderProps.get('timebox')).toEqual({ captureKind: 'root' })
    expect(folderProps.get('timelog')).toEqual({ captureKind: 'stream', captureStream: 'timelog' })
    expect(folderProps.get('log')).toEqual({ captureKind: 'log', captureStream: 'timelog' })
    expect(folderProps.get('results')).toEqual({ captureKind: 'results', captureStream: 'timelog' })

    const fileProps = new Map(
      drive.uploadFile.mock.calls.map((c) => {
        const a = c[1] as { name: string; appProperties?: Record<string, string> }
        return [a.name, a.appProperties]
      }),
    )
    expect(fileProps.get('streams.json')).toEqual({ captureKind: 'registry' })
    expect(fileProps.get('config.json')).toEqual({
      captureKind: 'config',
      captureStream: 'timelog',
    })
    expect(fileProps.get('checkpoint.json')).toEqual({
      captureKind: 'checkpoint',
      captureStream: 'timelog',
    })
  })

  it('preserves cached partition ids across re-runs', async () => {
    const { ensureTree } = await load()
    await ensureTree('tok', ['timelog'])
    const { getTree, saveTree } = await import('./tree')
    const t = (await getTree())!
    t.streams.timelog.partitions['2026-08-02'] = 'part-xyz'
    await saveTree(t)

    const tree = await ensureTree('tok', ['timelog'])
    expect(tree.streams.timelog.partitions['2026-08-02']).toBe('part-xyz')
  })
})

describe('ensureTree account binding', () => {
  it('discards cached partition ids after an account switch', async () => {
    const { ensureTree } = await load()
    await ensureTree('tok-a', ['timelog'])
    const { getTree, saveTree } = await import('./tree')
    const t = (await getTree())!
    t.streams.timelog.partitions['2026-08-02'] = 'stale-part-from-account-a'
    await saveTree(t)

    drive.setUser('user-B')
    const tree = await ensureTree('tok-b', ['timelog'])
    // The stale wrong-account partition id must NOT be merged into the tree.
    expect(tree.streams.timelog.partitions).toEqual({})
    expect((await getTree())!.streams.timelog.partitions).toEqual({})
    const { getStoredAccountId } = await import('./account')
    expect(await getStoredAccountId()).toBe('user-B')
  })

  it('a reconnect on the same account keeps cached ids (no extra bootstrap cost)', async () => {
    const { ensureTree } = await load()
    await ensureTree('tok-1', ['timelog'])
    const { getTree, saveTree } = await import('./tree')
    const t = (await getTree())!
    t.streams.timelog.partitions['2026-08-02'] = 'part-xyz'
    await saveTree(t)
    const createsAfterFirst = drive.createFolder.mock.calls.length
    const uploadsAfterFirst = drive.uploadFile.mock.calls.length

    // A fresh token (reconnect) for the same account: cache kept, nothing recreated.
    const tree = await ensureTree('tok-2', ['timelog'])
    expect(tree.streams.timelog.partitions['2026-08-02']).toBe('part-xyz')
    expect(drive.createFolder.mock.calls.length).toBe(createsAfterFirst)
    expect(drive.uploadFile.mock.calls.length).toBe(uploadsAfterFirst)
    // One identity check per token; the memo makes repeats with a token free.
    expect(drive.getAboutUser).toHaveBeenCalledTimes(2)
    await ensureTree('tok-2', ['timelog'])
    expect(drive.getAboutUser).toHaveBeenCalledTimes(2)
  })

  it('a first-ever grant (no stored identity) binds without discarding', async () => {
    // Upgrade path: a tree cache from an app version predating the binding.
    const { emptyStreamTree, saveTree } = await import('./tree')
    const st = emptyStreamTree('folder-old', 'log-old', 'results-old')
    st.partitions['2026-08-02'] = 'part-legacy'
    await saveTree({ rootId: 'root-old', streams: { timelog: st } })
    const { getStoredAccountId } = await import('./account')
    expect(await getStoredAccountId()).toBeUndefined()

    const { ensureTree } = await load()
    const tree = await ensureTree('tok', ['timelog'])
    expect(tree.streams.timelog.partitions['2026-08-02']).toBe('part-legacy')
    expect(await getStoredAccountId()).toBe('user-A')
  })
})
