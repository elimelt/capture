/**
 * Background captioning drain, the photo twin of transcribe/runner.ts.
 * Capture stays instant and offline-first; this runs after the fact, posting
 * each uncaptioned photo to the vision model and appending the result as an
 * amend event with a derivedFrom text attachment (append-only — the caption
 * flows to Drive with everything else).
 *
 * While a caption streams, partial text is published to the transient
 * `liveCaptions` store (keyed by source photo file) for the entry card;
 * only the final, complete caption is ever appended to the log.
 *
 * Failure handling: transient errors back off in memory (reset on app
 * relaunch); permanently uncaptionable photos (empty caption, missing blob)
 * get a local skip marker in the meta store so they are never retried.
 *
 * Enrichment is fully opt-in (owner policy, issue #89): this runner
 * early-returns unless `AppSettings.enrichmentEnabled` is on, independent of
 * whatever gate the caller (src/App.tsx) applies, so a future caller can't
 * accidentally send a photo to llm.elimelt.com by skipping the check.
 */
import { getDb } from '../store/db'
import { appendAmend, getBlob, listEvents } from '../store/events'
import { liveCaptions } from '../store/livetext'
import { getSettings } from '../store/settings'
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
 * Pure drain-gate predicate: the drain may run only while online *and* the
 * user has opted into automatic enrichment. Exported so the gate is testable
 * without touching IndexedDB or the network.
 */
export function shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean {
  return online && enrichmentEnabled
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
  // Offline check first and synchronous, so an offline drain never touches
  // IndexedDB at all — matches the "returns 0 immediately" contract.
  if (!navigator.onLine) return 0
  const { enrichmentEnabled } = await getSettings()
  if (!shouldDrain(navigator.onLine, enrichmentEnabled)) return 0
  const events = await listEvents(streamId)
  const pending = pendingCaptions(events)
  // Sweep live text from earlier attempts: anything no longer pending has
  // its persisted caption visible by now, so the transient copy is stale.
  liveCaptions.sweep(new Set(pending.map((p) => p.photo.file)))
  let appended = 0
  for (const { entryId, stream, photo } of pending) {
    if (!eligible(photo.file) || (await isSkipped(photo.file))) continue
    try {
      const blob = await getBlob(photo.file)
      if (!blob) {
        // Photo was never kept locally — nothing to caption from, now or later.
        await markSkipped(photo.file)
        continue
      }
      // Partial text streams into the live store for the entry card; it is
      // display-only and never persisted. Only the resolved final text
      // reaches the log below — a mid-stream failure lands in the catch,
      // which clears the partial and backs off exactly as before.
      const text = await captionPhoto(blob, (partial) => liveCaptions.set(photo.file, partial))
      if (text === '') {
        liveCaptions.clear(photo.file)
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
      // The final text stays in the live store until the next drain sweeps
      // it, so the card never flashes empty between the amend landing and
      // the store refresh that reveals the persisted attachment.
      retryState.delete(photo.file)
      appended++
    } catch {
      liveCaptions.clear(photo.file)
      recordFailure(photo.file)
    }
  }
  return appended
}
