import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { openDB } from 'idb'
import { getDb, resetDbCache } from '../store/db'
import { listEvents, wipeAll } from '../store/events'
import { CHATS_STREAM, appendChatMessage, createChat } from './chatSync'
import {
  chatTitle,
  deleteChat,
  listChats,
  loadChat,
  loadMostRecentChat,
  searchChats,
  type StoredChat,
} from './history'

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
  // Only Date is faked (fake-indexeddb needs real task scheduling); tests
  // advance the clock to separate createdAt/updatedAt stamps.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-02T10:00:00'))
})

afterEach(() => {
  vi.useRealTimers()
})

const conversation: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What did I do today?' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'You logged **3 entries** at Home.' }],
  },
]

function makeChat(id: string, updatedAt: string, messages: UIMessage[] = conversation): StoredChat {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt, messages }
}

/** Create a conversation in the assistant-chats stream; returns the chat id. */
async function seedChat(messages: UIMessage[] = conversation): Promise<string> {
  const id = await createChat()
  for (const m of messages) await appendChatMessage(id, m)
  return id
}

describe('chatTitle', () => {
  it('uses the first user message text', () => {
    expect(chatTitle(conversation)).toBe('What did I do today?')
  })

  it('skips leading assistant messages', () => {
    expect(chatTitle([conversation[1], conversation[0]])).toBe('What did I do today?')
  })

  it('truncates long titles to ~60 chars with an ellipsis', () => {
    const long = 'a'.repeat(80)
    const title = chatTitle([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: long }] }])
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
    expect(title.startsWith('a'.repeat(59))).toBe(true)
  })

  it('falls back when there is no user text', () => {
    expect(chatTitle([])).toBe('New conversation')
    expect(chatTitle([conversation[1]])).toBe('New conversation')
  })
})

describe('searchChats', () => {
  const chats = [
    makeChat('c1', '2026-01-02T00:00:00.000Z'),
    makeChat('c2', '2026-01-03T00:00:00.000Z', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Summarize my week' }] },
    ]),
  ]

  it('returns everything for an empty or whitespace query', () => {
    expect(searchChats(chats, '')).toEqual(chats)
    expect(searchChats(chats, '   ')).toEqual(chats)
  })

  it('matches case-insensitively over any message text', () => {
    expect(searchChats(chats, 'SUMMARIZE').map((c) => c.id)).toEqual(['c2'])
    expect(searchChats(chats, 'today').map((c) => c.id)).toEqual(['c1'])
  })

  it('matches assistant messages too', () => {
    expect(searchChats(chats, '3 entries').map((c) => c.id)).toEqual(['c1'])
  })

  it('matches all query words regardless of order or which message holds them', () => {
    expect(searchChats(chats, 'week summarize').map((c) => c.id)).toEqual(['c2'])
    expect(searchChats(chats, 'entries today').map((c) => c.id)).toEqual(['c1'])
  })

  it('requires every query word to match', () => {
    expect(searchChats(chats, 'summarize zebra')).toEqual([])
  })

  it('returns nothing when nothing matches', () => {
    expect(searchChats(chats, 'zebra')).toEqual([])
  })
})

describe('assistant chat persistence (event-sourced)', () => {
  it('returns undefined for a missing chat', async () => {
    expect(await loadChat('nope')).toBeUndefined()
  })

  it('round-trips a conversation appended message by message', async () => {
    const id = await seedChat()
    expect((await loadChat(id))?.messages).toEqual(conversation)
  })

  it('lists summaries sorted by last-touched desc, one title blob per chat', async () => {
    const older = await seedChat()
    vi.setSystemTime(new Date('2026-08-02T11:00:00'))
    const newer = await seedChat(conversation.slice(0, 1))
    expect(await listChats()).toEqual([
      expect.objectContaining({
        id: newer,
        title: 'What did I do today?',
        messageCount: 1,
      }),
      expect.objectContaining({
        id: older,
        title: 'What did I do today?',
        messageCount: 2,
      }),
    ])
  })

  it('loads the most recent chat for boot hydration', async () => {
    expect(await loadMostRecentChat()).toBeUndefined()
    await seedChat()
    vi.setSystemTime(new Date('2026-08-02T11:00:00'))
    const newer = await seedChat()
    expect((await loadMostRecentChat())?.id).toBe(newer)
  })

  it('deletes (revokes) a single chat, leaving the rest and the log intact', async () => {
    const doomed = await seedChat()
    vi.setSystemTime(new Date('2026-08-02T11:00:00'))
    const kept = await seedChat()
    const eventCount = (await listEvents(CHATS_STREAM)).length
    await deleteChat(doomed)
    expect((await listChats()).map((c) => c.id)).toEqual([kept])
    // Soft-delete: one revoke appended, nothing removed (SPEC §11).
    expect(await listEvents(CHATS_STREAM)).toHaveLength(eventCount + 1)
  })

  it('is erased by a full data wipe', async () => {
    await seedChat()
    await wipeAll()
    expect(await listChats()).toEqual([])
  })

  it('migrates the legacy single conversation from meta through to the stream', async () => {
    // Seed a v2-shaped DB with the old single-conversation meta key, before
    // the first getDb(). Upgrading composes two migrations: v3 turns the meta
    // key into a legacy `chats` row, then migrateChatsV1 turns that row into
    // capture + amend events in the assistant-chats stream.
    const legacy = await openDB('timebox', 2, {
      upgrade(db) {
        db.createObjectStore('events', { keyPath: ['stream', 'seq'] }).createIndex(
          'by-stream',
          'stream',
        )
        db.createObjectStore('blobs', { keyPath: 'file' })
        db.createObjectStore('sync', { keyPath: ['stream', 'seq'] })
        db.createObjectStore('places', { keyPath: 'id' })
        db.createObjectStore('meta')
      },
    })
    await legacy.put('meta', conversation, 'assistant:chat')
    legacy.close()
    resetDbCache()

    const chats = await listChats()
    expect(chats).toHaveLength(1)
    expect(chats[0].title).toBe('What did I do today?')
    expect(chats[0].messageCount).toBe(2)
    expect((await loadChat(chats[0].id))?.messages).toEqual(conversation)
    const db = await getDb()
    expect(await db.get('meta', 'assistant:chat')).toBeUndefined()
    // The intermediate chats row survives as the rollback artifact.
    expect(await db.count('chats')).toBe(1)
  })
})
