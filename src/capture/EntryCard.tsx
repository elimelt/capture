import { useRef, useState } from 'react'
import type { Entry } from '../contract/types'
import { getBlob } from '../store/events'
import type { SyncStatus } from '../store/db'
import { NoteSheet } from './NoteSheet'

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const STATUS_DOT: Record<SyncStatus, string> = {
  queued: 'bg-amber-500',
  uploaded: 'bg-emerald-500',
  error: 'bg-red-500',
}

export function StatusBadge({ status }: { status: SyncStatus }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
      {status}
    </span>
  )
}

interface EntryCardProps {
  entry: Entry
  status: SyncStatus
  onDelete: () => void
  onShiftTime: (mode: '-5' | '-1' | 'now') => void
  onAddNote: (text: string) => void
  onAddPhoto: (file: File) => void
}

export function EntryCard({
  entry,
  status,
  onDelete,
  onShiftTime,
  onAddNote,
  onAddPhoto,
}: EntryCardProps) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const audio = entry.attachments.find((a) => a.kind === 'audio')

  async function replay() {
    if (!audio || playing) return
    const blob = await getBlob(audio.file)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const el = new Audio(url)
    const done = () => {
      URL.revokeObjectURL(url)
      setPlaying(false)
    }
    el.onended = done
    el.onerror = done
    setPlaying(true)
    void el.play().catch(done)
  }

  const stepBtn =
    'min-h-11 min-w-11 rounded-lg border border-slate-300 px-2 text-xs font-medium text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-sm font-medium text-slate-900 dark:text-slate-100">
            <span>{timeLabel(entry.capturedAt)}</span>
            {entry.location?.placeLabel && (
              <span className="truncate text-slate-500 dark:text-slate-400">
                · {entry.location.placeLabel}
              </span>
            )}
            {audio?.durationSec !== undefined && (
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {audio.durationSec}s
              </span>
            )}
          </div>
          <StatusBadge status={status} />
        </div>
        {audio && (
          <button
            onClick={() => void replay()}
            aria-label="Replay audio"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 text-slate-600 active:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:active:bg-slate-800"
          >
            {playing ? '…' : '▶'}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button onClick={() => onShiftTime('-5')} className={stepBtn}>
          −5m
        </button>
        <button onClick={() => onShiftTime('-1')} className={stepBtn}>
          −1m
        </button>
        <button onClick={() => onShiftTime('now')} className={stepBtn}>
          now
        </button>
        <button onClick={() => setNoteOpen(true)} className={stepBtn}>
          + note
        </button>
        <button onClick={() => photoInputRef.current?.click()} className={stepBtn}>
          + photo
        </button>
        <button
          onClick={() => {
            if (window.confirm('Delete this entry?')) onDelete()
          }}
          className="ml-auto min-h-11 min-w-11 rounded-lg px-2 text-xs font-medium text-red-600 active:bg-red-50 dark:text-red-400 dark:active:bg-red-950"
        >
          Delete
        </button>
      </div>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onAddPhoto(file)
          e.target.value = ''
        }}
      />
      {noteOpen && <NoteSheet onSave={onAddNote} onClose={() => setNoteOpen(false)} />}
    </div>
  )
}
