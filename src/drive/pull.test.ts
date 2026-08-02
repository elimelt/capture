import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError, FOLDER_MIME } from './client'
import { serializeEvent } from '../contract/serialize'
import { eventRecordName, attachmentFileName, eventBaseName } from '../contract/filenames'
import type { CaptureEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'

/** In-memory Drive with folders/files, listable and readable. */
function fakeDrive() {
  interface Node {
    id: string
    name: string
    parentId: string
    mimeType: string
    content?: string | Blob
  }
  const nodes: Node[] = []
  let n = 0
  let failOn: 'list' | 'read' | null = null
  let failStatus = 500

  const add = (name: string, parentId: string, mimeType: string, content?: string | Blob) => {
    const id = `node-${n++}`
    nodes.push({ id, name, parentId, mimeType, content })
    return id
  }
  const byId = (id: string) => nodes.find((f) => f.id === id)

  return {
    nodes,
    add,
    fail(on: 'list' | 'read' | null, status = 500) {
      failOn = on
      failStatus = status
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
    createFolder: vi.fn(async (_t: string, name: string, parentId: string) =>
      add(name, parentId, FOLDER_MIME),
    ),
    uploadFile: vi.fn(
      async (_t: string, a: { name: string; parentId: string; mimeType: string; body: string | Blob }) =>
        add(a.name, a.parentId, a.mimeType, a.body),
    ),
    listChildren: vi.fn(async (_t: string, parentId: string) => {
      if (failOn === 'list') throw new DriveError(failStatus, 'boom')
      return nodes
        .filter((f) => f.parentId === parentId)
        .map(({ id, name, mimeType }) => ({ id, name, mimeType }))
    }),
    readFileText: vi.fn(async (_t: string, id: string) => {
      if (failOn === 'read') throw new DriveError(failStatus, 'boom')
      const c = byId(id)?.content
      return typeof c === 'string' ? c : ((await (c as Blob | undefined)?.text()) ?? '')
    }),
    readFileBlob: vi.fn(async (_t: string, id: string) => {
      if (failOn === 'read') throw new DriveError(failStatus, 'boom')
      const c = byId(id)?.content
      return typeof c === 'string' ? new Blob([c]) : (c ?? new Blob())
    }),
  }
}

let drive: ReturnType<typeof fakeDrive>

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client')
  return {
    ...actual,
    findFile: (...a: unknown[]) => drive.findFile(...(a as [string, never])),
    createFolder: (...a: unknown[]) => drive.createFolder(...(a as [string, string, string])),
    uploadFile: (...a: unknown[]) => drive.uploadFile(...(a as [string, never])),
    listChildren: (...a: unknown[]) => drive.listChildren(...(a as [string, string])),
    readFileText: (...a: unknown[]) => drive.readFileText(...(a as [string, string])),
    readFileBlob: (...a: unknown[]) => drive.readFileBlob(...(a as [string, string])),
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

/** A remote capture event as another device would have pushed it. */
function remoteCapture(seq: number, id: string, withAudio = false): CaptureEvent {
  const loggedAt = '2026-08-01T10:00:00-04:00'
  const e: CaptureEvent = {
    schema: EVENT_SCHEMA,
    type: 'capture',
    id,
    seq,
    stream: 'timelog',
    loggedAt,
    deviceTz: 'America/New_York',
    capturedAt: loggedAt,
    attachments: [],
  }
  if (withAudio) {
    e.attachments = [
      {
        kind: 'audio',
        file: attachmentFileName(eventBaseName(e), 'audio', 'audio/mp4'),
        mimeType: 'audio/mp4',
      },
    ]
  }
  return e
}

/** Build a remote tree: timebox/timelog/log/<date>/ + records; returns ids. */
function seedRemote(events: CaptureEvent[], blobs: Record<string, string> = {}) {
  const root = drive.add('timebox', 'root', FOLDER_MIME)
  const stream = drive.add('timelog', root, FOLDER_MIME)
  const log = drive.add('log', stream, FOLDER_MIME)
  const results = drive.add('results', stream, FOLDER_MIME)
  const partition = drive.add('2026-08-01', log, FOLDER_MIME)
  for (const e of events) {
    drive.add(eventRecordName(e), partition, 'application/json', serializeEvent(e))
  }
  for (const [file, content] of Object.entries(blobs)) {
    drive.add(file, partition, 'audio/mp4', new Blob([content]))
  }
  return { root, stream, log, results, partition }
}

describe('pullStream', () => {
  it('imports remote events and marks them uploaded (never re-pushed)', async () => {
    const remote = remoteCapture(1, 'remote'.slice(0, 6))
    seedRemote([remote])

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })

    const { listEvents, getSyncStatuses, listPendingSync } = await import('../store/events')
    expect(await listEvents('timelog')).toEqual([remote])
    expect((await getSyncStatuses('timelog')).get(remote.id)?.status).toBe('uploaded')
    expect(await listPendingSync('timelog')).toEqual([])
  })

  it('eagerly downloads referenced attachment blobs', async () => {
    const remote = remoteCapture(1, 'aaaaaa', true)
    const file = remote.attachments[0].file
    seedRemote([remote], { [file]: 'audio-bytes' })

    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    const { getBlob } = await import('../store/events')
    const blob = await getBlob(file)
    expect(blob).toBeDefined()
    expect(await blob!.text()).toBe('audio-bytes')
  })

  it('is idempotent and skips events already local', async () => {
    seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    drive.readFileText.mockClear()
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.readFileText).not.toHaveBeenCalled()
  })

  it('bumps the local seq counter past pulled seqs (no collision pile-up)', async () => {
    seedRemote([remoteCapture(1, 'aaaaaa'), remoteCapture(2, 'bbbbbb')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    const { appendCapture } = await import('../store/events')
    const next = await appendCapture({
      stream: 'timelog',
      capturedAt: '2026-08-02T09:00:00-04:00',
      attachments: [],
    })
    expect(next.seq).toBe(3)
  })

  it('ignores foreign files and non-partition folders in the tree', async () => {
    const { log, partition } = seedRemote([remoteCapture(1, 'aaaaaa')])
    drive.add('random-notes.txt', partition, 'text/plain', 'hi')
    drive.add('not-a-date', log, FOLDER_MIME)

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })
    const { listEvents } = await import('../store/events')
    expect((await listEvents('timelog')).map((e) => e.id)).toEqual(['aaaaaa'])
  })

  it('tolerates an attachment missing on Drive (pruned or push race)', async () => {
    const remote = remoteCapture(1, 'aaaaaa', true)
    seedRemote([remote]) // record present, blob absent

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })
    const { getBlob } = await import('../store/events')
    expect(await getBlob(remote.attachments[0].file)).toBeUndefined()
  })

  it('classifies auth failures as reconnect', async () => {
    seedRemote([remoteCapture(1, 'aaaaaa')])
    drive.fail('list', 401)
    const { pullStream } = await import('./pull')
    expect((await pullStream('tok', 'timelog')).outcome).toBe('reconnect')
  })

  it('classifies 429/5xx as retry-later', async () => {
    seedRemote([remoteCapture(1, 'aaaaaa')])
    drive.fail('read', 429)
    const { pullStream } = await import('./pull')
    expect((await pullStream('tok', 'timelog')).outcome).toBe('retry-later')
  })

  it('reports a malformed record as an error without importing it', async () => {
    const { partition } = seedRemote([])
    drive.add('000001_2026-08-01T10-00-00-0400_zzzzzz.json', partition, 'application/json', '{nope')

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res.outcome).toBe('error')
    const { listEvents } = await import('../store/events')
    expect(await listEvents('timelog')).toEqual([])
  })

  it('merges with locally queued events without disturbing their pending status', async () => {
    const { appendCapture } = await import('../store/events')
    const local = await appendCapture({
      stream: 'timelog',
      capturedAt: '2026-08-02T09:00:00-04:00',
      attachments: [],
    })
    // Remote device also minted seq 1 — the Design C collision case.
    seedRemote([remoteCapture(1, 'rrrrrr')])

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })

    const { listEvents, listPendingSync } = await import('../store/events')
    const ids = (await listEvents('timelog')).map((e) => e.id)
    expect(ids).toContain(local.id)
    expect(ids).toContain('rrrrrr')
    // The local event is still queued for push; the pulled one is not.
    expect((await listPendingSync('timelog')).map((r) => r.id)).toEqual([local.id])
  })
})
