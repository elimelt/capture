/**
 * PseudoEntry — the day view's merged, read-only view of one calendar event
 * plus its optional overlay (SPEC §3.6). Pure functions only; nothing here
 * ever writes.
 *
 * THE merge rule: the user's patch value wins where present; otherwise the
 * LIVE base value wins — never the frozen snapshot. Because untouched fields
 * always track the live event, upstream calendar edits auto-merge for free.
 * The snapshot exists only to *classify*: a field is dirty when the patch
 * touches it AND the live base has moved away from the snapshot on it. The
 * user's edit still wins the render even in conflict — the badge is
 * informational, never blocking.
 */
import type { CalEvent } from '../events'
import type { CalendarEventRef, OverlayState } from './types'

export type DirtyStatus = 'clean' | 'auto-merged' | 'conflict'

export type DirtyField = 'title' | 'time'

export interface PseudoEntry {
  /** The overlay id when materialized, else `cal:<calendarId>:<eventId>`. */
  id: string
  target: CalendarEventRef
  title: string
  note?: string
  /** Effective start, epoch ms: patch.startAt if present, else the live base. */
  startMs: number
  endMs: number
  allDay: boolean
  hidden: boolean
  /** True when a (non-revoked) overlay exists for this event. */
  materialized: boolean
  overlayId?: string
  htmlLink?: string
  /** True when the overlay's calendar event no longer exists in the fetch. */
  orphaned: boolean
  dirty: DirtyStatus
  dirtyFields: DirtyField[]
}

/**
 * Merge one live calendar event with its overlay into a PseudoEntry — pure,
 * read-only. `calendarId` identifies the calendar `base` was fetched from
 * (CalEvent itself carries no calendar id).
 *
 * - base only → a plain, unmaterialized pseudo-entry mirroring the event;
 * - both → patch value wins per field, live base fills the rest; dirty
 *   classification per the module doc (the snapshot's `updated` stamp is an
 *   equality fast-path: when it matches the live event's, the base is treated
 *   as unchanged);
 * - overlay only → orphaned: the frozen snapshot stands in for the base, and
 *   with no live base to diff the entry classifies as clean;
 * - a revoked overlay is treated as absent (revoke discards the overlay);
 * - neither → null.
 */
export function mergePseudoEntry(
  calendarId: string,
  base: CalEvent | undefined,
  overlay: OverlayState | undefined,
): PseudoEntry | null {
  if (overlay?.revoked) overlay = undefined
  if (base === undefined && overlay === undefined) return null

  if (overlay === undefined) {
    // base is defined here (the null case above covers neither).
    const ev = base as CalEvent
    return {
      id: `cal:${calendarId}:${ev.id}`,
      target: {
        calendarId,
        eventId: ev.id,
        ...(ev.recurringEventId !== undefined ? { recurringEventId: ev.recurringEventId } : {}),
      },
      title: ev.summary,
      startMs: ev.startMs,
      endMs: ev.endMs,
      allDay: ev.allDay,
      hidden: false,
      materialized: false,
      ...(ev.htmlLink !== undefined ? { htmlLink: ev.htmlLink } : {}),
      orphaned: false,
      dirty: 'clean',
      dirtyFields: [],
    }
  }

  const snap = overlay.baseSnapshot
  const patch = overlay.patch

  // Dirty classification needs a live base; an orphan has nothing to diff.
  let titleMoved = false
  let timeMoved = false
  if (base !== undefined) {
    const baseUnchanged = snap.updated !== undefined && snap.updated === base.updated
    if (!baseUnchanged) {
      titleMoved = base.summary !== snap.summary
      timeMoved =
        base.startMs !== snap.startMs || base.endMs !== snap.endMs || base.allDay !== snap.allDay
    }
  }
  const dirtyFields: DirtyField[] = []
  if (patch.title !== undefined && titleMoved) dirtyFields.push('title')
  if ((patch.startAt !== undefined || patch.endAt !== undefined) && timeMoved) {
    dirtyFields.push('time')
  }
  const dirty: DirtyStatus =
    dirtyFields.length > 0 ? 'conflict' : titleMoved || timeMoved ? 'auto-merged' : 'clean'

  return {
    id: overlay.id,
    target: { ...overlay.target },
    title: patch.title ?? base?.summary ?? snap.summary,
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    startMs:
      patch.startAt !== undefined
        ? new Date(patch.startAt).getTime()
        : (base?.startMs ?? snap.startMs),
    endMs:
      patch.endAt !== undefined ? new Date(patch.endAt).getTime() : (base?.endMs ?? snap.endMs),
    allDay: base?.allDay ?? snap.allDay,
    hidden: patch.hidden ?? false,
    materialized: true,
    overlayId: overlay.id,
    ...(base?.htmlLink !== undefined ? { htmlLink: base.htmlLink } : {}),
    orphaned: base === undefined,
    dirty,
    dirtyFields,
  }
}
