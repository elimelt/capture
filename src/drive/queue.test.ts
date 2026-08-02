import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError } from './client'

/** In-memory Drive that records upload order and can be told to fail. */
function fakeDrive() {
  const nodes: { id: string; name: string; parentId: string }[] = []
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
    createFolder: vi.fn(async (_t: string, name: string, parentId: string) => {
      const id = `folder-${n++}`
      nodes.push({ id, name, parentId })
      return id
    }),
    uploadFile: vi.fn(async (_t: string, a: { name: string; parentId: string }) => {
      if (failWith) throw new DriveError(failWith.status, 'boom')
      const id = `file-${n++}`
      nodes.push({ id, name: a.name, parentId: a.parentId })
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

  it('is idempotent: a re-drain re-uploads nothing already present', async () => {
    await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')
    drive.uploadFile.mockClear()

    // Force the row back to queued to simulate a retry over existing files.
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const row = (await getSyncStatuses('timelog')).values().next().value!
    await putSyncStatus({ ...row, status: 'queued', phase: 'attachments-pending' })

    await drainStream('tok', 'timelog')
    expect(drive.uploadFile).not.toHaveBeenCalled()
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
