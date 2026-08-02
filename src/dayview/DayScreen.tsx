/**
 * Screen 2 — Day (SPEC §4.2). One merged, time-sorted timeline of local
 * entries and calendar pseudo-entries (editable overlays — §3.6), rendered
 * by DayTimeline.
 */
import { useNavigate, useParams } from 'react-router-dom'
import { localDateOf, toLocalIso } from '../contract/time'
import { useAppStore } from '../store/appStore'
import { usePendingDelete } from '../capture/usePendingDelete'
import { Button, IconButton, ScreenHeader, Toast, cx, motion } from '../ui'
import { DaySynthesisCard } from './DaySynthesisCard'
import { DayTimeline } from './DayTimeline'
import { useDaySynthesis } from './useDaySynthesis'

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return localDateOf(toLocalIso(d))
}

function dayTitle(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === shiftDate(today, -1)) return 'Yesterday'
  return new Date(`${date}T12:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export default function DayScreen() {
  const params = useParams<{ date?: string }>()
  const navigate = useNavigate()
  const entries = useAppStore((s) => s.entries)
  const revoke = useAppStore((s) => s.revoke)
  const appSettings = useAppStore((s) => s.appSettings)
  const del = usePendingDelete(revoke)

  const today = localDateOf(toLocalIso(new Date()))
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today
  const title = dayTitle(date, today)

  const dayEntries = entries
    .filter((e) => !e.revoked && e.id !== del.pendingId && localDateOf(e.capturedAt) === date)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  const synthesis = useDaySynthesis(
    date,
    dayEntries,
    title,
    appSettings.assistantEnabled,
  )

  return (
    <div className={cx('flex flex-col gap-4 p-4', motion.fadeIn)}>
      <ScreenHeader
        title={title}
        subtitle={`${dayEntries.length} ${dayEntries.length === 1 ? 'entry' : 'entries'}`}
        trailing={
          <div className="flex items-center gap-1">
            <IconButton
              aria-label="Previous day"
              variant="ghost"
              onClick={() => navigate(`/day/${shiftDate(date, -1)}`)}
            >
              ‹
            </IconButton>
            {date !== today && (
              <Button variant="ghost" size="sm" onClick={() => navigate('/day')}>
                Today
              </Button>
            )}
            <IconButton
              aria-label="Next day"
              variant="ghost"
              disabled={date >= today}
              onClick={() => navigate(`/day/${shiftDate(date, 1)}`)}
            >
              ›
            </IconButton>
          </div>
        }
      />

      <DaySynthesisCard synthesis={synthesis} assistantEnabled={appSettings.assistantEnabled} />

      <DayTimeline
        date={date}
        entries={dayEntries}
        onDeleteEntry={del.request}
        emptyTitle={`Nothing logged ${date === today ? 'yet today' : 'this day'}`}
      />

      {del.toastOpen && (
        <Toast actionLabel="Undo" onAction={del.undo}>
          Entry deleted
        </Toast>
      )}
    </div>
  )
}
