# Timebox — Generic Capture Client with Drive + Chat-Assistant Processing

## Specification v0.3

---

## 1. Overview

Timebox is an installable Progressive Web App (PWA) built with React, used on iPhone as
if it were a native app. At its core it is a **generic, offline-first capture client**:
the user records **entries** — an envelope of attachments (audio, text, photo) plus
timestamp and location snapshot — into named **streams**, and the app uploads them to a
structured folder tree in the user's own **Google Drive**.

The app contains **no AI and no domain logic in the capture pipeline**. It does exactly
two jobs:

1. **Capture** entries quickly and reliably (offline-first) and upload them to Drive.
2. **Reflect** results: show per-entry processing status, and render stream-specific
   read-back views (for the timelog stream, a read-only view of the user's calendar).

The intelligence lives outside the app, in a per-stream **processing skill** the user
installs in their chat provider (Claude, ChatGPT, or any assistant with Google Drive +
Google Calendar connectors). On demand or on a schedule, the skill reads new entries from
Drive, interprets them, and acts on an output surface. Processing is therefore
**batch-style** (e.g. end of day), not real-time — an explicit, accepted trade-off.

**v1 ships exactly one stream: `timelog`.** Throughout the day the user logs short voice
memos marking activity transitions ("leaving for work", "arrived at work", "eating
lunch"); the timelog skill turns them into events on a Google Calendar the user chooses.
The contract, storage, and capture UI are stream-parameterized from day one, so future
streams (e.g. photo-first meal logging for calorie counting) are configuration plus a new
skill prompt — not an app rewrite (§3.1, §6.5).

There is **no backend**: static hosting + Google APIs only. The user's Drive is the data
store; their calendar (or another surface the skill writes to) is the output; their chat
subscription is the compute.

### 1.1 Goals

- One-tap capture of the stream's primary kind (audio for timelog); ≤ 2s from app open
  to recording.
- Fully offline-capable capture with an upload queue drained on demand ("Sync now").
- A clean, documented, **stream-generic file contract** in Drive that any LLM assistant
  can process.
- A provider-agnostic **skill specification** (prompt + procedure) per stream, shipped
  as a document the user pastes/installs into their assistant.
- Read-only calendar view in the app so the user sees the timelog outcome without
  leaving the app.
- Minimal Google OAuth surface: file-scoped Drive read/write + read-only calendar.
- **Extensibility**: a new stream must require no changes to contract mechanics, storage
  schema, upload engine, or the capture component — only a stream config and a skill
  prompt.

### 1.2 Non-Goals (v1)

- No transcription, parsing, or AI in the app. Attachments are captured, not understood.
- No calendar writes from the app, ever.
- No real-time processing (batch by design).
- No in-app UI for creating custom streams (v1 hardcodes `timelog`; the architecture
  supports more).
- No multi-user features; no accounts of our own.
- No background/continuous location tracking (impossible in an iOS PWA; not desired).
- No push notifications (deferred; see Open Questions).

### 1.3 System diagram

```
┌────────────── iPhone ──────────────┐        ┌──────── Google ────────┐
│  Capture client PWA (React)        │        │                        │
│  ┌──────────┐   ┌───────────────┐  │ upload │  Google Drive          │
│  │ Capture  │──▶│ IndexedDB     │──┼───────▶│  /timebox/<stream>/    │
│  │ (stream) │   │ upload queue  │  │        │        │               │
│  └──────────┘   └───────────────┘  │        │        ▼ read          │
│  ┌──────────┐                      │        │  Chat assistant skill  │
│  │ Day view │◀─────────────────────┼────────│  (one per stream)      │
│  └──────────┘   read-only          │        │        │ write         │
│   (timelog)                        │        │        ▼               │
│                                    │        │  Google Calendar, ...  │
└────────────────────────────────────┘        └────────────────────────┘
```

---

## 2. Target Platform & PWA Requirements

### 2.1 Baseline

- **Primary target:** iOS 17+ Safari, installed to the Home Screen (standalone mode).
- **Secondary:** desktop Chrome/Safari (reviewing the day, managing settings).
- Served over HTTPS from a static host. HTTPS is mandatory for service workers,
  microphone, geolocation, and Google OAuth.

### 2.2 PWA surface

- `manifest.webmanifest`: `display: "standalone"`, portrait, maskable icons (192/512px),
  plus `apple-touch-icon` (180px) since iOS ignores manifest icons.
- Service worker (Workbox via `vite-plugin-pwa`): precache the app shell. The app must
  open and record with no network at all.
- iOS meta tags for status-bar style and title; illustrated Add-to-Home-Screen onboarding
  (iOS never auto-prompts installation).

### 2.3 iOS standalone-mode constraints that shape this design

1. **`SpeechRecognition` (Web Speech API) does not work in standalone PWAs on iOS** — the
   object exists but recognition silently fails. Irrelevant here by design: Timebox does
   not transcribe. Audio is recorded, not recognized.
2. **`getUserMedia` + `MediaRecorder` do work in standalone mode** (iOS 14.5+), with two
   caveats: (a) iOS point releases have shipped mic/camera-in-PWA regressions (e.g. 18.0,
   fixed in 18.1.1) — feature-test at tap time and fall back to text entry; (b) iOS
   `MediaRecorder` emits `audio/mp4` (AAC), not webm/opus — never hardcode a mime type,
   use `MediaRecorder.isTypeSupported()` and record the actual type in the entry.
3. **No background execution.** Recording and uploading happen only while the app is
   foregrounded. The upload queue drains only on an explicit "Sync now" tap in Settings.
4. **Storage eviction:** Safari can evict script-writable storage after ~7 days of disuse
   (Home-Screen apps are treated more leniently). Call `navigator.storage.persist()`, and
   treat Drive as the durable store — surface unsynced data in Settings ("Out of sync"
   plus an entries-waiting count) so the user syncs explicitly.
5. **Popups are unreliable in standalone mode.** Google OAuth must be initiated from an
   explicit user tap and must tolerate account-chooser UI; test the full auth loop in
   standalone mode specifically (see §8.3).

---

## 3. Domain Model

### 3.1 Stream (the extensibility unit)

A **stream** is a named capture profile — one kind of thing the user logs. The capture
client is deliberately generic: everything below the stream is stream-agnostic, and
everything domain-specific hangs off the stream's config and skill.

```ts
interface Stream {
  id: string;                    // folder-safe slug: "timelog", "meals", ...
  name: string;                  // display name
  primaryAttachmentKind: 'audio' | 'photo' | 'text';  // what the big button captures
  captureDefaults: { maxAudioSec?: number; locationEnabled: boolean };
  skillDocPath: string;          // shipped skill prompt for this stream
}
```

**v1 ships exactly one built-in stream, `timelog`** (audio-first; §6.2), with no UI to
add more. The storage schema, Drive layout, upload queue, and capture component are
nonetheless keyed by `stream.id` from day one, so a second stream is configuration plus
a skill prompt — not a migration.

| Generic (stream-agnostic) | Domain-specific (per stream) |
|---|---|
| Event envelope + attachments (§3.3) | Interpretation (the skill prompt, §6) |
| Append-only log + checkpoint/results protocol (§5) | Stream body of `config.json` (§5.3) |
| Upload queue, status badges, results display (§6.4) | Bespoke read-back views (timelog Day view, §3.5) |
| Places enrichment, timestamps, timezone handling | Output surface the skill writes to (calendar, sheet, …) |

### 3.2 The log model (event sourcing)

Each stream is backed by an **append-only, immutable log of events**. This is the
foundational invariant of the whole system:

1. **Append-only.** The app only ever adds events to the end of a stream's log — locally
   (IndexedDB) and in Drive. Nothing in the log is ever edited, moved, or deleted by the
   app or by skills.
2. **Every user action is an event** — including corrections. "Delete" and "edit" are
   represented as *new* events (`revoke`, `amend`, §3.3) that reference a prior event by
   id. The visible state of an entry is a **fold** over the log, computed identically by
   the app and by consumers.
3. **Totally ordered per stream** by `seq` (embedded in filenames) with `loggedAt` then
   `id` breaking ties, so log position — not wall-clock time — defines order. Identity
   is the event `id`; `seq` is a non-unique ordering *hint*: two devices appending
   offline can mint the same per-stream seq, and the tiebreak keeps the fold
   deterministic across devices regardless (see §3.3). `capturedAt` remains the *domain*
   timestamp. (This matters when a correction to this morning is captured tonight.)
4. **Consumers are cursor-based.** Downstream processors (skills) track their progress
   with a checkpoint — "I have consumed the log through seq N" — rather than by mutating
   the log (§5.4). "Unprocessed" is defined as `seq > checkpoint`, discoverable without
   scanning history because filenames sort lexicographically by seq.
5. **Derived state is separate and rebuildable.** Checkpoints, results files, calendar
   events, and the app's own entry-status cache are all derivations. Any of them can be
   deleted and reconstructed by re-folding/re-consuming the log. The log is the only
   thing that must never be lost.

### 3.3 Events and entries

A log **event** is the unit of appending; an **entry** is the folded, user-visible item.
Three event types cover v1:

```ts
type LogEvent = CaptureEvent | AmendEvent | RevokeEvent;

interface EventBase {
  schema: 'capture.event.v1';
  id: string;                  // the identity: unique, crypto-random
  seq: number;                 // per-stream sequence assigned at append; ordering
                               // hint only — NOT unique across devices (§3.2 #3)
  stream: string;              // "timelog"
  loggedAt: string;            // ISO 8601 with offset: when the event was appended
  deviceTz: string;            // IANA zone at append
}

interface CaptureEvent extends EventBase {
  type: 'capture';
  capturedAt: string;          // domain time: when the capture button was tapped
  attachments: Attachment[];   // >= 1; primary kind comes from the stream config
  location?: { lat: number; lng: number; accuracyM: number;
               capturedAt: string; placeLabel?: string;
               address?: string };   // reverse-geocoded "near …" label
}

interface AmendEvent extends EventBase {
  type: 'amend';
  targets: string[];           // ids of prior capture events
  patch?: { capturedAt?: string; location?: GeoLocation;
            clearLocation?: boolean;         // append-only location removal
            removeAttachments?: string[] };  // files the fold hides (append-only
                                             // removal; files stay in the log)
  attachments?: Attachment[];  // appended to the target entry
}                              // timestamp stepper, "+ note"/"+ photo"/"+ audio",
                               // note edits, and attachment removal emit these

interface RevokeEvent extends EventBase {
  type: 'revoke';
  targets: string[];           // ids of prior capture events
  reason?: 'undo' | 'duplicate' | 'user-delete';
}

interface Attachment {
  kind: 'audio' | 'text' | 'photo';
  // audio: Blob + mimeType (audio/mp4 on iOS) + durationSec
  // text:  string (typed or pasted note)
  // photo: Blob + mimeType (image/jpeg|png|heic->jpeg)
  derivedFrom?: string;        // sibling attachment this was machine-derived
                               // from (e.g. a transcript's source audio);
                               // absent = user-created content
}
```

**Fold rules** (pure function, identical for app and skills): start with all `capture`
events; apply `amend` patches in log order — `seq`, ties broken by `loggedAt` then `id`
— and drop entries targeted by a `revoke`. The tiebreak makes the fold deterministic
even when two devices offline-minted the same seq (§3.2 #3). An `amend`/`revoke` whose
target hasn't been consumed yet simply folds in; one that arrives *after* its target was
already processed lands after the consumer's checkpoint, so the next run sees it and
compensates on the output surface (e.g. updates or deletes the calendar event it
previously created — §6.2).

Rules:

- The default capture flow produces a single attachment of the stream's **primary kind**
  (audio for `timelog`). Other kinds are optional add-ons, never requirements.
- The capture-screen **Undo toast emits a `revoke`** (it does not unwind the append —
  even a 5-second-old capture is already committed locally).
- The timestamp stepper and post-capture edits ("+ note", "+ photo", "+ audio", note
  edits, attachment removal) emit `amend` events. Attachment *files* are immutable; an
  amend adds new attachments and/or hides prior ones via `patch.removeAttachments` —
  hidden files and their history remain in the log, the fold just stops showing them.
  Editing a note is one amend that removes the old text file and adds its replacement
  (an edited transcript keeps its `derivedFrom` link, so it is never re-transcribed).
- Spoken corrections remain first-class: "correction: I actually left at 8:40" is just a
  new `capture` event whose *interpretation* is the skill's job. `amend`/`revoke` exist
  for structured UI actions, not for meaning.

### 3.4 Places (local-only)

User-named circles (center + radius) mapping coordinates to labels ("Home", "Office",
"Gym"). A capture-layer enrichment available to **all** streams: entries get a
human-readable `placeLabel` so a skill sees "Office" instead of raw coordinates (a meal
photo tagged "Office" is still useful). Stored only on-device; exported to Drive solely
as labels inside entry metadata.

Places are **automatic**: capturing at a coordinate that matches no existing place
prompts (dismissably — capture is already saved) to name it, from a "near …" hint.
Naming saves the place (default radius 50 m, editable) and retro-labels the just-captured
entry; future captures there auto-label. Skipping leaves the entry with coordinates only.

### 3.5 Day view model (timelog read-back; derived, read-only)

Read-back views are **per-stream**. The generic fallback for any stream is the folded
entry list annotated with results (§6.4). The timelog stream additionally gets a bespoke
Day view built from two read-only sources:

- **Calendar events** fetched from the user-selected target calendar (§8) — the truth of
  what the skill produced.
- **Local entries not yet reflected in any event** — shown as "pending" pins on the
  timeline so the user sees what awaits processing.

The app never writes calendar events and never edits them. "Fixing" a block = editing the
event in Google Calendar / asking the assistant, which the app then re-reads.

---

## 4. UX Specification

Design principle: **three screens**; capture is 95% of usage and must be near-instant.

### 4.1 Screen 1 — Capture (home, default route)

- Rendered from the **active stream's config**; v1 has one stream (`timelog`), so no
  stream switcher appears (v2: a compact header control).
- Dominant element: one large **capture button**, bottom-center, thumb-reachable. Its
  primary action is the stream's `primaryAttachmentKind` — audio for `timelog` (a future
  photo-first stream would open the camera instead; same component, different config).
- **Tap → recording starts immediately** (with a subtle waveform + elapsed time).
  Tap again to stop. Hard cap 60s (auto-stop). No confirmation step by default: stop →
  capture event appended and queued → success toast with **Undo (5s)** (undo appends a
  `revoke` event, §3.3).
- Above the button: the **latest-entry card** ("🎙 9:04 AM · Office · ⬆ uploaded") and a
  small day summary line ("6 entries today · 4 processed").
  Note: the app cannot show live transcripts (no STT); the card shows time, place, and an
  audio replay control. After processing, it shows the `displayTitle` the skill assigned
  (§6.4).
- While recording or immediately after, optional add-ons (small buttons): **+ note**
  (text field with iOS keyboard — the built-in dictation key works here too), **+ photo**
  (camera/library). Added during capture they join the capture event; added after, they
  become `amend` events (§3.3). The add-on set is identical across streams; only the
  primary action varies.
- **Timestamp**: taken when the capture button is tapped; adjustable post-capture via a
  compact "−5m / −1m / now" stepper on the entry card (emits an `amend`). Relative
  phrases in the audio itself ("ten minutes ago") are the skill's job to honor (§6.3).
- **Geolocation** is requested concurrently and never blocks capture (8s timeout,
  `maximumAge: 60s`; low accuracy acceptable).
- **Failure behavior**: if mic permission is denied or `MediaRecorder` fails at tap time,
  the button becomes a text-entry field (keyboard dictation available) — capture must
  never dead-end.
- Below the fold: today's entries (folded view, §3.3), newest first, each with replay,
  status badge (⬆ queued / ✓ uploaded / ✅ processed / ⚠ error), and **delete** —
  which always appends a `revoke` event, whether or not the capture has uploaded yet.

### 4.2 Screen 2 — Day (timelog timeline)

A stream-specific read-back view for `timelog` (the generic fallback for any stream is
the folded entry list with results annotations, §3.5).

- Vertical day timeline rendering **calendar events from the target calendar** (read-only),
  interleaved with **pending entry pins** (unprocessed entries shown at their timestamps).
- Header: date picker; connection status; **"Process now" helper** — a button that copies
  a ready-made instruction ("Process my timelog stream") to the clipboard and/or
  deep-links to the user's chat app, since the app cannot trigger the skill itself.
- Pull-to-refresh re-fetches events and the processing results file (§6.4).
- Tapping an event opens it in Google Calendar (deep link) for editing — the app never
  edits events.
- Empty/edge states: "No calendar connected", "N entries awaiting processing — run your
  timelog skill", "Skill last ran: yesterday 11:02 PM".

### 4.3 Screen 3 — Settings

- **Google**: connect/disconnect; shows granted scopes; target calendar picker (read-only
  list via Calendar API) — the selection is written into the timelog stream's Drive
  config file (§5.3) so the skill knows where to write.
- **Capture** (per stream; v1 shows only timelog): max clip length;
  keep-audio-after-processing toggle (default: keep; Drive is the user's own storage);
  photo quality.
- **Location**: on/off (default on); Places manager (add from current location, radius;
  default 50 m).
- **Skill setup** (per stream): a guided page that (a) shows the skill install
  instructions per provider, (b) renders the stream's canonical skill prompt (§6.2) with
  the user's folder path and calendar choice substituted in, with a copy button.
- **Data**: open Drive folder link; wipe local data; storage usage.

### 4.4 First-run flow

1. Three-card explainer: record transitions → they land in your Drive → your assistant
   puts your day on your calendar.
2. Add-to-Home-Screen instructions (illustrated, iOS-specific).
3. Connect Google (§8) — creates the `timebox/` folder tree in Drive, asks to pick a
   target calendar.
   Skippable: capture works with zero setup; uploads queue until connected.
4. Location permission ask with plain-language rationale — skippable.
5. Skill setup page (§4.3) with "do this later" allowed.

### 4.5 UX rules

- Capture path never blocks on: network, auth, GPS, or upload.
- Recording start latency target < 300ms from tap (pre-warm `getUserMedia` on app focus
  where permission is already granted).
- All destructive actions confirm. "Delete" is soft by construction — it appends a
  `revoke` event (§3.3); the underlying files remain in the log. True erasure (e.g. an
  accidentally sensitive recording) is done by the user directly in Drive, documented as
  an out-of-band escape hatch consumers must tolerate (§11).
- Timezone-safe: events carry UTC offset + IANA zone; the Day view renders in device zone.

---

## 5. Drive File Contract (the app↔skill interface)

This contract is the core third-party surface. It must be stable, human-readable,
trivially consumable by an LLM with a Drive connector, and **stream-generic**: the
mechanics below (layout, event schema, log/checkpoint/results protocol) carry no timelog
semantics. Domain meaning lives only in each stream's `config.json` and skill prompt.

It is an **append-only log contract** (§3.2): the `log/` tree is immutable — neither the
app nor any skill ever renames, moves, edits, or deletes anything in it. All mutable
state lives in explicitly-designated derived files (`checkpoint.json`, `results/`).

### 5.1 Folder layout

One root folder, one subfolder per stream, date partitions beneath. The app reads and
writes the entire tree (everything under `timebox/` is app-created, so `drive.file`
covers it).

```
timebox/                            (root; created by the app, drive.file scope)
  streams.json                      registry: streams the app has bootstrapped
  timelog/                          one folder per stream
    config.json                     stream settings the skill must read (§5.3)
    log/                            IMMUTABLE append-only event log
      2026-08-02/                   partition: local date of loggedAt
        000041_2026-08-02T09-04-11-0400_a1b2c3.json   event record (§5.2)
        000041_2026-08-02T09-04-11-0400_a1b2c3.m4a    audio attachment
        000042_2026-08-02T12-31-05-0400_d4e5f6.json
        000042_2026-08-02T12-31-05-0400_d4e5f6.m4a
        000042_2026-08-02T12-31-05-0400_d4e5f6_note.txt
        000043_2026-08-02T12-31-40-0400_e7a9b0.json   e.g. a revoke of 000042
    checkpoint.json                 MUTABLE consumer cursor (app-created stub, §5.4)
    results/                        MUTABLE skill-written reports (app-created stubs)
      2026-08-02.json               processing report for that date (§6.4)
  meals/                            (illustrative future stream — same shape)
    config.json
    log/ ...
```

- Filenames lead with the **zero-padded per-stream sequence number**, then the local
  `loggedAt` timestamp, then a short event id — so a plain name-sorted listing *is* the
  log order, and "everything after seq N" is answerable from a file listing alone,
  without opening a single file.
- Date partitions keep folder listings small and let a consumer fetch a bounded window;
  the partition key is `loggedAt` (append time), so a consumer never needs to look in
  partitions older than its checkpoint.

### 5.2 Event record file (`*.json`) — stream-agnostic

The serialized form of `LogEvent` (§3.3). A `capture` event:

```json
{
  "schema": "capture.event.v1",
  "type": "capture",
  "id": "a1b2c3",
  "seq": 41,
  "stream": "timelog",
  "loggedAt": "2026-08-02T09:04:11-04:00",
  "capturedAt": "2026-08-02T09:04:11-04:00",
  "deviceTz": "America/New_York",
  "location": { "lat": 40.7128, "lng": -74.006, "accuracyM": 25, "placeLabel": "Office" },
  "attachments": [
    { "kind": "audio", "file": "000041_2026-08-02T09-04-11-0400_a1b2c3.m4a",
      "mimeType": "audio/mp4", "durationSec": 3.2 }
  ]
}
```

A `revoke` (undo/delete) and an `amend` (timestamp fix, added note) are events of the
same schema with `"type": "revoke" | "amend"` and a `targets` field — see §3.3. The
record is identical for every stream; no domain fields ever enter the event schema.

**Atomic append protocol (Drive has no transactions):** the app uploads attachments
*first*, the event record *last*. The event record is the commit — an event exists iff
its `.json` exists. Orphan attachments from an interrupted upload are invisible to the
fold (no record references them) and are re-uploaded under the same names on retry
(idempotent by filename). Consumers must ignore any file not referenced by an event
record.

### 5.3 Stream config file (`<stream>/config.json`)

Generic header + a free-shape `skillConfig` body owned by the stream's skill:

```json
{
  "schema": "capture.streamconfig.v1",
  "stream": "timelog",
  "skillConfig": {
    "targetCalendar": { "id": "abc...@group.calendar.google.com", "name": "Timebox" },
    "eventDefaults": { "colorId": null }
  },
  "userNotes": "I work from home Tuesdays; 'the office' means the Brooklyn office."
}
```

`userNotes` is free text the user edits in the app to give the skill standing context —
per-user customization without app logic. The app treats `skillConfig` as opaque except
where a bespoke view needs it (the timelog Day view reads `targetCalendar`).

### 5.4 Consumer checkpoint (`checkpoint.json`) — how "unprocessed" is defined

The skill's cursor into the log. **App-created stub** (so `drive.file` lets the app read
it back — §11); the skill only ever updates it.

```json
{
  "schema": "capture.checkpoint.v1",
  "stream": "timelog",
  "consumedThroughSeq": 40,
  "updatedAt": "2026-08-01T21:03:00-04:00",
  "consumer": "timelog-skill@claude"
}
```

Protocol (stated verbatim in every skill prompt):

1. Read `consumedThroughSeq` = N.
2. List `log/` partitions dated ≥ the checkpoint's date; select files with seq > N —
   pure filename comparison, no file contents needed. This is how a consumer
   "efficiently sees only unprocessed events."
3. Fold and act on those events (§6.2). A `revoke`/`amend` whose target seq ≤ N is the
   **compensation case**: the target was already acted on, so the skill must adjust its
   prior output (update/delete the calendar event) rather than skip it.
4. **Only after** outputs and `results/` are written, set `consumedThroughSeq` to the
   highest seq handled. Updating the checkpoint last makes a crashed run safe: the next
   run re-reads the same events, and output idempotency (provenance lines, §6.2) makes
   re-acting harmless.

One checkpoint per stream in v1 (single consumer). Multiple independent consumers is a
v2 concern (a `checkpoints/` folder, one file per consumer name).

### 5.5 Contract rules

- The app writes only under `timebox/` (enforced by `drive.file` scope — it literally
  cannot see other files) and may read/write anything in the tree.
- **`log/` is immutable for everyone.** The app appends; skills read. No renames, moves,
  edits, or deletes — a skill that wants to say "done" advances its checkpoint.
- Mutable derived files (`checkpoint.json`, `results/*.json`) are always **created by
  the app as stubs** and only ever **updated** by skills (never re-created), preserving
  `drive.file` read-back visibility (§11).
- Schema versioning via the `schema` field (`capture.event.v1`,
  `capture.streamconfig.v1`, `capture.checkpoint.v1`, `capture.results.v1`); skill
  prompts pin `v1`.
- Adding a stream = new subfolder + `config.json` + skill prompt. No changes to event
  schema, upload engine, or log/checkpoint mechanics are permitted for a new stream —
  that is the extensibility invariant.

---

## 6. Processing Skills (provider-agnostic, one per stream)

A skill is **a document, not code**: a canonical prompt + procedure that works in any
assistant with Google Drive and Google Calendar connectors (Claude Projects/Skills,
ChatGPT Custom GPTs/connectors, etc.). The app ships each stream's skill as a markdown
file rendered in Settings with the user's specifics substituted.

Every skill follows the same generic frame — read stream config, consume the log from
its checkpoint (§5.4), fold events, act on an output surface, update `results/`, then
advance the checkpoint — with a stream-specific interpretation section. v1 ships one
skill: **timelog**.

### 6.1 Preconditions (user setup, guided by §4.3)

- Assistant has the Google Drive connector authorized for the account holding `timebox/`.
- Assistant has whatever output connector the stream needs (for timelog: Google Calendar
  with event write access).
- The skill prompt is installed (project instructions / custom GPT / saved skill).
- Optional: a **scheduled task** ("every day at 9 PM, process my timelog") — both major
  providers support scheduled/recurring tasks; this is what makes the batch flow
  hands-off in practice.

### 6.2 The timelog skill procedure (summary of the shipped prompt)

1. Read `timebox/timelog/config.json` → target calendar, user notes; read
   `checkpoint.json` → last consumed seq N.
2. List `log/` partitions from the checkpoint date forward; select event files with
   seq > N (§5.4). Read each record; listen to audio attachments; read text notes; look
   at photos if present. If audio cannot be processed by this assistant, say so
   explicitly and list the affected events rather than guessing.
3. **Fold** (§3.3): apply `amend` patches; drop `revoke`d captures. For an
   `amend`/`revoke` targeting seq ≤ N (already acted on), *compensate*: update or delete
   the calendar event previously created for the target (find it via its provenance
   line).
4. Interpret the surviving entries, ordered by effective time (`capturedAt` after
   amendments), as **activity boundaries**: each entry ends the previous activity and/or
   begins the next, honoring spoken relative times ("ten minutes ago"). Use `placeLabel`
   and `userNotes` to name activities sensibly ("arrived" at "Office" → "Work"). Days
   should be contiguous; flag gaps > 30 min instead of inventing content.
5. Create/update events on the target calendar. Every event description must include a
   `timebox:{captureEventIds}` provenance line; before creating, search that day's
   events for the line and update instead of duplicating (output idempotency — this is
   what makes re-running after a crashed run harmless).
6. Update `results/<date>.json` for each affected date (§6.4).
7. **Last**, advance `checkpoint.json` to the highest seq handled (§5.4).
8. Reply to the user with a compact day summary and anything ambiguous.

### 6.3 Interpretation guarantees pushed to the skill

Because interpretation is prompt-level, v1 explicitly does **not** specify a grammar. The
skill prompt instead sets behavioral rules: never drop an entry (unclear ones become
"Untitled activity" with the audio linked), never overlap events, prefer asking the user
in-chat over guessing when two readings differ by > 15 minutes.

### 6.4 Results file (`results/<date>.json`) — the generic feedback channel

Stream-agnostic acknowledgment format; the app renders `displayTitle`/`displayDetail`
verbatim on entry cards without understanding them. The skill defines the semantics
("Work 9:04–12:30" for timelog; "620 kcal" for a future meals stream).

```json
{
  "schema": "capture.results.v1",
  "stream": "timelog",
  "date": "2026-08-02",
  "processedAt": "2026-08-02T21:03:00-04:00",
  "entries": [
    { "id": "a1b2c3", "outcome": "ok",
      "displayTitle": "Work", "displayDetail": "9:04 AM – 12:30 PM · evt123",
      "transcript": "arrived at work" }
  ],
  "warnings": ["Gap 14:00–15:10 left unfilled"]
}
```

`outcome` is `ok | skipped | needs-attention`; `id` refers to the originating capture
event. Results are keyed by the entry's *domain* date (`capturedAt`), so a late
correction updates the results file of the day it corrects. The app polls this file and
`checkpoint.json` (both app-created stubs — §5.5) to flip entry statuses to `processed`
(entry's capture seq ≤ checkpoint), display assigned titles on entry cards, and show
"skill last ran" in the Day view.

### 6.5 Future streams (illustrative, non-normative)

A `meals` stream for calorie counting: `primaryAttachmentKind: 'photo'` (capture button
opens the camera), skill reads meal photos + notes from its own log/checkpoint,
estimates calories, appends rows to a Google Sheet (its `skillConfig` names the
spreadsheet), and writes results with `displayTitle: "Lunch"`,
`displayDetail: "~620 kcal"`. Zero app changes beyond registering the stream config —
this scenario is the acceptance test for the extensibility invariant (§5.5).

---

## 7. Location

- Snapshot at capture only, via `getCurrentPosition`; never blocks capture; entirely
  optional (Settings toggle removes all geolocation calls).
- Labels come from user-defined Places (§3.4); capturing at an unmatched coordinate
  prompts to name a new place (dismissable), which retro-labels the entry. A best-effort
  reverse geocode (OSM Nominatim) adds a short `address` ("near …") to Places and to a
  location that a user edits on an entry; it never blocks, is cached in IndexedDB by a
  rounded coordinate cell, and is throttled to ≤1 req/sec per Nominatim's usage policy.
- Coordinates + label travel inside entry metadata to Drive; the timelog skill may put
  the label in the event `location` field.
- Entry location is editable in-app (a small map preview in the card expands to a
  draggable-pin editor); edits emit an amend with `patch.location`, and clearing emits
  `patch.clearLocation` (append-only — prior events keep the coordinate in the log).

---

## 8. Google Integration (app side, no backend)

### 8.1 Third-party surfaces (complete list)

| Surface | Purpose | Scope |
|---|---|---|
| Google Identity Services JS (`accounts.google.com/gsi/client`) | OAuth 2.0 token flow in-browser | — |
| Google Drive API v3 (`fetch`, multipart + resumable uploads) | create/read/write the `timebox/` tree: upload entries, stream configs, results | `drive.file` (non-sensitive) |
| Google Calendar API v3 (`fetch`) | list calendars for target picker; read events for Day view | `calendar.readonly` (sensitive, read-only) |
| Google Cloud Console project | OAuth client ID (Web), consent screen, API enablement | — |
| User's chat provider (Claude / ChatGPT / other) | runs the skills; its own Google connectors are **its** surface, configured by the user, out of app scope | — |
| Static host (Cloudflare Pages / Netlify / GitHub Pages) | serve the PWA over HTTPS | — |

No `gapi` library; both APIs are called directly with `fetch` + Bearer token.

The app requests **no calendar write scope of any kind** — writes happen only through the
user's assistant, authorized separately by the user in that product.

### 8.2 Token model (no backend ⇒ no refresh tokens)

- GIS token model: `initTokenClient` → `requestAccessToken()`; access tokens last ~1 hour;
  renewal requires a user gesture (no silent programmatic refresh exists in this model).
- Accommodations:
  - Uploads are queued in IndexedDB; the queue drains on "Sync now" when a valid token
    exists. Capture itself never needs a token.
  - Token renewal piggybacks on the explicit Settings gestures (tapping "Sync now" or
    Connect), with a passive "Reconnect Google" pill when expired — never a blocking
    modal.
  - Token + expiry mirrored to IndexedDB so a relaunch within the hour reuses it
    (accepted, documented risk — see §9).

### 8.3 OAuth on iOS standalone

- Auth is initiated only from an explicit tap; popup flows are unreliable in Home-Screen
  apps, so the flow must survive account-chooser UI and app-switch; route state is
  restored via `sessionStorage`.
- OAuth app remains in **testing mode** (≤100 test users) — this app targets personal /
  small-circle use, so full Google verification is out of scope. Consequences: test users
  must be added manually in Cloud Console; consent shows an "unverified app" interstitial;
  **testing-mode consent expires after 7 days only for restricted scopes — not used here —
  but Google may still re-prompt periodically.** The reconnect pill covers this.

### 8.4 Upload engine (stream-agnostic)

1. Event saved → IndexedDB (blobs + event record, keyed by stream) → status `queued`.
2. Queue drains: on manual "Sync now" only. Sequential uploads into the event's
   stream/date partition, following the atomic append protocol
   (§5.2): attachments first (resumable upload for anything > 5 MB — rare for audio;
   possible for photos), the event record `.json` last — the record is the commit.
3. Success → status `uploaded`; local audio blob retained or pruned per Settings.
4. Failures: exponential backoff on 429/5xx; 401/403 → keep queued + reconnect pill;
   storage-quota errors surface explicitly (Drive full).

### 8.5 Pull engine (Drive → local; bidirectional sync)

The local IndexedDB is a **replica** of the Drive log, not the source of truth. Every
sync cycle runs **pull, then push** (same trigger as §8.4 — manual "Sync now"), so a
second device — or a reinstalled/wiped one — converges on the full log:

1. **Discover by filename.** List `log/`'s date-partition folders, then each
   partition's children. Record filenames carry `seq_ts_id` (§5.1), so the missing set
   (ids not in the local replica) is computed from listings alone — no file reads for
   events already held. Foreign files and non-`YYYY-MM-DD` folders are ignored.
2. **Download eagerly.** For each missing record: fetch the `.json`, then fetch every
   referenced attachment blob not already local (full offline availability). An
   attachment absent on Drive (pruned, or a §5.2 push race) is skipped and picked up on
   a later pull — the record commits last on push, so this is rare.
3. **Import atomically.** Events + blobs commit in one transaction; pulled events get
   sync status `uploaded` (never re-pushed) and the per-stream seq counter jumps past
   every pulled seq, so the next local append extends the merged log.
4. **Converge deterministically.** Identity is the event `id`; a seq collision from
   another device's offline appends is resolved by the fold's `seq → loggedAt → id`
   order (§3.3), with no coordination and no conflict state. Re-pulling is idempotent.
5. Failures classify exactly as §8.4: 401/403 → reconnect pill; 429/5xx → retry later;
   a partial pull keeps everything already imported.

---

## 9. No-Backend Considerations (consolidated)

### 9.1 What it buys

Zero server cost/ops; we hold no user data anywhere (Drive + Calendar are the user's own);
static deployment; offline-first by necessity; the AI bill rides on the user's existing
chat subscription instead of per-call API keys.

### 9.2 Costs and accepted mitigations

| Consequence | Mitigation |
|---|---|
| No refresh tokens → ~1h token expiry, gesture required to renew | Queue-based uploads; renewal on explicit sync/connect taps; passive reconnect pill (§8.2) |
| OAuth client ID public in bundle | Normal for public clients; restrict authorized JS origins to the production domain |
| Tokens readable via XSS | No third-party runtime scripts except GIS; strict CSP (`script-src 'self' https://accounts.google.com`); React escaping only, no `dangerouslySetInnerHTML` |
| Device holds unsynced entries; Safari may evict storage | `navigator.storage.persist()`; Settings surfaces "Out of sync" + entries-waiting counts so the user syncs explicitly; Drive is durable |
| App can't trigger skills or push notifications to them | Scheduled tasks in the chat provider; "Process now" copy-to-clipboard helper (§4.2) |
| Batch (not live) processing | Accepted by design; Day view interleaves pending entries so today is still legible |
| Unverified OAuth app (testing mode) | Personal-use posture; manual test-user list; interstitial documented in onboarding |

### 9.3 Privacy posture

- Attachments never touch a Timebox server (none exists). They go to the user's own
  Drive and are read by the assistant the user chose and authorized.
- Location is captured per-entry only, stored locally + in the user's Drive.
- No analytics, telemetry, or cookies in v1.

---

## 10. Architecture & Stack

| Layer | Choice |
|---|---|
| Framework | React 18 + TypeScript, Vite |
| PWA | `vite-plugin-pwa` (Workbox), `registerType: 'autoUpdate'` |
| State | Zustand (UI) + IndexedDB via `idb` (entries keyed by stream, blobs, queue, places, settings) |
| Routing | React Router: `/` capture, `/day/:date`, `/settings`, `/chat` (opt-in assistant) |
| Styling | Tailwind CSS; dark-mode aware; ≥44pt touch targets |
| Google | GIS script tag + hand-rolled `fetch` clients for Drive v3 / Calendar v3 |
| Audio | `getUserMedia` + `MediaRecorder`, mime-type negotiated at runtime |
| Testing | Vitest (queue, file-contract serializers, place matching); Playwright smoke |

```
src/
  streams/    // stream registry + configs (v1: the built-in timelog stream)
  capture/    // stream-parameterized capture component, add-ons, entry assembly
  contract/   // pure serializers for §5 files + schema types (unit-test heavy)
  drive/      // auth wrapper (GIS), upload queue, results poller
  gcal/       // read-only events client, calendar list (timelog view only)
  dayview/    // timelog: event + pending-entry timeline
  places/     // CRUD + point-in-radius matching
  store/      // IndexedDB repos (keyed by stream), Zustand slices
  assistant/  // opt-in AI chat: LLM client, context digest (app-level, like dayview/)
skills/
  timelog.SKILL.md  // canonical provider-agnostic skill prompt (versioned with schema)
```

Layering rule: `streams/`, `capture/`, `contract/`, `drive/`, `store/` are
stream-agnostic and must not import from `gcal/`, `dayview/` or `assistant/` (the
timelog-specific / app-level modules). This keeps the generic capture client
separable by construction.

### 10.1 In-app AI assistant (fully opt-in)

- Off by default (`AppSettings.assistantEnabled`). The Chat tab and route only
  exist once enabled, the chat bundle is lazy-loaded, and no request leaves the
  device until the user sends a message.
- Endpoint: `https://llm.elimelt.com/v1` — OpenAI-compatible, CORS-gated to the
  app origin, no API key. Model is user-selectable from a curated list
  (`AppSettings.assistantModel`, default `gpt-oss:20b`).
- Client-only: the AI SDK agent runs in-process (`DirectChatTransport`); there is
  no chat backend. The system prompt embeds a plain-text digest of the last 7
  days of folded entries — transcript/note text, place labels and media counts,
  never raw audio or photos.
- The assistant is read-only over the log: it answers questions; it never
  appends events. The current conversation persists locally (IndexedDB) so it
  survives app restarts; "New chat" or a data wipe clears it. Nothing is
  stored server-side.

---

## 11. Failure Modes & Edge Cases

- **Double-tap duplicates**: two entries < 15s apart trigger a "merge/keep both" toast.
- **Recording interrupted** (call, backgrounding): `MediaRecorder` stop events flush what
  was captured; a partial clip is still a valid entry.
- **Drive quota full**: uploads fail with a clear message; entries stay queued locally.
- **Skill never runs**: the log grows past a stale checkpoint; Day view shows a growing
  pending count and nudges toward the "Process now" helper.
- **App can't see skill-created files.** With `drive.file`, the app can only see files
  *it* created — so a `results/` or checkpoint file created *by the skill* would be
  invisible to the app. **Contract fix:** the app pre-creates `checkpoint.json` (at
  stream bootstrap) and `results/<date>.json` (at first upload of each day) as empty
  stubs; skills *update* (never re-create) them. Stated in every skill prompt and tested
  per provider. (The same rule applies to any future file a skill needs the app to read.)
- **User manually deletes log files in Drive** (the out-of-band erasure escape hatch,
  §4.5): consumers must tolerate gaps in the seq numbering; the app reconciles by
  treating missing local-known events as erased.
- **Assistant lacks audio understanding**: the skill must report unprocessable entries
  (§6.2 step 2), and the user can add a text note to those entries; provider capability
  is listed in the skill doc's compatibility table.
- **Event edited/deleted by user in Calendar**: fine — calendar is the source of truth;
  the app just re-reads. Provenance lines (§6.2) keep skill re-runs idempotent anyway.
- **Timezone travel / DST**: entries carry offset + IANA zone; skill instructed to use
  each entry's own offset; Day view renders device-local.
- **Clock skew**: device clock is authoritative; acceptable for this domain.
- **iOS mic regression in a point release**: runtime feature-check at tap; text-entry
  fallback (§4.1); never gate the app on audio.

---

## 12. Milestones

1. **M1 — Capture core (offline, zero Google):** PWA shell, stream-parameterized capture
   component (timelog config), entry store keyed by stream, replay, places, text/photo
   add-ons. Usable as a local voice log.
2. **M2 — Drive upload:** GIS auth, `timebox/` tree bootstrap (`streams.json` +
   `timelog/` + checkpoint/results stubs), append-protocol upload queue, stream config
   file, status badges, reconnect UX.
3. **M3 — Timelog skill v1:** `timelog.SKILL.md` contract + prompt, tested end-to-end on
   Claude and ChatGPT with real connectors (including checkpoint advance and
   stub-update visibility); Settings guided setup.
4. **M4 — Read-back:** calendar picker, read-only Day view, results + checkpoint
   polling, processed-status loop, "Process now" helper.
5. **M5 — Polish:** onboarding, export, retention setting, iOS device matrix
   (Safari tab vs standalone; iOS 17/18), duplicate handling; extensibility dry-run —
   define a second stream config on a branch and verify the §5.5 invariant holds (no
   engine/contract changes needed).

---

## 13. Open Questions

1. Should the app offer an optional local waveform-level VAD auto-stop (stop recording on
   2s of silence) to make capture truly one-tap?
2. Retention policy for old log audio — keep forever (user's Drive) or offer a
   user-initiated archival step (out-of-band, since the log is immutable to skills)?
3. Web Push (iOS 16.4+) for a "you haven't logged in 4 hours" nudge — worth the service
   worker + permission complexity in v2?
4. Multi-day backlog processing: should the skill prompt cap how many days it processes
   per run to stay within assistant context limits?
5. A second skill variant that also *summarizes* the day in prose (journal entry) — same
   contract, different prompt?
6. When multiple streams exist (v2): one combined skill run that processes all stream
   logs, or one skill per stream? (Per-stream keeps prompts small and failures
   isolated; combined is one scheduled task.)
7. Stream switcher UX (v2): header control vs long-press on the capture button?

