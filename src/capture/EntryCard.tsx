import { Suspense, lazy, useRef, useState } from 'react'
import type { AmendPatch, Entry, GeoLocation } from '../contract/types'
import { localTimeOf } from '../contract/time'
import type { SyncStatusRow } from '../store/db'
import {
  CopyIcon,
  IconButton,
  PinIcon,
  PlusIcon,
  SlidersIcon,
  TimelineRow,
  TrashIcon,
  captureIcon,
  cx,
  motion,
  tone,
  type_,
} from '../ui'
import { EditEntrySheet } from './EditEntrySheet'
import { TextSheet } from './TextSheet'
import { AttachmentTimeline } from './AttachmentTimeline'
import { LifecycleBadge } from './LifecycleBadge'
import { entryLifecycle, hasPendingEnrichment } from './lifecycle'
import { PlaceCard } from './PlaceCard'
import { locationName } from './placeCardModel'
import { useRecorder, type RecordingResult } from './useRecorder'

// Leaflet-backed; lazy so its chunk (JS + CSS) stays out of the initial
// bundle and now only loads once a card's `PlaceCard` row is explicitly
// tapped (#81) — not for every located card in view.
const MiniMap = lazy(() => import('./MiniMap'))
const LocationSheet = lazy(() =>
  import('./LocationSheet').then((m) => ({ default: m.LocationSheet })),
)

// Entry action buttons carry the same glyphs as the main CTA (RecordPanel):
// audio → mic, photo → camera, note → text cursor, via the shared modality mapping.
const AudioIcon = captureIcon('audio')
const PhotoIcon = captureIcon('photo')
const NoteIcon = captureIcon('text')

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

interface EntryCardProps {
  entry: Entry
  maxClipSec: number
  /** Drive sync row for this entry's seq (SPEC §8.4); absent = never queued locally. */
  sync?: SyncStatusRow
  /** Timeline-rail position — trims the connecting line at the rail's ends. */
  first?: boolean
  last?: boolean
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
  /** Request a plain-text representation of this entry from the parent. */
  onCopy?: (entry: Entry) => void
}

export function EntryCard({
  entry,
  maxClipSec,
  sync,
  first = false,
  last = false,
  onDelete,
  onSetTime,
  onAddNote,
  onAddPhoto,
  onAddAudio,
  onEditText,
  onRemoveAttachment,
  onSetLocation,
  onApplyEdit,
  onCopy,
}: EntryCardProps) {
  // View-local only, never persisted, never an event.
  const [noteOpen, setNoteOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  // The full-screen interactive map (#81): opened explicitly from the
  // PlaceCard row, never mounted alongside it — Leaflet loads only here.
  const [mapOpen, setMapOpen] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  // Per-card recorder for "+ audio" — entries can hold multiple clips.
  const rec = useRecorder()
  const lifecycle = entryLifecycle(sync, hasPendingEnrichment(entry))

  async function handleAudioTap() {
    if (rec.state === 'recording') {
      const result = await rec.stop()
      if (result) onAddAudio(result)
    } else {
      await rec.start(maxClipSec, (result) => onAddAudio(result))
    }
  }

  return (
    <TimelineRow
      time={<RailTime capturedAt={entry.capturedAt} onSetTime={onSetTime} />}
      first={first}
      last={last}
      className={motion.riseIn}
    >
      {/* Header: place label leading, lifecycle badge trailing. Actions live
          in the always-visible footer row; attachment media sits between. */}
      <div className="flex min-h-5 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center">
          {entry.location && (
            <span className={cx('flex min-w-0 items-center gap-1', type_.caption, tone.textMuted)}>
              <PinIcon size={13} />
              <span className="truncate">{locationName(entry.location)}</span>
            </span>
          )}
        </div>
        <span className="shrink-0">
          <LifecycleBadge lifecycle={lifecycle} />
        </span>
      </div>

      <AttachmentTimeline
        attachments={entry.attachments}
        attachmentLoggedAt={entry.attachmentLoggedAt}
        entryLoggedAt={entry.loggedAt}
        onEditText={onEditText}
        onRemoveAttachment={onRemoveAttachment}
      />
      {entry.location && <PlaceCard location={entry.location} onExpand={() => setMapOpen(true)} />}

      {rec.state === 'recording' ? (
        <RecordingBar
          elapsedSec={rec.elapsedSec}
          onDiscard={rec.cancel}
          onDone={() => void handleAudioTap()}
        />
      ) : (
        <EntryActions
          hasLocation={entry.location !== undefined}
          micError={rec.state === 'error'}
          onRetryMic={rec.resetError}
          onAddNote={() => setNoteOpen(true)}
          onAddPhoto={() => photoInputRef.current?.click()}
          onAddAudio={() => void handleAudioTap()}
          onEditLocation={() => setLocationOpen(true)}
          onEditEntry={() => setEditOpen(true)}
          onCopy={onCopy && (() => onCopy(entry))}
          onDelete={onDelete}
        />
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
      {/* The interactive map (#81): the PlaceCard row's onExpand is the only
          way in, so Leaflet's chunk loads on explicit request, never
          alongside the place card itself. */}
      {mapOpen && entry.location && (
        <Suspense fallback={null}>
          <MiniMap location={entry.location} onClose={() => setMapOpen(false)} />
        </Suspense>
      )}
    </TimelineRow>
  )
}

/**
 * The tap-to-edit capture time in the rail gutter (B8): a visible button
 * layered over an invisible native time input, so tapping opens the iOS
 * wheel picker (`showPicker()`, falling back to `focus()`). The Edit sheet
 * remains the second, discoverable path to the same field.
 */
function RailTime({
  capturedAt,
  onSetTime,
}: {
  capturedAt: string
  onSetTime: (time: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <span className="relative inline-block">
      <button
        onClick={() => {
          const el = inputRef.current
          if (!el) return
          if (typeof el.showPicker === 'function') el.showPicker()
          else el.focus()
        }}
        className={cx('rounded-md font-semibold', type_.caption, tone.textMuted, tone.pressWash)}
      >
        {timeLabel(capturedAt)}
      </button>
      <input
        ref={inputRef}
        type="time"
        value={localTimeOf(capturedAt)}
        onChange={(e) => {
          if (e.target.value) onSetTime(e.target.value)
        }}
        className="absolute inset-0 h-full w-full opacity-0"
        tabIndex={-1}
        aria-label="Change entry time"
      />
    </span>
  )
}

/**
 * The entry's action row: always visible (no reveal toggle), one compact
 * `sm` ghost `IconButton` per action so all of them fit on one line at
 * mobile widths. Every action is labelled via aria-label. The one special
 * case is a mic error, where the audio slot becomes a retry button that
 * only clears the error.
 */
function EntryActions({
  hasLocation,
  micError,
  onRetryMic,
  onAddNote,
  onAddPhoto,
  onAddAudio,
  onEditLocation,
  onEditEntry,
  onCopy,
  onDelete,
}: {
  hasLocation: boolean
  micError: boolean
  onRetryMic: () => void
  onAddNote: () => void
  onAddPhoto: () => void
  onAddAudio: () => void
  onEditLocation: () => void
  onEditEntry: () => void
  onCopy?: () => void
  onDelete: () => void
}) {
  return (
    <div className="mt-1 flex items-center">
      <IconButton size="sm" variant="ghost" aria-label="Add note" onClick={onAddNote}>
        <NoteIcon size={16} />
      </IconButton>
      <IconButton size="sm" variant="ghost" aria-label="Add photo" onClick={onAddPhoto}>
        <PhotoIcon size={16} />
      </IconButton>
      {micError ? (
        <IconButton
          size="sm"
          variant="ghost"
          aria-label="Microphone unavailable, tap to retry"
          onClick={onRetryMic}
        >
          <AudioIcon size={16} />
        </IconButton>
      ) : (
        <IconButton size="sm" variant="ghost" aria-label="Add audio" onClick={onAddAudio}>
          <AudioIcon size={16} />
        </IconButton>
      )}
      <IconButton
        size="sm"
        variant="ghost"
        aria-label={hasLocation ? 'Edit location' : 'Add location'}
        onClick={onEditLocation}
      >
        {hasLocation ? <PinIcon size={16} /> : <PlusIcon size={16} />}
      </IconButton>
      <IconButton size="sm" variant="ghost" aria-label="Edit entry" onClick={onEditEntry}>
        <SlidersIcon size={16} />
      </IconButton>
      {onCopy && (
        <IconButton size="sm" variant="ghost" aria-label="Copy entry" onClick={onCopy}>
          <CopyIcon size={16} />
        </IconButton>
      )}
      <IconButton
        size="sm"
        variant="danger"
        aria-label="Delete entry"
        onClick={onDelete}
        className="ml-auto"
      >
        <TrashIcon size={16} />
      </IconButton>
    </div>
  )
}

/**
 * The compact in-card recording bar: elapsed timer plus Discard/Done,
 * replacing the action controls while this card's recorder is live.
 */
function RecordingBar({
  elapsedSec,
  onDiscard,
  onDone,
}: {
  elapsedSec: number
  onDiscard: () => void
  onDone: () => void
}) {
  return (
    <div
      className={cx(
        'mt-3 flex items-center gap-2 rounded-xl bg-clay px-3 py-2 dark:bg-clay-dark',
        motion.scaleIn,
      )}
    >
      <span className={cx('font-medium tabular-nums text-white', type_.ui)}>
        {Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, '0')}
      </span>
      <button
        onClick={onDiscard}
        className={cx(
          'ml-auto min-h-9 rounded-lg bg-clay-deep/60 px-3 font-medium text-white/85 active:bg-clay-deep/80 dark:bg-clay-deep-dark/60 dark:active:bg-clay-deep-dark/80',
          type_.sub,
        )}
      >
        Discard
      </button>
      <button
        onClick={onDone}
        className={cx(
          'min-h-9 rounded-lg bg-white px-4 font-semibold text-clay-deep active:bg-clay-wash',
          type_.sub,
        )}
      >
        Done
      </button>
    </div>
  )
}
