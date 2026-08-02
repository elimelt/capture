/**
 * Background captioning drain, the photo twin of transcribe/runner.ts.
 * Capture stays instant and offline-first; this runs after the fact, posting
 * each uncaptioned photo to the vision model and appending the result as an
 * amend event with a derivedFrom text attachment (append-only — the caption
 * flows to Drive with everything else).
 *
 * Failure handling: transient errors back off in memory (reset on app
 * relaunch); permanently uncaptionable photos (empty caption, missing blob)
 * get a local skip marker in the meta store so they are never retried.
 */
import { getDb } from '../store/db'
import { appendAmend, getBlob, listEvents } from '../store/events'
import { captionPhoto } from './api'
import { pendingCaptions } from './plan'

const MAX_ATTEMPTS_PER_SESSION = 5
const BACKOFF_BASE_MS = 15_000

const SKIP_KEY = (file: string) => `caption:skip:${file}`

/** In-memory retry state per photo file: exponential backoff within a session. */
const retryState = new Map<string, { attempts: number; nextAt: number }>()

let draining: Promise<number> | null = null

async function isSkipped(file: string): Promise<boolean> {
  const db = await getDb()
  return (await db.get('meta', SKIP_KEY(file))) === true
}

async function markSkipped(file: string): Promise<void> {
  const db = await getDb()
  await db.put('meta', true, SKIP_KEY(file))
}

function eligible(file: string): boolean {
  const s = retryState.get(file)
  if (!s) return true
  return s.attempts < MAX_ATTEMPTS_PER_SESSION && Date.now() >= s.nextAt
}

function recordFailure(file: string): void {
  const attempts = (retryState.get(file)?.attempts ?? 0) + 1
  retryState.set(file, {
    attempts,
    nextAt: Date.now() + BACKOFF_BASE_MS * 2 ** (attempts - 1),
  })
}

/**
 * Captions every eligible pending photo attachment; returns how many amend
 * events were appended (caller refreshes the store if > 0). Re-entrant calls
 * coalesce onto the in-flight drain.
 */
export function drainCaptions(streamId: string): Promise<number> {
  draining ??= drain(streamId).finally(() => {
    draining = null
  })
  return draining
}

async function drain(streamId: string): Promise<number> {
  if (!navigator.onLine) return 0
  const events = await listEvents(streamId)
  let appended = 0
  for (const { entryId, stream, photo } of pendingCaptions(events)) {
    if (!eligible(photo.file) || (await isSkipped(photo.file))) continue
    try {
      const blob = await getBlob(photo.file)
      if (!blob) {
        // Photo was never kept locally — nothing to caption from, now or later.
        await markSkipped(photo.file)
        continue
      }
      const text = await captionPhoto(blob)
      if (text === '') {
        await markSkipped(photo.file)
        continue
      }
      await appendAmend({
        stream,
        targets: [entryId],
        attachments: [
          {
            kind: 'text',
            blob: new Blob([text], { type: 'text/plain' }),
            mimeType: 'text/plain',
            derivedFrom: photo.file,
          },
        ],
      })
      retryState.delete(photo.file)
      appended++
    } catch {
      recordFailure(photo.file)
    }
  }
  return appended
}
