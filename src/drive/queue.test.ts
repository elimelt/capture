import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  driveClientMock,
  fakeDrive,
  setActiveFakeDrive,
  type FakeDrive,
  type FakeUploadArgs,
} from './testing/fakeDrive'
import { useFreshIndexedDb } from '../testing/freshDb'

useFreshIndexedDb()

// Shared fake (issue #70) — see testing/fakeDrive.ts. This suite exercises
// upload order, the 409-on-pregenerated-id contract, and the failure knobs
// (`failNext` for a transient/global failure — including a Drive `reason`
// code for quota/rate-limit classification — and `failName` for one
// deterministically-poison row).
vi.mock('./client', () => driveClientMock())

let drive: FakeDrive

beforeEach(() => {
  drive = fakeDrive()
  setActiveFakeDrive(drive)
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

  it('keeps the row queued on a quota-exceeded 403 (issue #88) — distinct from reconnect', async () => {
    const event = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(403, 'storageQuotaExceeded')
    const { drainStream } = await import('./queue')

    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('quota')
    expect(res.error).toBeTruthy()
    const { getSyncStatuses } = await import('../store/events')
    const row = [...(await getSyncStatuses('timelog')).values()][0]
    // Same "keep queued, don't ask to reconnect" treatment as retry-later —
    // the token is fine, only Drive's storage is full.
    expect(row.status).toBe('queued')
    expect(row.error).toBeTruthy()

    // Freeing space and retrying immediately (no backoff gate) succeeds.
    drive.failNext(null)
    const retry = await drainStream('tok', 'timelog')
    expect(retry.outcome).toBe('drained')
    expect((await getSyncStatuses('timelog')).get(event.id)?.status).toBe('uploaded')
  })

  it('a plain 403 with no reason still asks to reconnect (not quota)', async () => {
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(403)
    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('reconnect')
  })

  it('a rate-limited 403 reason is retried like a 429, not treated as reconnect', async () => {
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(403, 'userRateLimitExceeded')
    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res.outcome).toBe('retry-later')
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

  it('defaults onProgress to a no-op — existing callers are unaffected', async () => {
    await captureWithAudio()
    const { drainStream } = await import('./queue')
    // No third argument: must not throw.
    await expect(drainStream('tok', 'timelog')).resolves.toMatchObject({ outcome: 'drained' })
  })

  it('reports an upload-start total then one upload-progress per commit unit, never per file', async () => {
    await captureWithAudio()
    await captureWithAudio() // 2 same-partition rows -> one segment batch (SPEC §5.7)
    const { drainStream } = await import('./queue')
    const events: unknown[] = []
    const res = await drainStream('tok', 'timelog', (e) => events.push(e))
    expect(res).toMatchObject({ outcome: 'drained', uploaded: 2 })
    expect(events).toEqual([
      { kind: 'upload-start', stream: 'timelog', itemsTotal: 2 },
      { kind: 'upload-progress', stream: 'timelog', delta: 2 },
    ])
  })

  it('reports an idle stream (nothing queued) with zero progress events', async () => {
    const { drainStream } = await import('./queue')
    const events: unknown[] = []
    await drainStream('tok', 'timelog', (e) => events.push(e))
    expect(events).toEqual([])
  })

  it('reports one upload-progress per batch on a mixed run (record then segment)', async () => {
    await captureWithAudio() // lone event -> per-event record path
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    const { drainStream } = await import('./queue')
    const firstRunEvents: unknown[] = []
    await drainStream('tok', 'timelog', (e) => firstRunEvents.push(e))
    expect(firstRunEvents).toEqual([
      { kind: 'upload-start', stream: 'timelog', itemsTotal: 1 },
      { kind: 'upload-progress', stream: 'timelog', delta: 1 },
    ])

    await captureWithAudio()
    await captureWithAudio() // 2 more same-partition rows -> one segment batch
    const secondRunEvents: unknown[] = []
    await drainStream('tok', 'timelog', (e) => secondRunEvents.push(e))
    expect(secondRunEvents).toEqual([
      { kind: 'upload-start', stream: 'timelog', itemsTotal: 2 },
      { kind: 'upload-progress', stream: 'timelog', delta: 2 },
    ])
  })

  it('does not report upload-progress for a batch that fails', async () => {
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(500)
    const { drainStream } = await import('./queue')
    const events: unknown[] = []
    const res = await drainStream('tok', 'timelog', (e) => events.push(e))
    expect(res.outcome).toBe('retry-later')
    expect(events).toEqual([{ kind: 'upload-start', stream: 'timelog', itemsTotal: 1 }])
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
    expect(node.content).toBe(serializeSegment([e1, e2]))
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

  it('recovers a crash mid-assignment: the pinned segment keeps its wider name, holding only assigned survivors', async () => {
    // Plan a [e1, e2, e3] segment, but crash after the assignment persisted
    // on e1 only (SPEC §5.7 commit protocol, step 1). The next drain must
    // upload the pinned segment — SAME name (declared range 1–3) and SAME
    // pre-generated id — containing exactly the assigned survivor [e1],
    // while e2/e3 land separately. No event lost, none duplicated; the
    // declared range strictly contains the content's range, which readers
    // must never trust for completeness (id dedupe is authoritative).
    const { appendCapture, getSyncStatuses, putSyncStatus } = await import('../store/events')
    const capture = () =>
      appendCapture({ stream: 'timelog', capturedAt: '2026-08-02T09:00:00-04:00', attachments: [] })
    const e1 = await capture()
    const e2 = await capture()
    const e3 = await capture()

    const { segmentFileName, parseSegmentName } = await import('../contract/filenames')
    const { serializeSegment, parseSegment } = await import('../contract/segments')
    const wideName = segmentFileName([e1, e2, e3])
    const row1 = (await getSyncStatuses('timelog')).get(e1.id)!
    await putSyncStatus({ ...row1, fileIds: { [wideName]: 'pinned-segment-id' } })

    const { drainStream } = await import('./queue')
    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'drained', uploaded: 3 })

    // The interrupted segment landed under its pinned name AND id, holding
    // only the assigned survivor — declared range ⊇ content range.
    const wide = drive.nodes.find((f) => f.name === wideName)!
    expect(wide.id).toBe('pinned-segment-id')
    expect(wide.content).toBe(serializeSegment([e1]))
    const declared = parseSegmentName(wideName)!
    const contentSeqs = parseSegment(wide.content as string).map((e) => e.seq)
    expect(declared.minSeq).toBe(e1.seq)
    expect(declared.maxSeq).toBe(e3.seq)
    expect(contentSeqs).toEqual([e1.seq]) // strictly inside the declared range

    // The unassigned members landed separately, as their own fresh segment.
    const rest = drive.nodes.find((f) => f.name === segmentFileName([e2, e3]))!
    expect(rest.content).toBe(serializeSegment([e2, e3]))

    // No event lost, none duplicated, none as a stray per-event record.
    const carried = drive.nodes
      .filter((f) => f.name.endsWith('.ndjson'))
      .flatMap((f) => parseSegment(f.content as string))
      .map((e) => e.id)
      .sort()
    expect(carried).toEqual([e1.id, e2.id, e3.id].sort())
    expect(drive.nodes.some((f) => /^\d+_.*\.json$/.test(f.name))).toBe(false)
    for (const row of (await getSyncStatuses('timelog')).values()) {
      expect(row.status).toBe('uploaded')
    }
  })

  it('never reuses an old-account segment assignment after an account switch (#32 × §5.7)', async () => {
    // A segment batch whose assignment (one shared id on every member row)
    // persisted on account A but whose upload never landed.
    await captureWithAudio()
    await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok-a', ['timelog']))
    const { drainStream } = await import('./queue')
    drive.failNext(500)
    expect((await drainStream('tok-a', 'timelog')).outcome).toBe('retry-later')

    const { getSyncStatuses } = await import('../store/events')
    const rows = [...(await getSyncStatuses('timelog')).values()]
    const staleIds = rows.flatMap((r) => Object.values(r.fileIds ?? {}))
    // The segment assignment reached every member row before the failure,
    // and — no backoff gate — both rows are already eligible for the retry.
    for (const row of rows) {
      expect(Object.keys(row.fileIds ?? {}).some((n) => n.endsWith('.ndjson'))).toBe(true)
    }

    // Switch accounts: stripPendingFileIds must drop segment assignments too
    // — reusing account A's segment id would 409 against A's file and be
    // miscounted as success while account B's Drive got nothing.
    drive.failNext(null)
    drive.setUser('user-B')
    drive.generateIds.mockClear()
    drive.uploadFile.mockClear()
    const landedBefore = drive.uploadOrder.length
    const res = await drainStream('tok-b', 'timelog')
    expect(res).toMatchObject({ outcome: 'drained', uploaded: 2 })
    expect(drive.generateIds).toHaveBeenCalled()
    const usedIds = drive.uploadFile.mock.calls
      .map((c) => (c[1] as FakeUploadArgs).fileId)
      .filter((id): id is string => id !== undefined)
    expect(usedIds.length).toBeGreaterThan(0)
    for (const id of usedIds) expect(staleIds).not.toContain(id)
    // Both events landed for real under fresh ids. Stripped rows are
    // indistinguishable from legacy rows (attempts > 0, no fileIds), so the
    // retry deliberately takes the cautious per-event probe path — two audio
    // files + two records, never a stale-id segment 409-as-"success".
    expect(drive.uploadOrder.length).toBe(landedBefore + 4)
    expect(drive.uploadOrder.slice(landedBefore).filter((n) => n.endsWith('.json'))).toHaveLength(2)
    expect(drive.uploadOrder.some((n) => n.endsWith('.ndjson'))).toBe(false)
  })

  it('parks a row that fails deterministically so it stops starving rows queued behind it (#87)', async () => {
    // A poison row (e.g. an oversized/malformed audio attachment that 400s
    // every attempt) used to stop the *whole* drain on every single "Sync
    // now" forever — it always sorts first by seq, so nothing queued behind
    // it ever got a chance. After MAX_ATTEMPTS_BEFORE_PARKED identical
    // failures it must be parked: still attempted (still visibly failing),
    // but no longer allowed to block the rest of the queue.
    const e1 = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failName(e1.attachments[0].file, 400)

    const { drainStream } = await import('./queue')
    const { getSyncStatuses } = await import('../store/events')

    for (let i = 1; i <= 5; i++) {
      const res = await drainStream('tok', 'timelog')
      expect(res).toEqual({ outcome: 'error', uploaded: 0, error: expect.stringContaining('boom-name') })
      const row = (await getSyncStatuses('timelog')).get(e1.id)!
      expect(row.status).toBe('error')
      expect(row.attempts).toBe(i)
    }
    // e1 is alone in the queue for these 5 calls, so there's no neighbor yet
    // to prove starvation against — attempts 1-5 above exercise the
    // pre-parking "stop immediately" behavior unchanged (see the 429 test's
    // analog for retryable failures). `isParked` is evaluated from each
    // drain's *starting* attempts count (planning happens before any upload
    // is attempted), so a row only reads as parked from the drain *after* it
    // reaches the threshold — hence adding the neighbor only now.

    // A fresh, perfectly healthy row queues behind the now-parked e1.
    const e2 = await captureWithAudio()

    // e1 is already parked going into this drain (5 prior attempts): it's
    // kept solo instead of batching with e2, so its 6th failure doesn't drag
    // e2 down with it — the drain moves on to e2 in the SAME call.
    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'error', uploaded: 1, error: expect.stringContaining('boom-name') })

    const statuses = await getSyncStatuses('timelog')
    const row1 = statuses.get(e1.id)!
    expect(row1.status).toBe('error')
    expect(row1.attempts).toBe(6)
    expect(row1.error).toContain('boom-name') // still visibly failed, not silently dropped
    expect(statuses.get(e2.id)?.status).toBe('uploaded') // unblocked

    // Parked or not, e1 is attempted every drain (no backoff gate) — it just
    // never gets to block anything again once parked.
    const again = await drainStream('tok', 'timelog')
    expect(again).toEqual({ outcome: 'error', uploaded: 0, error: expect.stringContaining('boom-name') })
    expect((await getSyncStatuses('timelog')).get(e1.id)?.attempts).toBe(7)

    // A third, later row still lands fine on a subsequent drain — parking
    // doesn't just unblock a one-time backlog, it stays unblocked.
    const e3 = await captureWithAudio()
    const third = await drainStream('tok', 'timelog')
    expect(third).toEqual({ outcome: 'error', uploaded: 1, error: expect.stringContaining('boom-name') })
    expect((await getSyncStatuses('timelog')).get(e3.id)?.status).toBe('uploaded')
  })

  it('reports no upload-progress for a parked batch, but still reports the healthy batch after it', async () => {
    // Progress × parking (#87 × sync-progress indicator): a parked batch
    // commits nothing, so it must not count toward upload-progress — the
    // reducer would otherwise report more "done" than actually landed. The
    // drain continuing past it, though, means the healthy batch behind it
    // still reports normally in the same call.
    const e1 = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failName(e1.attachments[0].file, 400)
    const { drainStream } = await import('./queue')
    for (let i = 1; i <= 5; i++) await drainStream('tok', 'timelog')

    await captureWithAudio() // e2: a fresh, healthy row queued behind the parked e1
    const events: unknown[] = []
    const res = await drainStream('tok', 'timelog', (e) => events.push(e))
    expect(res).toMatchObject({ outcome: 'error', uploaded: 1 })
    // itemsTotal counts both rows (the parked one is neither "done" nor
    // dropped from the total), but only e2's batch reports upload-progress.
    expect(events).toEqual([
      { kind: 'upload-start', stream: 'timelog', itemsTotal: 2 },
      { kind: 'upload-progress', stream: 'timelog', delta: 1 },
    ])
  })

  it('never batches a parked row with a healthy neighbor (#87)', async () => {
    // Batching a still-poison row into a segment with a healthy neighbor
    // would fail the whole segment every drain (segments commit as a unit),
    // re-poisoning the neighbor forever instead of freeing it.
    const e1 = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failName(e1.attachments[0].file, 400)
    const { drainStream } = await import('./queue')
    for (let i = 0; i < 5; i++) await drainStream('tok', 'timelog')
    const { getSyncStatuses } = await import('../store/events')
    expect((await getSyncStatuses('timelog')).get(e1.id)?.attempts).toBe(5) // now parked

    // Two fresh events land in the same partition as the parked row — absent
    // the parked-row exclusion, planBatches would run all three together.
    const e2 = await captureWithAudio()
    const e3 = await captureWithAudio()
    const res = await drainStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'error', uploaded: 2, error: expect.stringContaining('boom-name') })

    const statuses = await getSyncStatuses('timelog')
    expect(statuses.get(e2.id)?.status).toBe('uploaded')
    expect(statuses.get(e3.id)?.status).toBe('uploaded')
    // They landed as their own segment, never bundled with the poison row.
    expect(drive.nodes.some((f) => f.name.endsWith('.ndjson'))).toBe(true)
  })

  it('clears a row error once a retried upload succeeds', async () => {
    // A row that failed once (retryable) and later succeeds must not keep
    // reading as failed forever (src/capture/lifecycle.ts keys off `error`
    // being present on a non-uploaded row, but a stale `error` string must
    // never survive onto an `uploaded` row).
    const event = await captureWithAudio()
    await import('./bootstrap').then((m) => m.ensureTree('tok', ['timelog']))
    drive.failNext(503)
    const { drainStream } = await import('./queue')
    expect((await drainStream('tok', 'timelog')).outcome).toBe('retry-later')

    const { getSyncStatuses } = await import('../store/events')
    expect((await getSyncStatuses('timelog')).get(event.id)?.error).toBeTruthy()

    drive.failNext(null)
    expect((await drainStream('tok', 'timelog')).outcome).toBe('drained')
    const row = (await getSyncStatuses('timelog')).get(event.id)!
    expect(row.status).toBe('uploaded')
    expect(row.error).toBeUndefined()
  })
})
