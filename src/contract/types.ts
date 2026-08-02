/**
 * capture.event.v1 — the stream-agnostic event record (SPEC §5.2, §3.3).
 * These types are the serialized Drive contract; no domain fields allowed.
 */

export const EVENT_SCHEMA = 'capture.event.v1'

export interface GeoLocation {
  lat: number
  lng: number
  accuracyM: number
  placeLabel?: string
  /** Short reverse-geocoded address ("near …"); lazily filled, best-effort. */
  address?: string
}

export type AttachmentKind = 'audio' | 'text' | 'photo'

export interface Attachment {
  kind: AttachmentKind
  /** Filename within the entry's log partition (see filenames.ts). */
  file: string
  mimeType: string
  durationSec?: number
  /**
   * Filename of the sibling attachment this one was machine-derived from
   * (e.g. a transcript's source audio). Absent = user-created content.
   */
  derivedFrom?: string
}

interface EventBase {
  schema: typeof EVENT_SCHEMA
  /** Short unique id within the stream. */
  id: string
  /** Per-stream monotonic sequence number. */
  seq: number
  stream: string
  /** Append time, ISO-8601 with local offset. Partition key. */
  loggedAt: string
  /** IANA zone of the device at append time. */
  deviceTz: string
}

export interface CaptureEvent extends EventBase {
  type: 'capture'
  /** Domain time the entry refers to, ISO-8601 with local offset. */
  capturedAt: string
  location?: GeoLocation
  attachments: Attachment[]
}

export interface AmendPatch {
  capturedAt?: string
  location?: GeoLocation
  /**
   * Clear the entry's location (append-only removal — the prior capture/amend
   * still carries it in the log). Distinct from an absent `location`, which
   * means "no change". Ignored if `location` is also present.
   */
  clearLocation?: boolean
  /**
   * Files of prior attachments the fold hides from the entry (append-only
   * removal — the files and their history stay in the log). Editing a note
   * is one amend that removes the old text file and adds the new one.
   */
  removeAttachments?: string[]
}

export interface AmendEvent extends EventBase {
  type: 'amend'
  /** Ids of the capture events being amended. */
  targets: string[]
  patch?: AmendPatch
  /** Additional attachments appended to the target entries. */
  attachments?: Attachment[]
}

export interface RevokeEvent extends EventBase {
  type: 'revoke'
  /** Ids of the capture events being revoked. */
  targets: string[]
}

export type LogEvent = CaptureEvent | AmendEvent | RevokeEvent

/**
 * Entry — the folded, user-visible view of a capture event after applying
 * later amend/revoke events (SPEC §3.3). Never serialized; derived state.
 */
export interface Entry {
  id: string
  /** Seq of the originating capture event. */
  seq: number
  stream: string
  loggedAt: string
  /** Effective time (after amendments). */
  capturedAt: string
  deviceTz: string
  location?: GeoLocation
  attachments: Attachment[]
  /** Append timestamp for each currently visible attachment, keyed by file. */
  attachmentLoggedAt?: Record<string, string>
  /** Highest seq of any event that affected this entry. */
  lastEventSeq: number
  revoked: boolean
}
