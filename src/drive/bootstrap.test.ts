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
  const createFolder = vi.fn(async (_t: string, name: string, parentId: string) => {
    const id = `folder-${n++}`
    nodes.push({ id, name, parentId, isFolder: true })
    return id
  })
  const uploadFile = vi.fn(
    async (_t: string, a: { name: string; parentId: string }) => {
      const id = `file-${n++}`
      nodes.push({ id, name: a.name, parentId: a.parentId, isFolder: false })
      return id
    },
  )
  return { nodes, find, findFile, createFolder, uploadFile }
}

let drive: ReturnType<typeof fakeDrive>

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return {
    ...actual,
    findFile: (...args: unknown[]) => drive.findFile(...(args as [string, never])),
    createFolder: (...args: unknown[]) => drive.createFolder(...(args as [string, string, string])),
    uploadFile: (...args: unknown[]) => drive.uploadFile(...(args as [string, never])),
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
