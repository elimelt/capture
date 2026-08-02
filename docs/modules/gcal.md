# Module: `src/gcal`

The read-only Google Calendar layer for the timelog stream (SPEC §4.2/§4.3, milestone
M4 "read-back"). It lets the user pick a **target calendar** in Settings and shows that
calendar's events on the Day view, so the outcome of the external timelog skill (which
writes events to the calendar) is visible in the app. The app **never writes or edits
calendar events** (SPEC §1.2) — every mutation happens in Google Calendar itself, via
the `htmlLink` deep link on each rendered event.

Like `src/drive`, there is no `gapi` client: all Calendar API v3 calls are plain
`fetch` with a Bearer token. The token is the app's **single Google token** from
`src/drive/token` — `GOOGLE_SCOPES` in `src/config.ts` bundles `drive.file` +
`calendar.readonly` into one GIS consent (see `src/drive/auth.ts`), so `gcal` does no
auth of its own; callers pass the token in, exactly as with `drive/client`.

Data flow: Settings' `CalendarPicker` lists calendars via `listCalendars` and persists
the pick via `setTargetCalendar` (local `meta` row + Drive `config.json` mirror) → the
Day view's `useDayEvents` hook (`src/dayview`) resolves token + target and calls
`listEvents` over the `dayRange(date)` window → `DayTimeline` (`src/dayview`, see
[capture-and-dayview.md](capture-and-dayview.md)) merges the events with their
overlays into pseudo-entry cards on the day's timeline.

Layering (SPEC §10, enforced by `src/layering.test.ts`): `gcal/` is timelog-specific.
It may import the generic `contract/`, `drive/`, `store/`, and `streams/` layers —
never the reverse.

## File-by-file

### src/gcal/events.ts

The pure, fetch-free event model shared by the client and the Day view: normalizes the
Calendar API's two time shapes (timed `dateTime` vs all-day `date`) into epoch ms,
orders events, and builds the local-day query window.

Key exports:

- `interface CalendarSummary { id: string; summary: string; primary: boolean }` — a calendar-list entry for the Settings picker.
- `interface CalEvent { id: string; summary: string; htmlLink?: string; startMs: number; endMs: number; allDay: boolean; updated?: string; recurringEventId?: string }` — a normalized event; `startMs` is the ordering + render key. `updated` (the API's last-modification stamp) and `recurringEventId` (parent series id of an expanded instance) exist for the overlay layer (SPEC §3.6).
- `interface RawEventTime { dateTime?: string; date?: string }` and `interface RawEvent { id?; summary?; htmlLink?; status?; start?; end?; updated?; recurringEventId? }` — the subset of the API resource that is read.
- `parseEvent(raw: RawEvent): CalEvent | null` — `null` for unusable events: cancelled (`status === 'cancelled'`), id-less, or missing a parseable start/end. `allDay` is true when `start.date` is present; summary is trimmed with a `'(no title)'` fallback; `htmlLink`, `updated`, and `recurringEventId` are omitted (not `undefined`-valued) when absent.
- `parseEvents(raw: RawEvent[]): CalEvent[]` — maps + drops nulls; does **not** reorder (the API is asked to sort).
- `sortEvents(events: CalEvent[]): CalEvent[]` — stable copy ordered by `startMs`, then `endMs`.
- `dayRange(date: string): { timeMin: string; timeMax: string }` — the `[timeMin, timeMax)` RFC-3339 window covering one local calendar date, rendered with the device UTC offset via `contract/time#toLocalIso` so the API returns that day's events in the user's zone.

Edge case: all-day dates (`"YYYY-MM-DD"`) are parsed as `` `${date}T00:00:00` `` —
local midnight — because a bare `new Date("YYYY-MM-DD")` is parsed as UTC and would
land the event on the wrong day in western timezones.

### src/gcal/client.ts

Thin Calendar API v3 layer over `fetch` + Bearer token, mirroring `drive/client.ts` —
only the two read endpoints the app needs.

Key exports:

- `class CalendarError extends Error` — carries `status: number`; getters `isAuth` (401/403 → token expired or calendar scope not granted: prompt reconnect) and `isRetryable` (429 or ≥500 → transient). Thrown by both helpers on a non-OK response, with the message extracted from the JSON error body when available.
- `listCalendars(token: string): Promise<CalendarSummary[]>` — `GET /users/me/calendarList` with `minAccessRole=reader`, `maxResults=250`, and a `fields` filter that also requests `nextPageToken`; follows it in a `do…while` loop (mirroring `drive/client.ts#listChildren`) so a user with more than 250 readable calendars still sees all of them. Entries without an `id` are dropped; `summary` falls back to the id when blank; `primary` defaults to `false`.
- `interface ListEventsArgs { calendarId: string; timeMin: string; timeMax: string }` — window bounds are RFC-3339; use `events.dayRange()` to build them.
- `listEvents(token, { calendarId, timeMin, timeMax }): Promise<CalEvent[]>` — `GET /calendars/{id}/events` with `singleEvents=true` (recurring events expanded server-side into concrete instances), `orderBy=startTime`, `maxResults=250`, and a `fields` filter that includes `updated`, `recurringEventId`, and `nextPageToken` (the overlay layer's dirty-check fast path and instance identity — SPEC §3.6). Follows `nextPageToken` across pages before returning, concatenating items so a dense day (all-day + recurring expansions past 250 instances) isn't silently truncated. `calendarId` is `encodeURIComponent`-ed in the path (ids contain `@` and can contain `/`). The full concatenated item list is run through `parseEvents` + `sortEvents`.

### src/gcal/config.ts

Target-calendar selection (SPEC §4.3, §5.3). Two layers of truth, in priority order:

1. a local `meta` row (key `gcal:targetCalendar`) — instant, offline, the Day view's
   source of truth;
2. `skillConfig.targetCalendar` inside the stream's `config.json` on Drive — the
   durable copy a skill or another device reads back.

Key exports:

- `interface TargetCalendar { id: string; summary: string }`.
- `getTargetCalendar(): Promise<TargetCalendar | undefined>` — the locally-cached pick, or `undefined` if none chosen yet.
- `resolveTargetSelection(stored: TargetCalendar | undefined, calendars: CalendarSummary[]): { selectedId: string; autoPick: TargetCalendar | undefined }` — **pure** "should we auto-pick?" decision behind the Settings picker. A stored target always wins and is never re-persisted (`autoPick` undefined — no redundant writes on repeat visits), even if momentarily absent from the fetched list; with nothing stored, the primary calendar is both selected and returned as `autoPick` for the caller to persist immediately; with nothing stored and no primary, the placeholder stays (`selectedId: ''`) and nothing is persisted. Extracted pure to pin the regression where the picker displayed the primary calendar as selected without persisting it, so the Day view stayed on `no-calendar` until the user manually switched calendars.
- `mergeTargetCalendar(stream: string, currentText: string | undefined, target: TargetCalendar): string` — **pure** read-modify-write of a `config.json` body, exported for testing without Drive: sets `skillConfig.targetCalendar` while preserving every other `skillConfig` field and `userNotes`. A missing, corrupt, or wrong-schema body falls back to a fresh stub for the stream. Output goes through `contract/files#serializeStreamConfig` (fixed key order, trailing newline).
- `setTargetCalendar(token: string, target: TargetCalendar): Promise<void>` — saves locally **first** (the pick is never lost), then best-effort mirrors into Drive: `ensureTree` (shared idempotent bootstrap, so `config.json` exists) → `findFile('config.json')` → `readFileText` → `mergeTargetCalendar` → `updateFileContent`. A missing stream folder or file returns quietly after the local save; a Drive error propagates **after** the local save so the UI can warn ("Saved on this device; will sync to Drive later") while the Day view still works.

### src/gcal/overlay/ — calendar-overlay pseudo-entries (SPEC §3.6, §5.6)

Local annotations over the read-only calendar events: a third append-only log (stream
`calendar-overlay`, schema `capture.calendar-overlay.v1`) that lets the Day view
retitle, annotate, re-time, or hide a calendar event without ever writing to Google
(SPEC §1.2 — the scope stays `calendar.readonly`). Deliberately **not** part of
`capture.event.v1` (contract/ stays domain-free and skill-facing) and **never read by
any skill**. The log is **local-only** today: no sync rows are written, it is not in
`allSyncStreams()`, and Drive wiring is deferred — unlike the system streams, it does
not reuse the `capture.event.v1` envelope/stores, so the multi-stream sync engine
needs overlay-aware wiring before it can carry it. The Day view consumes this module
through `src/dayview` (`DayTimeline` / `PseudoEntryCard` / `EditPseudoEntrySheet` /
`useOverlays` — see [capture-and-dayview.md](capture-and-dayview.md)).

- `overlay/types.ts` — `OVERLAY_SCHEMA` / `OVERLAY_STREAM`; `CalendarEventRef`
  (instance-level `{calendarId, eventId, recurringEventId?}` — `singleEvents=true`
  means occurrence ids arrive pre-expanded); `OverlayBaseSnapshot` (field-level
  copy-on-write base `{summary, startMs, endMs, allDay, updated?}` — not a hash,
  because dirty detection must say *which* field moved; `updated` is the Calendar API
  stamp used as an equality fast path); `OverlayPatch` (`title`/`note`/`startAt`/
  `endAt`/`hidden`, each value with a `clearX` sibling mirroring
  `AmendPatch.clearLocation`; times are local-offset ISO-8601); the three event types
  `OverlayCreateEvent` (`type: 'overlay'`, freezes the snapshot + first patch),
  `OverlayAmendEvent`, `OverlayRevokeEvent`, union `OverlayLogEvent`; and the folded
  `OverlayState` (never serialized; its accumulated `patch` never carries `clearX`).
- `overlay/fold.ts` — `foldOverlay(events, {includeRevoked?})` with the same
  seq → loggedAt → id total order as `contract/fold.ts` (`compareOverlayEvents` is
  deliberately a local duplicate — the contract-critical comparator is not
  imported/widened). Amends merge **field-by-field** into the accumulated patch (a
  later "add note" never clobbers an earlier "override title"); a value beats its
  `clearX` within the same amend; `clearTime` is ignored when `startAt`/`endAt` is
  present; amend/revoke on a revoked overlay and unknown targets are no-ops. Also
  `overlayKey(ref)` (`` `${calendarId}::${eventId}` ``) and
  `indexOverlaysByTarget(states)` (later state wins duplicate targets).
- `overlay/serialize.ts` — `serializeOverlayEvent` / `parseOverlayEvent`, same wire
  conventions as `contract/serialize.ts` (fixed key order — envelope, then
  `target`/`baseSnapshot`/`patch` — 2-space indent, trailing newline, optional fields
  omitted, `clearX` omitted when its value is present). Byte-pinned by golden-file
  tests now so nothing changes when the log starts syncing.
- `overlay/pseudoEntry.ts` — `mergePseudoEntry(calendarId, base?, overlay?)`: the
  **pure, read-only** merge of one live `CalEvent` with its `OverlayState` into a
  `PseudoEntry` (id = overlay id when materialized, else `cal:<calendarId>:<eventId>`).
  THE rule: the patch value wins per field, otherwise the **live** base wins — never
  the frozen snapshot — so upstream calendar edits auto-merge for free. `dirtyFields`
  (`'title' | 'time'`) = fields the patch touches where the live base moved off the
  snapshot; any ⇒ `dirty: 'conflict'` (informational — the user's edit still renders),
  base movement only on untouched fields ⇒ `'auto-merged'`, else `'clean'`. A revoked
  overlay is treated as absent; overlay-without-base renders from the snapshot as
  `orphaned` (and classifies clean — nothing to diff).
- `overlay/buildPseudoEntries.ts` — `buildPseudoEntries(calendarId, calEvents,
  overlays, date)`: matches overlays to events by `eventId` within `calendarId`
  (overlays for other calendars are ignored; recurring instances are independent),
  includes unmatched overlays as orphans only when their effective date equals `date`,
  drops `hidden` entries, sorts by effective start. **Callers must only pass real
  data when the fetch state is `'ready'`** — orphan detection against a loading/error
  state would be all false positives.
- `overlay/overlayPlan.ts` — pure edit-sheet planning: `OverlayDraft`,
  `draftFromPseudoEntry(entry)`, `overlayPatchFromDraft(original, edited)` (minimal
  diff; **`undefined` = the no-op guard** — an unedited draft never materializes an
  empty overlay; emptied title/note map to `clearTitle`/`clearNote`), and
  `toggleHidden(entry)`.
- `overlay/store.ts` — the only writer of the overlay log, mirroring
  `src/store/events.ts` in miniature but living under `gcal/` (store/ must never
  import gcal/): `appendOverlayCreate` / `appendOverlayAmend` / `appendOverlayRevoke`
  (atomic append: `meta` counter `nextSeq:calendar-overlay` — the same per-stream
  mechanism as capture streams, its own seq space — plus the event row in one
  transaction against the `overlayEvents` store), `listOverlayEvents()` (log order),
  `listOverlayStates()` (the fold). Rows are opaque to `store/db.ts`
  (`OverlayEventRow`); this module owns the strong typing. `wipeAll()`
  (`src/store/events.ts`) clears `overlayEvents` too.

### Test files

- `src/gcal/events.test.ts` — covers `parseEvent` normalization (epoch-ms conversion, all-day at local midnight, `(no title)` fallback, `htmlLink` omission), the dropping of cancelled/id-less/time-less events, threading + omission of `updated`/`recurringEventId`, `sortEvents` ordering, and `dayRange`'s local-midnight boundaries.
- `src/gcal/overlay/fold.test.ts` — create/amend/revoke folding, field-wise merge across amends, per-field `clearX`-vs-value precedence (alone and combined), amend/revoke-after-revoke and unknown-target no-ops, `includeRevoked`, and seq/loggedAt/id tiebreak determinism under adversarial permutations (mirrors `contract/fold.edge-cases.test.ts`).
- `src/gcal/overlay/serialize.test.ts` — golden-byte fixtures for all three types, round-trips (including optional-field omission and `clearX` suppression), and validation errors (mirrors `contract/serialize.test.ts`).
- `src/gcal/overlay/pseudoEntry.test.ts` — the full `{base present/absent} × {overlay present/absent} × {patch touches title/time/both/neither} × {base moved on touched vs untouched fields}` dirty-classification matrix, user-value-always-wins, the `updated` fast path, orphans, and day-grouping (patched date wins; untouched time follows the live date).
- `src/gcal/overlay/buildPseudoEntries.test.ts` — eventId matching, recurring-instance independence, hidden exclusion, orphan date-matching, multi-calendar filtering, effective-start ordering.
- `src/gcal/overlay/overlayPlan.test.ts` — draft round-trip, the no-op guard (including whitespace-only edits), per-field diffs, emptied-field → `clearX`, `toggleHidden`.
- `src/gcal/overlay/store.test.ts` — fake-indexeddb append/list/fold round-trips, independent `calendar-overlay` seq allocation, the v8 migration (existing stores intact, `overlayEvents` empty), and `wipeAll` clearing the log + counter.
- `src/gcal/client.test.ts` — with stubbed `fetch`, verifies the query parameters and Bearer header of both endpoints (including that the `listEvents` `fields` filter requests `updated` and `recurringEventId` and that both survive parsing), `calendarId` path-encoding, dropped id-less calendar entries, `CalendarError` status classification (`isAuth` / `isRetryable`), and that both `listCalendars` and `listEvents` follow `nextPageToken` across pages and concatenate results.
- `src/gcal/config.test.ts` — exercises the pure `mergeTargetCalendar` (preservation of sibling `skillConfig` fields and `userNotes`, overwrite of a prior `targetCalendar`, fresh-stub fallback on missing/corrupt bodies, and the fixed-key/trailing-newline serialization convention) and the pure `resolveTargetSelection` (auto-pick of primary on first load, stored target selected without re-persisting — including when absent from the list — and no auto-pick without a primary).

## Cross-module wiring

- `src/config.ts` — defines `DRIVE_SCOPE`, `CALENDAR_READONLY_SCOPE`, and
  `GOOGLE_SCOPES`. The scopes live in this neutral build-config module (not in `drive/`
  or `gcal/`) so the generic layers can compose them without breaking the layering rule.
- `src/drive/auth.ts` — `connect()` requests the full `GOOGLE_SCOPES` set in one
  consent, so the single stored token also authorizes Calendar reads.
- `src/dayview/useDayEvents.ts` — hook returning a discriminated `DayEventsState`
  (`not-connected` / `no-calendar` / `loading` / `ready` / `auth-error` / `error`).
  Missing token or target calendar are **normal, non-error states**; a thrown
  `CalendarError` maps to `auth-error` only when `isAuth`. The `ready` state carries
  `calendarId` alongside the events — the overlay layer matches and targets overlays
  per calendar, and `CalEvent` itself has no calendar id.
- `src/dayview/DayTimeline.tsx` — merges the `ready` events with the folded overlays
  into pseudo-entry cards interleaved with the day's real entries
  (`buildPseudoEntries` runs **only** on `'ready'`); non-ready states render quiet,
  non-blocking one-line notes. Documented in
  [capture-and-dayview.md](capture-and-dayview.md).
- `src/settings/SettingsScreen.tsx` (`CalendarPicker`) — lists calendars when
  connected and resolves the initial selection via `resolveTargetSelection`: the
  stored target if any, else the primary calendar, which is then **persisted
  immediately** via `setTargetCalendar` (so the Day view picks it up without a
  manual switch — no target is ever left display-only). Manual picks also persist
  via `setTargetCalendar`. A 401/403 prompts a reconnect (the calendar scope isn't
  granted on the current token) rather than showing an empty list.

## Key invariants & gotchas

- **Strictly read-only.** The app requests no calendar write scope of any kind (SPEC
  §8.1) and never creates, edits, or deletes events. "Fixing" an event means opening
  it in Google Calendar via the deep link. Calendar overlays (SPEC §3.6) do not bend
  this: they are local annotations rendered over the events and are never pushed to
  Google.
- **The overlay log is app-only and skill-free.** No skill ever reads
  `capture.calendar-overlay.v1` events, and the log has no config/checkpoint/results
  protocol (SPEC §5.6). It is also local-only — not in `allSyncStreams()`, and the
  multi-stream sync engine needs overlay-aware wiring (its own store + schema) before
  it can carry it — so treat `overlay/store.ts` appends as device-local state for now.
- **One token, combined scopes.** There is no separate calendar auth. A 401/403 from
  the Calendar API usually means the stored token predates the calendar scope (or
  expired); the fix is always a reconnect, surfaced by Settings and the Day view copy.
- **Calendar unavailability is never an error state.** No token, no chosen calendar,
  or a failed fetch all degrade to a one-line note under the Day view header — local
  entries carry the day on their own.
- **The local pick is never lost.** `setTargetCalendar` writes the `meta` row before
  touching Drive; the Drive mirror is best-effort and its failure only produces a
  warning note.
- **Never clobber skill edits.** The `config.json` mirror is a read-modify-write that
  preserves all other `skillConfig` fields and `userNotes` (SPEC §5.5). Read-back is
  only possible because `drive/bootstrap` pre-creates `config.json` (under
  `drive.file` the app sees only files it created).
- **Timezone safety.** All-day events parse at *local* midnight, and `dayRange` emits
  offset-carrying RFC-3339 bounds — both deliberately avoid UTC-midnight bugs.
- **Layering** (`src/layering.test.ts`): the generic layers must not import `gcal/`;
  `gcal/` itself imports only `contract/`, `drive/`, `store/`, and `streams/`. Its
  inbound consumers are `src/dayview` and `src/settings`.
