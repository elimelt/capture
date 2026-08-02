import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError } from './client'

interface FakeUploadArgs {
  name: string
  parentId: string
  fileId?: string
  appProperties?: Record<string, string>
}

/** In-memory Drive that records upload order and can be told to fail. */
function fakeDrive() {
  const nodes: {
    id: string
    name: string
    parentId: string
    appProperties?: Record<string, string>
  }[] = []
  const uploadOrder: string[] = []
  let n = 0
  let failWith: { status: number } | null = null

  const find = (name: string, parentId: string) =>
    nodes.find((f) => f.name === name && f.parentId === parentId)
  return {
    nodes,
    uploadOrder,
    failNext(status: number | null) {
      failWith = status === null ? null : { status }
    },
    findFile: vi.fn(async (_t: string, a: { name: string; parentId: string }) =>
      find(a.name, a.parentId)?.id ?? null,
    ),
    createFolder: vi.fn(
      async (
        _t: string,
        name: string,
        parentId: string,
        appProperties?: Record<string, string>,
      ) => {
        const id = `folder-${n++}`
        nodes.push({ id, name, parentId, ...(appProperties ? { appProperties } : {}) })
        return id
      },
    ),
    generateIds: vi.fn(async (_t: string, count: number) =>
      Array.from({ length: count }, () => `gen-${n++}`),
    ),
    uploadFile: vi.fn(async (_t: string, a: FakeUploadArgs) => {
      if (failWith) throw new DriveError(failWith.status, 'boom')
      // Mirror the real client's contract: re-uploading a pre-generated id
      // that already landed yields 409 upstream, which uploadFile swallows
      // and reports as success without creating anything.
      if (a.fileId && nodes.some((f) => f.id === a.fileId)) return a.fileId
      const id = a.fileId ?? `file-${n++}`
      nodes.push({ id, name: a.name, parentId: a.parentId, ...(a.appProperties ? { appProperties: a.appProperties } : {}) })
      uploadOrder.push(a.name)
      return id
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
    generateIds: (...a: unknown[]) => drive.generateIds(...(a as [string, number])),
    uploadFile: (...a: unknown[]) => drive.uploadFile(...(a as [string, never])),
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

async function captureWithAudio() {
  const { appendCapture } = await import('../store/events')
  return appendCapture({
    stream: 'timelog',
    capturedAt: '2026-08-02T09:00:00-04:00',
    attachments: [{ kind: 'audio', blob: new Blob(['a']), mimeType: 'audio/mp4' }],
  })
}

describe('drainStream', () => {
  it('uploads attachments before the record and marks the row uploaded', async () => {
    const event = await captureWithAudio()
    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')

    expect(res.outcome).toBe('drained')
    expect(res.uploaded).toBe(1)
    const { eventRecordName } = await import('../contract/filenames')
    const audio = event.attachments[0].file
    const record = eventRecordName(event)
    expect(drive.uploadOrder.indexOf(audio)).toBeLessThan(drive.uploadOrder.indexOf(record))
    expect(drive.uploadOrder.indexOf(record)).toBeGreaterThanOrEqual(0)

    const { getSyncStatuses } = await import('../store/events')
    expect((await getSyncStatuses('timelog')).get(event.id)?.status).toBe('uploaded')
  })

  it('is idempotent: a re-drain reuses the same pre-generated ids and duplicates nothing', async () => {
    await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')
    const nodesAfterFirst = drive.nodes.length
    const orderAfterFirst = [...drive.uploadOrder]
    drive.uploadFile.mockClear()
    drive.findFile.mockClear()
    drive.generateIds.mockClear()

    // Force the row back to queued to simulate a retry over existing files.
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const row = (await getSyncStatuses('timelog')).values().next().value!
    expect(row.fileIds).toBeTruthy() // ids were persisted before the uploads
    await putSyncStatus({ ...row, status: 'queued', phase: 'attachments-pending' })

    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('drained')
    // Re-uploads went out with the persisted ids (409 → success upstream):
    // nothing new lands on Drive and no find-before-upload probes are made.
    for (const call of drive.uploadFile.mock.calls) {
      const args = call[1] as FakeUploadArgs
      expect(args.fileId).toBe(row.fileIds![args.name])
    }
    expect(drive.nodes.length).toBe(nodesAfterFirst)
    expect(drive.uploadOrder).toEqual(orderAfterFirst)
    expect(drive.findFile).not.toHaveBeenCalled()
    expect(drive.generateIds).not.toHaveBeenCalled()
  })

  it('never probes with findFile on the happy path (pre-generated ids)', async () => {
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.findFile.mockClear()
    drive.uploadFile.mockClear()

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('drained')
    // The only find left is the partition folder's find-before-create
    // (folders can't use pre-generated ids); files upload with minted ids.
    expect(drive.findFile).toHaveBeenCalledTimes(1)
    expect(drive.generateIds).toHaveBeenCalledTimes(1)
    expect(drive.uploadFile).toHaveBeenCalledTimes(2)

    // A second event on the same day pushes with zero discovery requests:
    // the partition id is cached and the id pool still has minted ids.
    await captureWithAudio()
    drive.findFile.mockClear()
    drive.generateIds.mockClear()
    drive.uploadFile.mockClear()
    await drainStream('tok', 'timelog')
    expect(drive.findFile).not.toHaveBeenCalled()
    expect(drive.generateIds).not.toHaveBeenCalled()
    expect(drive.uploadFile).toHaveBeenCalledTimes(2)
  })

  it('keeps find-before-upload for legacy rows that already attempted an upload', async () => {
    await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')
    const nodesAfterFirst = drive.nodes.length

    // Rewind the row to what an older app version would have left behind
    // after a crash mid-drain: queued, attempted once, and no fileIds.
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const row = (await getSyncStatuses('timelog')).values().next().value!
    await putSyncStatus({
      ...row,
      status: 'queued',
      phase: 'attachments-pending',
      attempts: 1,
      fileIds: undefined,
    })
    drive.uploadFile.mockClear()

    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('drained')
    // The probe found both files already on Drive, so nothing re-uploads.
    expect(drive.uploadFile).not.toHaveBeenCalled()
    expect(drive.nodes.length).toBe(nodesAfterFirst)
  })

  it('tags uploads and partition folders with appProperties at creation', async () => {
    const event = await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')

    const { eventRecordName, partitionOf } = await import('../contract/filenames')
    const byName = new Map(drive.nodes.map((f) => [f.name, f]))
    expect(byName.get(eventRecordName(event))?.appProperties).toEqual({
      captureKind: 'record',
      captureStream: 'timelog',
    })
    expect(byName.get(event.attachments[0].file)?.appProperties).toEqual({
      captureKind: 'attachment',
      captureStream: 'timelog',
    })
    expect(byName.get(partitionOf(event))?.appProperties).toEqual({
      captureKind: 'partition',
      captureStream: 'timelog',
    })
  })

  it('re-bootstraps and drains when the cached tree lacks the stream', async () => {
    const event = await captureWithAudio()
    // Seed a cached tree bootstrapped for a different stream only.
    const { saveTree, emptyStreamTree } = await import('./tree')
    await saveTree({ rootId: 'root-0', streams: { other: emptyStreamTree('f-0', 'l-0', 'r-0') } })

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')

    expect(res.outcome).toBe('drained')
    expect(res.uploaded).toBe(1)
    const { eventRecordName } = await import('../contract/filenames')
    expect(drive.uploadOrder).toContain(eventRecordName(event))
  })

  it('stops and asks to reconnect on a 401', async () => {
    await captureWithAudio()
    const { drainStream } = await import('./queue')
    // Bootstrap succeeds; fail only when the attachment upload starts.
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(401)

    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('reconnect')
    const { getSyncStatuses } = await import('../store/events')
    expect([...(await getSyncStatuses('timelog')).values()][0].status).toBe('queued')
  })

  it('backs off with nextRetryAt on a 429', async () => {
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(429)
    const { drainStream } = await import('./queue')

    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('retry-later')
    const { getSyncStatuses } = await import('../store/events')
    const row = [...(await getSyncStatuses('timelog')).values()][0]
    expect(row.status).toBe('queued')
    expect(row.nextRetryAt).toBeTruthy()
    expect(row.attempts).toBe(1)
  })

  it('prunes local audio when keepAudioLocally is false', async () => {
    const event = await captureWithAudio()
    const { saveStreamSettings } = await import('../store/settings')
    await saveStreamSettings('timelog', { maxClipSec: 60, keepAudioLocally: false })

    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')

    const { getBlob } = await import('../store/events')
    const audioFile = event.attachments[0].file
    expect(await getBlob(audioFile)).toBeUndefined()
  })

  it('is idle when nothing is queued', async () => {
    const { drainStream } = await import('./queue')
    expect(await drainStream('tok', 'timelog')).toEqual({ outcome: 'idle', uploaded: 0 })
  })
})
