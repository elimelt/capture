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
`listEvents` over the `dayRange(date)` window → `CalendarEvents` renders the rows.

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
- `interface CalEvent { id: string; summary: string; htmlLink?: string; startMs: number; endMs: number; allDay: boolean }` — a normalized event; `startMs` is the ordering + render key.
- `interface RawEventTime { dateTime?: string; date?: string }` and `interface RawEvent { id?; summary?; htmlLink?; status?; start?; end? }` — the subset of the API resource that is read.
- `parseEvent(raw: RawEvent): CalEvent | null` — `null` for unusable events: cancelled (`status === 'cancelled'`), id-less, or missing a parseable start/end. `allDay` is true when `start.date` is present; summary is trimmed with a `'(no title)'` fallback; `htmlLink` is omitted (not `undefined`-valued) when absent.
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
- `listCalendars(token: string): Promise<CalendarSummary[]>` — `GET /users/me/calendarList` with `minAccessRole=reader`, `maxResults=250`, and a `fields` filter. Entries without an `id` are dropped; `summary` falls back to the id when blank; `primary` defaults to `false`.
- `interface ListEventsArgs { calendarId: string; timeMin: string; timeMax: string }` — window bounds are RFC-3339; use `events.dayRange()` to build them.
- `listEvents(token, { calendarId, timeMin, timeMax }): Promise<CalEvent[]>` — `GET /calendars/{id}/events` with `singleEvents=true` (recurring events expanded server-side into concrete instances), `orderBy=startTime`, `maxResults=250`, and a `fields` filter. `calendarId` is `encodeURIComponent`-ed in the path (ids contain `@` and can contain `/`). The response is run through `parseEvents` + `sortEvents`.

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

### Test files

- `src/gcal/events.test.ts` — covers `parseEvent` normalization (epoch-ms conversion, all-day at local midnight, `(no title)` fallback, `htmlLink` omission), the dropping of cancelled/id-less/time-less events, `sortEvents` ordering, and `dayRange`'s local-midnight boundaries.
- `src/gcal/client.test.ts` — with stubbed `fetch`, verifies the query parameters and Bearer header of both endpoints, `calendarId` path-encoding, dropped id-less calendar entries, and `CalendarError` status classification (`isAuth` / `isRetryable`).
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
  `CalendarError` maps to `auth-error` only when `isAuth`.
- `src/dayview/CalendarEvents.tsx` — renders the `ready` state as tappable rows that
  open each event in Google Calendar via `htmlLink`; non-ready states render quiet,
  non-blocking one-line notes.
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
  it in Google Calendar via the deep link.
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
