/**
 * Chat persistence: conversations survive app restarts (iOS kills standalone
 * PWAs freely). Each conversation is a row in the `chats` store; "New chat"
 * starts a fresh row, past rows stay browsable/searchable from the history
 * sheet, and Settings → wipe clears the store wholesale.
 */
import type { UIMessage } from 'ai'
import { getDb } from '../store/db'

/** A persisted conversation — the store row with strong message typing. */
export interface StoredChat {
  id: string
  /** ISO local time. */
  createdAt: string
  /** ISO local time; caller bumps it on every save. */
  updatedAt: string
  messages: UIMessage[]
}

/** What the history list renders: no message payloads, just the gist. */
export interface ChatSummary {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  messageCount: number
}

const TITLE_MAX = 60

function messageText(m: UIMessage): string {
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** First user message, truncated to a list-row title. */
export function chatTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  const text = first ? messageText(first).trim() : ''
  if (!text) return 'New conversation'
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text
}

/**
 * Case-insensitive word-AND match: every whitespace-separated query word
 * must appear somewhere in the conversation's text (any message, any
 * order). Pure so the history sheet can filter as-you-type without
 * touching idb. Empty/whitespace query returns everything.
 */
export function searchChats(chats: StoredChat[], query: string): StoredChat[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return chats
  return chats.filter((c) => {
    const text = c.messages.map(messageText).join('\n').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

export async function loadChat(id: string): Promise<StoredChat | undefined> {
  const db = await getDb()
  return (await db.get('chats', id)) as StoredChat | undefined
}

/** Upsert; the caller sets updatedAt. */
export async function saveChat(chat: StoredChat): Promise<void> {
  const db = await getDb()
  await db.put('chats', chat)
}

/** Every conversation, most recently touched first. */
export async function loadAllChats(): Promise<StoredChat[]> {
  const db = await getDb()
  const all = (await db.getAll('chats')) as StoredChat[]
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function listChats(): Promise<ChatSummary[]> {
  return (await loadAllChats()).map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    title: chatTitle(c.messages),
    messageCount: c.messages.length,
  }))
}

export async function deleteChat(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('chats', id)
}

/** Boot hydration: pick up where the user left off. */
export async function loadMostRecentChat(): Promise<StoredChat | undefined> {
  const [mostRecent] = await loadAllChats()
  return mostRecent
}
