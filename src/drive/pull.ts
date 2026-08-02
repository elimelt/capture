/**
 * Pull engine (SPEC §8.5): the read half of bidirectional sync. Lists the
 * stream's log/ partitions on Drive, discovers event records the local
 * replica lacks (by id — filenames carry seq_ts_id, so discovery needs no
 * file reads), downloads each missing record plus every referenced attachment
 * blob (eager: full offline availability), and imports them atomically.
 *
 * Safe against every push/pull race the append-only contract allows:
 * - Records commit last on push (§5.2), so any record we see has its
 *   attachments already uploaded; a still-missing attachment is tolerated
 *   and picked up on the next pull.
 * - Identity is the event id; a seq collision from another device is fine
 *   (the fold orders by seq → loggedAt → id) and the import bumps the local
 *   seq counter past everything pulled so our next append doesn't pile on.
 * - Re-pulling is idempotent: known ids are skipped, blob writes overwrite
 *   with identical bytes.
 * - Foreign files in the tree (user drops, other tools) are ignored: only
 *   names matching the record pattern with a parseable seq partition ever
 *   get read.
 */
import { parseEvent } from '../contract/serialize'
import { idOfRecordName } from '../contract/filenames'
import type { Attachment, LogEvent } from '../contract/types'
import { getBlob, importEvents, listEvents } from '../store/events'
import { DriveError, FOLDER_MIME, listChildren, readFileBlob, readFileText } from './client'
import { ensureTree } from './bootstrap'
import { getTree, saveTree } from './tree'

export type PullOutcome = 'idle' | 'pulled' | 'reconnect' | 'retry-later' | 'error'

export interface PullResult {
  outcome: PullOutcome
  /** Events imported into the local replica. */
  pulled: number
  /** Present when outcome is 'error'. */
  error?: string
}

/** "YYYY-MM-DD" — the only folder names the app creates under log/ (§5.1). */
const PARTITION_RE = /^\d{4}-\d{2}-\d{2}$/

function attachmentsOf(event: LogEvent): Attachment[] {
  if (event.type === 'capture') return event.attachments
  if (event.type === 'amend') return event.attachments ?? []
  return []
}

/**
 * Pull one stream's remote log into the local replica. Returns how many
 * events were imported. Classifies failures like the drainer: 401/403 →
 * reconnect, 429/5xx → retry-later, anything else → error. A mid-pull
 * failure loses nothing: everything imported so far is already committed,
 * and the next pull resumes from the (now smaller) missing set.
 */
export async function pullStream(token: string, stream: string): Promise<PullResult> {
  let pulled = 0
  try {
    const tree = (await getTree()) ?? (await ensureTree(token, [stream]))
    const st = tree.streams[stream] ?? (await ensureTree(token, [stream])).streams[stream]

    const known = new Set((await listEvents(stream)).map((e) => e.id))
    const partitions = (await listChildren(token, st.logId)).filter(
      (c) => c.mimeType === FOLDER_MIME && PARTITION_RE.test(c.name),
    )

    for (const partition of partitions) {
      // Keep the push path's partition cache warm as a side benefit.
      if (st.partitions[partition.name] !== partition.id) {
        st.partitions[partition.name] = partition.id
        await saveTree(tree)
      }

      const children = await listChildren(token, partition.id)
      const byName = new Map(children.map((c) => [c.name, c]))
      const missing = children.filter((c) => {
        const id = idOfRecordName(c.name)
        return id !== null && !known.has(id)
      })
      if (missing.length === 0) continue

      const events: LogEvent[] = []
      const blobs = new Map<string, Blob>()
      for (const record of missing) {
        const event = parseEvent(await readFileText(token, record.id))
        if (event.stream !== stream) continue
        for (const att of attachmentsOf(event)) {
          const child = byName.get(att.file)
          // Missing on Drive (pruned or push race) or already local: skip.
          if (!child || (await getBlob(att.file))) continue
          blobs.set(att.file, await readFileBlob(token, child.id))
        }
        events.push(event)
        known.add(event.id)
      }

      await importEvents(stream, events, blobs)
      pulled += events.length
    }

    return { outcome: pulled > 0 ? 'pulled' : 'idle', pulled }
  } catch (err) {
    // Partitions already imported stay imported; only the count reflects that.
    if (err instanceof DriveError && err.isAuth) return { outcome: 'reconnect', pulled }
    if (err instanceof DriveError && err.isRetryable) return { outcome: 'retry-later', pulled }
    const message = err instanceof Error ? err.message : String(err)
    return { outcome: 'error', pulled, error: message }
  }
}
