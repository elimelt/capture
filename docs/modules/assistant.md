# Module: `src/assistant`

The opt-in AI chat assistant. It is entirely client-side: the PWA has no backend, so the
AI SDK's agent loop runs in-process in the browser against an OpenAI-compatible endpoint
(`https://llm.elimelt.com/v1`, an Ollama facade, no API key — access is origin-gated by
CORS). The agent answers questions about the user's local Timebox log (entries, places)
by calling **read-only tools** over the zustand store and IndexedDB; it never embeds the
whole log in the prompt. Conversations are persisted to the IndexedDB `chats` store so
they survive iOS killing the standalone PWA, and are browsable/searchable from a history
sheet.

The feature is gated by `AppSettings.assistantEnabled`; none of this code loads until the
user enables it (`ChatScreen` is imported lazily by the app shell).

Responsibilities by file:

- `config.ts` — endpoint URL, curated model list, default model.
- `context.ts` — system-prompt builder and the shared plain-text log rendering.
- `tools.ts` — the three read-only tools (`list_entries`, `search_entries`, `get_places`).
- `transport.ts` — `ChatTransport` that runs a `ToolLoopAgent` in-process and streams UI chunks.
- `history.ts` — chat persistence (IndexedDB `chats` store) plus pure title/search helpers.
- `ChatScreen.tsx` — the chat UI, wiring everything above together.
- `ChatHistorySheet.tsx` — bottom sheet listing/searching/deleting past conversations.
- `Markdown.tsx` — markdown renderer for assistant replies.

## File-by-file

### src/assistant/config.ts

Static assistant configuration.

- `ASSISTANT_BASE_URL = 'https://llm.elimelt.com/v1'` — the OpenAI-compatible endpoint.
- `ASSISTANT_MODELS` — curated list of models known to exist on the endpoint; the first
  entry is the default. Currently a single entry: `gpt-oss:20b` ("GPT-OSS 20B"), the only
  hosted model that emits well-formed `tool_calls`, which the assistant relies on to read
  the log.
- `DEFAULT_ASSISTANT_MODEL: string` — `ASSISTANT_MODELS[0].id`. Must stay equal to
  `APP_DEFAULTS.assistantModel` in `store/settings.ts`; the settings store must not import
  from `assistant/`, so the pairing is enforced by tests on both sides (see
  `context.test.ts`).
- `modelLabel(id: string): string` — human label for a model id, falling back to the id.

### src/assistant/context.ts

System prompt and shared log rendering. Everything here is pure formatting (no blob I/O —
that lives in `tools.ts`), so it tests without IndexedDB.

- `interface DigestItem` — one entry's digest view: `capturedAt` (local ISO with offset),
  optional `place`, `texts: string[]` (transcripts + notes in display order),
  `audioCount`, `photoCount`.
- `formatDigest(items: readonly DigestItem[]): string` — renders items grouped by day
  (`YYYY-MM-DD:` headers, blank line between days), one line per entry:
  `- HH:MM [@ place] — text1 | text2 [1 audio, 2 photos]`. Empty input yields
  `(no entries in this period)`; an entry with no text and no media renders
  `(empty entry)`. Date and time come from string slices of `capturedAt`
  (`slice(0, 10)` / `slice(11, 16)`), never a `Date` round-trip, so the rendering always
  shows the wall-clock time the entry was captured in.
- `buildInstructions(now: Date = new Date()): string` — the system prompt: role, data
  model, tool usage guidance (which tool for which question, "ground answers in tool
  results; say so instead of guessing"), and the current local time. The time is
  **truncated to the hour** (`toLocalIso(now).slice(0, 13) + ':00'`, plus `deviceTz()`)
  so the prompt — the very start of the token stream — stays byte-identical across turns
  and tool-loop steps, keeping the server's prefix (KV) cache valid.

Uses `deviceTz`/`toLocalIso` from `../contract/time`. `formatDigest` is consumed by
`tools.ts`; `buildInstructions` is passed to the transport by `ChatScreen.tsx`.

### src/assistant/tools.ts

The read-only tools the agent calls over the local log. Data access is injected —
`createAssistantTools` takes getters — so `ChatScreen` wires the zustand store while
tests inject fixtures. Only text-blob reads (`getBlob` from `../store/events`) touch
IndexedDB. All tools return plain text in the `formatDigest` rendering.

- `LIST_ENTRIES_MAX = 300`, `SEARCH_ENTRIES_MAX = 50` — output caps; the rendered text
  appends an explicit `(truncated: …)` note when a cap is hit.
- `toDigestItem(entry: Entry): Promise<DigestItem>` — builds an entry's digest: loads
  each `text` attachment's blob, trims it, keeps non-empty texts; counts `audio` and
  `photo` attachments; carries `location?.placeLabel` as `place`.
- `createAssistantTools(getEntries: () => readonly Entry[], getPlaces: () => readonly Place[])`
  — returns a `ToolSet` with three AI SDK `tool()`s (JSON-schema inputs, async `execute`
  returning a string):
  - `list_entries({ from, to })` — entries whose local capture date (a
    `capturedAt.slice(0, 10)` string compare) falls in the inclusive `YYYY-MM-DD` range.
    Skips revoked entries. Keeps the **newest** `LIST_ENTRIES_MAX` (`slice(-MAX)`) when
    over the cap.
  - `get_places({})` — the user's saved places as `- Name (radius N m)` lines, or
    `(no saved places)`.
  - `search_entries({ query })` — case-insensitive substring search over all entry texts
    in the whole log (loads every non-revoked entry's text blobs). Keeps the **first**
    `SEARCH_ENTRIES_MAX` matches in store order but counts the true total; returns
    `(no entries matching "…")` when nothing matches.

Results are re-sorted by `capturedAt` before rendering so `formatDigest`'s day grouping
stays coherent regardless of store order.

### src/assistant/transport.ts

Client-side chat transport around the AI SDK.

- `createAssistantTransport(modelId: string, instructions: () => string | Promise<string>, tools: ToolSet = {}): ChatTransport<UIMessage>`
  — returns a transport whose `sendMessages` constructs, per call, a `ToolLoopAgent`
  (model from a `createOpenAICompatible` provider, freshly-awaited `instructions`, the
  given `tools`) wrapped in the AI SDK's `DirectChatTransport`, which runs the agent
  in-process and yields a `ReadableStream` of UI message chunks. `reconnectToStream`
  always resolves `null` (nothing server-side to reconnect to).

Notable behaviors:

- **Instructions are re-built per message** (the `instructions` thunk is awaited inside
  `sendMessages`) so the current-time line in the system prompt stays fresh.
- **`user-agent` header stripping** (`assistantFetch`): the AI SDK appends attribution
  suffixes to `user-agent`; browsers that honor a caller-set user-agent include it in the
  CORS preflight, and llm.elimelt.com only allowlists `Content-Type, Authorization`, so
  the request would die before a single byte streams. The custom fetch deletes the header
  at the fetch boundary.
- **Reasoning effort**: for `gpt-oss*` models only, `providerOptions.openaiCompatible.reasoningEffort`
  is set to `'low'` (the server rejects the knob for non-thinking models). Low cuts warm
  first-content latency from ~24s to ~7s and, in testing, dated "yesterday" more reliably
  than high.
- **Debug logging** (`DEBUG`, `tapStream`): on localhost only, requests/responses and each
  stream chunk are logged with timing (first text-delta latency, per-chunk types, final
  delta count); off localhost `tapStream` is a pass-through.
- The `DirectChatTransport` is cast to `ChatTransport<UIMessage>`: it defaults to
  `UIMessage<unknown, never, …>` (no data parts), and this chat uses the plain `UIMessage`
  shape (text plus generic tool parts), so the widening is safe.

### src/assistant/history.ts

Chat persistence over the IndexedDB `chats` store (via `getDb()` from `../store/db`; the
store itself and the v2→v3 migration live there). Each conversation is one row; "New
chat" starts a fresh row, past rows stay browsable, and Settings → wipe clears the store
wholesale (`wipeAll` in `store/events`).

- `interface StoredChat` — `{ id, createdAt, updatedAt, messages: UIMessage[] }`;
  timestamps are ISO local time and the **caller** bumps `updatedAt` on every save.
- `interface ChatSummary` — `{ id, createdAt, updatedAt, title, messageCount }`; what the
  history list renders (no message payloads).
- `chatTitle(messages: UIMessage[]): string` — text of the first `user` message,
  truncated to 60 chars with a trailing `…`; `'New conversation'` when there is none.
- `searchChats(chats: StoredChat[], query: string): StoredChat[]` — pure, case-insensitive
  word-AND match: every whitespace-separated query word must appear somewhere in the
  conversation's concatenated text (any message, any order). Empty/whitespace query
  returns everything. Pure so the history sheet can filter as-you-type without touching idb.
- `loadChat(id): Promise<StoredChat | undefined>`, `saveChat(chat): Promise<void>`
  (upsert), `deleteChat(id): Promise<void>`.
- `loadAllChats(): Promise<StoredChat[]>` — all rows sorted by `updatedAt` descending.
- `listChats(): Promise<ChatSummary[]>` — summaries in the same order.
- `loadMostRecentChat(): Promise<StoredChat | undefined>` — boot hydration ("pick up
  where the user left off").

### src/assistant/ChatScreen.tsx

The chat UI (default export `ChatScreen()`, lazily loaded and opt-in). Wires the model
from settings, `buildInstructions`, `createAssistantTools` (getters over
`useAppStore.getState().entries` / `.places`), and `createAssistantTransport` into an
`@ai-sdk/react` `Chat` consumed via `useChat`.

Conversation lifecycle:

- A **module-scope `cache`** (`{ model, chatId, createdAt, chat }`) keeps the active
  `Chat` instance alive across tab switches within one JS lifetime. `getChat(model, seed)`
  returns the cached chat when model and id match; for the same conversation with a
  different model it re-creates the transport but **carries over the live messages**;
  otherwise it builds a fresh `Chat` from the seed's stored messages.
- On first mount in a JS lifetime, a `useEffect` hydrates the most recent conversation
  from IndexedDB (`loadMostRecentChat`), falling back to `freshSeed()`
  (`crypto.randomUUID()`, empty messages). Until hydration resolves the component renders
  `null`.
- **Persistence**: each settled turn (`status === 'ready'` or `'error'`, non-empty
  messages) is saved via `saveChat` with a bumped `updatedAt` — not per-delta, since
  streaming would hammer idb.
- **New chat** stops any in-flight stream and swaps in a fresh seed; the old conversation
  stays in history. Selecting a row in `ChatHistorySheet` loads that `StoredChat`;
  deleting the active row resets to a fresh conversation.

Rendering details:

- User turns are right-aligned bubbles of plain text (`messageText` concatenates `text`
  parts); assistant turns render reasoning parts as a collapsible `ReasoningTrace`
  ("Thinking…" while `p.state === 'streaming'`), tool parts as one-line captions, and the
  text through `Markdown`.
- `toolActivityLabel(part)` maps tool-invocation parts (both `dynamic-tool` and typed
  `tool-<name>` shapes) to captions: `Read log <from> – <to>`, `Searched the log for
  "<query>"`, `Looked up saved places`, or a generic fallback; returns `null` for other
  part types.
- `awaitingResponse(status, messages)` drives the `ThinkingDots` placeholder: `true` when
  submitted, or when streaming but the last assistant message has no non-empty text or
  reasoning yet (tool calls can run for seconds before visible content).
- Stick-to-bottom scrolling: auto-follows the stream only while the user is pinned within
  80px of the document bottom (`pinnedRef`); scrolling up detaches, scrolling down or
  sending/switching conversations re-attaches.
- The composer is `position: fixed` above the tab bar and lifts above the iOS keyboard
  using `useKeyboardInset()`; while busy the send button becomes a Stop button. An empty
  conversation shows three suggestion buttons. Errors render a dismissible one-liner via
  `clearError`.

### src/assistant/ChatHistorySheet.tsx

`ChatHistorySheet({ activeChatId, onClose, onSelect, onDeleteActive })` — a bottom sheet
(shared `Sheet` UI component) listing every stored conversation, most recent first.

- Loads all chats once on mount (`loadAllChats`); state `null` means "still loading",
  distinguishing it from a genuinely empty history ("No past chats yet.").
- Filters as-you-type with the pure `searchChats` (no idb per keystroke); shows
  "No matches." when the filter empties a non-empty list.
- Each row shows `chatTitle`, a short date (time-of-day if updated today, else
  `Mon D`), and the message count; tapping a row calls `onSelect(chat)`.
- Delete removes the row from idb and reloads the list; deleting the active conversation
  additionally calls `onDeleteActive` so the caller resets to a fresh chat.
- The list has a fixed height (`h-[60dvh]`, not max-) so the sheet stays tall while
  typing a search; `overscroll-contain` stops rubber-banding from reaching the page.

### src/assistant/Markdown.tsx

`Markdown({ children }: { children: string })` — renders assistant replies with
`react-markdown` + `remark-gfm` (lists, tables), using app design tokens (serif body,
quiet chrome for code/quotes/tables). Component overrides: `h1`/`h2`/`h3` all render as
a uniform `<h3>` heading; links open in a new tab with `rel="noreferrer"`; `code`
distinguishes block code (language `className` present, inside `<pre>`) from inline code;
tables wrap in a horizontally scrollable container. The wrapper div uses
`[overflow-wrap:anywhere]` so long tokens can't break the layout.

### src/assistant/context.test.ts

Covers `formatDigest` rendering (empty log, day grouping, time/place/text/media layout,
`(empty entry)`), `buildInstructions` content and its hour-truncation prefix-cache
stability, plus the config↔settings pin: `DEFAULT_ASSISTANT_MODEL` is on the curated
list and equals the settings default.

### src/assistant/history.test.ts

Covers `chatTitle` (first user message, truncation, fallbacks), `searchChats` (word-AND,
case-insensitive, cross-message), CRUD round-trips against fake-indexeddb (upsert, sorted
summaries, most-recent hydration, delete, erasure by `wipeAll`), and the v2→v3 migration
of the legacy single conversation from the `meta` store key `assistant:chat` into a
`chats` row.

### src/assistant/tools.test.ts

Covers the three tools with injected fixture getters and fake-indexeddb blobs: inclusive
local-date range filtering, revoked-entry exclusion, text-blob reads, empty-result
messages, and both truncation caps with their notes.

### src/assistant/transport.integration.test.ts

Live end-to-end test against the real llm.elimelt.com endpoint: asserts genuine streaming
(ordered lifecycle chunks, ≥5 text-deltas spread over >50ms rather than one final burst,
model `llama3.2:3b`) and the client-side tool loop on `gpt-oss:20b` (`tool-input-start` /
`tool-input-available` / `tool-output-available` chunks flow through the UI stream and the
answer is grounded in the tool result). Network-dependent, so it is excluded from
`npm test` — `vite.config.ts` excludes `**/*.integration.test.ts` unless
`VITEST_INTEGRATION=1` — and run via `npm run test:integration`, which sets that flag and
targets just this file.

## Key invariants & gotchas

- **No server**: the agent loop (`ToolLoopAgent` + `DirectChatTransport`) runs in the
  browser. Tools execute client-side against local data; nothing but the chat request
  ever leaves the device, and the endpoint needs no API key (CORS origin gating).
- **Prefix-cache stability**: `buildInstructions` truncates the current time to the hour
  so the system prompt is byte-identical across turns within an hour; changing the prompt
  invalidates the server's KV cache and forces a full re-prefill.
- **Wall-clock time by string slicing**: `capturedAt` is local ISO with offset and is
  sliced for date (`0,10`) and time (`11,16`) — never round-tripped through `Date` — so
  renderings and range filters use the wall-clock time at capture, not the viewer's zone.
- **CORS user-agent strip**: removing the AI SDK's `user-agent` suffix in
  `assistantFetch` is load-bearing; without it the preflight fails against
  llm.elimelt.com and no bytes stream.
- **Config/settings pin**: `DEFAULT_ASSISTANT_MODEL` must equal
  `APP_DEFAULTS.assistantModel` in `store/settings.ts`; the store must not import from
  `assistant/`, so tests on both sides enforce the pairing.
- **Revoked entries** are always filtered out by both `list_entries` and
  `search_entries`.
- **Truncation semantics differ**: `list_entries` keeps the *newest* 300 in range;
  `search_entries` keeps the *first* 50 matches in store order (while reporting the true
  total). Both say so in the returned text.
- **Persistence cadence**: chats are saved only on settled turns (`ready`/`error`), so a
  mid-stream app kill loses the in-flight assistant turn; `updatedAt` is set by the
  caller, not by `saveChat`.
- **`search_entries` cost**: it reads every non-revoked entry's text blobs from
  IndexedDB on each call — fine at personal-log scale, but it is a full scan.
- **Module-scope chat cache** in `ChatScreen.tsx` means the active conversation survives
  tab switches but is per-JS-lifetime; a model change re-creates the transport while
  keeping live messages of the same conversation.
