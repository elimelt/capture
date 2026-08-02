import { afterEach, describe, expect, it, vi } from 'vitest'
import { CalendarError, listCalendars, listEvents } from './client'

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>()
  for (const res of responses) fetchMock.mockResolvedValueOnce(res)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listCalendars', () => {
  it('requests readable calendars and maps id/summary/primary', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        items: [
          { id: 'primary@x', summary: '  Me  ', primary: true },
          { id: 'team@group', summary: 'Team' },
          { summary: 'no id — dropped' },
        ],
      }),
    )
    const cals = await listCalendars('tok')
    expect(cals).toEqual([
      { id: 'primary@x', summary: 'Me', primary: true },
      { id: 'team@group', summary: 'Team', primary: false },
    ])

    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toContain('/users/me/calendarList')
    expect(parsed.searchParams.get('minAccessRole')).toBe('reader')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })
})

describe('listEvents', () => {
  it('builds an expanded, ordered query and returns parsed events', async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        items: [
          {
            id: 'e1',
            summary: 'Work',
            htmlLink: 'https://cal/e1',
            start: { dateTime: '2026-08-02T09:00:00Z' },
            end: { dateTime: '2026-08-02T10:00:00Z' },
          },
        ],
      }),
    )
    const events = await listEvents('tok', {
      calendarId: 'a b/c@group',
      timeMin: '2026-08-02T00:00:00-04:00',
      timeMax: '2026-08-03T00:00:00-04:00',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'e1', summary: 'Work', allDay: false })

    const [url] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))
    // calendarId is path-encoded (the '/', space and '@' must survive).
    expect(parsed.pathname).toContain(encodeURIComponent('a b/c@group'))
    expect(parsed.searchParams.get('singleEvents')).toBe('true')
    expect(parsed.searchParams.get('orderBy')).toBe('startTime')
    expect(parsed.searchParams.get('timeMin')).toBe('2026-08-02T00:00:00-04:00')
  })
})

describe('CalendarError classification', () => {
  it('throws a classified error on non-2xx and flags auth vs retryable', async () => {
    stubFetch(jsonResponse({ error: { message: 'insufficient scope' } }, 403))
    await expect(listCalendars('tok')).rejects.toMatchObject({ status: 403 })

    expect(new CalendarError(401, 'x').isAuth).toBe(true)
    expect(new CalendarError(403, 'x').isAuth).toBe(true)
    expect(new CalendarError(429, 'x').isRetryable).toBe(true)
    expect(new CalendarError(500, 'x').isRetryable).toBe(true)
    expect(new CalendarError(404, 'x').isAuth).toBe(false)
  })
})
