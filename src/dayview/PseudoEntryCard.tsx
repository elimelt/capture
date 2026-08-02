/**
 * One calendar pseudo-entry's card on the Day timeline (SPEC §3.6, §4.2):
 * the merged view of a live calendar event plus its optional overlay.
 * Renders the merge output (`mergePseudoEntry`) — the user's edits already
 * win per field — with informational badges: "May be outdated" only when
 * dirty === 'conflict' (the base moved under an edited field; never
 * blocking), and "Deleted upstream" for orphans, which gain a Remove action
 * (revoke — user notes never silently vanish). Tapping the content opens the
 * edit sheet; Hide is one tap (an overlay patch, undoable via the caller's
 * toast). Deliberately calendar-flavored, not an EntryCard: no attachments,
 * location, or playback — those belong to captures.
 */
import { Button, CalendarIcon, EyeOffIcon, SlidersIcon, TimelineRow, TrashIcon, cx, motion, tone, type_ } from '../ui'
import type { PseudoEntry } from '../gcal/overlay/pseudoEntry'

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "9:00 AM – 10:30 AM" for timed events; all-day events get a plain label. */
export function pseudoTimeLabel(entry: Pick<PseudoEntry, 'allDay' | 'startMs' | 'endMs'>): string {
  if (entry.allDay) return 'All day'
  return `${clock(entry.startMs)} – ${clock(entry.endMs)}`
}

/** The single start-time (or "All day") shown in the narrow rail gutter — the
 *  full range stays in the card header where there's room. */
function pseudoRailTime(entry: Pick<PseudoEntry, 'allDay' | 'startMs'>): string {
  return entry.allDay ? 'All day' : clock(entry.startMs)
}

interface PseudoEntryCardProps {
  entry: PseudoEntry
  /** Timeline-rail position — trims the connecting line at the rail's ends. */
  first?: boolean
  last?: boolean
  /** Open the edit sheet (also fired by tapping the card content). */
  onEdit: () => void
  /** Hide from the Day view (toggleHidden → one overlay patch). */
  onHide: () => void
  /** Orphans only: discard the overlay entirely (revoke). */
  onRemove: () => void
}

export function PseudoEntryCard({ entry, first = false, last = false, onEdit, onHide, onRemove }: PseudoEntryCardProps) {
  return (
    <TimelineRow
      time={<span className="tabular-nums">{pseudoRailTime(entry)}</span>}
      first={first}
      last={last}
      className={motion.riseIn}
    >
      <button
        onClick={onEdit}
        aria-label={`Edit “${entry.title}”`}
        className={cx('block w-full rounded-lg text-left', tone.pressWash)}
      >
        <div className="flex items-center gap-2">
          <span className={tone.textFaint}>
            <CalendarIcon size={13} />
          </span>
          <span className={cx('shrink-0 tabular-nums', type_.caption, tone.textMuted)}>
            {pseudoTimeLabel(entry)}
          </span>
          {entry.dirty === 'conflict' && (
            <span
              className={cx(
                'ml-auto shrink-0 rounded-full px-2 py-0.5',
                type_.caption,
                tone.dangerWash,
                tone.danger,
              )}
              title="This event changed in Google Calendar after you edited it — your edit may be outdated."
            >
              May be outdated
            </span>
          )}
          {entry.orphaned && (
            <span
              className={cx(
                'ml-auto shrink-0 rounded-full border px-2 py-0.5',
                type_.caption,
                tone.border,
                tone.textMuted,
              )}
              title="This event no longer exists in Google Calendar; your notes are kept."
            >
              Deleted upstream
            </span>
          )}
        </div>
        <p className={cx('mt-1 truncate', type_.body, tone.textPrimary)}>{entry.title}</p>
        {/* The note is a free-text annotation the user typed on this event —
            content, not chrome (#85) — so it reads serif like an entry note,
            just one step quieter (textSecondary) than the title. */}
        {entry.note !== undefined && entry.note !== '' && (
          <p className={cx('mt-0.5', type_.bodySmall, tone.textSecondary)}>{entry.note}</p>
        )}
      </button>

      <div className="mt-2 flex items-center gap-1">
        {entry.orphaned && (
          <Button variant="dangerGhost" size="sm" onClick={onRemove}>
            <TrashIcon /> Remove
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onHide} className="ml-auto">
          <EyeOffIcon /> Hide
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <SlidersIcon /> Edit
        </Button>
      </div>
    </TimelineRow>
  )
}
