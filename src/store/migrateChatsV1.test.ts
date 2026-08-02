import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseEvent, serializeEvent } from '../contract/serialize'
import { toLocalIso } from '../contract/time'
import type { AmendEvent, CaptureEvent, LogEvent } from '../contract/types'
import { getDb, resetDbCache, type StoredChatRow, type SyncStatusRow } from './db'
import { listEvents } from './events'
import {
  CHATS_MIGRATION_MARKER,
  MIGRATED_CHATS_STREAM,
  MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA,
  migrateChatsV1,
} from './migrateChatsV1'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

// Message payloads are opaque to store/ (assistant/ owns the typing), so the
// fixtures are plain objects shaped like UIMessages.
const msg = (id: string, role: string, text: string) => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

const chatRow = (
  id: string,
  createdAt: string,
  updatedAt: string,
  messages: unknown[],
): StoredChatRow => ({ id, createdAt, updatedAt, messages })

/** Seed a pre-migration DB (v5 schema) with legacy chats rows. */
async function seedLegacyDb(rows: StoredChatRow[], version = 5): Promise<void> {
  const db = await openDB('timebox', version, {
    upgrade(db) {
      const events = db.createObjectStore('events', { keyPath: 'id' })
      events.createIndex('by-stream', 'stream')
      db.createObjectStore('blobs', { keyPath: 'file' })
      db.createObjectStore('sync', { keyPath: 'id' })
      db.createObjectStore('places', { keyPath: 'id' })
      db.createObjectStore('meta')
      db.createObjectStore('chats', { keyPath: 'id' })
      db.createObjectStore('geocache', { keyPath: 'key' })
    },
  })
  for (const row of rows) await db.put('chats', row)
  db.close()
}

async function readPayload(file: string): Promise<{ schema: string; message: unknown }> {
  const db = await getDb()
  const stored = await db.get('blobs', file)
  return JSON.parse(await stored!.blob.text()) as { schema: string; message: unknown }
}

const twoChats = () => [
  chatRow('legacy-b', '2026-02-01T00:00:00.000Z', '2026-02-01T00:10:00.000Z', [
    msg('u1', 'user', 'newer chat'),
  ]),
  chatRow('legacy-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z', [
    msg('u1', 'user', 'What did I do today?'),
    msg('a1', 'assistant', 'Three entries.'),
    msg('u2', 'user', 'Thanks'),
  ]),
]

describe('migrateChatsV1', () => {
  it('converts legacy rows to capture + ordered amends preserving message order', async () => {
    await seedLegacyDb(twoChats())
    const events = await listEvents(MIGRATED_CHATS_STREAM) // opens the DB → migrates

    // 2 captures + 4 messages = 6 events, seq strictly increasing from 1.
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    const captures = events.filter((e): e is CaptureEvent => e.type === 'capture')
    const amends = events.filter((e): e is AmendEvent => e.type === 'amend')
    expect(captures).toHaveLength(2)
    expect(amends).toHaveLength(4)

    // Oldest conversation replays first; its capture carries no attachments
    // and its createdAt (as a local-offset contract timestamp).
    const [chatA, chatB] = captures
    expect(chatA.attachments).toEqual([])
    expect(chatA.loggedAt).toBe(toLocalIso(new Date('2026-01-01T00:00:00.000Z')))
    expect(chatA.capturedAt).toBe(chatA.loggedAt)
    expect(chatB.loggedAt).toBe(toLocalIso(new Date('2026-02-01T00:00:00.000Z')))

    // Every message is one amend targeting its chat's capture id, with one
    // application/json text attachment wrapping the message in the envelope —
    // seq order (not the synthesized loggedAt, shared per chat) is the order.
    const aAmends = amends.filter((e) => e.targets[0] === chatA.id)
    expect(aAmends.map((e) => e.seq)).toEqual([2, 3, 4])
    for (const amend of aAmends) {
      expect(amend.attachments).toHaveLength(1)
      expect(amend.attachments![0].mimeType).toBe('application/json')
      expect(amend.loggedAt).toBe(toLocalIso(new Date('2026-01-01T00:10:00.000Z')))
    }
    const texts = await Promise.all(
      aAmends.map(async (e) => {
        const payload = await readPayload(e.attachments![0].file)
        expect(payload.schema).toBe(MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA)
        return (payload.message as { parts: { text: string }[] }).parts[0].text
      }),
    )
    expect(texts).toEqual(['What did I do today?', 'Three entries.', 'Thanks'])
    expect(amends.find((e) => e.targets[0] === chatB.id)!.seq).toBe(6)
  })

  it('queues every synthesized event for upload and advances the seq counter', async () => {
    await seedLegacyDb(twoChats())
    const events = await listEvents(MIGRATED_CHATS_STREAM)
    const db = await getDb()
    for (const e of events) {
      const row = (await db.get('sync', e.id)) as SyncStatusRow
      expect(row).toMatchObject({
        stream: MIGRATED_CHATS_STREAM,
        seq: e.seq,
        status: 'queued',
        attempts: 0,
        phase: e.type === 'capture' ? 'record-pending' : 'attachments-pending',
      })
    }
    expect(await db.get('meta', `nextSeq:${MIGRATED_CHATS_STREAM}`)).toBe(7)
    expect(await db.get('meta', CHATS_MIGRATION_MARKER)).toBe(true)
  })

  it('leaves the legacy chats rows in place as a rollback artifact', async () => {
    await seedLegacyDb(twoChats())
    await listEvents(MIGRATED_CHATS_STREAM)
    const db = await getDb()
    expect(await db.count('chats')).toBe(2)
    expect(((await db.get('chats', 'legacy-a')) as StoredChatRow).messages).toHaveLength(3)
  })

  it('produces events that round-trip the wire contract', async () => {
    await seedLegacyDb(twoChats())
    for (const e of await listEvents(MIGRATED_CHATS_STREAM)) {
      expect(parseEvent(serializeEvent(e))).toEqual(e)
    }
  })

  it('is idempotent across two runs', async () => {
    await seedLegacyDb(twoChats())
    const first = await listEvents(MIGRATED_CHATS_STREAM)
    expect(first).toHaveLength(6)

    // Second run (e.g. a later version bump re-enters the upgrade callback).
    const db = await getDb()
    const tx = db.transaction(['events', 'blobs', 'sync', 'meta', 'chats'], 'readwrite')
    await migrateChatsV1(tx)
    await tx.done
    expect(await listEvents(MIGRATED_CHATS_STREAM)).toEqual(first)
  })

  it('is a no-op on a fresh install, and marks itself applied', async () => {
    const db = await getDb()
    expect(await listEvents(MIGRATED_CHATS_STREAM)).toEqual([])
    expect(await db.get('sync', 'anything')).toBeUndefined()
    expect(await db.get('meta', CHATS_MIGRATION_MARKER)).toBe(true)
  })

  it('guards by applied-state, not the version number', async () => {
    // A parallel schema branch (calendar overlays v8 / settings v9 / waveform
    // cache v11 / sync by-stream index v12) can carry a device to the
    // current version without this migration ever running. Simulate: the DB
    // is already at the code's version (keep this in sync with db.ts's
    // current version) with legacy rows un-migrated — no upgrade fires on
    // open.
    await seedLegacyDb(
      [chatRow('legacy-a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z', [
        msg('u1', 'user', 'hello'),
      ])],
      12,
    )
    const db = await getDb()
    expect(await db.get('meta', CHATS_MIGRATION_MARKER)).toBeUndefined()
    expect(await listEvents(MIGRATED_CHATS_STREAM)).toEqual([])

    // The applied-state guard lets the same block run at ANY later version
    // bump and still migrate exactly once.
    for (let run = 0; run < 2; run++) {
      const tx = db.transaction(['events', 'blobs', 'sync', 'meta', 'chats'], 'readwrite')
      await migrateChatsV1(tx)
      await tx.done
    }
    expect(await listEvents(MIGRATED_CHATS_STREAM)).toHaveLength(2)
    expect(await db.get('meta', CHATS_MIGRATION_MARKER)).toBe(true)
  })

  it('skips (and marks applied) when the stream already has events', async () => {
    // Marker lost but the stream is already event-sourced (e.g. restored from
    // a synced replica): re-synthesizing would duplicate every conversation.
    await seedLegacyDb(twoChats())
    const preExisting: LogEvent = {
      schema: 'capture.event.v1',
      type: 'capture',
      id: 'remote1',
      seq: 1,
      stream: MIGRATED_CHATS_STREAM,
      loggedAt: '2026-01-01T00:00:00+00:00',
      deviceTz: 'UTC',
      capturedAt: '2026-01-01T00:00:00+00:00',
      attachments: [],
    }
    const seeded = await openDB('timebox', 5)
    await seeded.put('events', preExisting)
    seeded.close()
    resetDbCache()

    expect(await listEvents(MIGRATED_CHATS_STREAM)).toEqual([preExisting])
    expect(await (await getDb()).get('meta', CHATS_MIGRATION_MARKER)).toBe(true)
  })
})
