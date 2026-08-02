# Module: `src/assistant`

The opt-in AI chat assistant. It is entirely client-side: the PWA has no backend, so the
AI SDK's agent loop runs in-process in the browser against an OpenAI-compatible endpoint
(`https://llm.elimelt.com/v1`, an Ollama facade, no API key — access is origin-gated by
CORS). The agent answers questions about the user's local Capture log (entries, places)
by calling **read tools** over the zustand store and IndexedDB — it never embeds the
whole log in the prompt — and, on explicit user request, can **create or update entries**
through two narrow write tools that append ordinary capture/amend events via the store's
own actions (the single write path; the append-only log is never mutated). Conversations
are event-sourced in the `assistant-chats` system stream (SPEC §3.1, §10.1) — so they
survive iOS killing the standalone PWA *and* sync to Drive through the same manual
multi-stream cycle as everything else — and are browsable/searchable from a history
sheet. Deleting a chat is a soft-delete (`revoke`; SPEC §11).

The feature is gated by `AppSettings.assistantEnabled`; none of this code loads until the
user enables it (`ChatScreen` is imported lazily by the app shell).

Responsibilities by file:

- `config.ts` — endpoint URL, curated model list, default model.
- `context.ts` — system-prompt builder and the shared plain-text log rendering.
- `tools.ts` — the three read tools (`list_entries`, `search_entries`, `get_places`) and
  the two write tools (`create_entry`, `update_entry`), plus the `EntryWriter` boundary.
- `transport.ts` — `ChatTransport` that runs a `ToolLoopAgent` in-process and streams UI chunks.
- `chatSync.ts` — chats as events in the `assistant-chats` stream: create/append/revoke
  writers over `store/events.ts` and fold-based readers.
- `history.ts` — pure title/search helpers plus thin CRUD delegates to `chatSync.ts`.
- `sendQueue.ts` — pure state machine for mid-turn message queueing and steering.
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
  optional `id` (the entry id, so `update_entry` has something to target), optional
  `place`, `texts: string[]` (transcripts + notes in display order), `audioCount`,
  `photoCount`.
- `formatDigest(items: readonly DigestItem[]): string` — renders items grouped by day
  (`YYYY-MM-DD:` headers, blank line between days), one line per entry:
  `- HH:MM [@ place] — text1 | text2 [1 audio, 2 photos] (id …)` (the id suffix only
  when `id` is present). Empty input yields `(no entries in this period)`; an entry with
  no text and no media renders `(empty entry)`. Date and time come from string slices of
  `capturedAt` (`slice(0, 10)` / `slice(11, 16)`), never a `Date` round-trip, so the
  rendering always shows the wall-clock time the entry was captured in.
- `buildInstructions(now: Date = new Date()): string` — the system prompt: role, data
  model, tool usage guidance (which tool for which question, "ground answers in tool
  results; say so instead of guessing", and that write tools run **only when the user
  explicitly asks**), and the current local time. The time is
  **truncated to the hour** (`toLocalIso(now).slice(0, 13) + ':00'`, plus `deviceTz()`)
  so the prompt — the very start of the token stream — stays byte-identical across turns
  and tool-loop steps, keeping the server's prefix (KV) cache valid.

Uses `deviceTz`/`toLocalIso` from `../contract/time`. `formatDigest` is consumed by
`tools.ts`; `buildInstructions` is passed to the transport by `ChatScreen.tsx`.

### src/assistant/tools.ts

The tools the agent calls over the local log: three reads and two narrow writes. Data
access is injected — `createAssistantTools` takes getters plus an `EntryWriter` — so
`ChatScreen` wires the zustand store while tests inject fixtures. Only text-blob reads
(`getBlob` from `../store/events`) touch IndexedDB directly; writes go through the
injected store actions. Read tools return plain text in the `formatDigest` rendering;
write tools return a terse factual line (`Created entry <id>.` / `Updated entry <id>.`)
or an `(error: …)` line — they never throw out of `execute`.

- `LIST_ENTRIES_MAX = 300`, `SEARCH_ENTRIES_MAX = 50` — output caps; the rendered text
  appends an explicit `(truncated: …)` note when a cap is hit.
- `interface EntryWriter` — `{ capture(input), amend(input) }`, the **only** writes the
  assistant can perform. `ChatScreen` injects the store's `capture`/`amend` actions (the
  single write path); revoke, settings, sync and wipe are not injected and therefore
  unreachable from any tool call.
- `toDigestItem(entry: Entry): Promise<DigestItem>` — builds an entry's digest: loads
  each `text` attachment's blob, trims it, keeps non-empty texts; counts `audio` and
  `photo` attachments; carries `location?.placeLabel` as `place` and `entry.id` as `id`.
- `createAssistantTools(getEntries, getPlaces, writer)` — returns a `ToolSet` of AI SDK
  `tool()`s (JSON-schema inputs, async `execute` returning a string):
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
  - `create_entry({ text })` — appends one ordinary capture event: `capturedAt` = now
    (`toLocalIso`), a single trimmed `text/plain` note attachment — the same shape as the
    capture screen's "+ note" path, minus the UI-only location snapshot. Rejects
    empty/non-string text without writing.
  - `update_entry({ id, text?, time? })` — appends **one** amend event targeting an
    existing entry, the same pipeline as the UI edit path. `text` replaces the entry's
    user notes: `patch.removeAttachments` lists the existing non-derived text attachment
    files (machine-derived transcripts/captions — anything with `derivedFrom` — are never
    removed) and a new note attachment carries the trimmed text. `time` (`"HH:MM"`,
    24-hour) sets `patch.capturedAt` recomposed in the **entry's own zone** — civil date
    from `localDateOf(entry.capturedAt)` + the new time via `zonedIso(…, entry.deviceTz)`,
    exactly like `editPlan`'s `draftPatch` — never a device-zone `Date` round-trip, which
    would silently move cross-timezone entries. Validation happens before any write:
    unknown or revoked id, empty text, malformed time, or no fields at all each return an
    `(error: …)` line and append nothing.

The AI SDK executes all tool calls of one model step **concurrently**, so the write
tools serialize through a per-toolset promise chain (`enqueueWrite`): each write task —
including `update_entry`'s `getEntries()` read — starts only after the previous write
has fully landed. Without this, two updates to the same entry would both remove the same
note file and the fold would keep both replacement notes. Two concurrent `create_entry`
calls still create two entries — that is the intended meaning of two create calls.

Read results are re-sorted by `capturedAt` before rendering so `formatDigest`'s day
grouping stays coherent regardless of store order.

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

### src/assistant/chatSync.ts

Chats as a synced stream: every conversation lives in the `assistant-chats` system
stream, reusing the generic event contract and `contract/fold` **unmodified** and
writing exclusively through `store/events.ts` (the single write path), so chat events
get sync rows + blobs and the multi-stream `drainSync` pushes/pulls them like any
other stream's.

The mapping onto the entry model:

- **Create chat** = one `capture` event with no attachments; the event's `id` **is**
  the chat id from then on.
- **Every message** (including the first) = one `amend` targeting the chat id,
  carrying one `text`/`application/json` attachment whose blob is a
  `capture.chatmessage.v1` envelope — `{ schema, message: UIMessage }`, wrapping the
  third-party message shape so the payload can version independently of the `ai`
  package.
- **Delete chat** = one `revoke` (**soft-delete**, SPEC §11): the chat leaves every
  list, but its events and message blobs stay in the local log and, once synced, in
  Drive; true erasure is the same out-of-band Drive-file deletion as for any entity.

Cross-device convergence is inherited, not implemented: fold applies amends in
`compareEvents` order (seq → loggedAt → id), which is exactly message order, so two
devices appending to one chat offline converge to the same deterministic order on
every replica with zero custom merge code.

Exports:

- `CHATS_STREAM = 'assistant-chats'`, `CHAT_MESSAGE_PAYLOAD_SCHEMA = 'capture.chatmessage.v1'`,
  `interface ChatMessagePayload` — pinned against the duplicates in
  `store/migrateChatsV1.ts` by a test (store/ must not import assistant/).
- `createChat(): Promise<string>`, `appendChatMessage(chatId, message)`,
  `deleteChatStream(chatId)` — the three writers.
- `interface SyncedChat` — `{ id, createdAt, updatedAt, messages: UIMessage[] }`;
  `createdAt` is the capture's `loggedAt`, `updatedAt` the `loggedAt` of the last
  event that touched the chat.
- `loadChat(id)`, `loadAllChats()` (most recently touched first),
  `loadMostRecentChat()` — full loads; read all of the relevant chats' blobs.
- `loadChatSummaries(): Promise<ChatSummarySource[]>` — the summary source with an
  explicit **perf contract**: at most one blob read per chat (the first attachment,
  which is always the first message, for the title; `messageCount` comes free from
  `attachments.length`). Unreadable/foreign payload blobs are skipped, never thrown.
- `messagesSince(persistedCount, messages)` — pure persistence-on-settle helper for
  `ChatScreen` (the messages not yet appended), unit-testable without mounting.

### src/assistant/history.ts

Pure presentation helpers over the synced chats plus thin CRUD delegates to
`chatSync.ts` — the module keeps the API the history sheet and chat screen consume.
"New chat" starts a fresh conversation, past ones stay browsable, delete is a soft
revoke, and Settings → wipe clears the whole log (`wipeAll` in `store/events`).

- `type StoredChat = SyncedChat` — the conversation shape the UI renders.
- `interface ChatSummary` — `{ id, createdAt, updatedAt, title, messageCount }`; what the
  history list renders (no message payloads).
- `chatTitle(messages: UIMessage[]): string` — text of the first `user` message,
  truncated to 60 chars with a trailing `…`; `'New conversation'` when there is none.
- `searchChats(chats: StoredChat[], query: string): StoredChat[]` — pure, case-insensitive
  word-AND match: every whitespace-separated query word must appear somewhere in the
  conversation's concatenated text (any message, any order). Empty/whitespace query
  returns everything. Pure so the history sheet can filter as-you-type without touching idb.
- `listChats(): Promise<ChatSummary[]>` — summaries via `loadChatSummaries()` +
  `chatTitle` (inherits the ≤ one-blob-per-chat contract).
- `deleteChat(id)` — delegates to `deleteChatStream`.
- Re-exports `loadChat`, `loadAllChats`, `loadMostRecentChat` from `chatSync.ts`.

### src/assistant/sendQueue.ts

Pure state machine for mid-turn message queueing (no SDK, no I/O — fully unit-tested).
Submitting while a turn is in flight must not call `sendMessage` again: the SDK's
`AbstractChat` has no busy guard and would start a second concurrent request racing the
active stream. Instead, mid-turn submits queue FIFO and flush **one per settled turn**;
"steer" interrupts the in-flight response so a queued message sends immediately.

- `interface QueuedMessage` — `{ id, text }`.
- `interface SendQueueState` — `{ turnInFlight, queue: readonly QueuedMessage[] }`.
- `type SendQueueCommand` — `{ type: 'send', message } | { type: 'stop' }`; every
  transition returns `{ state, commands }` (`SendQueueTransition`) and the caller
  executes the commands (ChatScreen maps them to the chat's `sendMessage`/`stop`).
- `initialSendQueue(turnInFlight = false)` — `turnInFlight` seeds from the live chat
  status, because the screen can mount while a stream it started earlier (module-scope
  `Chat`) is still running.
- `submit(state, message)` — idle: emit `send`, mark in flight. Mid-turn: enqueue, no
  commands.
- `settled(state)` — the in-flight turn reached `ready`/`error` (including via
  `stop()`): flush the queue head as the next turn (emit `send`, stay in flight), or go
  idle when nothing is queued. The caller dispatches this exactly once per settle — on
  the status *transition* — which bounds sends to one per settled turn.
- `steer(state, id)` — mid-turn: promote message `id` to the queue head and emit only
  `stop`; the abort settles the turn and that settle flushes it. Every send flows
  through the same settle path, so steering cannot race the aborting stream (the SDK's
  abort handler sets status back to `ready` asynchronously; sending directly would let
  that stale transition clobber the new turn's status or double-flush the queue).
  Remaining messages keep their order and continue on later settles. Idle (the turn
  settled between render and tap): degrade to an immediate `send`. Unknown id: no-op.
- `discard(state, id)` — drop a queued message (the pending bubble's Remove action).

### src/assistant/ChatScreen.tsx

The chat UI (default export `ChatScreen()`, lazily loaded and opt-in). Wires the model
from settings, `buildInstructions`, `createAssistantTools` (getters over
`useAppStore.getState().entries` / `.places`, plus an `EntryWriter` delegating to the
store's `capture`/`amend` actions — the only writes handed to the agent), and
`createAssistantTransport` into an `@ai-sdk/react` `Chat` consumed via `useChat`.
Because writes run through the store actions, the entry list refreshes immediately and
the events queue for the normal manual sync.

Conversation lifecycle:

- A **module-scope `cache`** (`{ model, chatId, createdAt, persisted, persistedCount, chat }`)
  keeps the active `Chat` instance alive across tab switches within one JS lifetime.
  `getChat(model, seed)` returns the cached chat when model and id match; for the same
  conversation with a different model it re-creates the transport but **carries over
  the live messages** (and persistence bookkeeping); otherwise it builds a fresh
  `Chat` from the seed's stored messages (`persisted`/`persistedCount` seeded from
  `seed.messages.length`).
- On first mount in a JS lifetime, a `useEffect` hydrates the most recent conversation
  from the stream (`loadMostRecentChat`), falling back to `freshSeed()`
  (`crypto.randomUUID()` as an ephemeral id, empty messages). Until hydration resolves
  the component renders `null`.
- **Persistence**: on each settled turn (`status === 'ready'` or `'error'`, non-empty
  messages) only the messages new since the last settle (`messagesSince` over the
  cache's `persistedCount`) are appended — one `appendChatMessage` amend per message;
  never per-delta (streaming would hammer idb) and never a whole-conversation
  rewrite. The chat's capture event is minted lazily by `createChat()` on the first
  persisted turn (swapping the ephemeral seed id for the event id), so an untouched
  "New chat" never touches the log. `persistedCount` advances synchronously before
  the async writes, so a re-fired effect (StrictMode double-invoke) can't append
  duplicates and an interleaved queued turn's settle appends only its own new
  messages; the settle effect that flushes the queue is declared after the persist
  effect so the settled turn is handed to persistence before the next turn starts.
- **Mid-turn queueing** (`sendQueue.ts`): the machine state lives in a ref (the
  authority — event handlers must see post-transition state immediately) mirrored to a
  `queued` useState for rendering; `dispatch` applies a transition and executes its
  commands. A `prevStatusRef` guard dispatches `settled` only on the status transition
  into `ready`/`error` from `submitted`/`streaming` (StrictMode- and re-render-safe).
  Queued drafts are dropped — not sent — on unmount (component state), on conversation
  switch, and explicitly (`dropQueue()`) *before* the `stop()` in "New chat" / history
  select / delete-active, since the abort's own settle would otherwise flush the queue
  head into the conversation being abandoned. A plain Stop with messages queued also
  settles the turn, so the head sends next — queued means "sends when the current
  response ends, however it ends".
- **New chat** stops any in-flight stream and swaps in a fresh seed; the old conversation
  stays in history. Selecting a row in `ChatHistorySheet` loads that `StoredChat`;
  deleting the active row resets to a fresh conversation.

Rendering details:

- User turns are right-aligned bubbles of plain text (`messageText` concatenates `text`
  parts); queued (not-yet-sent) messages render after the thread as right-aligned
  dashed-border pending bubbles with a "Queued" caption, a Remove action, and — on the
  queue head while busy — a "Send now (interrupts)" steer action; assistant turns
  render reasoning parts as a collapsible `ReasoningTrace`
  ("Thinking…" while `p.state === 'streaming'`), tool parts as one-line captions, and the
  text through `Markdown`.
- `toolActivityLabel(part)` maps tool-invocation parts (both `dynamic-tool` and typed
  `tool-<name>` shapes) to captions: `Read log <from> – <to>`, `Searched the log for
  "<query>"`, `Looked up saved places`, `Added a log entry`, `Updated entry <id>`, or a
  generic fallback; returns `null` for other part types.
- `awaitingResponse(status, messages)` drives the `ThinkingDots` placeholder: `true` when
  submitted, or when streaming but the last assistant message has no non-empty text or
  reasoning yet (tool calls can run for seconds before visible content).
- Stick-to-bottom scrolling: auto-follows the stream only while the user is pinned within
  80px of the document bottom (`pinnedRef`); scrolling up detaches, scrolling down or
  sending/switching conversations re-attaches.
- The composer is `position: fixed` above the tab bar and lifts above the iOS keyboard
  using `useKeyboardInset()`; while busy the send button becomes a Stop button, and when
  the input also has text a Queue button (the form submit) appears beside it — the Stop
  button goes muted so exactly one action reads primary, and it is explicitly
  `type="button"` so stopping never also submits the form. Submitting mid-turn queues
  the message; a stopped turn keeps its partial text (the SDK's abort path sets status
  `ready` with the streamed-so-far message intact) and persists like any settled turn.
  An empty conversation shows three suggestion buttons. Errors render a dismissible
  one-liner via `clearError`.

### src/assistant/ChatHistorySheet.tsx

`ChatHistorySheet({ activeChatId, onClose, onSelect, onDeleteActive })` — a bottom sheet
(shared `Sheet` UI component) listing every stored conversation, most recent first.

- Loads all chats once on mount (`loadAllChats`); state `null` means "still loading",
  distinguishing it from a genuinely empty history ("No past chats yet.").
- Filters as-you-type with the pure `searchChats` (no idb per keystroke); shows
  "No matches." when the filter empties a non-empty list.
- Each row shows `chatTitle`, a short date (time-of-day if updated today, else
  `Mon D`), and the message count; tapping a row calls `onSelect(chat)`.
- Delete appends a `revoke` (soft-delete — the events stay in the log and on Drive) and
  reloads the list; deleting the active conversation additionally calls `onDeleteActive`
  so the caller resets to a fresh chat.
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

### src/assistant/chatSync.test.ts

Covers the stream mapping end to end against fake-indexeddb (with only `Date` faked so
timestamps are controllable): the registry pin (`assistant-chats` ∈ `SYSTEM_STREAMS`)
and the constant pin against `store/migrateChatsV1.ts`; `messagesSince` unit cases;
capture-with-no-attachments chat creation (event id = chat id); message-order
preservation across N appends; `loadAllChats`/`loadMostRecentChat` last-touched
ordering; createdAt/updatedAt stamping; unreadable-payload tolerance; soft-delete
(revoked chats leave every list while `listEvents` and the message blobs keep
everything, plus the new revoke); cross-device offline-append merge via `importEvents`
with a colliding seq converging in `compareEvents` order with no dupes/drops (and
idempotent re-import, and post-merge local appends landing last); the summaries perf
contract (a `getBlob` spy asserts ≤ one blob read per chat for `loadChatSummaries`
and `listChats`); a golden byte-for-byte `capture.chatmessage.v1` envelope test
including a `dynamic-tool` (tool-invocation) part; and the fresh-install migration
marker.

### src/assistant/history.test.ts

Covers `chatTitle` (first user message, truncation, fallbacks), `searchChats` (word-AND,
case-insensitive, cross-message), CRUD round-trips against the event-sourced backing
(append-by-message round-trip, sorted summaries, most-recent hydration, revoke-delete
leaving the log intact, erasure by `wipeAll`), and the composed migration of the legacy
single conversation: `meta['assistant:chat']` → v3 `chats` row → `assistant-chats`
stream events, with the intermediate row kept as the rollback artifact.

### src/assistant/sendQueue.test.ts

Covers the pure machine: immediate send when idle; mid-turn submits enqueue FIFO with
no send command; `settled` flushing exactly the queue head, draining one message per
settle in order, and going idle on an empty queue; a flushed message never re-sending
on later settles; steer promoting any queued message to the head with only a `stop`
command, the subsequent settle sending it first and the rest continuing in order, the
idle degradation to an immediate send, and unknown-id no-ops; `discard` removal and
unknown-id no-op. Input states are frozen, so transitions are verified non-mutating.

### src/assistant/tools.test.ts

Covers all five tools with injected fixture getters, a recording `EntryWriter` mock, and
fake-indexeddb blobs. Reads: inclusive local-date range filtering, revoked-entry
exclusion, text-blob reads, the `(id …)` suffix, empty-result messages, and both
truncation caps with their notes. Writes: create happy path (one capture event, trimmed
note blob, local-ISO `capturedAt`, id in the result); update happy paths (note
replacement preserving derived transcripts, time-of-day patch in the entry's own zone —
including a cross-timezone Asia/Tokyo entry — both combined in a single amend event);
a concurrency test that fires two simultaneous `update_entry` calls at one entry against
a writer that folds a real event log, asserting the fold converges to exactly one note;
and every rejection — unknown id, revoked entry, empty text, malformed time, no fields —
asserting that **nothing** is appended; plus write failures surfacing as `(error: …)`
text rather than throws.

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
- **Write boundary**: the agent's only writes are `EntryWriter.capture`/`amend` — the
  store actions `ChatScreen` injects. Each successful write tool call appends exactly one
  ordinary `capture`/`amend` event through the store's single write path (append-only log
  preserved, UI refreshed, event queued for manual sync); revoke, settings, sync and wipe
  are never injected. Write tools validate first and return `(error: …)` text — never
  throw, never append on invalid input. `update_entry` never removes machine-derived
  attachments (`derivedFrom` set), mirroring the UI edit path.
- **Writes are serialized**: tool calls in one model step run concurrently in the SDK,
  so write executions queue through `enqueueWrite` — each reads the log state the
  previous write produced. Time edits recompose `capturedAt` in the entry's own
  `deviceTz` (`zonedIso`), never the device zone.
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
- **One request at a time**: the SDK's `AbstractChat.sendMessage` has no busy guard —
  calling it mid-stream starts a second concurrent request racing the first. All sends
  go through the `sendQueue` machine: mid-turn submits queue and flush one per settled
  turn, and steering emits `stop` and lets the abort's settle do the send (never a
  direct send racing the aborting stream). Queued messages are drafts: dropped on
  unmount, conversation switch, and delete — never sent to an abandoned conversation.
- **Stopping keeps partial turns**: `stop()` aborts the active response; the SDK keeps
  the streamed-so-far assistant message and sets status `ready`, so the partial turn
  persists like any settled turn. Aborting mid-tool-call cannot deadlock the write
  tools' `enqueueWrite` chain — in-flight `execute` promises settle on their own and
  the chain continues past rejections.
- **Persistence cadence**: chats are persisted only on settled turns (`ready`/`error`) —
  one amend event per newly-settled message — so a mid-stream app kill loses the
  in-flight assistant turn. Timestamps derive from event `loggedAt`, not caller
  arguments.
- **Chats sync like everything else**: chat events live in the `assistant-chats`
  stream and ride the ordinary manual multi-stream sync — no chat-specific sync code,
  no automatic triggers. A pull that imports another device's messages shows up on the
  next conversation load/mount, not live.
- **Chat deletion is soft** (SPEC §11): `deleteChatStream` appends a `revoke`; the
  conversation's events and blobs remain in the local log and in Drive. True erasure
  is manual Drive-file deletion, as for every other entity.
- **`search_entries` cost**: it reads every non-revoked entry's text blobs from
  IndexedDB on each call — fine at personal-log scale, but it is a full scan.
- **Module-scope chat cache** in `ChatScreen.tsx` means the active conversation survives
  tab switches but is per-JS-lifetime; a model change re-creates the transport while
  keeping live messages of the same conversation.
