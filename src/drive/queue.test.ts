import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveError } from './client'

interface FakeUploadArgs {
  name: string
  parentId: string
  mimeType?: string
  body?: Blob | string
  fileId?: string
  appProperties?: Record<string, string>
}

/** In-memory Drive that records upload order and can be told to fail. */
function fakeDrive() {
  const nodes: {
    id: string
    name: string
    parentId: string
    mimeType?: string
    body?: Blob | string
    appProperties?: Record<string, string>
  }[] = []
  const uploadOrder: string[] = []
  let n = 0
  let failWith: { status: number } | null = null
  let user = 'user-A'

  const find = (name: string, parentId: string) =>
    nodes.find((f) => f.name === name && f.parentId === parentId)
  return {
    nodes,
    uploadOrder,
    failNext(status: number | null) {
      failWith = status === null ? null : { status }
    },
    /** Simulate a Google-account switch for subsequent tokens. */
    setUser(id: string) {
      user = id
    },
    getAboutUser: vi.fn(async (_t: string) => ({ permissionId: user })),
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
      nodes.push({
        id,
        name: a.name,
        parentId: a.parentId,
        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
        ...(a.body !== undefined ? { body: a.body } : {}),
        ...(a.appProperties ? { appProperties: a.appProperties } : {}),
      })
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
    getAboutUser: (...a: unknown[]) => drive.getAboutUser(...(a as [string])),
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

  it('keeps the row queued on a 429 and the next drain retries it immediately', async () => {
    // Stuck-queue regression (sync is manual-only): a transient 429/5xx must
    // not gate the row out of later drains — every "Sync now" is an explicit
    // user ask, so the very next drain retries and uploads.
    const event = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(429)
    const { drainStream } = await import('./queue')

    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('retry-later')
    const { getSyncStatuses } = await import('../store/events')
    const row = [...(await getSyncStatuses('timelog')).values()][0]
    expect(row.status).toBe('queued')
    expect(row.nextRetryAt).toBeUndefined() // no persisted backoff gate
    expect(row.attempts).toBe(1)
    expect(row.error).toBeTruthy() // failure is recorded, not silent

    drive.failNext(null)
    const retry = await drainStream('tok', 'timelog')
    expect(retry.outcome).toBe('drained')
    expect(retry.uploaded).toBe(1)
    expect((await getSyncStatuses('timelog')).get(event.id)?.status).toBe('uploaded')
  })

  it('drains a legacy row stuck behind a persisted nextRetryAt (stuck-queue regression)', async () => {
    // Rows written by older app versions can carry a nextRetryAt up to an
    // hour in the future. The old drainer skipped them *and* reported the
    // cycle 'drained' (clean), so "Sync now" said "Already up to date" and
    // stamped lastSyncAt while the entry stayed queued — for a manual-only
    // sync that reads as "queued forever". A drain must upload such rows.
    const event = await captureWithAudio()
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const row = (await getSyncStatuses('timelog')).get(event.id)!
    const { toLocalIso } = await import('../contract/time')
    await putSyncStatus({
      ...row,
      attempts: 3,
      nextRetryAt: toLocalIso(new Date(Date.now() + 60 * 60_000)),
      error: 'Drive 503: boom',
    })

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('drained')
    expect(res.uploaded).toBe(1)
    expect((await getSyncStatuses('timelog')).get(event.id)?.status).toBe('uploaded')
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

  it('batches ≥2 pending events into one sealed segment upload (SPEC §5.7)', async () => {
    const e1 = await captureWithAudio()
    const e2 = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.findFile.mockClear()
    drive.uploadFile.mockClear()
    drive.uploadOrder.length = 0

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'drained', uploaded: 2 })

    // 2 audio uploads + 1 segment = 3 uploads, one partition find, one
    // generateIds batch — never a per-event record.
    const { segmentFileName } = await import('../contract/filenames')
    const { serializeSegment } = await import('../contract/segments')
    const segment = segmentFileName([e1, e2])
    expect(drive.uploadFile).toHaveBeenCalledTimes(3)
    expect(drive.findFile).toHaveBeenCalledTimes(1)
    expect(drive.generateIds).toHaveBeenCalledTimes(1)
    expect(drive.uploadOrder).toEqual([e1.attachments[0].file, e2.attachments[0].file, segment])

    // Exact SPEC §5.7 bytes, NDJSON mime, segment tag.
    const node = drive.nodes.find((f) => f.name === segment)!
    expect(node.body).toBe(serializeSegment([e1, e2]))
    expect(node.mimeType).toBe('application/x-ndjson')
    expect(node.appProperties).toEqual({ captureKind: 'segment', captureStream: 'timelog' })

    const { getSyncStatuses } = await import('../store/events')
    const statuses = await getSyncStatuses('timelog')
    expect(statuses.get(e1.id)?.status).toBe('uploaded')
    expect(statuses.get(e2.id)?.status).toBe('uploaded')
    // The segment's single id was persisted on BOTH member rows.
    expect(statuses.get(e1.id)?.fileIds?.[segment]).toBeTruthy()
    expect(statuses.get(e1.id)?.fileIds?.[segment]).toBe(statuses.get(e2.id)?.fileIds?.[segment])
  })

  it('re-drains a whole crashed segment batch via 409 without duplicating', async () => {
    await captureWithAudio()
    await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')
    const nodesAfterFirst = drive.nodes.length
    const orderAfterFirst = [...drive.uploadOrder]

    // Crash after upload, before any row was marked: both rows rewound to
    // queued with their fileIds (including the segment assignment) intact.
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    for (const row of (await getSyncStatuses('timelog')).values()) {
      await putSyncStatus({ ...row, status: 'queued', phase: 'record-pending' })
    }
    drive.uploadFile.mockClear()
    drive.findFile.mockClear()
    drive.generateIds.mockClear()

    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'drained', uploaded: 2 })
    // Re-uploads went out under the persisted ids (409 → success upstream):
    // nothing new on Drive, no probes, no fresh id minting.
    expect(drive.nodes.length).toBe(nodesAfterFirst)
    expect(drive.uploadOrder).toEqual(orderAfterFirst)
    expect(drive.findFile).not.toHaveBeenCalled()
    expect(drive.generateIds).not.toHaveBeenCalled()
    for (const row of (await getSyncStatuses('timelog')).values()) {
      expect(row.status).toBe('uploaded')
    }
  })

  it('finishes a segment crashed mid-marking without a per-event record', async () => {
    const e1 = await captureWithAudio()
    const e2 = await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')
    const nodesAfterFirst = drive.nodes.length

    // Crash mid-step-4 (SPEC §5.7): e1 marked, e2 still queued but carrying
    // the segment assignment.
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const row2 = (await getSyncStatuses('timelog')).get(e2.id)!
    await putSyncStatus({ ...row2, status: 'queued', phase: 'record-pending' })

    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'drained', uploaded: 1 })
    expect(drive.nodes.length).toBe(nodesAfterFirst) // 409 path: nothing new
    expect((await getSyncStatuses('timelog')).get(e2.id)?.status).toBe('uploaded')
    // The lone remaining member still commits through the segment path —
    // never as a duplicate per-event record.
    const { eventRecordName } = await import('../contract/filenames')
    expect(drive.nodes.some((f) => f.name === eventRecordName(e1))).toBe(false)
    expect(drive.nodes.some((f) => f.name === eventRecordName(e2))).toBe(false)
  })

  it('never batches across date partitions', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-01T23:59:00') })
    const e1 = await captureWithAudio()
    vi.setSystemTime(new Date('2026-08-02T00:01:00'))
    const e2 = await captureWithAudio()
    vi.useRealTimers()

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'drained', uploaded: 2 })

    // One-event runs per partition: two per-event records, no segment.
    const { eventRecordName } = await import('../contract/filenames')
    expect(drive.uploadOrder).toContain(eventRecordName(e1))
    expect(drive.uploadOrder).toContain(eventRecordName(e2))
    expect(drive.nodes.some((f) => f.name.endsWith('.ndjson'))).toBe(false)
  })

  it('keeps a legacy row on the per-event path, never batched into a segment', async () => {
    const e1 = await captureWithAudio()
    const { drainStream } = await import('./queue')
    await drainStream('tok', 'timelog')

    // Rewind e1 to the legacy shape (attempted once, no fileIds), then queue
    // a fresh second event.
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const row1 = (await getSyncStatuses('timelog')).get(e1.id)!
    await putSyncStatus({
      ...row1,
      status: 'queued',
      phase: 'attachments-pending',
      attempts: 1,
      fileIds: undefined,
    })
    const e2 = await captureWithAudio()

    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'drained', uploaded: 2 })
    // The legacy row probed its existing files; the fresh row went out as a
    // per-event record; no segment was written.
    const { eventRecordName } = await import('../contract/filenames')
    expect(drive.nodes.some((f) => f.name === eventRecordName(e2))).toBe(true)
    expect(drive.nodes.some((f) => f.name.endsWith('.ndjson'))).toBe(false)
    expect(drive.nodes.filter((f) => f.name === eventRecordName(e1))).toHaveLength(1)
  })

  it('keeps every segment member queued on a 429; the next drain re-batches and lands it', async () => {
    // A batch fails as a unit, and — sync being manual-only, with no backoff
    // gate — every member must stay eligible: the very next "Sync now"
    // re-plans the same segment from the persisted assignment and re-uploads
    // idempotently under the same pre-generated id.
    await captureWithAudio()
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(429)

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('retry-later')
    const { getSyncStatuses } = await import('../store/events')
    const failedRows = [...(await getSyncStatuses('timelog')).values()]
    const segmentIds = new Set<string>()
    for (const row of failedRows) {
      expect(row.status).toBe('queued')
      expect(row.attempts).toBe(1)
      expect(row.nextRetryAt).toBeUndefined() // no persisted backoff gate
      expect(row.error).toBeTruthy() // failure is recorded, not silent
      const segmentKey = Object.keys(row.fileIds ?? {}).find((n) => n.endsWith('.ndjson'))!
      segmentIds.add(row.fileIds![segmentKey])
    }
    expect(segmentIds.size).toBe(1) // one shared assignment survives the failure

    drive.failNext(null)
    drive.generateIds.mockClear()
    const retry = await drainStream('tok', 'timelog')
    expect(retry).toEqual({ outcome: 'drained', uploaded: 2 })
    expect(drive.generateIds).not.toHaveBeenCalled() // ids reused, not re-minted
    const segment = drive.nodes.find((f) => f.name.endsWith('.ndjson'))!
    expect(segment.id).toBe([...segmentIds][0]) // landed under the pinned id
    for (const row of (await getSyncStatuses('timelog')).values()) {
      expect(row.status).toBe('uploaded')
    }
  })

  it('costs zero Drive calls for a stream with nothing queued', async () => {
    // Regression guard for the multi-stream sync loop: an idle stream — e.g.
    // a system stream ('settings', 'assistant-chats') with no events yet —
    // must not bootstrap folders, mint ids, or upload anything.
    const { drainStream } = await import('./queue')
    for (const stream of ['settings', 'assistant-chats', 'timelog']) {
      expect(await drainStream('tok', stream)).toEqual({ outcome: 'idle', uploaded: 0 })
    }
    expect(drive.findFile).not.toHaveBeenCalled()
    expect(drive.createFolder).not.toHaveBeenCalled()
    expect(drive.generateIds).not.toHaveBeenCalled()
    expect(drive.uploadFile).not.toHaveBeenCalled()
  })

  it('never reuses old-account fileIds after an account switch (#32)', async () => {
    // A row that assigned pre-generated ids on account A but never landed:
    // bootstrap first, then fail the drain after the ids persist on the row.
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok-a', ['timelog']))
    const { drainStream } = await import('./queue')
    drive.failNext(500)
    expect((await drainStream('tok-a', 'timelog')).outcome).toBe('retry-later')
    const { getSyncStatuses, putSyncStatus } = await import('../store/events')
    const failedRow = (await getSyncStatuses('timelog')).values().next().value!
    const staleIds = Object.values(failedRow.fileIds!)
    expect(staleIds.length).toBeGreaterThan(0)
    // Make the row immediately retryable (skip the 429/5xx backoff window).
    const { nextRetryAt: _elapsed, ...retryable } = failedRow
    await putSyncStatus(retryable)

    // Switch accounts: the retried drain must re-mint ids with the new
    // account's token — reusing account A's ids would 409 against A's files
    // and be miscounted as success while account B's Drive got nothing.
    drive.failNext(null)
    drive.setUser('user-B')
    drive.generateIds.mockClear()
    drive.uploadFile.mockClear()
    const landedBefore = drive.uploadOrder.length
    const res = await drainStream('tok-b', 'timelog')
    expect(res.outcome).toBe('drained')
    expect(res.uploaded).toBe(1)
    expect(drive.generateIds).toHaveBeenCalled()
    const usedIds = drive.uploadFile.mock.calls
      .map((c) => (c[1] as FakeUploadArgs).fileId)
      .filter((id): id is string => id !== undefined)
    expect(usedIds.length).toBeGreaterThan(0)
    for (const id of usedIds) expect(staleIds).not.toContain(id)
    // Both event files landed for real (no phantom 409-as-success successes).
    expect(drive.uploadOrder.length).toBe(landedBefore + 2)
  })
})
