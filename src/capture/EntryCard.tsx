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
  // View-local only, never persisted, never an event — the log carries user
  // data, not UI state (#78, revised by #102). `menuOpen` is the single "+"
  // affordance's expand state (actions are what collapse now).
  const [menuOpen, setMenuOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  // The full-screen interactive map (#81): opened explicitly from the
  // PlaceCard row, never mounted alongside it — Leaflet loads only here.
  const [mapOpen, setMapOpen] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)
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

  // The captured time now lives in the rail gutter (`TimelineRow`), not the
  // card header — tapping it still opens the native iOS wheel picker (B8), and
  // the Edit sheet remains the second, discoverable path to the same field.
  const timeControl = (
    <span className="relative inline-block">
      <button
        onClick={() => {
          const el = timeInputRef.current
          if (!el) return
          if (typeof el.showPicker === 'function') el.showPicker()
          else el.focus()
        }}
        className={cx('rounded-md font-semibold', type_.caption, tone.textMuted, tone.pressWash)}
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
  )

  return (
    <TimelineRow time={timeControl} first={first} last={last} className={motion.riseIn}>
      {/* Header: place label and lifecycle status; attachment media lives below. */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {entry.location && (
            <span className={cx('truncate', type_.sub, tone.textMuted)}>
              {locationName(entry.location)}
            </span>
          )}
        </div>
        <span className="shrink-0">
          <LifecycleBadge lifecycle={lifecycle} />
        </span>
        {onCopy && (
          <IconButton aria-label="Copy entry" onClick={() => onCopy(entry)}>
            <CopyIcon size={16} />
          </IconButton>
        )}
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
        <div
          className={cx(
            'mt-3 flex items-center gap-2 rounded-xl bg-clay px-3 py-2 dark:bg-clay-dark',
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
        <div className={cx('mt-3 flex flex-wrap items-center gap-1 border-t pt-2', tone.border)}>
          {/* The single "+" affordance (#102): replaces the old labelled
              action column. Every action is still reachable and labelled
              (aria-label) — icon-only now, tighter, but never removed. */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {menuOpen && (
              <>
                <IconButton
                  aria-label="Add note"
                  onClick={() => {
                    setMenuOpen(false)
                    setNoteOpen(true)
                  }}
                >
                  <NoteIcon size={16} />
                </IconButton>
                <IconButton
                  aria-label="Add photo"
                  onClick={() => {
                    setMenuOpen(false)
                    photoInputRef.current?.click()
                  }}
                >
                  <PhotoIcon size={16} />
                </IconButton>
                {rec.state === 'error' ? (
                  <IconButton aria-label="Microphone unavailable, tap to retry" onClick={rec.resetError}>
                    <AudioIcon size={16} />
                  </IconButton>
                ) : (
                  <IconButton
                    aria-label="Add audio"
                    onClick={() => {
                      setMenuOpen(false)
                      void handleAudioTap()
                    }}
                  >
                    <AudioIcon size={16} />
                  </IconButton>
                )}
                <IconButton
                  aria-label={entry.location ? 'Edit location' : 'Add location'}
                  onClick={() => {
                    setMenuOpen(false)
                    setLocationOpen(true)
                  }}
                >
                  {entry.location ? <PinIcon size={16} /> : <PlusIcon size={16} />}
                </IconButton>
                <IconButton
                  aria-label="Edit entry"
                  onClick={() => {
                    setMenuOpen(false)
                    setEditOpen(true)
                  }}
                >
                  <SlidersIcon size={16} />
                </IconButton>
                <IconButton
                  variant="danger"
                  aria-label="Delete entry"
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete()
                  }}
                >
                  <TrashIcon size={16} />
                </IconButton>
              </>
            )}
            <IconButton
              aria-expanded={menuOpen}
              aria-label={menuOpen ? 'Close actions' : 'Add or edit'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className={cx('inline-flex transition-transform', menuOpen && 'rotate-45')}>
                <PlusIcon size={18} />
              </span>
            </IconButton>
          </div>
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
