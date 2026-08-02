import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AmendEvent } from '../contract/types'

const { captionPhoto } = vi.hoisted(() => ({
  captionPhoto: vi.fn<(blob: Blob) => Promise<string>>(),
}))
vi.mock('./api', () => ({ captionPhoto }))

const AT = '2026-08-02T09:04:11-04:00'
const photoAttachment = () => ({
  kind: 'photo' as const,
  blob: new Blob(['img'], { type: 'image/jpeg' }),
  mimeType: 'image/jpeg',
})

// The runner keeps module-level state (retry backoff, in-flight drain), so
// each test gets a fresh module registry and a fresh IndexedDB.
async function setup() {
  const events = await import('../store/events')
  const db = await import('../store/db')
  const runner = await import('./runner')
  return { ...events, ...db, ...runner }
}

async function appendPhotoCapture(s: Awaited<ReturnType<typeof setup>>) {
  return s.appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [photoAttachment()] })
}

function amendsOf(events: readonly { type: string }[]): AmendEvent[] {
  return events.filter((e): e is AmendEvent => e.type === 'amend')
}

beforeEach(() => {
  vi.resetModules()
  captionPhoto.mockReset()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drainCaptions', () => {
  it('appends an amend with a derivedFrom caption for pending photos', async () => {
    const s = await setup()
    captionPhoto.mockResolvedValue('A latte on a wooden table.')
    const cap = await appendPhotoCapture(s)

    expect(await s.drainCaptions('timelog')).toBe(1)

    const [amend] = amendsOf(await s.listEvents('timelog'))
    expect(amend.targets).toEqual([cap.id])
    const [caption] = amend.attachments!
    expect(caption.kind).toBe('text')
    expect(caption.mimeType).toBe('text/plain')
    expect(caption.derivedFrom).toBe(cap.attachments[0].file)
    expect(await (await s.getBlob(caption.file))!.text()).toBe('A latte on a wooden table.')
  })

  it('returns 0 on a second drain once the photo is captioned', async () => {
    const s = await setup()
    captionPhoto.mockResolvedValue('A latte.')
    await appendPhotoCapture(s)
    expect(await s.drainCaptions('timelog')).toBe(1)
    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).toHaveBeenCalledTimes(1)
  })

  it('skips an empty caption permanently via a meta marker', async () => {
    const s = await setup()
    captionPhoto.mockResolvedValue('')
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainCaptions('timelog')).toBe(0)
    const db = await s.getDb()
    expect(await db.get('meta', `caption:skip:${file}`)).toBe(true)

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).toHaveBeenCalledTimes(1)
  })

  it('skips photos whose blob is missing without calling the API', async () => {
    const s = await setup()
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file
    const db = await s.getDb()
    await db.delete('blobs', file)

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).not.toHaveBeenCalled()
    expect(await db.get('meta', `caption:skip:${file}`)).toBe(true)
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('backs off after a captioning failure', async () => {
    const s = await setup()
    captionPhoto.mockRejectedValue(new Error('boom'))
    await appendPhotoCapture(s)

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).toHaveBeenCalledTimes(1)
  })

  it('does nothing while offline', async () => {
    const s = await setup()
    captionPhoto.mockResolvedValue('A latte.')
    await appendPhotoCapture(s)
    vi.stubGlobal('navigator', { onLine: false })

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).not.toHaveBeenCalled()
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('coalesces overlapping drains onto one in-flight promise', async () => {
    const s = await setup()
    let resolveText!: (text: string) => void
    captionPhoto.mockImplementation(
      () =>
        new Promise((res) => {
          resolveText = res
        }),
    )
    await appendPhotoCapture(s)

    const first = s.drainCaptions('timelog')
    const second = s.drainCaptions('timelog')
    expect(second).toBe(first)

    await vi.waitFor(() => expect(captionPhoto).toHaveBeenCalledTimes(1))
    resolveText('A latte.')
    expect(await first).toBe(1)
    expect(await second).toBe(1)
    expect(captionPhoto).toHaveBeenCalledTimes(1)
  })
})
