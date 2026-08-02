/**
 * Tests the shared drain engine directly, independent of either concrete
 * pipeline. Pipeline-specific wiring (skip-marker prefixes, amend shape,
 * mime-type pass-through) is covered by transcribe/runner.test.ts and
 * vision/runner.test.ts; the mechanisms that must behave identically for
 * both — failure classification, the circuit breaker, the missing-blob
 * defer, and the pull-race re-plan guard — are pinned once, here, so they
 * can't diverge again (issue #51).
 *
 * Reuses transcribe/plan.ts's `pendingTranscriptions` as a stand-in generic
 * plan (any pipeline's plan has the same shape), with a stubbed `callApi`
 * instead of a real api.ts client.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AmendEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { pendingTranscriptions, type PendingTranscription } from '../transcribe/plan'
import type { EnrichmentRunnerConfig } from './runner'

const AT = '2026-08-02T09:04:11-04:00'
const audioAttachment = () => ({
  kind: 'audio' as const,
  blob: new Blob(['hi'], { type: 'text/plain' }),
  mimeType: 'audio/mp4',
  durationSec: 3.2,
})

function amendsOf(events: readonly { type: string }[]): AmendEvent[] {
  return events.filter((e): e is AmendEvent => e.type === 'amend')
}

function remoteTranscriptAmend(targetId: string, audioFile: string): AmendEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'amend',
    id: 'remote1',
    seq: 2,
    stream: 'timelog',
    loggedAt: AT,
    deviceTz: 'America/New_York',
    targets: [targetId],
    attachments: [
      { kind: 'text', file: '000002_remote_note.txt', mimeType: 'text/plain', derivedFrom: audioFile },
    ],
  }
}

/**
 * `EnrichmentError` a test constructs must be `instanceof` the *same*
 * `./error` module instance `classifyFailure` inside a freshly-imported
 * `./runner` checks against — both this and `setup()` dynamically import
 * `./error`/`./runner` fresh each test (after `vi.resetModules()` in
 * `beforeEach`), and two dynamic imports of the same specifier resolve to
 * the same instance as long as no reset happens in between.
 */
async function importEnrichmentError() {
  return (await import('./error')).EnrichmentError
}

/**
 * `./runner` statically imports `getDb`/`listEvents`/etc from the store
 * modules, so it must be (re-)imported here too, after `vi.resetModules()`,
 * or its closed-over bindings would stay pinned to whatever IndexedDB was
 * live the first time this file's imports were resolved.
 */
async function setup(callApi: EnrichmentRunnerConfig<PendingTranscription>['callApi']) {
  const events = await import('../store/events')
  const db = await import('../store/db')
  const livetextMod = await import('../store/livetext')
  const settings = await import('../store/settings')
  const { createEnrichmentRunner } = await import('./runner')
  await settings.saveSettings({ ...settings.APP_SETTINGS_DEFAULTS, enrichmentEnabled: true })
  const liveStore = livetextMod.createLiveTextStore()
  const runner = createEnrichmentRunner<PendingTranscription>({
    skipPrefix: 'test:skip:',
    plan: pendingTranscriptions,
    sourceOf: (item) => item.audio,
    targetOf: (item) => ({ entryId: item.entryId, stream: item.stream }),
    callApi,
    liveStore,
  })
  return { ...events, ...db, ...settings, runner, liveStore }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function appendAudioCapture(s: Setup) {
  return s.appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [audioAttachment()] })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createEnrichmentRunner — failure classification (issue #60)', () => {
  it('skip-marks a permanent EnrichmentError immediately, with its message as the reason', async () => {
    const EnrichmentError = await importEnrichmentError()
    const callApi = vi
      .fn()
      .mockRejectedValue(new EnrichmentError('transcription failed: HTTP 413', { retryable: false }))
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(callApi).toHaveBeenCalledTimes(1)
    expect(await s.runner.listSkipped()).toEqual([
      { file, reason: 'transcription failed: HTTP 413', at: expect.any(String) },
    ])

    // Never retried again, even on a later drain.
    expect(await s.runner.drain('timelog')).toBe(0)
    expect(callApi).toHaveBeenCalledTimes(1)
  })

  it('backs off (does not skip) a retryable EnrichmentError, same as an untyped Error', async () => {
    const EnrichmentError = await importEnrichmentError()
    const callApi = vi
      .fn()
      .mockRejectedValue(new EnrichmentError('transcription failed: HTTP 503', { retryable: true }))
    const s = await setup(callApi)
    await appendAudioCapture(s)

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(await s.runner.listSkipped()).toEqual([])
    // Backing off means the very next drain doesn't retry immediately either.
    expect(await s.runner.drain('timelog')).toBe(0)
    expect(callApi).toHaveBeenCalledTimes(1)
  })

  it('treats an unrecognized thrown error as retryable, never as a skip', async () => {
    const callApi = vi.fn().mockRejectedValue(new Error('boom'))
    const s = await setup(callApi)
    await appendAudioCapture(s)

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(await s.runner.listSkipped()).toEqual([])
  })
})

describe('createEnrichmentRunner — missing blob is deferred, not skipped (issue #55)', () => {
  it('does not call the API or write a skip marker when the source blob is absent', async () => {
    const callApi = vi.fn()
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file
    const db = await s.getDb()
    await db.delete('blobs', file)

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(callApi).not.toHaveBeenCalled()
    expect(await s.runner.listSkipped()).toEqual([])
  })

  it('picks the item up on the very next drain once a blob appears, with no backoff incurred', async () => {
    const callApi = vi.fn().mockResolvedValue('hello world')
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file
    const db = await s.getDb()
    const row = await db.get('blobs', file)
    await db.delete('blobs', file)

    expect(await s.runner.drain('timelog')).toBe(0)
    await db.put('blobs', row!)
    expect(await s.runner.drain('timelog')).toBe(1)
    expect(callApi).toHaveBeenCalledTimes(1)
  })
})

describe('createEnrichmentRunner — per-drain circuit breaker (issue #62)', () => {
  it('stops attempting further items in the same drain once a host-down failure is seen', async () => {
    const EnrichmentError = await importEnrichmentError()
    const callApi = vi
      .fn()
      .mockRejectedValueOnce(new EnrichmentError('timed out', { retryable: true, hostDown: true }))
      .mockResolvedValue('should not be reached')
    const s = await setup(callApi)
    await appendAudioCapture(s)
    await appendAudioCapture(s)

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(callApi).toHaveBeenCalledTimes(1)
    // Neither item was skip-marked — the untried one is simply still pending,
    // and the tried one backed off normally.
    expect(await s.runner.listSkipped()).toEqual([])
  })

  it('does not trip the breaker on a same-request rejection that is merely retryable', async () => {
    const EnrichmentError = await importEnrichmentError()
    const callApi = vi
      .fn()
      .mockRejectedValueOnce(new EnrichmentError('HTTP 503', { retryable: true, hostDown: false }))
      .mockResolvedValue('second item ok')
    const s = await setup(callApi)
    await appendAudioCapture(s)
    await appendAudioCapture(s)

    expect(await s.runner.drain('timelog')).toBe(1)
    expect(callApi).toHaveBeenCalledTimes(2)
  })
})

describe('createEnrichmentRunner — post-API re-plan guard (issue #51)', () => {
  it('drops an in-flight result if a pull imports another device’s result mid-drain', async () => {
    let resolveText!: (text: string) => void
    const callApi = vi.fn().mockImplementation(
      () =>
        new Promise<string>((res) => {
          resolveText = res
        }),
    )
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)

    const drain = s.runner.drain('timelog')
    await vi.waitFor(() => expect(callApi).toHaveBeenCalledTimes(1))
    await s.importEvents(
      'timelog',
      [remoteTranscriptAmend(cap.id, cap.attachments[0].file)],
      new Map<string, Blob>(),
    )
    resolveText('local result')

    expect(await drain).toBe(0)
    expect(amendsOf(await s.listEvents('timelog'))).toHaveLength(1)
  })
})

describe('createEnrichmentRunner — listSkipped / retry (issue #55)', () => {
  it('retry() clears the marker and backoff so the next drain reattempts', async () => {
    const EnrichmentError = await importEnrichmentError()
    const callApi = vi
      .fn()
      .mockRejectedValueOnce(new EnrichmentError('permanent', { retryable: false }))
      .mockResolvedValue('recovered text')
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(await s.runner.listSkipped()).toHaveLength(1)

    await s.runner.retry(file)
    expect(await s.runner.listSkipped()).toEqual([])
    expect(await s.runner.drain('timelog')).toBe(1)
    expect(callApi).toHaveBeenCalledTimes(2)
  })

  it('honors a legacy bare-`true` marker as an unknown-reason skip', async () => {
    const callApi = vi.fn()
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file
    const db = await s.getDb()
    await db.put('meta', true, `test:skip:${file}`)

    expect(await s.runner.listSkipped()).toEqual([{ file, reason: 'unknown', at: '' }])
    expect(await s.runner.drain('timelog')).toBe(0)
    expect(callApi).not.toHaveBeenCalled()
  })
})

describe('createEnrichmentRunner — empty result (issue: valid non-retryable outcome)', () => {
  it('skip-marks an empty result with reason "empty-result"', async () => {
    const callApi = vi.fn().mockResolvedValue('')
    const s = await setup(callApi)
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    expect(await s.runner.drain('timelog')).toBe(0)
    expect(await s.runner.listSkipped()).toEqual([
      { file, reason: 'empty-result', at: expect.any(String) },
    ])
  })
})
