import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AmendEvent } from '../contract/types'

const { transcribeAudio } = vi.hoisted(() => ({
  transcribeAudio: vi.fn<(blob: Blob, mimeType: string) => Promise<string>>(),
}))
vi.mock('./api', () => ({ transcribeAudio }))

const AT = '2026-08-02T09:04:11-04:00'
const audioAttachment = () => ({
  kind: 'audio' as const,
  blob: new Blob(['hi'], { type: 'text/plain' }),
  mimeType: 'audio/mp4',
  durationSec: 3.2,
})

// The runner keeps module-level state (retry backoff, in-flight drain), so
// each test gets a fresh module registry and a fresh IndexedDB.
async function setup() {
  const events = await import('../store/events')
  const db = await import('../store/db')
  const runner = await import('./runner')
  return { ...events, ...db, ...runner }
}

async function appendAudioCapture(s: Awaited<ReturnType<typeof setup>>) {
  return s.appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [audioAttachment()] })
}

function amendsOf(events: readonly { type: string }[]): AmendEvent[] {
  return events.filter((e): e is AmendEvent => e.type === 'amend')
}

beforeEach(() => {
  vi.resetModules()
  transcribeAudio.mockReset()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drainTranscriptions', () => {
  it('appends an amend with a derivedFrom transcript for pending audio', async () => {
    const s = await setup()
    transcribeAudio.mockResolvedValue('hello world')
    const cap = await appendAudioCapture(s)

    expect(await s.drainTranscriptions('timelog')).toBe(1)

    const [amend] = amendsOf(await s.listEvents('timelog'))
    expect(amend.targets).toEqual([cap.id])
    const [transcript] = amend.attachments!
    expect(transcript.kind).toBe('text')
    expect(transcript.mimeType).toBe('text/plain')
    expect(transcript.derivedFrom).toBe(cap.attachments[0].file)
    expect(await (await s.getBlob(transcript.file))!.text()).toBe('hello world')
  })

  it('returns 0 on a second drain once the audio is transcribed', async () => {
    const s = await setup()
    transcribeAudio.mockResolvedValue('hello world')
    await appendAudioCapture(s)
    expect(await s.drainTranscriptions('timelog')).toBe(1)
    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
  })

  it('skips an empty transcript permanently via a meta marker', async () => {
    const s = await setup()
    transcribeAudio.mockResolvedValue('')
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    const db = await s.getDb()
    expect(await db.get('meta', `transcribe:skip:${file}`)).toBe(true)

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
  })

  it('skips audio whose blob is missing without calling the API', async () => {
    const s = await setup()
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file
    const db = await s.getDb()
    await db.delete('blobs', file)

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(await db.get('meta', `transcribe:skip:${file}`)).toBe(true)
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('backs off after a transcription failure', async () => {
    const s = await setup()
    transcribeAudio.mockRejectedValue(new Error('boom'))
    await appendAudioCapture(s)

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
  })

  it('does nothing while offline', async () => {
    const s = await setup()
    transcribeAudio.mockResolvedValue('hello world')
    await appendAudioCapture(s)
    vi.stubGlobal('navigator', { onLine: false })

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('coalesces overlapping drains onto one in-flight promise', async () => {
    const s = await setup()
    let resolveText!: (text: string) => void
    transcribeAudio.mockImplementation(
      () =>
        new Promise((res) => {
          resolveText = res
        }),
    )
    await appendAudioCapture(s)

    const first = s.drainTranscriptions('timelog')
    const second = s.drainTranscriptions('timelog')
    expect(second).toBe(first)

    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    resolveText('hello world')
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(transcribeAudio).toHaveBeenCalledTimes(1)
  })
})
