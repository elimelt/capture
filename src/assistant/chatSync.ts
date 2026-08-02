/**
 * Chats as a synced stream (SPEC §3.1, §10.1): every conversation lives in
 * the `assistant-chats` system stream, so chat history syncs to Drive through
 * the exact same append-only log, upload queue, and pull engine as every
 * other stream — no chat-specific sync code.
 *
 * Mapping onto the generic entry model (reuses contract/fold unmodified):
 *   - create chat   = `capture` event, no attachments; the event id IS the
 *                     chat id from then on.
 *   - every message = one `amend` targeting the chat id, carrying one
 *                     text/application-json attachment wrapping the UIMessage
 *                     in a versioned `capture.chatmessage.v1` envelope.
 *   - delete chat   = `revoke` (soft-delete — SPEC §11): the chat disappears
 *                     from every list, but its events and message blobs stay
 *                     in the local log and, once synced, in Drive; true
 *                     erasure is the same out-of-band Drive-file deletion as
 *                     for any other entity.
 *
 * Cross-device convergence is free: fold applies amends in `compareEvents`
 * order (seq → loggedAt → id), which is exactly message order, so two devices
 * appending to one chat offline converge to the same deterministic order on
 * every replica.
 *
 * All writes go through store/events.ts (the single write path), so every
 * chat event gets a sync row + blobs and the multi-stream drainSync pushes it.
 */
import type { UIMessage } from 'ai'
import { fold } from '../contract/fold'
import { toLocalIso } from '../contract/time'
import type { Entry } from '../contract/types'
import { appendAmend, appendCapture, appendRevoke, getBlob, listEvents } from '../store/events'

export const CHATS_STREAM = 'assistant-chats'
export const CHAT_MESSAGE_PAYLOAD_SCHEMA = 'capture.chatmessage.v1'

/**
 * The attachment blob's JSON shape: the third-party UIMessage wrapped in an
 * envelope so the payload can version independently of the `ai` package.
 */
export interface ChatMessagePayload {
  schema: typeof CHAT_MESSAGE_PAYLOAD_SCHEMA
  message: UIMessage
}

/** A conversation folded out of the stream (the old StoredChat, event-sourced). */
export interface SyncedChat {
  /** The chat's capture-event id. */
  id: string
  /** loggedAt of the capture event, ISO local time. */
  createdAt: string
  /** loggedAt of the last event that touched the chat, ISO local time. */
  updatedAt: string
  messages: UIMessage[]
}

/** Summary-building source: at most the first message is materialized. */
export interface ChatSummarySource {
  id: string
  createdAt: string
  updatedAt: string
  /** attachments.length — free, no blob reads. */
  messageCount: number
  /** The chat's first message (one blob read), for title derivation. */
  firstMessage: UIMessage | undefined
}

/** Start a new conversation in the stream; returns the chat id. */
export async function createChat(): Promise<string> {
  const event = await appendCapture({
    stream: CHATS_STREAM,
    capturedAt: toLocalIso(new Date()),
    attachments: [],
  })
  return event.id
}

/** Append one settled message to a chat (one amend, one JSON attachment). */
export async function appendChatMessage(chatId: string, message: UIMessage): Promise<void> {
  const payload: ChatMessagePayload = { schema: CHAT_MESSAGE_PAYLOAD_SCHEMA, message }
  await appendAmend({
    stream: CHATS_STREAM,
    targets: [chatId],
    attachments: [
      {
        kind: 'text',
        mimeType: 'application/json',
        blob: new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      },
    ],
  })
}

/** Soft-delete: revoke the chat's capture event (content stays in the log). */
export async function deleteChatStream(chatId: string): Promise<void> {
  await appendRevoke({ stream: CHATS_STREAM, targets: [chatId] })
}

/**
 * Persistence-on-settle helper: the messages not yet appended to the stream.
 * Pure so ChatScreen's settle handler is testable without mounting it.
 */
export function messagesSince(
  persistedCount: number,
  messages: readonly UIMessage[],
): UIMessage[] {
  return messages.slice(Math.max(0, persistedCount))
}

interface ChatShell {
  entry: Entry
  createdAt: string
  updatedAt: string
}

/** Folded, non-revoked chats, most recently touched first. No blob reads. */
async function chatShells(): Promise<ChatShell[]> {
  const events = await listEvents(CHATS_STREAM) // already in compareEvents order
  const entries = fold(events) // revoked chats drop out here
  // updatedAt = loggedAt of the last (compareEvents-order) event touching the
  // chat; the map is seeded by captures so amends to unknown ids are ignored.
  const updated = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'capture') updated.set(e.id, e.loggedAt)
    else if (e.type === 'amend') {
      for (const t of e.targets) if (updated.has(t)) updated.set(t, e.loggedAt)
    }
  }
  return entries
    .map((entry) => ({
      entry,
      createdAt: entry.loggedAt,
      updatedAt: updated.get(entry.id) ?? entry.loggedAt,
    }))
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        (a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0),
    )
}

/** One attachment blob → UIMessage; undefined for missing/foreign payloads. */
async function readMessage(file: string): Promise<UIMessage | undefined> {
  const blob = await getBlob(file)
  if (!blob) return undefined
  try {
    const payload = JSON.parse(await blob.text()) as Partial<ChatMessagePayload>
    return payload.schema === CHAT_MESSAGE_PAYLOAD_SCHEMA && payload.message !== undefined
      ? payload.message
      : undefined
  } catch {
    return undefined
  }
}

/** All of one chat's messages, in fold (= insertion) order. */
async function messagesOf(entry: Entry): Promise<UIMessage[]> {
  const out: UIMessage[] = []
  for (const att of entry.attachments) {
    const message = await readMessage(att.file)
    if (message) out.push(message)
  }
  return out
}

async function toSyncedChat(shell: ChatShell): Promise<SyncedChat> {
  return {
    id: shell.entry.id,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    messages: await messagesOf(shell.entry),
  }
}

/** One chat with all its messages (reads all of that chat's blobs). */
export async function loadChat(id: string): Promise<SyncedChat | undefined> {
  const shell = (await chatShells()).find((s) => s.entry.id === id)
  return shell ? toSyncedChat(shell) : undefined
}

/** Every non-revoked chat, most recently touched first (reads all blobs). */
export async function loadAllChats(): Promise<SyncedChat[]> {
  const out: SyncedChat[] = []
  for (const shell of await chatShells()) out.push(await toSyncedChat(shell))
  return out
}

/** Boot hydration: pick up where the user left off. */
export async function loadMostRecentChat(): Promise<SyncedChat | undefined> {
  const [mostRecent] = await chatShells()
  return mostRecent ? toSyncedChat(mostRecent) : undefined
}

/**
 * Summary sources for the history list. Perf contract (SPEC §10.1): at most
 * ONE blob read per chat — the first attachment (always the first message,
 * since every message is an amend attachment) for the title; the count comes
 * from attachment metadata for free.
 */
export async function loadChatSummaries(): Promise<ChatSummarySource[]> {
  const shells = await chatShells()
  const out: ChatSummarySource[] = []
  for (const { entry, createdAt, updatedAt } of shells) {
    out.push({
      id: entry.id,
      createdAt,
      updatedAt,
      messageCount: entry.attachments.length,
      firstMessage:
        entry.attachments.length > 0 ? await readMessage(entry.attachments[0].file) : undefined,
    })
  }
  return out
}
