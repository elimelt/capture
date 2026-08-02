/**
 * One-shot migration: legacy `chats` object-store rows → events in the
 * `assistant-chats` system stream (SPEC §3.1, §10.1). Each conversation
 * becomes one `capture` event (its id is the chat id from here on) plus one
 * `amend` per message carrying a `capture.chatmessage.v1` JSON attachment —
 * the exact shape `assistant/chatSync.ts` appends for new messages, so the
 * migrated history syncs to Drive through the ordinary queue.
 *
 * Guarded by "has it been applied", never by the IndexedDB version number:
 * parallel schema branches claimed neighboring versions (calendar overlays
 * v8, settings v9) and landed in arbitrary order, so a device can reach any
 * version with or without this migration having run. The guard is a meta
 * marker plus a stream-state check; the function is idempotent and safe to
 * call on every version change.
 *
 * Message order is preserved by strictly increasing `seq` across all
 * synthesized events (the fold orders by seq first), not by the synthesized
 * `loggedAt` values — every message of one chat shares the row's `updatedAt`.
 *
 * The legacy `chats` store and its rows are deliberately left in place as a
 * rollback artifact; a later release drops them once the stream path is
 * proven.
 */
import type { IDBPTransaction, StoreNames } from 'idb'
import { attachmentFileName, eventBaseName } from '../contract/filenames'
import { newEventId } from '../contract/ids'
import { deviceTz, toLocalIso } from '../contract/time'
import { EVENT_SCHEMA, type AmendEvent, type CaptureEvent } from '../contract/types'
import type { StoredChatRow, TimeboxDB } from './db'

/**
 * Stream id + payload schema. Owned by `assistant/chatSync.ts`; duplicated
 * here because store/ must not import from assistant/ (the layering rule).
 * The pairing is pinned by a test in `assistant/chatSync.test.ts`.
 */
export const MIGRATED_CHATS_STREAM = 'assistant-chats'
export const MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA = 'capture.chatmessage.v1'

/** Meta key marking the migration as applied on this device. */
export const CHATS_MIGRATION_MARKER = 'migrated:chats:v1'

const SEQ_KEY = `nextSeq:${MIGRATED_CHATS_STREAM}`

/**
 * Works inside the versionchange upgrade transaction and, for tests and
 * recovery paths, inside an ordinary readwrite transaction spanning the same
 * stores.
 */
type MigrationTx<M extends 'versionchange' | 'readwrite'> = IDBPTransaction<
  TimeboxDB,
  StoreNames<TimeboxDB>[],
  M
>

/** Legacy timestamps are UTC `toISOString()`; contract times carry the local offset. */
function toContractIso(legacyIso: string): string {
  const parsed = new Date(legacyIso)
  return Number.isNaN(parsed.getTime()) ? toLocalIso(new Date()) : toLocalIso(parsed)
}

export async function migrateChatsV1<M extends 'versionchange' | 'readwrite'>(
  tx: MigrationTx<M>,
): Promise<void> {
  const meta = tx.objectStore('meta')
  if ((await meta.get(CHATS_MIGRATION_MARKER)) !== undefined) return
  // Belt and suspenders: events in the stream without the marker (e.g. the
  // marker was lost) still mean the chat history is already event-sourced —
  // re-synthesizing would duplicate every conversation.
  const existing = await tx.objectStore('events').index('by-stream').count(MIGRATED_CHATS_STREAM)
  if (existing > 0) {
    await meta.put(true, CHATS_MIGRATION_MARKER)
    return
  }

  const rows = (await tx.objectStore('chats').getAll()) as StoredChatRow[]
  if (rows.length === 0) {
    await meta.put(true, CHATS_MIGRATION_MARKER)
    return
  }
  // Deterministic replay order: oldest conversation first, id as tiebreak.
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  const events = tx.objectStore('events')
  const blobs = tx.objectStore('blobs')
  const sync = tx.objectStore('sync')
  const tz = deviceTz()
  let nextSeq = ((await meta.get(SEQ_KEY)) as number | undefined) ?? 1

  for (const row of rows) {
    const createdAt = toContractIso(row.createdAt)
    const updatedAt = toContractIso(row.updatedAt)
    const chat: CaptureEvent = {
      schema: EVENT_SCHEMA,
      type: 'capture',
      id: newEventId(),
      seq: nextSeq++,
      stream: MIGRATED_CHATS_STREAM,
      loggedAt: createdAt,
      deviceTz: tz,
      capturedAt: createdAt,
      attachments: [],
    }
    await events.put(chat)
    await sync.put({
      id: chat.id,
      stream: MIGRATED_CHATS_STREAM,
      seq: chat.seq,
      status: 'queued',
      attempts: 0,
      phase: 'record-pending',
    })
    for (const message of row.messages) {
      const amend: AmendEvent = {
        schema: EVENT_SCHEMA,
        type: 'amend',
        id: newEventId(),
        seq: nextSeq++,
        stream: MIGRATED_CHATS_STREAM,
        loggedAt: updatedAt,
        deviceTz: tz,
        targets: [chat.id],
        attachments: [],
      }
      const file = attachmentFileName(eventBaseName(amend), 'text', 'application/json')
      amend.attachments = [{ kind: 'text', file, mimeType: 'application/json' }]
      const payload = { schema: MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA, message }
      await events.put(amend)
      await blobs.put({
        file,
        blob: new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      })
      await sync.put({
        id: amend.id,
        stream: MIGRATED_CHATS_STREAM,
        seq: amend.seq,
        status: 'queued',
        attempts: 0,
        phase: 'attachments-pending',
      })
    }
  }

  await meta.put(nextSeq, SEQ_KEY)
  await meta.put(true, CHATS_MIGRATION_MARKER)
}
