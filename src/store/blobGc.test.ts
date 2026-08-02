import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CaptureEvent, LogEvent } from '../contract/types'
import { getDb, resetDbCache } from './db'
import type { SyncStatusRow } from './db'
import { appendAmend, appendCapture, appendRevoke, getBlob, putSyncStatus } from './events'
import { planBlobGc, reclaimStreamBlobs } from './blobGc'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

const AT = '2026-08-02T09:04:11-04:00'

function capture(id: string, seq: number, file: string): CaptureEvent {
  return {
    schema: 'capture.event.v1',
    type: 'capture',
    id,
    seq,
    stream: 'timelog',
    loggedAt: AT,
    deviceTz: 'America/New_York',
    capturedAt: AT,
    attachments: [{ kind: 'audio', file, mimeType: 'audio/mp4' }],
  }
}

function uploadedRow(id: string, seq: number): SyncStatusRow {
  return { id, stream: 'timelog', seq, status: 'uploaded', phase: 'done', attempts: 1 }
}

function queuedRow(id: string, seq: number): SyncStatusRow {
  return { id, stream: 'timelog', seq, status: 'queued', phase: 'attachments-pending', attempts: 0 }
}

describe('planBlobGc', () => {
  it('keeps a live (non-revoked) attachment even once uploaded', () => {
    const events: LogEvent[] = [capture('a', 1, 'a-audio.m4a')]
    const statuses = new Map([['a', uploadedRow('a', 1)]])
    expect(planBlobGc(events, statuses)).toEqual([])
  })

  it('reclaims a revoked entry once its capture event is uploaded', () => {
    const events: LogEvent[] = [
      capture('a', 1, 'a-audio.m4a'),
      { schema: 'capture.event.v1', type: 'revoke', id: 'r', seq: 2, stream: 'timelog', loggedAt: AT, deviceTz: 'America/New_York', targets: ['a'] },
    ]
    const statuses = new Map([
      ['a', uploadedRow('a', 1)],
      ['r', uploadedRow('r', 2)],
    ])
    expect(planBlobGc(events, statuses)).toEqual(['a-audio.m4a'])
  })

  it('never reclaims a revoked entry whose capture is not yet uploaded', () => {
    const events: LogEvent[] = [
      capture('a', 1, 'a-audio.m4a'),
      { schema: 'capture.event.v1', type: 'revoke', id: 'r', seq: 2, stream: 'timelog', loggedAt: AT, deviceTz: 'America/New_York', targets: ['a'] },
    ]
    const statuses = new Map([['a', queuedRow('a', 1)]])
    expect(planBlobGc(events, statuses)).toEqual([])
  })

  it('reclaims a removeAttachments-hidden file once its owning event is uploaded', () => {
    const events: LogEvent[] = [
      capture('a', 1, 'old.txt'),
      {
        schema: 'capture.event.v1',
        type: 'amend',
        id: 'b',
        seq: 2,
        stream: 'timelog',
        loggedAt: AT,
        deviceTz: 'America/New_York',
        targets: ['a'],
        patch: { removeAttachments: ['old.txt'] },
        attachments: [{ kind: 'text', file: 'new.txt', mimeType: 'text/plain' }],
      },
    ]
    const statuses = new Map([
      ['a', uploadedRow('a', 1)],
      ['b', uploadedRow('b', 2)],
    ])
    expect(planBlobGc(events, statuses)).toEqual(['old.txt'])
  })
})

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('reclaimStreamBlobs', () => {
  it('deletes an uploaded-and-revoked entry blob, leaving live entries alone', async () => {
    const keep = await appendCapture({
      stream: 'timelog',
      capturedAt: AT,
      attachments: [{ kind: 'audio', blob: new Blob(['keep']), mimeType: 'audio/mp4' }],
    })
    const gone = await appendCapture({
      stream: 'timelog',
      capturedAt: AT,
      attachments: [{ kind: 'audio', blob: new Blob(['gone']), mimeType: 'audio/mp4' }],
    })
    await putSyncStatus(uploadedRow(keep.id, keep.seq))
    await putSyncStatus(uploadedRow(gone.id, gone.seq))
    await appendRevoke({ stream: 'timelog', targets: [gone.id] })

    const reclaimed = await reclaimStreamBlobs('timelog')

    expect(reclaimed).toEqual([gone.attachments[0].file])
    expect(await getBlob(gone.attachments[0].file)).toBeUndefined()
    expect(await getBlob(keep.attachments[0].file)).toBeDefined()
  })

  it('leaves a revoked entry blob alone until its capture event has uploaded', async () => {
    const gone = await appendCapture({
      stream: 'timelog',
      capturedAt: AT,
      attachments: [{ kind: 'audio', blob: new Blob(['gone']), mimeType: 'audio/mp4' }],
    })
    await appendRevoke({ stream: 'timelog', targets: [gone.id] })

    const reclaimed = await reclaimStreamBlobs('timelog')

    expect(reclaimed).toEqual([])
    expect(await getBlob(gone.attachments[0].file)).toBeDefined()
  })

  it('reclaims a note edit\'s superseded text attachment once uploaded', async () => {
    const entry = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const first = await appendAmend({
      stream: 'timelog',
      targets: [entry.id],
      attachments: [{ kind: 'text', blob: new Blob(['v1']), mimeType: 'text/plain' }],
    })
    await putSyncStatus(uploadedRow(entry.id, entry.seq))
    await putSyncStatus(uploadedRow(first.id, first.seq))
    const oldFile = first.attachments![0].file
    const second = await appendAmend({
      stream: 'timelog',
      targets: [entry.id],
      patch: { removeAttachments: [oldFile] },
      attachments: [{ kind: 'text', blob: new Blob(['v2']), mimeType: 'text/plain' }],
    })
    await putSyncStatus(uploadedRow(second.id, second.seq))

    const reclaimed = await reclaimStreamBlobs('timelog')

    expect(reclaimed).toEqual([oldFile])
    expect(await getBlob(oldFile)).toBeUndefined()
    expect(await getBlob(second.attachments![0].file)).toBeDefined()
  })
})
