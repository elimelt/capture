/**
 * Chat history: pure presentation helpers (title, search) over the synced
 * chats plus thin CRUD delegates. Conversations are event-sourced in the
 * `assistant-chats` stream (see chatSync.ts) — this module keeps the API the
 * history sheet and chat screen consume: "New chat" starts a fresh
 * conversation, past ones stay browsable/searchable, delete is a soft revoke,
 * and Settings → wipe clears the whole log.
 */
import type { UIMessage } from 'ai'
import { deleteChatStream, loadChatSummaries, type SyncedChat } from './chatSync'

/** The conversation shape the UI renders; alias of the synced shape. */
export type StoredChat = SyncedChat
export { loadAllChats, loadChat, loadMostRecentChat } from './chatSync'

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

/**
 * Summaries, most recently touched first. Reads at most one blob per chat
 * (the first message, always a user turn, carries the title).
 */
export async function listChats(): Promise<ChatSummary[]> {
  return (await loadChatSummaries()).map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    title: chatTitle(c.firstMessage ? [c.firstMessage] : []),
    messageCount: c.messageCount,
  }))
}

/** Soft-delete: the chat leaves every list; its events stay in the log. */
export async function deleteChat(id: string): Promise<void> {
  await deleteChatStream(id)
}
