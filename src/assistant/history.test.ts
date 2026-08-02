import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { openDB } from 'idb'
import { getDb, resetDbCache } from '../store/db'
import { wipeAll } from '../store/events'
import {
  chatTitle,
  deleteChat,
  listChats,
  loadChat,
  loadMostRecentChat,
  saveChat,
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

  it('returns nothing when nothing matches', () => {
    expect(searchChats(chats, 'zebra')).toEqual([])
  })
})

describe('assistant chat persistence', () => {
  it('returns undefined for a missing chat', async () => {
    expect(await loadChat('nope')).toBeUndefined()
  })

  it('round-trips a saved conversation', async () => {
    const chat = makeChat('c1', '2026-01-02T00:00:00.000Z')
    await saveChat(chat)
    expect(await loadChat('c1')).toEqual(chat)
  })

  it('upserts on save', async () => {
    await saveChat(makeChat('c1', '2026-01-02T00:00:00.000Z'))
    const updated = makeChat('c1', '2026-01-03T00:00:00.000Z', conversation.slice(0, 1))
    await saveChat(updated)
    expect(await loadChat('c1')).toEqual(updated)
    expect(await listChats()).toHaveLength(1)
  })

  it('lists summaries sorted by updatedAt desc', async () => {
    await saveChat(makeChat('older', '2026-01-02T00:00:00.000Z'))
    await saveChat(makeChat('newer', '2026-01-05T00:00:00.000Z', conversation.slice(0, 1)))
    expect(await listChats()).toEqual([
      {
        id: 'newer',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
        title: 'What did I do today?',
        messageCount: 1,
      },
      {
        id: 'older',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        title: 'What did I do today?',
        messageCount: 2,
      },
    ])
  })

  it('loads the most recent chat for boot hydration', async () => {
    expect(await loadMostRecentChat()).toBeUndefined()
    await saveChat(makeChat('older', '2026-01-02T00:00:00.000Z'))
    await saveChat(makeChat('newer', '2026-01-05T00:00:00.000Z'))
    expect((await loadMostRecentChat())?.id).toBe('newer')
  })

  it('deletes a single chat, leaving the rest', async () => {
    await saveChat(makeChat('c1', '2026-01-02T00:00:00.000Z'))
    await saveChat(makeChat('c2', '2026-01-03T00:00:00.000Z'))
    await deleteChat('c1')
    expect((await listChats()).map((c) => c.id)).toEqual(['c2'])
  })

  it('is erased by a full data wipe', async () => {
    await saveChat(makeChat('c1', '2026-01-02T00:00:00.000Z'))
    await wipeAll()
    expect(await listChats()).toEqual([])
  })

  it('migrates the legacy single conversation from meta on upgrade to v3', async () => {
    // Seed a v2-shaped DB (meta store only — the v3 upgrade touches nothing
    // else) with the old single-conversation key, before the first getDb().
    const legacy = await openDB('timebox', 2, {
      upgrade(db) {
        db.createObjectStore('meta')
      },
    })
    await legacy.put('meta', conversation, 'assistant:chat')
    legacy.close()

    const chats = await listChats()
    expect(chats).toHaveLength(1)
    expect(chats[0].title).toBe('What did I do today?')
    expect(chats[0].messageCount).toBe(2)
    expect((await loadChat(chats[0].id))?.messages).toEqual(conversation)
    const db = await getDb()
    expect(await db.get('meta', 'assistant:chat')).toBeUndefined()
  })
})
