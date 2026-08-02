/**
 * Read-only calendar block for the Day view (SPEC §4.2, §3.5). Renders the
 * target calendar's events for the day as tappable rows that open the event in
 * Google Calendar (htmlLink). The app never edits events (§1.2). Non-ready
 * states render quiet, non-blocking copy — local entries carry the day on their
 * own, so calendar unavailability is never an error the user must act on.
 */
import { Card, cx, tone, type_ } from '../ui'
import type { CalEvent } from '../gcal/events'
import type { DayEventsState } from './useDayEvents'

/** "9:04 AM" in the device zone; all-day events get a plain label instead. */
function timeLabel(ev: CalEvent): string {
  if (ev.allDay) return 'All day'
  return new Date(ev.startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function EventRow({ event }: { event: CalEvent }) {
  if (event.htmlLink === undefined) {
    return (
      <div className={cx('flex items-baseline gap-2', type_.body, tone.textPrimary)}>
        <span className={cx('shrink-0 tabular-nums', type_.caption, tone.textMuted)}>
          {timeLabel(event)}
        </span>
        <span className="truncate">{event.summary}</span>
      </div>
    )
  }
  return (
    <a
      href={event.htmlLink}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open “${event.summary}” in Google Calendar`}
      className={cx('flex items-baseline gap-2', tone.pressWash, 'rounded-lg')}
    >
      <span className={cx('shrink-0 tabular-nums', type_.caption, tone.textMuted)}>
        {timeLabel(event)}
      </span>
      <span className={cx('truncate', type_.body, tone.textPrimary)}>{event.summary}</span>
    </a>
  )
}

const NON_READY_NOTE: Record<Exclude<DayEventsState['kind'], 'ready' | 'loading'>, string> = {
  'not-connected': 'Connect Google in Settings to see calendar events.',
  'no-calendar': 'Pick a calendar in Settings to see events here.',
  'auth-error': 'Reconnect Google in Settings to see calendar events.',
  error: 'Couldn’t load calendar events.',
}

export function CalendarEvents({ state }: { state: DayEventsState }) {
  if (state.kind === 'loading') return null

  if (state.kind !== 'ready')
    return <p className={cx('px-1', type_.sub, tone.textFaint)}>{NON_READY_NOTE[state.kind]}</p>

  if (state.events.length === 0)
    return (
      <p className={cx('px-1', type_.sub, tone.textFaint)}>
        No events on {state.calendarName} this day.
      </p>
    )

  return (
    <Card className="flex flex-col gap-2">
      <p className={cx(type_.overline, tone.textMuted)}>{state.calendarName}</p>
      {state.events.map((ev) => (
        <EventRow key={ev.id} event={ev} />
      ))}
    </Card>
  )
}
