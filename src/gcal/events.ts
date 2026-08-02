/**
 * Read-only Calendar event model (SPEC §3.5, §4.2). Pure, testable helpers the
 * gcal client and the Day view share: normalize the Calendar API's two time
 * shapes (timed `dateTime` vs all-day `date`) into epoch-ms, order events, and
 * build the local-day query window. No fetching here — that lives in client.ts.
 *
 * gcal/ is the timelog-specific read-back layer (SPEC §10); it may depend on
 * the generic contract/ helpers, never the other way around.
 */
import { toLocalIso } from '../contract/time'

/** An entry in the user's calendar list, for the Settings target picker (§4.3). */
export interface CalendarSummary {
  id: string
  summary: string
  primary: boolean
}

/** A calendar event, normalized from the API's start/end shapes (§3.5). */
export interface CalEvent {
  id: string
  summary: string
  /** Deep link to open/edit the event in Google Calendar (§4.2). */
  htmlLink?: string
  /** Epoch ms of the event start — the ordering + render key. */
  startMs: number
  /** Epoch ms of the event end. */
  endMs: number
  /** True for all-day events (carried as `date`, not `dateTime`). */
  allDay: boolean
  /** Last-modification RFC-3339 stamp; overlay dirty-check fast path (§3.6). */
  updated?: string
  /** Parent series id for expanded recurring instances (§3.6 overlays). */
  recurringEventId?: string
}

/** The Calendar API `start`/`end` shape: exactly one of dateTime | date. */
export interface RawEventTime {
  dateTime?: string
  date?: string
}

/** The subset of a Calendar API event resource we read. */
export interface RawEvent {
  id?: string
  summary?: string
  htmlLink?: string
  status?: string
  start?: RawEventTime
  end?: RawEventTime
  updated?: string
  recurringEventId?: string
}

function timeMs(t: RawEventTime | undefined, allDay: boolean): number | null {
  if (t === undefined) return null
  // All-day dates ("YYYY-MM-DD") are parsed at local midnight so they sit on
  // the right day in the device zone (bare Date("YYYY-MM-DD") is UTC).
  if (allDay) return t.date ? new Date(`${t.date}T00:00:00`).getTime() : null
  return t.dateTime ? new Date(t.dateTime).getTime() : null
}

/**
 * Normalize one raw event, or null if it is unusable — cancelled, or missing
 * an id or a parseable start/end. Callers filter the nulls out.
 */
export function parseEvent(raw: RawEvent): CalEvent | null {
  if (!raw.id || raw.status === 'cancelled') return null
  const allDay = raw.start?.date !== undefined
  const startMs = timeMs(raw.start, allDay)
  const endMs = timeMs(raw.end, allDay)
  if (startMs === null || endMs === null) return null
  return {
    id: raw.id,
    summary: raw.summary?.trim() || '(no title)',
    ...(raw.htmlLink ? { htmlLink: raw.htmlLink } : {}),
    startMs,
    endMs,
    allDay,
    ...(raw.updated ? { updated: raw.updated } : {}),
    ...(raw.recurringEventId ? { recurringEventId: raw.recurringEventId } : {}),
  }
}

/** Parse + drop unusable events; does not reorder (the API is asked to sort). */
export function parseEvents(raw: RawEvent[]): CalEvent[] {
  return raw.map(parseEvent).filter((e): e is CalEvent => e !== null)
}

/** Stable order: earliest start first, then earliest end. */
export function sortEvents(events: CalEvent[]): CalEvent[] {
  return [...events].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

/**
 * The [timeMin, timeMax) RFC-3339 window covering one local calendar date,
 * rendered with the device offset so the Calendar API returns that day's
 * events in the user's zone (§4.5 timezone-safety).
 */
export function dayRange(date: string): { timeMin: string; timeMax: string } {
  const start = new Date(`${date}T00:00:00`)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  return { timeMin: toLocalIso(start), timeMax: toLocalIso(end) }
}
