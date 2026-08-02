/**
 * Assistant chat (opt-in). Client-only: useChat over a DirectChatTransport
 * against llm.elimelt.com, system prompt digested from the recent log.
 * Editorial voice: assistant replies are serif markdown on the page itself;
 * user turns are quiet spruce-washed bubbles.
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
  motion,
  tone,
  type_,
  useKeyboardInset,
} from '../ui'
import { modelLabel } from './config'
import { buildInstructions } from './context'
import { clearChatHistory, loadChatHistory, saveChatHistory } from './history'
import { Markdown } from './Markdown'
import { createAssistantTransport } from './transport'

// The conversation survives tab switches (module-scope Chat) and app
// restarts (IndexedDB, hydrated on first mount). Only "New chat" discards
// it; a model change re-creates the transport but keeps the messages.
let cache: { model: string; chat: Chat<UIMessage> } | null = null

function getChat(model: string, initialMessages: UIMessage[]): Chat<UIMessage> {
  if (cache?.model !== model) {
    cache = {
      model,
      chat: new Chat({
        messages: cache?.chat.messages ?? initialMessages,
        transport: createAssistantTransport(model, () =>
          buildInstructions(useAppStore.getState().entries),
        ),
      }),
    }
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

export default function ChatScreen() {
  const model = useAppStore((s) => s.appSettings.assistantModel)
  const [chat, setChat] = useState<Chat<UIMessage> | null>(() =>
    cache ? getChat(model, []) : null,
  )

  // First mount in this JS lifetime: hydrate the conversation from IndexedDB.
  useEffect(() => {
    if (cache) {
      setChat(getChat(model, []))
      return
    }
    let cancelled = false
    void loadChatHistory().then((messages) => {
      if (!cancelled) setChat(getChat(model, messages))
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
      onReset={() => {
        cache = null
        setChat(getChat(model, []))
      }}
    />
  )
}

function ChatView({
  chat,
  model,
  onReset,
}: {
  chat: Chat<UIMessage>
  model: string
  onReset: () => void
}) {
  const { messages, sendMessage, stop, status, error, clearError } = useChat({ chat })
  const [input, setInput] = useState('')
  const keyboardInset = useKeyboardInset()
  const bottomRef = useRef<HTMLDivElement>(null)

  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, status])

  // Persist each settled turn (not per-delta; streaming would hammer idb).
  useEffect(() => {
    if ((status === 'ready' || status === 'error') && messages.length > 0) {
      void saveChatHistory(messages)
    }
  }, [status, messages])

  function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setInput('')
    void sendMessage({ text: trimmed })
  }

  function newChat() {
    stop()
    void clearChatHistory()
    onReset()
  }

  return (
    <div className={cx('flex flex-col gap-4 p-4 pb-20', motion.fadeIn)}>
      <ScreenHeader
        title="Assistant"
        subtitle={modelLabel(model)}
        trailing={
          messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={newChat}>
              New chat
            </Button>
          )
        }
      />

      {messages.length === 0 && (
        <div className="mt-6 flex flex-col items-center gap-4">
          <p className={cx('px-6 text-center font-serif text-[16px] italic', tone.textMuted)}>
            Ask about your log — it reads your last seven days.
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
            <div key={m.id} className={cx('self-end', motion.riseIn)}>
              <div
                className={cx(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-3.5 py-2',
                  tone.accentWash,
                  type_.ui,
                  tone.textPrimary,
                )}
              >
                {messageText(m)}
              </div>
            </div>
          ) : (
            <div key={m.id} className={cx('self-stretch', motion.fadeIn)}>
              <Markdown>{messageText(m)}</Markdown>
            </div>
          ),
        )}
        {status === 'submitted' && <ThinkingDots />}
        {error && (
          <p className={cx(type_.sub, tone.danger)}>
            {'Something went wrong reaching the assistant. '}
            <button className="underline" onClick={clearError}>
              Dismiss
            </button>
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer: fixed above the tab bar; lifts above the iOS keyboard
          (fixed elements stay in the layout viewport in standalone mode). */}
      <div
        className={cx(
          'fixed inset-x-0 z-40 border-t px-3 py-2 backdrop-blur-xl',
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
            <RoundButton label="Stop" onClick={() => void stop()}>
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
            </RoundButton>
          ) : (
            <RoundButton label="Send" type="submit" disabled={!input.trim()}>
              <path d="M12 19V6M6 12l6-6 6 6" fill="none" strokeWidth="2.2" />
            </RoundButton>
          )}
        </form>
      </div>
    </div>
  )
}

function RoundButton({
  label,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      className={cx(
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:opacity-40',
        tone.accentBg,
        tone.accentBgActive,
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
