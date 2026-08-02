import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { attachmentFileName, eventBaseName } from '../contract/filenames'
import { EVENT_SCHEMA, type AmendEvent } from '../contract/types'
import { getDb, resetDbCache } from '../store/db'
import { getBlob, importEvents, listEvents } from '../store/events'
import {
  CHATS_MIGRATION_MARKER,
  MIGRATED_CHATS_STREAM,
  MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA,
} from '../store/migrateChatsV1'
import { SYSTEM_STREAMS, allSyncStreams } from '../streams/registry'
import { listChats } from './history'
import {
  CHATS_STREAM,
  CHAT_MESSAGE_PAYLOAD_SCHEMA,
  appendChatMessage,
  createChat,
  deleteChatStream,
  loadAllChats,
  loadChat,
  loadChatSummaries,
  loadMostRecentChat,
  messagesSince,
} from './chatSync'

// Spy on getBlob so the summaries perf contract is count-assertable; every
// other export stays the real implementation.
vi.mock('../store/events', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../store/events')>()
  return { ...mod, getBlob: vi.fn(mod.getBlob) }
})

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
  // Only Date is faked (fake-indexeddb needs real task scheduling); events
  // minted at different setSystemTime values get distinct loggedAt stamps.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-02T10:00:00'))
  vi.mocked(getBlob).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMsg(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

async function seedChat(messages: UIMessage[]): Promise<string> {
  const id = await createChat()
  for (const m of messages) await appendChatMessage(id, m)
  return id
}

describe('stream registration and schema pins', () => {
  it('assistant-chats is a registered system stream the sync loop covers', () => {
    expect(SYSTEM_STREAMS).toContain(CHATS_STREAM)
    expect(allSyncStreams()).toContain(CHATS_STREAM)
  })

  it('matches the migration constants (store/ cannot import assistant/)', () => {
    expect(MIGRATED_CHATS_STREAM).toBe(CHATS_STREAM)
    expect(MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA).toBe(CHAT_MESSAGE_PAYLOAD_SCHEMA)
  })
})

describe('messagesSince', () => {
  const msgs = [userMsg('u1', 'a'), assistantMsg('a1', 'b'), userMsg('u2', 'c')]

  it('returns only the messages past the persisted count', () => {
    expect(messagesSince(1, msgs).map((m) => m.id)).toEqual(['a1', 'u2'])
    expect(messagesSince(2, msgs).map((m) => m.id)).toEqual(['u2'])
  })

  it('returns everything when nothing is persisted yet', () => {
    expect(messagesSince(0, msgs)).toEqual(msgs)
  })

  it('returns nothing when everything is already persisted', () => {
    expect(messagesSince(3, msgs)).toEqual([])
    expect(messagesSince(5, msgs)).toEqual([])
  })

  it('treats a negative count as zero', () => {
    expect(messagesSince(-2, msgs)).toEqual(msgs)
  })

  it('is empty for no messages', () => {
    expect(messagesSince(0, [])).toEqual([])
  })
})

describe('chat round-trips', () => {
  it('creates a chat as a capture event with no attachments; the event id is the chat id', async () => {
    const id = await createChat()
    const events = await listEvents(CHATS_STREAM)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'capture', id, attachments: [] })
    expect((await loadChat(id))?.messages).toEqual([])
  })

  it('preserves message order across N appends', async () => {
    const messages = [
      userMsg('u1', 'What did I do today?'),
      assistantMsg('a1', 'Three entries.'),
      userMsg('u2', 'And yesterday?'),
      assistantMsg('a2', 'Two entries.'),
      userMsg('u3', 'Thanks'),
    ]
    const id = await seedChat(messages)
    expect((await loadChat(id))?.messages).toEqual(messages)
  })

  it('returns undefined for an unknown chat', async () => {
    expect(await loadChat('nope')).toBeUndefined()
  })

  it('orders loadAllChats by last-touched, most recent first', async () => {
    const first = await seedChat([userMsg('u1', 'older')])
    vi.setSystemTime(new Date('2026-08-02T11:00:00'))
    const second = await seedChat([userMsg('u1', 'newer')])
    expect((await loadAllChats()).map((c) => c.id)).toEqual([second, first])
    // Touching the older chat moves it back to the front.
    vi.setSystemTime(new Date('2026-08-02T12:00:00'))
    await appendChatMessage(first, assistantMsg('a1', 'follow-up'))
    expect((await loadAllChats()).map((c) => c.id)).toEqual([first, second])
    expect((await loadMostRecentChat())?.id).toBe(first)
  })

  it('stamps createdAt from the capture and updatedAt from the last message', async () => {
    const id = await seedChat([userMsg('u1', 'hi')])
    vi.setSystemTime(new Date('2026-08-02T11:00:00'))
    await appendChatMessage(id, assistantMsg('a1', 'hello'))
    const chat = await loadChat(id)
    expect(chat?.createdAt.slice(0, 19)).toBe('2026-08-02T10:00:00')
    expect(chat?.updatedAt.slice(0, 19)).toBe('2026-08-02T11:00:00')
  })

  it('skips unreadable message payloads instead of failing the chat', async () => {
    const id = await seedChat([userMsg('u1', 'hi')])
    const events = await listEvents(CHATS_STREAM)
    const amend = events.find((e) => e.type === 'amend') as AmendEvent
    const db = await getDb()
    await db.put('blobs', {
      file: amend.attachments![0].file,
      blob: new Blob(['not json'], { type: 'application/json' }),
    })
    expect((await loadChat(id))?.messages).toEqual([])
  })
})

describe('soft-delete (revoke)', () => {
  it('hides the chat from every list while its events and blobs remain', async () => {
    const doomed = await seedChat([userMsg('u1', 'delete me'), assistantMsg('a1', 'ok')])
    const kept = await seedChat([userMsg('u1', 'keep me')])
    const eventsBefore = await listEvents(CHATS_STREAM)
    const doomedAmend = eventsBefore.find(
      (e) => e.type === 'amend' && e.targets.includes(doomed),
    ) as AmendEvent

    await deleteChatStream(doomed)

    expect((await loadAllChats()).map((c) => c.id)).toEqual([kept])
    expect((await listChats()).map((c) => c.id)).toEqual([kept])
    expect(await loadChat(doomed)).toBeUndefined()
    expect((await loadMostRecentChat())?.id).toBe(kept)

    // Soft-delete by design (SPEC §11): the log keeps every event — the
    // original capture+amends plus the new revoke — and the message blobs.
    const eventsAfter = await listEvents(CHATS_STREAM)
    expect(eventsAfter).toHaveLength(eventsBefore.length + 1)
    expect(eventsAfter.filter((e) => e.type === 'revoke')).toHaveLength(1)
    expect(await getBlob(doomedAmend.attachments![0].file)).toBeDefined()
  })
})

describe('cross-device merge', () => {
  function remoteMessageEvent(
    chatId: string,
    id: string,
    seq: number,
    loggedAt: string,
    message: UIMessage,
  ): { event: AmendEvent; file: string; blob: Blob } {
    const event: AmendEvent = {
      schema: EVENT_SCHEMA,
      type: 'amend',
      id,
      seq,
      stream: CHATS_STREAM,
      loggedAt,
      deviceTz: 'UTC',
      targets: [chatId],
      attachments: [],
    }
    const file = attachmentFileName(eventBaseName(event), 'text', 'application/json')
    event.attachments = [{ kind: 'text', file, mimeType: 'application/json' }]
    const payload = { schema: CHAT_MESSAGE_PAYLOAD_SCHEMA, message }
    return { event, file, blob: new Blob([JSON.stringify(payload)], { type: 'application/json' }) }
  }

  it('converges offline appends from two devices by compareEvents with no dupes or drops', async () => {
    // Device A (this replica): capture seq 1 + one message amend seq 2.
    const chatId = await createChat()
    const mA1 = userMsg('uA1', 'from device A')
    await appendChatMessage(chatId, mA1)

    // Device B appended two messages offline after syncing only the capture:
    // its first amend mints the SAME seq 2 (the collision compareEvents'
    // loggedAt tiebreak exists for) with a later loggedAt.
    const mB1 = assistantMsg('aB1', 'from device B, first')
    const mB2 = userMsg('uB2', 'from device B, second')
    const b1 = remoteMessageEvent(chatId, 'r00001', 2, '2027-01-01T00:00:00+00:00', mB1)
    const b2 = remoteMessageEvent(chatId, 'r00002', 3, '2027-01-01T00:00:05+00:00', mB2)
    const blobs = new Map([
      [b1.file, b1.blob],
      [b2.file, b2.blob],
    ])
    await importEvents(CHATS_STREAM, [b1.event, b2.event], blobs)

    // seq 2 (A, earlier loggedAt) → seq 2 (B) → seq 3 (B); nothing lost.
    expect((await loadChat(chatId))?.messages.map((m) => m.id)).toEqual(['uA1', 'aB1', 'uB2'])

    // Re-importing the same pull is idempotent — no duplicates.
    await importEvents(CHATS_STREAM, [b1.event, b2.event], blobs)
    expect((await loadChat(chatId))?.messages.map((m) => m.id)).toEqual(['uA1', 'aB1', 'uB2'])

    // The local seq counter moved past the imported log, so the next local
    // append lands after everything already merged.
    const mA2 = userMsg('uA2', 'from device A, after merge')
    await appendChatMessage(chatId, mA2)
    expect((await loadChat(chatId))?.messages.map((m) => m.id)).toEqual([
      'uA1',
      'aB1',
      'uB2',
      'uA2',
    ])
  })
})

describe('summaries perf contract', () => {
  it('reads at most one blob per chat (title only; count from metadata)', async () => {
    await seedChat([userMsg('u1', 'first chat'), assistantMsg('a1', 'x'), userMsg('u2', 'y')])
    vi.setSystemTime(new Date('2026-08-02T11:00:00'))
    await seedChat([userMsg('u1', 'second chat'), assistantMsg('a1', 'z')])

    vi.mocked(getBlob).mockClear()
    const summaries = await loadChatSummaries()
    expect(vi.mocked(getBlob).mock.calls.length).toBeLessThanOrEqual(2)
    expect(summaries.map((s) => ({ count: s.messageCount, first: s.firstMessage?.id }))).toEqual([
      { count: 2, first: 'u1' },
      { count: 3, first: 'u1' },
    ])

    // listChats builds on the same source: still ≤ one blob per chat.
    vi.mocked(getBlob).mockClear()
    const chats = await listChats()
    expect(vi.mocked(getBlob).mock.calls.length).toBeLessThanOrEqual(2)
    expect(chats.map((c) => ({ title: c.title, count: c.messageCount }))).toEqual([
      { title: 'second chat', count: 2 },
      { title: 'first chat', count: 3 },
    ])
  })
})

describe('capture.chatmessage.v1 envelope (golden)', () => {
  it('wraps the UIMessage — including tool-invocation parts — byte-for-byte', async () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'list_entries',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { from: '2026-08-01', to: '2026-08-02' },
          output: '2026-08-02:\n- 09:04 — coffee',
        },
        { type: 'text', text: 'You logged one entry.' },
      ],
    }
    const chatId = await createChat()
    await appendChatMessage(chatId, message)

    const amend = (await listEvents(CHATS_STREAM)).find((e) => e.type === 'amend') as AmendEvent
    expect(amend.attachments).toHaveLength(1)
    expect(amend.attachments![0]).toMatchObject({
      kind: 'text',
      mimeType: 'application/json',
    })
    expect(amend.attachments![0].file.endsWith('.json')).toBe(true)

    const blob = await getBlob(amend.attachments![0].file)
    expect(await blob!.text()).toBe(
      '{"schema":"capture.chatmessage.v1","message":' +
        '{"id":"a1","role":"assistant","parts":[' +
        '{"type":"dynamic-tool","toolName":"list_entries","toolCallId":"call-1",' +
        '"state":"output-available","input":{"from":"2026-08-01","to":"2026-08-02"},' +
        '"output":"2026-08-02:\\n- 09:04 — coffee"},' +
        '{"type":"text","text":"You logged one entry."}]}}',
    )

    // And the round-trip lands the identical message back in the chat.
    expect((await loadChat(chatId))?.messages).toEqual([message])
  })
})

describe('migration marker interplay', () => {
  it('marks migration as applied on a fresh install (no legacy rows)', async () => {
    const db = await getDb()
    expect(await db.get('meta', CHATS_MIGRATION_MARKER)).toBe(true)
    expect(await listEvents(CHATS_STREAM)).toEqual([])
  })
})
