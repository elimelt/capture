/**
 * Background transcription drain. Capture stays instant and offline-first;
 * this runs after the fact, posting each untranscribed audio attachment to
 * the transcription service and appending the result as an amend event with
 * a derivedFrom text attachment (append-only — the transcript flows to
 * Drive with everything else once M2 lands).
 *
 * Failure handling: transient errors back off in memory (reset on app
 * relaunch); permanently untranscribable clips (empty transcript, missing
 * blob) get a local skip marker in the meta store so they are never retried.
 */
import { getDb } from '../store/db'
import { appendAmend, getBlob, listEvents } from '../store/events'
import { transcribeAudio } from './api'
import { pendingTranscriptions } from './plan'

const MAX_ATTEMPTS_PER_SESSION = 5
const BACKOFF_BASE_MS = 15_000

const SKIP_KEY = (file: string) => `transcribe:skip:${file}`

/** In-memory retry state per audio file: exponential backoff within a session. */
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
 * Transcribes every eligible pending audio attachment; returns how many
 * amend events were appended (caller refreshes the store if > 0).
 * Re-entrant calls coalesce onto the in-flight drain.
 */
export function drainTranscriptions(streamId: string): Promise<number> {
  draining ??= drain(streamId).finally(() => {
    draining = null
  })
  return draining
}

async function drain(streamId: string): Promise<number> {
  if (!navigator.onLine) return 0
  const events = await listEvents(streamId)
  let appended = 0
  for (const { entryId, stream, audio } of pendingTranscriptions(events)) {
    if (!eligible(audio.file) || (await isSkipped(audio.file))) continue
    try {
      const blob = await getBlob(audio.file)
      if (!blob) {
        // Audio was never kept locally (keepAudioLocally off) — nothing to
        // transcribe from, now or later.
        await markSkipped(audio.file)
        continue
      }
      const text = await transcribeAudio(blob, audio.mimeType)
      if (text === '') {
        await markSkipped(audio.file)
        continue
      }
      // A sync pull may have imported another device's transcript while the
      // API call was in flight; re-plan against the current log and drop the
      // result if this audio no longer needs one (at-most-once globally).
      const stillPending = pendingTranscriptions(await listEvents(streamId))
      if (!stillPending.some((p) => p.audio.file === audio.file)) {
        retryState.delete(audio.file)
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
            derivedFrom: audio.file,
          },
        ],
      })
      retryState.delete(audio.file)
      appended++
    } catch {
      recordFailure(audio.file)
    }
  }
  return appended
}
