import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AmendEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { useFreshIndexedDb } from '../testing/freshDb'

useFreshIndexedDb()

const { captionPhoto } = vi.hoisted(() => ({
  captionPhoto: vi.fn<(blob: Blob, onPartial?: (text: string) => void) => Promise<string>>(),
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
//
// Enrichment is opt-in and off by default (issue #89); these tests exercise
// the drain's per-file behavior, so setup() opts in unless a test explicitly
// asserts the off-by-default gate itself.
async function setup(options: { enrichmentEnabled?: boolean } = {}) {
  const events = await import('../store/events')
  const db = await import('../store/db')
  const livetext = await import('../store/livetext')
  const settings = await import('../store/settings')
  const runner = await import('./runner')
  await settings.saveSettings({
    ...settings.APP_SETTINGS_DEFAULTS,
    enrichmentEnabled: options.enrichmentEnabled ?? true,
  })
  return { ...events, ...db, ...settings, ...runner, liveCaptions: livetext.liveCaptions }
}

async function appendPhotoCapture(s: Awaited<ReturnType<typeof setup>>) {
  return s.appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [photoAttachment()] })
}

function amendsOf(events: readonly { type: string }[]): AmendEvent[] {
  return events.filter((e): e is AmendEvent => e.type === 'amend')
}

/** A caption amend as another device would have pushed it to Drive. */
function remoteCaptionAmend(targetId: string, photoFile: string): AmendEvent {
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
        derivedFrom: photoFile,
      },
    ],
  }
}

beforeEach(() => {
  captionPhoto.mockReset()
  vi.stubGlobal('navigator', { onLine: true })
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

  it('skips an empty caption permanently via a meta marker with a reason', async () => {
    const s = await setup()
    captionPhoto.mockResolvedValue('')
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainCaptions('timelog')).toBe(0)
    const db = await s.getDb()
    expect(await db.get('meta', `caption:skip:${file}`)).toMatchObject({ reason: 'empty-result' })
    expect(await s.listSkippedCaptions()).toEqual([
      { file, reason: 'empty-result', at: expect.any(String) },
    ])

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).toHaveBeenCalledTimes(1)
  })

  it('defers (does not skip) photos whose blob is missing, retrying once one appears', async () => {
    // #55: a source pruned locally after upload is indistinguishable from
    // one never downloaded — both must be retried once a blob is local.
    const s = await setup()
    captionPhoto.mockResolvedValue('A latte.')
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file
    const db = await s.getDb()
    const blob = await db.get('blobs', file)
    await db.delete('blobs', file)

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).not.toHaveBeenCalled()
    expect(await db.get('meta', `caption:skip:${file}`)).toBeUndefined()
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])

    await db.put('blobs', blob!)
    expect(await s.drainCaptions('timelog')).toBe(1)
    expect(captionPhoto).toHaveBeenCalledTimes(1)
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

  it('does not re-caption a photo whose caption arrived via a pulled amend', async () => {
    // The pull-race guard (issue #51): the vision runner previously lacked
    // this check that the transcribe runner already had, which could
    // produce duplicate captions on a photo synced from two devices.
    const s = await setup()
    captionPhoto.mockResolvedValue('A latte on a wooden table.')
    const cap = await appendPhotoCapture(s)
    await s.importEvents(
      'timelog',
      [remoteCaptionAmend(cap.id, cap.attachments[0].file)],
      new Map<string, Blob>(),
    )

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).not.toHaveBeenCalled()
    expect(amendsOf(await s.listEvents('timelog'))).toHaveLength(1)
  })

  it('drops an in-flight caption when a pull imports a remote one mid-drain', async () => {
    const s = await setup()
    let resolveText!: (text: string) => void
    captionPhoto.mockImplementation(
      () =>
        new Promise((res) => {
          resolveText = res
        }),
    )
    const cap = await appendPhotoCapture(s)

    const drain = s.drainCaptions('timelog')
    await vi.waitFor(() => expect(captionPhoto).toHaveBeenCalledTimes(1))
    await s.importEvents(
      'timelog',
      [remoteCaptionAmend(cap.id, cap.attachments[0].file)],
      new Map<string, Blob>(),
    )
    resolveText('A latte on a wooden table.')

    expect(await drain).toBe(0)
    expect(amendsOf(await s.listEvents('timelog'))).toHaveLength(1)
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

  it('publishes streamed partials to the live store; only the final text is persisted', async () => {
    const s = await setup()
    let emitPartial!: (text: string) => void
    let resolveText!: (text: string) => void
    captionPhoto.mockImplementation(
      (_blob, onPartial) =>
        new Promise((res) => {
          emitPartial = onPartial!
          resolveText = res
        }),
    )
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file

    const drain = s.drainCaptions('timelog')
    await vi.waitFor(() => expect(captionPhoto).toHaveBeenCalledTimes(1))
    emitPartial('A latte')
    expect(s.liveCaptions.snapshot().get(file)).toBe('A latte')
    emitPartial('A latte on a wooden table.')
    resolveText('A latte on a wooden table.')

    expect(await drain).toBe(1)
    // The final live text lingers (until the next drain sweeps it) so the
    // card never flashes empty before the store refresh.
    expect(s.liveCaptions.snapshot().get(file)).toBe('A latte on a wooden table.')
    const amends = amendsOf(await s.listEvents('timelog'))
    expect(amends).toHaveLength(1)
    expect(await (await s.getBlob(amends[0].attachments![0].file))!.text()).toBe(
      'A latte on a wooden table.',
    )
  })

  it('sweeps stale live text on the next drain once the caption is persisted', async () => {
    const s = await setup()
    captionPhoto.mockImplementation(async (_blob, onPartial) => {
      onPartial?.('A latte.')
      return 'A latte.'
    })
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainCaptions('timelog')).toBe(1)
    expect(s.liveCaptions.snapshot().get(file)).toBe('A latte.')
    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(s.liveCaptions.snapshot().has(file)).toBe(false)
  })

  it('clears live partial text when captioning fails mid-stream and persists nothing', async () => {
    const s = await setup()
    captionPhoto.mockImplementation(async (_blob, onPartial) => {
      onPartial?.('A lat')
      throw new Error('connection lost')
    })
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(s.liveCaptions.snapshot().has(file)).toBe(false)
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('clears live text when a pull imports a remote caption mid-drain', async () => {
    const s = await setup()
    let emitPartial!: (text: string) => void
    let resolveText!: (text: string) => void
    captionPhoto.mockImplementation(
      (_blob, onPartial) =>
        new Promise((res) => {
          emitPartial = onPartial!
          resolveText = res
        }),
    )
    const cap = await appendPhotoCapture(s)
    const file = cap.attachments[0].file

    const drain = s.drainCaptions('timelog')
    await vi.waitFor(() => expect(captionPhoto).toHaveBeenCalledTimes(1))
    emitPartial('local partial')
    await s.importEvents('timelog', [remoteCaptionAmend(cap.id, file)], new Map<string, Blob>())
    resolveText('local final')

    expect(await drain).toBe(0)
    expect(s.liveCaptions.snapshot().has(file)).toBe(false)
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

// Owner policy (issue #89): automatic captioning is fully opt-in. These pin
// the pure drain-gate predicate plus the runner-level early-return that makes
// it impossible to reach llm.elimelt.com while enrichment is off.
describe('shouldDrain (pure gate predicate)', () => {
  it('requires both online and enrichment opted in', async () => {
    const { shouldDrain } = await setup()
    expect(shouldDrain(true, true)).toBe(true)
    expect(shouldDrain(true, false)).toBe(false)
    expect(shouldDrain(false, true)).toBe(false)
    expect(shouldDrain(false, false)).toBe(false)
  })
})

describe('drainCaptions — enrichment opt-in gate', () => {
  it('never calls the API while enrichment is disabled (the default)', async () => {
    const s = await setup({ enrichmentEnabled: false })
    captionPhoto.mockResolvedValue('A latte on a wooden table.')
    await appendPhotoCapture(s)

    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).not.toHaveBeenCalled()
    expect(amendsOf(await s.listEvents('timelog'))).toEqual([])
  })

  it('backfills photos captured while enrichment was off once it is turned on', async () => {
    const s = await setup({ enrichmentEnabled: false })
    captionPhoto.mockResolvedValue('A latte on a wooden table.')
    const cap = await appendPhotoCapture(s)

    // Off: nothing is sent, and the pending photo just accumulates in the log.
    expect(await s.drainCaptions('timelog')).toBe(0)
    expect(captionPhoto).not.toHaveBeenCalled()

    // On: the same drain logic picks up the backlog with no special-casing —
    // pendingCaptions() already scans the full event history.
    await s.saveSettings({ ...s.APP_SETTINGS_DEFAULTS, enrichmentEnabled: true })
    expect(await s.drainCaptions('timelog')).toBe(1)
    expect(captionPhoto).toHaveBeenCalledTimes(1)

    const [amend] = amendsOf(await s.listEvents('timelog'))
    expect(amend.targets).toEqual([cap.id])
    expect(amend.attachments![0].derivedFrom).toBe(cap.attachments[0].file)
  })

  it('runner-level gate holds even if a caller forgets to check the setting first', async () => {
    // Simulates a future caller that doesn't gate at the call site: the
    // runner's own early-return is the one that must hold (defense in depth).
    const s = await setup({ enrichmentEnabled: false })
    captionPhoto.mockResolvedValue('A latte on a wooden table.')
    await appendPhotoCapture(s)

    await s.drainCaptions('timelog')
    await s.drainCaptions('timelog') // a second, unconditional call from a hypothetical caller
    expect(captionPhoto).not.toHaveBeenCalled()
  })
})
