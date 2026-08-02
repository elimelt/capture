/**
 * Past-chat viewer: a bottom sheet listing every stored conversation,
 * filterable by local substring search. Tapping a row makes it the active
 * conversation; the small delete affordance removes a row (deleting the
 * active one also resets the chat to a fresh conversation, handled by the
 * caller via onDeleteActive).
 */
import { useEffect, useState } from 'react'
import { Button, Sheet, TextInput, cx, tone, type_ } from '../ui'
import {
  chatTitle,
  deleteChat,
  loadAllChats,
  searchChats,
  type StoredChat,
} from './history'

function shortDate(iso: string): string {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ChatHistorySheet({
  activeChatId,
  onClose,
  onSelect,
  onDeleteActive,
}: {
  activeChatId: string | undefined
  onClose: () => void
  onSelect: (chat: StoredChat) => void
  onDeleteActive: () => void
}) {
  // null = still loading; distinguishes from a genuinely empty history.
  const [chats, setChats] = useState<StoredChat[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void loadAllChats().then(setChats)
  }, [])

  const filtered = chats ? searchChats(chats, query) : []

  async function remove(id: string) {
    await deleteChat(id)
    setChats(await loadAllChats())
    if (id === activeChatId) onDeleteActive()
  }

  return (
    <Sheet title="Past chats" onClose={onClose}>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search past chats…"
        aria-label="Search past chats"
        className="w-full"
      />
      {/* Fixed height (not max-) so the sheet stays tall while typing a
          search; overscroll-contain stops rubber-banding from reaching the
          page behind. */}
      <div className="mt-2 flex h-[60dvh] flex-col overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
        {chats?.length === 0 && <EmptyNote>No past chats yet.</EmptyNote>}
        {chats && chats.length > 0 && filtered.length === 0 && (
          <EmptyNote>No matches.</EmptyNote>
        )}
        {filtered.map((c) => (
          <div
            key={c.id}
            className={cx('flex items-center gap-2 border-b last:border-b-0', tone.border)}
          >
            <button
              className={cx('min-w-0 flex-1 py-2.5 text-left', tone.pressWash)}
              onClick={() => onSelect(c)}
            >
              <p className={cx('truncate', type_.body, tone.textPrimary)}>
                {chatTitle(c.messages)}
              </p>
              <p className={cx('mt-0.5', type_.caption, tone.textMuted)}>
                {shortDate(c.updatedAt)}
                {' · '}
                {c.messages.length === 1 ? '1 message' : `${c.messages.length} messages`}
              </p>
            </button>
            <Button variant="dangerGhost" size="sm" onClick={() => void remove(c.id)}>
              Delete
            </Button>
          </div>
        ))}
      </div>
    </Sheet>
  )
}

function EmptyNote({ children }: { children: string }) {
  return (
    <p className={cx('py-6 text-center font-serif text-[15px] italic', tone.textMuted)}>
      {children}
    </p>
  )
}
