/**
 * Day-view calendar fetch (SPEC §4.2). Resolves the connection + chosen target
 * calendar, then reads that calendar's events for the given local date. Returns
 * a discriminated state the view maps straight to UI: the read-only calendar
 * layer never mutates anything, and a missing token / calendar / scope is a
 * normal, non-error state (the day still shows local entries either way).
 *
 * dayview/ is timelog-specific (§10), so it may lean on gcal/ and drive/.
 */
import { useEffect, useState } from 'react'
import { getValidAccessToken } from '../drive/token'
import { CalendarError, listEvents } from '../gcal/client'
import { getTargetCalendar } from '../gcal/config'
import { dayRange, type CalEvent } from '../gcal/events'

export type DayEventsState =
  | { kind: 'not-connected' }
  | { kind: 'no-calendar' }
  | { kind: 'loading' }
  | { kind: 'ready'; events: CalEvent[]; calendarId: string; calendarName: string }
  | { kind: 'auth-error' }
  | { kind: 'error' }

/**
 * Fetch the target calendar's events for `date` ("YYYY-MM-DD"). Re-runs when the
 * date changes or `reloadKey` is bumped (e.g. after connecting in Settings).
 */
export function useDayEvents(date: string, reloadKey = 0): DayEventsState {
  const [state, setState] = useState<DayEventsState>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    void (async () => {
      const token = await getValidAccessToken()
      if (token === undefined) {
        if (live) setState({ kind: 'not-connected' })
        return
      }
      const target = await getTargetCalendar()
      if (target === undefined) {
        if (live) setState({ kind: 'no-calendar' })
        return
      }
      try {
        const events = await listEvents(token, { calendarId: target.id, ...dayRange(date) })
        // calendarId rides along for the overlay layer: buildPseudoEntries
        // matches overlays per calendar, and new overlays target it (§3.6).
        if (live) {
          setState({ kind: 'ready', events, calendarId: target.id, calendarName: target.summary })
        }
      } catch (err) {
        if (!live) return
        setState({ kind: err instanceof CalendarError && err.isAuth ? 'auth-error' : 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [date, reloadKey])

  return state
}
