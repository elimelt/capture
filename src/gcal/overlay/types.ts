/**
 * capture.calendar-overlay.v1 — local annotations layered over read-only
 * Google Calendar events (SPEC §3.6, §5.6). A third append-only log alongside
 * the capture streams, with the same three-verb shape: `overlay` creates
 * (copy-on-write against a frozen snapshot of the live calendar event),
 * `amend` patches, `revoke` discards. The calendar itself is never written
 * (SPEC §1.2 — the scope stays calendar.readonly); overlays are app-only
 * pseudo-entry state and **no skill ever reads this log**.
 *
 * Deliberately NOT new kinds inside capture.event.v1: contract/ is the
 * domain-free, skill-facing Drive contract, and calendar overlays are neither
 * captures nor skill-visible. gcal/overlay owns these types end to end;
 * store/db persists the rows opaquely (layering rule, SPEC §10).
 */

export const OVERLAY_SCHEMA = 'capture.calendar-overlay.v1'
export const OVERLAY_STREAM = 'calendar-overlay'

/**
 * Instance-level identity of the calendar event an overlay annotates. The app
 * fetches with `singleEvents=true`, so recurring events are already expanded
 * and `eventId` is the concrete occurrence id; `recurringEventId` (the parent
 * series id, when the instance belongs to one) is carried for display and
 * future "apply to series" affordances, never for matching.
 */
export interface CalendarEventRef {
  calendarId: string
  eventId: string
  recurringEventId?: string
}

/**
 * The frozen copy-on-write base: the live calendar event's fields at the
 * moment the overlay was created. Field-level (not a hash) because dirty
 * detection must say WHICH field moved (SPEC §3.6 merge/dirty policy).
 * `updated` is the Calendar API `Event.updated` RFC-3339 stamp — an equality
 * fast-path: when the live event's `updated` matches, the base is unchanged.
 */
export interface OverlayBaseSnapshot {
  summary: string
  /** Epoch ms, mirroring CalEvent (gcal/events.ts). */
  startMs: number
  /** Epoch ms, mirroring CalEvent. */
  endMs: number
  allDay: boolean
  updated?: string
}

/**
 * The user's edits over the base event. Every field has a `clearX` sibling
 * (mirroring AmendPatch.clearLocation): absent field = "no change", `clearX` =
 * "drop my override, revert to the live event". A value wins over its clear
 * within the same amend. `startAt`/`endAt` are local-offset ISO-8601 strings
 * (the contract timestamp convention); `hidden` hides the pseudo-entry from
 * the day view without discarding the overlay (`hidden: false` unhides —
 * contrast with revoke, which discards the overlay entirely). No attachments
 * and no GeoLocation: calendar events are not captures.
 */
export interface OverlayPatch {
  title?: string
  clearTitle?: boolean
  note?: string
  clearNote?: boolean
  startAt?: string
  endAt?: string
  /** Revert both time overrides; ignored if startAt or endAt is also present. */
  clearTime?: boolean
  hidden?: boolean
}

interface OverlayEventBase {
  schema: typeof OVERLAY_SCHEMA
  /** Short unique id within the stream (the identity, as in capture.event.v1). */
  id: string
  /** Per-stream monotonic sequence number; ordering hint only. */
  seq: number
  stream: string
  /** Append time, ISO-8601 with local offset. */
  loggedAt: string
  /** IANA zone of the device at append time. */
  deviceTz: string
}

/** Materializes an overlay: freezes the base snapshot and applies a first patch. */
export interface OverlayCreateEvent extends OverlayEventBase {
  type: 'overlay'
  target: CalendarEventRef
  baseSnapshot: OverlayBaseSnapshot
  patch: OverlayPatch
}

export interface OverlayAmendEvent extends OverlayEventBase {
  type: 'amend'
  /** Ids of the overlay (create) events being amended. */
  targets: string[]
  patch?: OverlayPatch
}

export interface OverlayRevokeEvent extends OverlayEventBase {
  type: 'revoke'
  /** Ids of the overlay (create) events being discarded. */
  targets: string[]
}

export type OverlayLogEvent = OverlayCreateEvent | OverlayAmendEvent | OverlayRevokeEvent

/**
 * The folded, effective view of one overlay after applying later amends —
 * derived state, never serialized. `patch` is the accumulated effective patch:
 * `clearX` flags are wire-only and never appear here (a clear simply removes
 * the field from the accumulated patch).
 */
export interface OverlayState {
  /** Id of the originating overlay (create) event. */
  id: string
  target: CalendarEventRef
  baseSnapshot: OverlayBaseSnapshot
  patch: OverlayPatch
  /** Highest seq of any event that affected this overlay. */
  lastEventSeq: number
  revoked: boolean
}
