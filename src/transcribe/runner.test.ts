import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AmendEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'

const { transcribeAudio } = vi.hoisted(() => ({
  transcribeAudio:
    vi.fn<
      (blob: Blob, mimeType: string, onPartial?: (text: string) => void) => Promise<string>
    >(),
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
  const livetext = await import('../store/livetext')
  const runner = await import('./runner')
  return { ...events, ...db, ...runner, liveTranscripts: livetext.liveTranscripts }
}

async function appendAudioCapture(s: Awaited<ReturnType<typeof setup>>) {
  return s.appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [audioAttachment()] })
}

function amendsOf(events: readonly { type: string }[]): AmendEvent[] {
  return events.filter((e): e is AmendEvent => e.type === 'amend')
}

/** A transcript amend as another device would have pushed it to Drive. */
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
      {
        kind: 'text',
        file: '000002_remote_note.txt',
        mimeType: 'text/plain',
        derivedFrom: audioFile,
      },
    ],
  }
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

  it('does not re-transcribe audio whose transcript arrived via a pulled amend', async () => {
    const s = await setup()
    transcribeAudio.mockResolvedValue('hello world')
    const cap = await appendAudioCapture(s)
    await s.importEvents(
      'timelog',
      [remoteTranscriptAmend(cap.id, cap.attachments[0].file)],
      new Map<string, Blob>(),
    )

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(transcribeAudio).not.toHaveBeenCalled()
    expect(amendsOf(await s.listEvents('timelog'))).toHaveLength(1)
  })

  it('drops an in-flight transcript when a pull imports a remote one mid-drain', async () => {
    const s = await setup()
    let resolveText!: (text: string) => void
    transcribeAudio.mockImplementation(
      () =>
        new Promise((res) => {
          resolveText = res
        }),
    )
    const cap = await appendAudioCapture(s)

    const drain = s.drainTranscriptions('timelog')
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    await s.importEvents(
      'timelog',
      [remoteTranscriptAmend(cap.id, cap.attachments[0].file)],
      new Map<string, Blob>(),
    )
    resolveText('hello world')

    expect(await drain).toBe(0)
    expect(amendsOf(await s.listEvents('timelog'))).toHaveLength(1)
  })

  it('publishes streamed partials to the live store; only the final text is persisted', async () => {
    const s = await setup()
    let emitPartial!: (text: string) => void
    let resolveText!: (text: string) => void
    transcribeAudio.mockImplementation(
      (_blob, _mime, onPartial) =>
        new Promise((res) => {
          emitPartial = onPartial!
          resolveText = res
        }),
    )
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    const drain = s.drainTranscriptions('timelog')
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    emitPartial('hello')
    expect(s.liveTranscripts.snapshot().get(file)).toBe('hello')
    emitPartial('hello world')
    expect(s.liveTranscripts.snapshot().get(file)).toBe('hello world')
    resolveText('hello world')

    expect(await drain).toBe(1)
    // The final live text lingers (until the next drain sweeps it) so the
    // card never flashes empty before the store refresh.
    expect(s.liveTranscripts.snapshot().get(file)).toBe('hello world')
    // Only the resolved final text was persisted, in one amend.
    const amends = amendsOf(await s.listEvents('timelog'))
    expect(amends).toHaveLength(1)
    expect(await (await s.getBlob(amends[0].attachments![0].file))!.text()).toBe('hello world')
  })

  it('sweeps stale live text on the next drain once the transcript is persisted', async () => {
    const s = await setup()
    transcribeAudio.mockImplementation(async (_blob, _mime, onPartial) => {
      onPartial?.('hello world')
      return 'hello world'
    })
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainTranscriptions('timelog')).toBe(1)
    expect(s.liveTranscripts.snapshot().get(file)).toBe('hello world')
    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(s.liveTranscripts.snapshot().has(file)).toBe(false)
  })

  it('clears live partial text when transcription fails mid-stream and persists nothing', async () => {
    const s = await setup()
    transcribeAudio.mockImplementation(async (_blob, _mime, onPartial) => {
      onPartial?.('partial wor')
      throw new Error('connection lost')
    })
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainTranscriptions('timelog')).toBe(0)
    expect(s.liveTranscripts.snapshot().has(file)).toBe(false)
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('clears live text when a pull imports a remote transcript mid-drain', async () => {
    const s = await setup()
    let emitPartial!: (text: string) => void
    let resolveText!: (text: string) => void
    transcribeAudio.mockImplementation(
      (_blob, _mime, onPartial) =>
        new Promise((res) => {
          emitPartial = onPartial!
          resolveText = res
        }),
    )
    const cap = await appendAudioCapture(s)
    const file = cap.attachments[0].file

    const drain = s.drainTranscriptions('timelog')
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1))
    emitPartial('local partial')
    await s.importEvents('timelog', [remoteTranscriptAmend(cap.id, file)], new Map<string, Blob>())
    resolveText('local final')

    expect(await drain).toBe(0)
    expect(s.liveTranscripts.snapshot().has(file)).toBe(false)
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
