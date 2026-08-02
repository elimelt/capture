/**
 * Google Calendar API v3 over plain fetch + Bearer token (SPEC §8.1 — no gapi,
 * mirrors drive/client.ts). Read-only: list the user's calendars for the
 * Settings target picker (§4.3) and read one calendar's events for the Day view
 * (§4.2). The app never writes calendar events (§1.2). The Bearer token is the
 * app's single Google token, which is granted calendar.readonly alongside
 * drive.file at connect (§8.1) — the caller passes it in, as in drive/client.
 */
import {
  parseEvents,
  sortEvents,
  type CalEvent,
  type CalendarSummary,
  type RawEvent,
} from './events'

const API = 'https://www.googleapis.com/calendar/v3'

/** A Calendar HTTP failure, classified like DriveError for the callers' UX. */
export class CalendarError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CalendarError'
    this.status = status
  }
  /** 401/403 → token expired or calendar scope not granted: prompt reconnect. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
  /** 429/5xx → transient: safe to retry later. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res
  let detail = res.statusText
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    if (body.error?.message) detail = body.error.message
  } catch {
    // Non-JSON error body; the status alone is enough to classify.
  }
  throw new CalendarError(res.status, `Calendar ${res.status}: ${detail}`)
}

interface RawCalendarListEntry {
  id?: string
  summary?: string
  primary?: boolean
}

/**
 * The user's calendars, for the target picker (§4.3). Only calendars the user
 * can at least read are returned (minAccessRole=reader); the primary one is
 * flagged so the UI can default to it.
 */
export async function listCalendars(token: string): Promise<CalendarSummary[]> {
  const items: RawCalendarListEntry[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      fields: 'nextPageToken, items(id,summary,primary)',
      minAccessRole: 'reader',
      maxResults: '250',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await ensureOk(
      await fetch(`${API}/users/me/calendarList?${params}`, { headers: bearer(token) }),
    )
    const data = (await res.json()) as { items?: RawCalendarListEntry[]; nextPageToken?: string }
    if (data.items) items.push(...data.items)
    pageToken = data.nextPageToken
  } while (pageToken)
  return items
    .filter((c): c is RawCalendarListEntry & { id: string } => typeof c.id === 'string')
    .map((c) => ({ id: c.id, summary: c.summary?.trim() || c.id, primary: c.primary ?? false }))
}

export interface ListEventsArgs {
  calendarId: string
  /** RFC-3339 window bounds; use events.dayRange() to build them. */
  timeMin: string
  timeMax: string
}

/**
 * A single calendar's events within [timeMin, timeMax), expanded to single
 * instances and ordered by start. Recurring events are expanded server-side
 * (singleEvents=true) so the Day view sees concrete blocks (§4.2).
 */
export async function listEvents(
  token: string,
  { calendarId, timeMin, timeMax }: ListEventsArgs,
): Promise<CalEvent[]> {
  const items: RawEvent[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      // `updated` feeds the overlay dirty-check fast path and `recurringEventId`
      // the instance-level overlay identity (SPEC §3.6); parseEvent threads both.
      fields:
        'nextPageToken, items(id,summary,htmlLink,status,start(date,dateTime),end(date,dateTime),updated,recurringEventId)',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await ensureOk(
      await fetch(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
        headers: bearer(token),
      }),
    )
    const data = (await res.json()) as { items?: RawEvent[]; nextPageToken?: string }
    if (data.items) items.push(...data.items)
    pageToken = data.nextPageToken
  } while (pageToken)
  return sortEvents(parseEvents(items))
}
