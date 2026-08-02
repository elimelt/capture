import { beforeEach, describe, expect, it, vi } from 'vitest'
// `./testing/fakeDrive` must be imported before `./client` below: both are
// intercepted once `vi.mock('./client', ...)` is registered, and the mock
// factory needs `driveClientMock` already initialized (see fakeDrive.ts's
// module doc for why it can't just import `../client` itself).
import { driveClientMock, fakeDrive, setActiveFakeDrive, type FakeDrive } from './testing/fakeDrive'
import { FOLDER_MIME } from './client'
import { serializeEvent } from '../contract/serialize'
import { serializeSegment } from '../contract/segments'
import {
  eventRecordName,
  attachmentFileName,
  eventBaseName,
  segmentFileName,
} from '../contract/filenames'
import type { CaptureEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { useFreshIndexedDb } from '../testing/freshDb'

useFreshIndexedDb()

// Shared fake (issue #70) — see testing/fakeDrive.ts. This suite exercises
// the full journal-backed changes feed: cursors, trash, appProperties, and
// the list/read/changes failure-injection knob.
vi.mock('./client', () => driveClientMock())

let drive: FakeDrive

beforeEach(() => {
  drive = fakeDrive()
  setActiveFakeDrive(drive)
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

  it('makes a no-op incremental pull a single request (changes cursor)', async () => {
    seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog') // cold start: full walk + cursor mint

    for (const fn of [drive.listChildren, drive.readFileText, drive.getStartPageToken]) {
      fn.mockClear()
    }
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.listChanges).toHaveBeenCalledTimes(1)
    expect(drive.listChildren).not.toHaveBeenCalled()
    expect(drive.readFileText).not.toHaveBeenCalled()
    expect(drive.getStartPageToken).not.toHaveBeenCalled()
  })

  it('imports records discovered through the changes feed', async () => {
    const { log } = seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    // Another device pushes a new partition + record after our cold start.
    const remote = remoteCapture(2, 'bbbbbb')
    const partition2 = drive.add('2026-08-02', log, FOLDER_MIME)
    drive.add(eventRecordName(remote), partition2, 'application/json', serializeEvent(remote))

    drive.listChildren.mockClear()
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })
    // The folder change warmed the partition cache, so no files.get needed;
    // only the one dirty partition was listed.
    expect(drive.getFileMetadata).not.toHaveBeenCalled()
    expect(drive.listChildren).toHaveBeenCalledTimes(1)

    const { listEvents } = await import('../store/events')
    expect((await listEvents('timelog')).map((e) => e.id).sort()).toEqual(['aaaaaa', 'bbbbbb'])
  })

  it('resolves a record in an uncached partition with a single files.get', async () => {
    const { log } = seedRemote([])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    // The record's change arrives without its partition folder's (e.g. the
    // folder predates the cursor): the parent must be resolved by id.
    const remote = remoteCapture(1, 'cccccc')
    const partition2 = drive.add('2026-08-02', log, FOLDER_MIME, undefined, { quiet: true })
    drive.add(eventRecordName(remote), partition2, 'application/json', serializeEvent(remote))

    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })
    expect(drive.getFileMetadata).toHaveBeenCalledTimes(1)

    // …and the resolution warmed the push path's partition cache.
    const { getTree } = await import('./tree')
    expect((await getTree())!.streams.timelog.partitions['2026-08-02']).toBe(partition2)
  })

  it('ignores changes for events already local (our own pushes)', async () => {
    const { partition } = seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    // A metadata touch on the already-imported record re-journals it.
    const record = drive.nodes.find((f) => f.parentId === partition && f.name.endsWith('.json'))!
    drive.touch(record.id)

    drive.listChildren.mockClear()
    drive.readFileText.mockClear()
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.listChildren).not.toHaveBeenCalled()
    expect(drive.readFileText).not.toHaveBeenCalled()
  })

  it('ignores removed, trashed, foreign, and other-stream-tagged changes', async () => {
    const { log, partition } = seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    const record = drive.nodes.find((f) => f.parentId === partition && f.name.endsWith('.json'))!
    drive.remove(record.id)
    drive.add('000009_2026-08-01T10-00-00-0400_zzzzzz.json', partition, 'application/json', '{}', {
      trashed: true,
    })
    drive.add('random-notes.txt', partition, 'text/plain', 'hi')
    drive.add('000010_2026-08-01T10-00-00-0400_yyyyyy.json', log, 'application/json', '{}', {
      appProperties: { captureKind: 'record', captureStream: 'other' },
    })

    drive.listChildren.mockClear()
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.listChildren).not.toHaveBeenCalled()
    // The removed record stays imported: the log is append-only.
    const { listEvents } = await import('../store/events')
    expect((await listEvents('timelog')).map((e) => e.id)).toEqual(['aaaaaa'])
  })

  it('falls back to a full listing and re-mints the cursor when it expires (410)', async () => {
    const { log } = seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    // New remote records land, but the persisted cursor has expired.
    const remote = remoteCapture(2, 'dddddd')
    const partition2 = drive.add('2026-08-02', log, FOLDER_MIME)
    drive.add(eventRecordName(remote), partition2, 'application/json', serializeEvent(remote))
    drive.fail('changes', 410)

    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })
    expect(drive.getStartPageToken).toHaveBeenCalledTimes(2) // cold start + re-mint

    // The re-minted cursor works: the next pull is an O(1) no-op again.
    drive.fail(null)
    drive.listChanges.mockClear()
    drive.listChildren.mockClear()
    expect(await pullStream('tok', 'timelog')).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.listChanges).toHaveBeenCalledTimes(1)
    expect(drive.listChildren).not.toHaveBeenCalled()
  })

  it('does not advance the cursor when an import fails mid-pull', async () => {
    const { log } = seedRemote([])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    const remote = remoteCapture(1, 'eeeeee')
    const partition2 = drive.add('2026-08-02', log, FOLDER_MIME)
    drive.add(eventRecordName(remote), partition2, 'application/json', serializeEvent(remote))

    drive.fail('read', 500)
    expect((await pullStream('tok', 'timelog')).outcome).toBe('retry-later')

    // The failed window replays: the record is not lost.
    drive.fail(null)
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 })
  })

  it('imports a multi-event segment as a unit (SPEC §5.7)', async () => {
    const a = remoteCapture(1, 'aaaaaa')
    const b = remoteCapture(2, 'bbbbbb', true)
    const file = b.attachments[0].file
    const { partition } = seedRemote([], { [file]: 'audio-bytes' })
    drive.add(segmentFileName([a, b]), partition, 'application/x-ndjson', serializeSegment([a, b]))

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 2 })

    const { listEvents, getSyncStatuses, getBlob } = await import('../store/events')
    expect(await listEvents('timelog')).toEqual([a, b])
    // Members' attachments were eagerly fetched by their own names.
    expect(await (await getBlob(file))!.text()).toBe('audio-bytes')
    // Pulled events are never re-pushed.
    for (const id of ['aaaaaa', 'bbbbbb']) {
      expect((await getSyncStatuses('timelog')).get(id)?.status).toBe('uploaded')
    }
  })

  it('imports mixed partitions: segments alongside per-event records', async () => {
    const a = remoteCapture(1, 'aaaaaa')
    const b = remoteCapture(2, 'bbbbbb')
    const c = remoteCapture(3, 'cccccc')
    const { partition } = seedRemote([c]) // c as a plain record
    drive.add(segmentFileName([a, b]), partition, 'application/x-ndjson', serializeSegment([a, b]))

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 3 })
    const { listEvents } = await import('../store/events')
    expect((await listEvents('timelog')).map((e) => e.id)).toEqual(['aaaaaa', 'bbbbbb', 'cccccc'])
  })

  it('dedupes a segment overlapping an already-imported single record', async () => {
    // 'bbbbbb' was already imported as a per-event record; a segment then
    // arrives whose first member 'aaaaaa' is new but which resends 'bbbbbb'.
    // (Discovery keys on the segment's *first* member — SPEC §5.8 — so an
    // overlap at the first member is skipped as already-held wholesale; a
    // deeper overlap must dedupe line by line.)
    const a = remoteCapture(1, 'aaaaaa')
    const b = remoteCapture(2, 'bbbbbb')
    const { partition } = seedRemote([b])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog') // 'bbbbbb' imported as a single

    drive.add(segmentFileName([a, b]), partition, 'application/x-ndjson', serializeSegment([a, b]))

    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 1 }) // only 'aaaaaa'
    const { listEvents } = await import('../store/events')
    expect((await listEvents('timelog')).map((e) => e.id)).toEqual(['aaaaaa', 'bbbbbb'])
  })

  it('discovers segments through the changes feed', async () => {
    const { log } = seedRemote([remoteCapture(1, 'aaaaaa')])
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog') // cold start + cursor mint

    // Another device pushes a segment into a new partition.
    const a = { ...remoteCapture(2, 'dddddd'), loggedAt: '2026-08-02T10:00:00-04:00' }
    const b = { ...remoteCapture(3, 'eeeeee'), loggedAt: '2026-08-02T10:01:00-04:00' }
    const partition2 = drive.add('2026-08-02', log, FOLDER_MIME)
    drive.add(segmentFileName([a, b]), partition2, 'application/x-ndjson', serializeSegment([a, b]))

    drive.listChildren.mockClear()
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 2 })
    expect(drive.listChildren).toHaveBeenCalledTimes(1) // just the dirty partition

    const { listEvents } = await import('../store/events')
    expect((await listEvents('timelog')).map((e) => e.id)).toEqual(['aaaaaa', 'dddddd', 'eeeeee'])
  })

  it('ignores segment changes whose first member is already local (our own pushes)', async () => {
    const a = remoteCapture(1, 'aaaaaa')
    const b = remoteCapture(2, 'bbbbbb')
    const { partition } = seedRemote([])
    drive.add(segmentFileName([a, b]), partition, 'application/x-ndjson', serializeSegment([a, b]))
    const { pullStream } = await import('./pull')
    await pullStream('tok', 'timelog')

    // A metadata touch re-journals the segment; its first id is local now.
    const segment = drive.nodes.find((f) => f.name.endsWith('.ndjson'))!
    drive.touch(segment.id)

    drive.listChildren.mockClear()
    drive.readFileText.mockClear()
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.listChildren).not.toHaveBeenCalled()
    expect(drive.readFileText).not.toHaveBeenCalled()
  })

  it('fails a malformed segment as a unit — imports none of its lines', async () => {
    const a = remoteCapture(1, 'aaaaaa')
    const { partition } = seedRemote([])
    drive.add(
      '000001-000002_2026-08-01T10-00-00-0400_aaaaaa.ndjson',
      partition,
      'application/x-ndjson',
      serializeSegment([a]).concat('{nope\n'),
    )

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res.outcome).toBe('error')
    expect(res.error).toMatch(/invalid segment line 2/)
    // Nothing half-imported: not even the valid first line.
    const { listEvents } = await import('../store/events')
    expect(await listEvents('timelog')).toEqual([])
  })

  it('treats a v1 cursor as unusable and walks the full listing once (SPEC §5.8)', async () => {
    const a = remoteCapture(1, 'aaaaaa')
    const b = remoteCapture(2, 'bbbbbb')
    const { partition } = seedRemote([])
    drive.add(segmentFileName([a, b]), partition, 'application/x-ndjson', serializeSegment([a, b]))

    // A v1 engine persisted its cursor as a bare string — and had already
    // consumed (and ignored) the segment's change entry.
    const { getDb } = await import('../store/db')
    await (await getDb()).put('meta', String(drive.nodes.length + 10), 'drive:changes:timelog')

    const { pullStream } = await import('./pull')
    const res = await pullStream('tok', 'timelog')
    expect(res).toEqual({ outcome: 'pulled', pulled: 2 })
    expect(drive.getStartPageToken).toHaveBeenCalledTimes(1) // cold start walk
    expect(drive.listChanges).not.toHaveBeenCalled()

    // The fresh cursor is format-2: the next pull is an O(1) no-op.
    drive.listChildren.mockClear()
    expect(await pullStream('tok', 'timelog')).toEqual({ outcome: 'idle', pulled: 0 })
    expect(drive.listChanges).toHaveBeenCalledTimes(1)
    expect(drive.listChildren).not.toHaveBeenCalled()
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
