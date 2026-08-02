import { Suspense, lazy, useRef, useState } from 'react'
import type { AmendPatch, Entry, GeoLocation } from '../contract/types'
import { localTimeOf } from '../contract/time'
import type { SyncStatus } from '../store/db'
import {
  Button,
  Card,
  IconButton,
  PinIcon,
  PlusIcon,
  TrashIcon,
  captureIcon,
  cx,
  motion,
  tone,
  type_,
} from '../ui'
import { EditEntrySheet } from './EditEntrySheet'
import { TextSheet } from './TextSheet'
import { AttachmentBody } from './AttachmentBody'
import { SyncBadge } from './SyncBadge'
import { useAudioPlayback } from './useAudioPlayback'
import { useRecorder, type RecordingResult } from './useRecorder'

// Leaflet-backed; lazy so its chunk (JS + CSS) stays out of the initial
// bundle and only loads for cards that show or edit a location.
const MiniMap = lazy(() => import('./MiniMap'))
const LocationSheet = lazy(() =>
  import('./LocationSheet').then((m) => ({ default: m.LocationSheet })),
)

// Entry action buttons carry the same glyphs as the main CTA (RecordPanel):
// audio → mic, photo → camera, note → pencil, via the shared modality mapping.
const AudioIcon = captureIcon('audio')
const PhotoIcon = captureIcon('photo')
const NoteIcon = captureIcon('text')

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

interface EntryCardProps {
  entry: Entry
  maxClipSec: number
  /** Drive upload status for this entry's seq (SPEC §8.4); absent = not queued. */
  syncStatus?: SyncStatus
  onDelete: () => void
  /** New time-of-day "HH:mm" on the entry's own date (B8). */
  onSetTime: (time: string) => void
  onAddNote: (text: string) => void
  onAddPhoto: (file: File) => void
  onAddAudio: (result: RecordingResult) => void
  onEditText: (oldFile: string, text: string, derivedFrom?: string) => void
  onRemoveAttachment: (file: string) => void
  /** Set or clear the entry's location (amend patch.location). */
  onSetLocation: (location: GeoLocation | null) => void
  /** One combined edit (date/time + attachment removals) as a single amend. */
  onApplyEdit: (patch: AmendPatch) => void
}

export function EntryCard({
  entry,
  maxClipSec,
  syncStatus,
  onDelete,
  onSetTime,
  onAddNote,
  onAddPhoto,
  onAddAudio,
  onEditText,
  onRemoveAttachment,
  onSetLocation,
  onApplyEdit,
}: EntryCardProps) {
  const [noteOpen, setNoteOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)
  const audio = entry.attachments.find((a) => a.kind === 'audio')
  const playback = useAudioPlayback(audio?.file)
  // Per-card recorder for "+ audio" — entries can hold multiple clips.
  const rec = useRecorder()

  async function handleAudioTap() {
    if (rec.state === 'recording') {
      const result = await rec.stop()
      if (result) onAddAudio(result)
    } else {
      await rec.start(maxClipSec, (result) => onAddAudio(result))
    }
  }

  return (
    <Card className={motion.riseIn}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className={cx('flex items-baseline gap-2', type_.body)}>
            {/* Tapping the time opens the native iOS wheel picker (B8). */}
            <span className="relative">
              <button
                onClick={() => {
                  const el = timeInputRef.current
                  if (!el) return
                  if (typeof el.showPicker === 'function') el.showPicker()
                  else el.focus()
                }}
                className={cx(
                  'rounded-md font-semibold tabular-nums underline decoration-dotted underline-offset-4',
                  tone.textPrimary,
                  'decoration-line-strong dark:decoration-line-strong-dark',
                )}
              >
                {timeLabel(entry.capturedAt)}
              </button>
              <input
                ref={timeInputRef}
                type="time"
                value={localTimeOf(entry.capturedAt)}
                onChange={(e) => {
                  if (e.target.value) onSetTime(e.target.value)
                }}
                className="absolute inset-0 h-full w-full opacity-0"
                tabIndex={-1}
                aria-label="Change entry time"
              />
            </span>
            {(entry.location?.placeLabel ?? entry.location?.address) && (
              <span className={cx('truncate', type_.sub, tone.textMuted)}>
                {entry.location.placeLabel ?? `near ${entry.location.address}`}
              </span>
            )}
            <span className={cx('shrink-0', audio?.durationSec === undefined && 'ml-auto')}>
              <SyncBadge status={syncStatus} />
            </span>
            {audio?.durationSec !== undefined && (
              <span className={cx('ml-auto shrink-0 tabular-nums', type_.caption, tone.textFaint)}>
                {audio.durationSec}s
              </span>
            )}
          </div>
        </div>
        {audio && (
          <IconButton
            aria-label={playback.playing ? 'Stop playback' : 'Play recording'}
            onClick={() => void playback.toggle()}
            className="relative overflow-hidden"
          >
            {/* Progress fill behind the icon (B10). */}
            {playback.playing && (
              <span
                className="absolute inset-y-0 left-0 bg-spruce/20 transition-[width] duration-200 ease-linear dark:bg-spruce-dark/25"
                style={{ width: `${playback.progress * 100}%` }}
              />
            )}
            <span className="relative">{playback.playing ? '■' : '▶'}</span>
          </IconButton>
        )}
      </div>

      <AttachmentBody
        attachments={entry.attachments}
        onEditText={onEditText}
        onRemoveAttachment={onRemoveAttachment}
      />

      {entry.location && (
        <div className="mt-2">
          <Suspense fallback={null}>
            <MiniMap location={entry.location} />
          </Suspense>
        </div>
      )}

      {rec.state === 'recording' ? (
        <div
          className={cx(
            'mt-2 flex items-center gap-2 rounded-xl bg-clay px-3 py-2 dark:bg-clay-dark',
            motion.scaleIn,
          )}
        >
          <span className={cx('font-medium tabular-nums text-white', type_.ui)}>
            {Math.floor(rec.elapsedSec / 60)}:{String(rec.elapsedSec % 60).padStart(2, '0')}
          </span>
          <button
            onClick={rec.cancel}
            className={cx(
              'ml-auto min-h-9 rounded-lg bg-clay-deep/60 px-3 font-medium text-white/85 active:bg-clay-deep/80 dark:bg-clay-deep-dark/60 dark:active:bg-clay-deep-dark/80',
              type_.sub,
            )}
          >
            Discard
          </button>
          <button
            onClick={() => void handleAudioTap()}
            className={cx(
              'min-h-9 rounded-lg bg-white px-4 font-semibold text-clay-deep active:bg-clay-wash',
              type_.sub,
            )}
          >
            Done
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setNoteOpen(true)}>
            <NoteIcon size={14} /> note
          </Button>
          <Button variant="ghost" size="sm" onClick={() => photoInputRef.current?.click()}>
            <PhotoIcon size={14} /> photo
          </Button>
          {rec.state === 'error' ? (
            <Button variant="ghost" size="sm" onClick={rec.resetError}>
              mic unavailable
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void handleAudioTap()}>
              <AudioIcon size={14} /> audio
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setLocationOpen(true)}>
            {entry.location ? <PinIcon /> : <PlusIcon />} location
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)} className="ml-auto">
            Edit
          </Button>
          <Button variant="dangerGhost" size="sm" onClick={onDelete}>
            <TrashIcon /> Delete
          </Button>
        </div>
      )}

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
      {noteOpen && (
        <TextSheet
          title="Add note"
          placeholder="Type a note…"
          cta="Save note"
          onSave={onAddNote}
          onClose={() => setNoteOpen(false)}
        />
      )}
      {editOpen && (
        <EditEntrySheet
          entry={entry}
          onSave={onApplyEdit}
          onClose={() => setEditOpen(false)}
        />
      )}
      {locationOpen && (
        <Suspense fallback={null}>
          <LocationSheet
            initial={entry.location}
            onSave={(loc) => onSetLocation(loc)}
            onClear={() => onSetLocation(null)}
            onClose={() => setLocationOpen(false)}
          />
        </Suspense>
      )}
    </Card>
  )
}
