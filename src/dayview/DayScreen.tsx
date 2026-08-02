/**
 * Screen 2 — Day (SPEC §4.2). One merged, time-sorted timeline of local
 * entries and calendar pseudo-entries (editable overlays — §3.6), rendered
 * by DayTimeline.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { localDateOf, toLocalIso } from '../contract/time'
import type { Entry } from '../contract/types'
import { useAppStore } from '../store/appStore'
import { usePendingDelete } from '../capture/usePendingDelete'
import { getBlob } from '../store/events'
import { copyPlainText } from '../context/clipboard'
import { formatEntriesPlainText, formatEntryPlainText } from '../context/plainText'
import { Button, CopyIcon, IconButton, ScreenHeader, Toast, cx, motion } from '../ui'
import { DayTimeline } from './DayTimeline'

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
  const assistantEnabled = useAppStore((s) => s.appSettings.assistantEnabled)
  const revoke = useAppStore((s) => s.revoke)
  const del = usePendingDelete(revoke)
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'error' | null>(null)

  useEffect(() => {
    if (!copyFeedback) return
    const timer = setTimeout(() => setCopyFeedback(null), 3500)
    return () => clearTimeout(timer)
  }, [copyFeedback])

  const today = localDateOf(toLocalIso(new Date()))
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today
  const title = dayTitle(date, today)

  const dayEntries = entries
    .filter((e) => !e.revoked && e.id !== del.pendingId && localDateOf(e.capturedAt) === date)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  async function copyEntry(entry: Entry) {
    try {
      await copyPlainText(await formatEntryPlainText(entry, getBlob))
      setCopyFeedback('copied')
    } catch {
      setCopyFeedback('error')
    }
  }

  async function copyDay() {
    try {
      await copyPlainText(await formatEntriesPlainText(dayEntries, getBlob))
      setCopyFeedback('copied')
    } catch {
      setCopyFeedback('error')
    }
  }

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
            <IconButton
              aria-label="Copy day"
              disabled={dayEntries.length === 0}
              onClick={() => void copyDay()}
            >
              <CopyIcon size={16} />
            </IconButton>
          </div>
        }
      />

      <DayTimeline
        date={date}
        entries={dayEntries}
        onDeleteEntry={del.request}
        onCopyEntry={(entry) => void copyEntry(entry)}
        onAskEntry={
          assistantEnabled
            ? (entry, intent) => navigate('/chat', { state: { entryId: entry.id, intent } })
            : undefined
        }
        emptyTitle={`Nothing logged ${date === today ? 'yet today' : 'this day'}`}
      />

      {del.toastOpen && (
        <Toast actionLabel="Undo" onAction={del.undo}>
          Entry deleted
        </Toast>
      )}
      {copyFeedback === 'copied' && <Toast>Copied to clipboard</Toast>}
      {copyFeedback === 'error' && <Toast>Couldn’t copy</Toast>}
    </div>
  )
}
