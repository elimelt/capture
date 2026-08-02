/**
 * Assemble one day's pseudo-entries: the fetched calendar events merged with
 * their overlays, plus orphaned overlays whose event vanished from the
 * calendar but whose effective start still falls on the requested date
 * (SPEC §3.6). Pure — the day view calls this over already-fetched data.
 */
import { localDateOf, toLocalIso } from '../../contract/time'
import type { CalEvent } from '../events'
import { mergePseudoEntry, type PseudoEntry } from './pseudoEntry'
import type { OverlayState } from './types'

/** Local calendar date ("YYYY-MM-DD") an overlay's effective start falls on. */
function effectiveDateOf(state: OverlayState): string {
  if (state.patch.startAt !== undefined) return localDateOf(state.patch.startAt)
  return localDateOf(toLocalIso(new Date(state.baseSnapshot.startMs)))
}

/**
 * Build the pseudo-entries for one local date from `calEvents` fetched from
 * `calendarId` (the events themselves carry no calendar id) and the folded
 * overlay states.
 *
 * - Overlays match events by `eventId` within `calendarId`; overlays
 *   targeting other calendars are ignored entirely. Recurring instances are
 *   independent (`singleEvents=true` expansion means each occurrence has its
 *   own event id).
 * - An overlay with no matching event is included as `orphaned: true` only
 *   when its effective date equals `date` — orphans from other days belong to
 *   other days' views.
 * - Entries whose effective patch says `hidden` are dropped.
 * - Result is ordered by effective start (`startMs`, then `endMs`, then id).
 *
 * IMPORTANT: only call this with real data — i.e. when the calendar fetch
 * state is 'ready'. Passing a partial/empty event list from a loading or
 * error state would misclassify every overlay as orphaned (false positives).
 */
export function buildPseudoEntries(
  calendarId: string,
  calEvents: readonly CalEvent[],
  overlays: readonly OverlayState[],
  date: string,
): PseudoEntry[] {
  const byEventId = new Map<string, OverlayState>()
  for (const o of overlays) {
    if (o.revoked || o.target.calendarId !== calendarId) continue
    byEventId.set(o.target.eventId, o) // later state wins, as in indexOverlaysByTarget
  }

  const entries: PseudoEntry[] = []
  const matched = new Set<string>()
  for (const ev of calEvents) {
    const overlay = byEventId.get(ev.id)
    if (overlay !== undefined) matched.add(ev.id)
    const entry = mergePseudoEntry(calendarId, ev, overlay)
    if (entry !== null && !entry.hidden) entries.push(entry)
  }
  for (const [eventId, overlay] of byEventId) {
    if (matched.has(eventId)) continue
    if (effectiveDateOf(overlay) !== date) continue
    const entry = mergePseudoEntry(calendarId, undefined, overlay)
    if (entry !== null && !entry.hidden) entries.push(entry)
  }

  entries.sort(
    (a, b) =>
      a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return entries
}
