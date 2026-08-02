import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { getDb, resetDbCache } from '../store/db'
import { wipeAll } from '../store/events'
import { clearChatHistory, loadChatHistory, saveChatHistory } from './history'

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

describe('assistant chat history', () => {
  it('returns an empty conversation when nothing is stored', async () => {
    expect(await loadChatHistory()).toEqual([])
  })

  it('round-trips a saved conversation', async () => {
    await saveChatHistory(conversation)
    expect(await loadChatHistory()).toEqual(conversation)
  })

  it('overwrites on save (single current conversation)', async () => {
    await saveChatHistory(conversation)
    await saveChatHistory(conversation.slice(0, 1))
    expect(await loadChatHistory()).toEqual(conversation.slice(0, 1))
  })

  it('clears on clearChatHistory', async () => {
    await saveChatHistory(conversation)
    await clearChatHistory()
    expect(await loadChatHistory()).toEqual([])
  })

  it('is erased by a full data wipe', async () => {
    await saveChatHistory(conversation)
    await wipeAll()
    expect(await loadChatHistory()).toEqual([])
  })
})
