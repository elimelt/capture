/**
 * Chat persistence: the current conversation survives app restarts (iOS
 * kills standalone PWAs freely). One conversation, stored under a meta key —
 * "New chat" clears it, and Settings → wipe clears meta wholesale.
 */
import type { UIMessage } from 'ai'
import { getDb } from '../store/db'

const KEY = 'assistant:chat'

export async function loadChatHistory(): Promise<UIMessage[]> {
  const db = await getDb()
  const stored = (await db.get('meta', KEY)) as UIMessage[] | undefined
  return stored ?? []
}

export async function saveChatHistory(messages: UIMessage[]): Promise<void> {
  const db = await getDb()
  await db.put('meta', messages, KEY)
}

export async function clearChatHistory(): Promise<void> {
  const db = await getDb()
  await db.delete('meta', KEY)
}
