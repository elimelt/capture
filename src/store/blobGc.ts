/**
 * Blob garbage collection (issue #53). The only two blob-deletion paths
 * before this module existed were `wipeAll()` and post-upload audio pruning
 * (`drive/queue.ts#pruneAudio`, gated on `keepAudioLocally`) — nothing ever
 * reclaimed a blob the fold had hidden. A `revoke` or an
 * `AmendPatch.removeAttachments` drops an attachment from the *folded* view
 * on purpose (SPEC §3.3), but its blob stayed in the `blobs` store forever:
 * unbounded local storage growth with no remedy short of "wipe all data".
 *
 * `planBlobGc` is the pure core: given one stream's full event history and
 * its sync rows, which attachment files are safe to delete right now. A
 * file is deletable iff both hold:
 *
 *   (a) it is hidden by the fold — absent from every live entry's
 *       attachments (dropped via `revoke` or `removeAttachments`), and
 *   (b) the event that attached it is already `uploaded` — so deleting it
 *       locally never loses the only copy. A file whose owning event is
 *       still `queued`/`error` is left alone even if the fold already hides
 *       it; the next sweep (after that event's next successful upload)
 *       picks it up.
 *
 * Deliberately attachment-kind-agnostic: audio, photo, and text blobs are
 * reclaimed by the same sweep once they meet (a) and (b) — unlike
 * `pruneAudio`, which only ever prunes *visible* entries' audio per the
 * `keepAudioLocally` setting. The two mechanisms are complementary and both
 * still needed: `pruneAudio` trims storage for entries the user keeps;
 * `planBlobGc` reclaims storage for entries/attachments the user removed.
 */
import { fold } from '../contract/fold'
import type { Attachment, LogEvent } from '../contract/types'
import type { SyncStatusRow } from './db'
import { deleteBlob, getSyncStatuses, listEvents } from './events'

function attachmentsOf(event: LogEvent): Attachment[] {
  if (event.type === 'capture') return event.attachments
  if (event.type === 'amend') return event.attachments ?? []
  return []
}

/**
 * Pure: attachment filenames safe to delete from one stream's `blobs` store
 * right now. `events` should be the stream's full history (as from
 * `listEvents`); `syncStatuses` its sync rows keyed by event id (as from
 * `getSyncStatuses`) — a missing row is treated as "not yet uploaded"
 * (never deletable), the safe default.
 */
export function planBlobGc(
  events: readonly LogEvent[],
  syncStatuses: ReadonlyMap<string, SyncStatusRow>,
): string[] {
  const live = new Set<string>()
  for (const entry of fold(events)) {
    for (const att of entry.attachments) live.add(att.file)
  }

  const deletable = new Set<string>()
  for (const event of events) {
    if (event.type === 'revoke') continue
    if (syncStatuses.get(event.id)?.status !== 'uploaded') continue
    for (const att of attachmentsOf(event)) {
      if (!live.has(att.file)) deletable.add(att.file)
    }
  }
  return [...deletable]
}

/**
 * Run one GC sweep over a stream: read its events + sync rows, compute the
 * deletable set, and delete each blob. Safe to call at any time (e.g. after
 * a sync cycle, or from the Settings storage panel) — it never touches
 * events, only the `blobs` store, and only ever removes files `planBlobGc`
 * already proved are both fold-hidden and durably uploaded. Returns the
 * filenames actually reclaimed.
 */
export async function reclaimStreamBlobs(stream: string): Promise<string[]> {
  const [events, syncStatuses] = await Promise.all([listEvents(stream), getSyncStatuses(stream)])
  const deletable = planBlobGc(events, syncStatuses)
  for (const file of deletable) await deleteBlob(file)
  return deletable
}
