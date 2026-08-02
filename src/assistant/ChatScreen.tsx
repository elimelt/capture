/**
 * Assistant chat (opt-in). Client-only: useChat over a DirectChatTransport
 * against llm.elimelt.com; the agent reads the log through tools and can
 * create/update entries via the store's own capture/amend actions (nothing
 * else is injected — see EntryWriter in tools.ts). Editorial voice:
 * assistant replies are serif markdown on the page itself; user turns are
 * quiet spruce-washed bubbles. Submitting while a turn is in flight queues
 * the message (dashed pending bubble; sent when the turn settles) with a
 * "Send now" steer action that interrupts the stream — see sendQueue.ts.
 */
import { useEffect, useRef, useState } from 'react'
import { Chat, useChat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import { useAppStore } from '../store/appStore'
import {
  Button,
  ScreenHeader,
  TextInput,
  cx,
  layer,
  motion,
  tone,
  type_,
  useKeyboardInset,
} from '../ui'
import { ChatHistorySheet } from './ChatHistorySheet'
import { appendChatMessage, createChat, messagesSince } from './chatSync'
import { modelLabel } from './config'
import { buildInstructions } from './context'
import { loadMostRecentChat, type StoredChat } from './history'
import { Markdown } from './Markdown'
import * as sendQueue from './sendQueue'
import { createAssistantTools } from './tools'
import { createAssistantTransport } from './transport'

// The active conversation survives tab switches (module-scope Chat) and app
// restarts (IndexedDB, hydrated on first mount). "New chat" starts a fresh
// conversation — the old one stays in history; a model change re-creates the
// transport but keeps the messages.
type ChatSeed = Pick<StoredChat, 'id' | 'createdAt' | 'messages'>

let cache: {
  model: string
  chatId: string
  createdAt: string
  /** Whether the chat's capture event exists in the stream (lazily minted). */
  persisted: boolean
  /** How many of the live messages are already appended to the stream. */
  persistedCount: number
  chat: Chat<UIMessage>
} | null = null

function freshSeed(): ChatSeed {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), messages: [] }
}

function getChat(model: string, seed: ChatSeed): Chat<UIMessage> {
  if (cache && cache.model === model && cache.chatId === seed.id) return cache.chat
  // Same conversation, different model: keep the live messages. Otherwise
  // start from the seed's stored messages.
  const carried = cache?.chatId === seed.id ? cache : null
  cache = {
    model,
    chatId: seed.id,
    createdAt: carried?.createdAt ?? seed.createdAt,
    // A stored chat exists in the stream with all its messages; a fresh seed
    // has no capture event yet (minted on the first persisted turn).
    persisted: carried?.persisted ?? seed.messages.length > 0,
    persistedCount: carried?.persistedCount ?? seed.messages.length,
    chat: new Chat({
      messages: carried?.chat.messages ?? seed.messages,
      transport: createAssistantTransport(
        model,
        () => buildInstructions(),
        createAssistantTools(
          () => useAppStore.getState().entries,
          () => useAppStore.getState().places,
          // Only these two store actions are handed to the agent: entry
          // create + amend. Revoke, settings, sync and wipe stay unreachable.
          {
            capture: (input) => useAppStore.getState().capture(input),
            amend: (input) => useAppStore.getState().amend(input),
          },
        ),
      ),
    }),
  }
  return cache.chat
}

const SUGGESTIONS = [
  'What did I do today?',
  'Summarize my week',
  'Where did I spend the most time?',
]

function messageText(m: UIMessage): string {
  return m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
}

function hasVisibleContent(m: UIMessage): boolean {
  return m.parts.some(
    (p) => (p.type === 'text' || p.type === 'reasoning') && p.text.trim() !== '',
  )
}

/** A response is in flight but nothing readable has arrived yet (tool calls
 * can run for seconds before the first visible text or reasoning). */
function awaitingResponse(status: string, messages: UIMessage[]): boolean {
  if (status === 'submitted') return true
  if (status !== 'streaming') return false
  const last = messages.at(-1)
  return !(last?.role === 'assistant' && hasVisibleContent(last))
}

/** One-line caption for a tool invocation part; null for other parts or
 * shapes we don't recognize. */
function toolActivityLabel(part: UIMessage['parts'][number]): string | null {
  let toolName: string
  let input: unknown
  if (part.type === 'dynamic-tool') {
    toolName = part.toolName
    input = part.input
  } else if (part.type.startsWith('tool-')) {
    toolName = part.type.slice('tool-'.length)
    input = 'input' in part ? part.input : undefined
  } else {
    return null
  }
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  if (toolName === 'list_entries' && typeof args.from === 'string' && typeof args.to === 'string') {
    return `Read log ${args.from} – ${args.to}`
  }
  if (toolName === 'search_entries' && typeof args.query === 'string') {
    return `Searched the log for \u201c${args.query}\u201d`
  }
  if (toolName === 'get_places') return 'Looked up saved places'
  if (toolName === 'create_entry') return 'Added a log entry'
  if (toolName === 'update_entry') {
    return typeof args.id === 'string' ? `Updated entry ${args.id}` : 'Updated an entry'
  }
  return `Consulted the log (${toolName})`
}

export default function ChatScreen() {
  const model = useAppStore((s) => s.appSettings.assistantModel)
  const [chat, setChat] = useState<Chat<UIMessage> | null>(() =>
    cache ? getChat(model, { id: cache.chatId, createdAt: cache.createdAt, messages: [] }) : null,
  )

  // First mount in this JS lifetime: hydrate the most recent conversation
  // from IndexedDB; nothing stored yet → start a fresh one.
  useEffect(() => {
    if (cache) {
      setChat(getChat(model, { id: cache.chatId, createdAt: cache.createdAt, messages: [] }))
      return
    }
    let cancelled = false
    void loadMostRecentChat().then((stored) => {
      if (!cancelled) setChat(getChat(model, stored ?? freshSeed()))
    })
    return () => {
      cancelled = true
    }
  }, [model])

  if (!chat) return null

  return (
    <ChatView
      chat={chat}
      model={model}
      onReset={() => setChat(getChat(model, freshSeed()))}
      onLoadChat={(stored) => setChat(getChat(model, stored))}
    />
  )
}

function ChatView({
  chat,
  model,
  onReset,
  onLoadChat,
}: {
  chat: Chat<UIMessage>
  model: string
  onReset: () => void
  onLoadChat: (stored: StoredChat) => void
}) {
  const { messages, sendMessage, stop, status, error, clearError } = useChat({ chat })
  const [input, setInput] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const keyboardInset = useKeyboardInset()
  // Stick-to-bottom: auto-follow the stream only while the user is pinned
  // near the bottom. Scrolling up detaches; scrolling back down re-attaches.
  const pinnedRef = useRef(true)

  const busy = status === 'submitted' || status === 'streaming'

  // Mid-turn submits queue instead of racing the stream (the SDK starts a
  // second concurrent request if sendMessage runs while one is in flight).
  // The machine is pure (sendQueue.ts); dispatch applies a transition and
  // runs its commands. The ref is the authority — event handlers must see
  // the post-transition state immediately, not the next render's snapshot —
  // and `queued` mirrors it for rendering the pending bubbles. Seeding from
  // `busy` covers mounting while an earlier stream (module-scope Chat) runs.
  const machineRef = useRef(sendQueue.initialSendQueue(busy))
  const [queued, setQueued] = useState<readonly sendQueue.QueuedMessage[]>([])

  function dispatch(t: sendQueue.SendQueueTransition) {
    machineRef.current = t.state
    setQueued(t.state.queue)
    for (const c of t.commands) {
      if (c.type === 'stop') {
        void stop()
      } else {
        pinnedRef.current = true
        void sendMessage({ text: c.message.text })
      }
    }
  }

  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement
      pinnedRef.current = doc.scrollHeight - window.innerHeight - window.scrollY < 80
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Switching conversations always lands at the latest turn — and drops any
  // queued drafts: they belong to the composer session, not the thread.
  useEffect(() => {
    pinnedRef.current = true
    machineRef.current = sendQueue.initialSendQueue(
      status === 'submitted' || status === 'streaming',
    )
    setQueued([])
    // Deps: [chat] only — status merely seeds the reset.
  }, [chat])

  useEffect(() => {
    if (pinnedRef.current) {
      // True document bottom, so the trailing padding clears the fixed
      // composer and the last message stays fully visible.
      window.scrollTo({ top: document.documentElement.scrollHeight })
    }
  }, [messages, status, queued])

  // Persist each settled turn (not per-delta; streaming would hammer idb):
  // append only the messages new since the last settle to the chats stream —
  // one amend event per message. The chat's capture event is minted lazily on
  // the first persisted turn, so an untouched "New chat" never hits the log.
  // persistedCount advances synchronously before the async writes so a
  // re-fired effect (StrictMode double-invoke) can't append duplicates.
  useEffect(() => {
    if ((status === 'ready' || status === 'error') && messages.length > 0 && cache) {
      const active = cache
      const fresh = messagesSince(active.persistedCount, messages)
      if (fresh.length === 0) return
      active.persistedCount += fresh.length
      void (async () => {
        if (!active.persisted) {
          active.persisted = true
          active.chatId = await createChat()
        }
        for (const m of fresh) await appendChatMessage(active.chatId, m)
      })()
    }
  }, [status, messages])

  // Flush the send queue once per settled turn — on the status *transition*
  // (ready/error, including after stop()), never on re-renders where status
  // merely stays settled, so one settle sends exactly one queued message.
  // Declared after the persist effect: the settled turn is handed to
  // persistence before the next turn starts (persistedCount advances
  // synchronously there, so an interleaved queued turn's settle appends only
  // its own new messages — nothing is dropped either way).
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (
      (prev === 'submitted' || prev === 'streaming') &&
      (status === 'ready' || status === 'error')
    ) {
      dispatch(sendQueue.settled(machineRef.current))
    }
  }, [status])

  function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    setInput('')
    pinnedRef.current = true
    dispatch(sendQueue.submit(machineRef.current, { id: crypto.randomUUID(), text: trimmed }))
  }

  /** Drop queued drafts *before* stop(): the abort settles the turn, and a
   * settle flushes the queue — into the conversation being abandoned. The
   * machine ref is authoritative, so clearing it here is race-free; the
   * [chat] effect re-seeds turnInFlight after the swap. */
  function dropQueue() {
    machineRef.current = sendQueue.initialSendQueue(machineRef.current.turnInFlight)
    setQueued([])
  }

  // The old conversation stays in history; just start a fresh one.
  function newChat() {
    dropQueue()
    stop()
    onReset()
  }

  return (
    <div className={cx('flex flex-col gap-4 p-4 pb-20', motion.fadeIn)}>
      {/* Sticky header: pulls up over main's safe-area pad so, when stuck,
          its blurred surface extends under the iOS status bar. */}
      <div
        className={cx(
          'sticky top-0 -mx-4 -mt-[calc(env(safe-area-inset-top)_+_1rem)] border-b px-4 pb-3 pt-[calc(env(safe-area-inset-top)_+_1rem)] backdrop-blur-xl',
          layer.nav,
          tone.border,
          'bg-paper/85 dark:bg-paper-dark/85',
        )}
      >
        <ScreenHeader
          title="Assistant"
          subtitle={modelLabel(model)}
          trailing={
            <div className="flex items-center">
              <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
                History
              </Button>
              {messages.length > 0 && (
                <Button variant="ghost" size="sm" onClick={newChat}>
                  New chat
                </Button>
              )}
            </div>
          }
        />
      </div>

      {messages.length === 0 && (
        <div className="mt-6 flex flex-col items-center gap-4">
          <p className={cx('px-6 text-center italic', type_.body, tone.textMuted)}>
            Ask about your log — it looks up your entries and places as needed.
          </p>
          <div className="flex flex-col items-stretch gap-2 self-stretch px-2">
            {SUGGESTIONS.map((s) => (
              <Button key={s} variant="secondary" onClick={() => send(s)}>
                {s}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4" style={{ paddingBottom: keyboardInset }}>
        {messages.map((m) =>
          m.role === 'user' ? (
            <div
              key={m.id}
              className={cx('min-w-0 max-w-[85%] self-end', motion.riseIn)}
            >
              <div
                className={cx(
                  'whitespace-pre-wrap rounded-2xl rounded-br-md px-3.5 py-2 [overflow-wrap:anywhere]',
                  tone.accentWash,
                  type_.ui,
                  tone.textPrimary,
                )}
              >
                {messageText(m)}
              </div>
            </div>
          ) : (
            <div key={m.id} className={cx('min-w-0 self-stretch', motion.fadeIn)}>
              {m.parts.map((p, i) => {
                if (p.type === 'reasoning') {
                  return p.text.trim() !== '' ? (
                    <ReasoningTrace key={i} text={p.text} streaming={p.state === 'streaming'} />
                  ) : null
                }
                const activity = toolActivityLabel(p)
                return activity ? (
                  <p key={i} className={cx('mb-1 italic', type_.caption, tone.textMuted)}>
                    {activity}
                  </p>
                ) : null
              })}
              <Markdown>{messageText(m)}</Markdown>
            </div>
          ),
        )}
        {awaitingResponse(status, messages) && <ThinkingDots />}
        {queued.map((q, i) => (
          <div
            key={q.id}
            className={cx('flex min-w-0 max-w-[85%] flex-col items-end gap-1 self-end', motion.riseIn)}
          >
            <div
              className={cx(
                'whitespace-pre-wrap rounded-2xl rounded-br-md border border-dashed px-3.5 py-2 [overflow-wrap:anywhere]',
                tone.borderStrong,
                type_.ui,
                tone.textSecondary,
              )}
            >
              {q.text}
            </div>
            <p className={cx(type_.caption, tone.textMuted)}>
              Queued
              {i === 0 && busy && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => dispatch(sendQueue.steer(machineRef.current, q.id))}
                  >
                    Send now (interrupts)
                  </button>
                </>
              )}
              {' · '}
              <button
                type="button"
                className="underline"
                onClick={() => dispatch(sendQueue.discard(machineRef.current, q.id))}
              >
                Remove
              </button>
            </p>
          </div>
        ))}
        {error && (
          <p className={cx(type_.sub, tone.danger)}>
            {'Something went wrong reaching the assistant. '}
            <button className="underline" onClick={clearError}>
              Dismiss
            </button>
          </p>
        )}
      </div>

      {/* Composer: fixed above the tab bar; lifts above the iOS keyboard
          (fixed elements stay in the layout viewport in standalone mode). */}
      <div
        className={cx(
          'fixed inset-x-0 border-t px-3 py-2 backdrop-blur-xl',
          layer.raised,
          tone.border,
          'bg-card/80 dark:bg-card-dark/80',
        )}
        style={{
          bottom:
            keyboardInset > 0
              ? `${keyboardInset}px`
              : 'calc(3.5rem + env(safe-area-inset-bottom))',
        }}
      >
        <form
          className="mx-auto flex max-w-md items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send(input)
          }}
        >
          <TextInput
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your log…"
            enterKeyHint="send"
            className="min-w-0 flex-1"
          />
          {busy ? (
            <>
              {/* Muted while a Queue button is present so exactly one action
                  reads primary; submitting mid-turn queues instead of racing
                  the in-flight stream. */}
              <RoundButton
                label="Stop"
                type="button"
                muted={input.trim() !== ''}
                onClick={() => void stop()}
              >
                <rect x="7" y="7" width="10" height="10" rx="1.5" />
              </RoundButton>
              {input.trim() !== '' && (
                <RoundButton label="Queue message" type="submit">
                  <path d="M12 19V6M6 12l6-6 6 6" fill="none" strokeWidth="2.2" />
                </RoundButton>
              )}
            </>
          ) : (
            <RoundButton label="Send" type="submit" disabled={!input.trim()}>
              <path d="M12 19V6M6 12l6-6 6 6" fill="none" strokeWidth="2.2" />
            </RoundButton>
          )}
        </form>
      </div>

      {historyOpen && (
        <ChatHistorySheet
          activeChatId={cache?.chatId}
          onClose={() => setHistoryOpen(false)}
          onSelect={(stored) => {
            dropQueue()
            stop()
            onLoadChat(stored)
            setHistoryOpen(false)
          }}
          onDeleteActive={() => {
            dropQueue()
            stop()
            onReset()
          }}
        />
      )}
    </div>
  )
}

function RoundButton({
  label,
  muted = false,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; muted?: boolean }) {
  return (
    <button
      {...rest}
      aria-label={label}
      className={cx(
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40',
        muted
          ? cx('border', tone.borderStrong, tone.textSecondary, tone.pressWash)
          : cx('text-white', tone.accentBg, tone.accentBgActive),
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="currentColor"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  )
}

/** Collapsible reasoning trace: a quiet caption while streaming, tappable
 * to reveal the full thought text (kept collapsed by default). */
function ReasoningTrace({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className={cx('mb-1', motion.fadeIn)}>
      <summary
        className={cx(
          'cursor-pointer list-none select-none italic [&::-webkit-details-marker]:hidden',
          type_.caption,
          tone.textMuted,
          streaming && 'animate-pulse',
        )}
      >
        {streaming ? 'Thinking…' : 'Thought process'}
      </summary>
      <p
        className={cx(
          'mb-1 mt-1 whitespace-pre-wrap border-l-2 pl-3 italic [overflow-wrap:anywhere]',
          type_.caption,
          tone.textMuted,
          tone.border,
        )}
      >
        {text}
      </p>
    </details>
  )
}

function ThinkingDots() {
  return (
    <div className={cx('flex gap-1.5 py-1', motion.fadeIn)} aria-label="Assistant is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cx('h-2 w-2 animate-pulse rounded-full', tone.accentBg, 'opacity-60')}
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </div>
  )
}
