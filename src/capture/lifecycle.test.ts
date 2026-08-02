import { describe, expect, it } from 'vitest'
import type { Attachment, Entry } from '../contract/types'
import type { SyncStatus, SyncStatusRow } from '../store/db'
import { entryLifecycle, hasPendingEnrichment, lifecycleLabel } from './lifecycle'

function row(status: SyncStatus, error?: string): SyncStatusRow {
  return {
    id: 'e1',
    stream: 'timelog',
    seq: 1,
    status,
    phase: status === 'uploaded' ? 'done' : 'record-pending',
    attempts: 0,
    ...(error !== undefined ? { error } : {}),
  }
}

const AUDIO: Attachment = { kind: 'audio', file: 'a.m4a', mimeType: 'audio/mp4' }
const TRANSCRIPT: Attachment = { kind: 'text', file: 'a_note.txt', mimeType: 'text/plain', derivedFrom: 'a.m4a' }
const NOTE: Attachment = { kind: 'text', file: 'a_note2.txt', mimeType: 'text/plain' }
const PHOTO: Attachment = { kind: 'photo', file: 'a_photo.jpg', mimeType: 'image/jpeg' }
const CAPTION: Attachment = { kind: 'text', file: 'a_note3.txt', mimeType: 'text/plain', derivedFrom: 'a_photo.jpg' }

function entry(attachments: Attachment[] = []): Entry {
  return {
    id: 'e1',
    seq: 1,
    stream: 'timelog',
    loggedAt: '2026-08-02T09:00:00-04:00',
    capturedAt: '2026-08-02T09:00:00-04:00',
    deviceTz: 'America/New_York',
    attachments,
    lastEventSeq: 1,
    revoked: false,
  }
}

describe('entryLifecycle', () => {
  // Exhaustive over the 3 (status: queued/uploaded/undefined) x 2
  // (hasPendingEnrichment: true/false) space, per #79's assertions list.
  it('(queued, pending) -> understanding', () => {
    expect(entryLifecycle(row('queued'), true)).toBe('understanding')
  })
  it('(queued, none) -> settled', () => {
    expect(entryLifecycle(row('queued'), false)).toBe('settled')
  })
  it('(uploaded, pending) -> understanding', () => {
    expect(entryLifecycle(row('uploaded'), true)).toBe('understanding')
  })
  it('(uploaded, none) -> settled', () => {
    expect(entryLifecycle(row('uploaded'), false)).toBe('settled')
  })
  it('(undefined row, pending) -> understanding — never-queued pulled entries', () => {
    expect(entryLifecycle(undefined, true)).toBe('understanding')
  })
  it('(undefined row, none) -> settled', () => {
    expect(entryLifecycle(undefined, false)).toBe('settled')
  })
  it('(error, pending) -> failed', () => {
    expect(entryLifecycle(row('error'), true)).toBe('failed')
  })
  it('(error, none) -> failed', () => {
    expect(entryLifecycle(row('error'), false)).toBe('failed')
  })

  // Regression: the drainer (src/drive/queue.ts) records `error` on every
  // failure path, including 429/5xx and 401/403, which leave `status:
  // 'queued'` so the next automatic retry can pick the row up (no backoff
  // gate). A row that has already failed at least once but is still queued
  // for retry must read as 'failed' too — reading it as plain 'queued'
  // (identical to a never-attempted row) is exactly what made a
  // repeatedly-failing audio upload look like an ordinary silent queue,
  // the "stays queued forever" report.
  it('(queued with a recorded error, pending) -> failed, not settled/understanding', () => {
    expect(entryLifecycle(row('queued', 'Drive 503: boom'), true)).toBe('failed')
  })
  it('(queued with a recorded error, none) -> failed', () => {
    expect(entryLifecycle(row('queued', 'Drive 401: boom'), false)).toBe('failed')
  })
  it('(queued, no error) -> stays settled/understanding, not failed', () => {
    // A brand-new, never-attempted row must not read as failed.
    expect(entryLifecycle(row('queued'), false)).not.toBe('failed')
  })

  // A row that failed once and later succeeded must never keep reading as
  // failed just because a stale `error` string survives on the row (the
  // drainer clears it on success, but the display mapping must not depend
  // on that for correctness).
  it('(uploaded with a stale error, none) -> settled, not failed', () => {
    expect(entryLifecycle(row('uploaded', 'Drive 503: boom'), false)).toBe('settled')
  })
  it('(uploaded with a stale error, pending) -> understanding, not failed', () => {
    expect(entryLifecycle(row('uploaded', 'Drive 503: boom'), true)).toBe('understanding')
  })

  it('invariant: no input combination maps a sync error to anything but failed', () => {
    const statuses: (SyncStatus | undefined)[] = ['queued', 'uploaded', 'error', undefined]
    for (const status of statuses) {
      for (const pending of [true, false]) {
        const sync = status === undefined ? undefined : row(status)
        const result = entryLifecycle(sync, pending)
        if (status === 'error') {
          expect(result).toBe('failed')
        } else {
          expect(result).not.toBe('failed')
        }
      }
    }
  })

  it('invariant: a recorded error on a not-yet-uploaded row always fails, regardless of status/pending', () => {
    const statuses: SyncStatus[] = ['queued', 'error']
    for (const status of statuses) {
      for (const pending of [true, false]) {
        expect(entryLifecycle(row(status, 'boom'), pending)).toBe('failed')
      }
    }
  })

  it('invariant: an uploaded row never reads as failed, even with a stale error', () => {
    for (const pending of [true, false]) {
      expect(entryLifecycle(row('uploaded', 'stale boom'), pending)).not.toBe('failed')
    }
  })
})

describe('lifecycleLabel', () => {
  it('is null for settled — render nothing', () => {
    expect(lifecycleLabel('settled')).toBeNull()
  })
  it('is a quiet processing word for understanding', () => {
    expect(lifecycleLabel('understanding')).toBe('Organizing…')
  })
  it('mentions retry for failed', () => {
    expect(lifecycleLabel('failed')).toMatch(/retry/i)
  })
})

describe('hasPendingEnrichment', () => {
  it('is false for an entry with no attachments', () => {
    expect(hasPendingEnrichment(entry())).toBe(false)
  })
  it('is true for audio with no transcript', () => {
    expect(hasPendingEnrichment(entry([AUDIO]))).toBe(true)
  })
  it('is false once a transcript is derived from the audio', () => {
    expect(hasPendingEnrichment(entry([AUDIO, TRANSCRIPT]))).toBe(false)
  })
  it('is true for a photo with no caption', () => {
    expect(hasPendingEnrichment(entry([PHOTO]))).toBe(true)
  })
  it('is false once a caption is derived from the photo', () => {
    expect(hasPendingEnrichment(entry([PHOTO, CAPTION]))).toBe(false)
  })
  it('is false for a plain user note (not derived from anything)', () => {
    expect(hasPendingEnrichment(entry([NOTE]))).toBe(false)
  })
  it('is true when one of several attachments is still pending', () => {
    expect(hasPendingEnrichment(entry([AUDIO, TRANSCRIPT, PHOTO]))).toBe(true)
  })
  it('is false once every audio/photo has its derived text', () => {
    expect(hasPendingEnrichment(entry([AUDIO, TRANSCRIPT, PHOTO, CAPTION]))).toBe(false)
  })
})
