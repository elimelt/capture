/** Screen 2 — Day (SPEC §4.2). M1 placeholder: local entries only, no calendar. */
import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { localDateOf, toLocalIso } from '../contract/time'
import { useAppStore } from '../store/appStore'
import { StatusBadge, timeLabel } from '../capture/EntryCard'

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return localDateOf(toLocalIso(d))
}

export default function DayScreen() {
  const params = useParams<{ date?: string }>()
  const navigate = useNavigate()
  const entries = useAppStore((s) => s.entries)
  const syncStatuses = useAppStore((s) => s.syncStatuses)
  const refresh = useAppStore((s) => s.refresh)

  const today = localDateOf(toLocalIso(new Date()))
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today

  useEffect(() => {
    void refresh()
  }, [refresh])

  const dayEntries = entries
    .filter((e) => !e.revoked && localDateOf(e.capturedAt) === date)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  const navBtn =
    'flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800'

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <button
          aria-label="Previous day"
          onClick={() => navigate(`/day/${shiftDate(date, -1)}`)}
          className={navBtn}
        >
          ‹
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => {
            if (e.target.value) navigate(`/day/${e.target.value}`)
          }}
          className="min-h-11 flex-1 rounded-lg border border-slate-300 bg-white px-3 text-center text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          aria-label="Next day"
          onClick={() => navigate(`/day/${shiftDate(date, 1)}`)}
          className={navBtn}
        >
          ›
        </button>
      </div>

      <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300">
        Calendar integration arrives in M2+ — for now this shows your local entries only.
      </div>

      {dayEntries.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
          No entries on {date}.
        </p>
      ) : (
        <ol className="relative ml-2 border-l border-slate-200 dark:border-slate-800">
          {dayEntries.map((entry) => (
            <li key={entry.id} className="relative mb-4 ml-4">
              <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-sky-500" />
              <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {timeLabel(entry.capturedAt)}
                  </span>
                  {entry.location?.placeLabel && (
                    <span className="truncate text-slate-500 dark:text-slate-400">
                      {entry.location.placeLabel}
                    </span>
                  )}
                  <span className="ml-auto">
                    <StatusBadge
                      status={syncStatuses.get(entry.seq)?.status ?? 'queued'}
                    />
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  {entry.attachments.map((a) => a.kind).join(' · ') || 'no attachments'}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
