/** Screen 2 — Day (SPEC §4.2). M1: local entries timeline; calendar/results arrive M4. */
import { useNavigate, useParams } from 'react-router-dom'
import { localDateOf, toLocalIso } from '../contract/time'
import { useAppStore } from '../store/appStore'
import { timeLabel } from '../capture/EntryCard'
import { AttachmentBody } from '../capture/AttachmentBody'
import { usePendingDelete } from '../capture/usePendingDelete'
import { Button, Card, EmptyState, IconButton, ScreenHeader, Toast, cx, tone, type_ } from '../ui'

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
  const amend = useAppStore((s) => s.amend)
  const del = usePendingDelete(revoke)

  const today = localDateOf(toLocalIso(new Date()))
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : today

  const dayEntries = entries
    .filter((e) => !e.revoked && e.id !== del.pendingId && localDateOf(e.capturedAt) === date)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  return (
    <div className="flex flex-col gap-4 p-4">
      <ScreenHeader
        title={dayTitle(date, today)}
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

      {dayEntries.length === 0 ? (
        <EmptyState title={`Nothing logged ${date === today ? 'yet today' : 'this day'}`} />
      ) : (
        <ol className={cx('relative ml-2 border-l', tone.border)}>
          {dayEntries.map((entry) => {
            const audio = entry.attachments.find((a) => a.kind === 'audio')
            return (
              <li key={entry.id} className="relative mb-3 ml-4">
                <span className="absolute -left-[21.5px] top-4 h-2.5 w-2.5 rounded-full bg-spruce dark:bg-spruce-dark" />
                <Card>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className={cx('flex items-baseline gap-2', type_.body)}>
                        <span className={cx('font-semibold tabular-nums', tone.textPrimary)}>
                          {timeLabel(entry.capturedAt)}
                        </span>
                        {entry.location?.placeLabel && (
                          <span className={cx('truncate', type_.sub, tone.textMuted)}>
                            {entry.location.placeLabel}
                          </span>
                        )}
                        {audio?.durationSec !== undefined && (
                          <span
                            className={cx(
                              'ml-auto shrink-0 tabular-nums',
                              type_.caption,
                              tone.textFaint,
                            )}
                          >
                            {audio.durationSec}s
                          </span>
                        )}
                      </div>
                    </div>
                    <Button variant="dangerGhost" size="sm" onClick={() => del.request(entry.id)}>
                      Delete
                    </Button>
                  </div>
                  <AttachmentBody
                    attachments={entry.attachments}
                    onEditText={(oldFile, text, derivedFrom) =>
                      void amend({
                        targets: [entry.id],
                        patch: { removeAttachments: [oldFile] },
                        attachments: [
                          {
                            kind: 'text',
                            blob: new Blob([text], { type: 'text/plain' }),
                            mimeType: 'text/plain',
                            ...(derivedFrom !== undefined ? { derivedFrom } : {}),
                          },
                        ],
                      })
                    }
                    onRemoveAttachment={(file) =>
                      void amend({
                        targets: [entry.id],
                        patch: { removeAttachments: [file] },
                      })
                    }
                  />
                </Card>
              </li>
            )
          })}
        </ol>
      )}

      {del.toastOpen && (
        <Toast actionLabel="Undo" onAction={del.undo}>
          Entry deleted
        </Toast>
      )}
    </div>
  )
}
