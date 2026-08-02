import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { AmendPatch, Entry, GeoLocation } from '../contract/types'
import { localTimeOf } from '../contract/time'
import type { SyncStatusRow } from '../store/db'
import { getBlob } from '../store/events'
import {
  Button,
  Card,
  ChevronDownIcon,
  IconButton,
  PinIcon,
  PlusIcon,
  SlidersIcon,
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
import { LifecycleBadge } from './LifecycleBadge'
import { entryLifecycle, hasPendingEnrichment } from './lifecycle'
import { groupAttachments } from './attachmentGroups'
import { cardViewModel } from './cardView'
import { useAudioPlayback } from './useAudioPlayback'
import { useRecorder, type RecordingResult } from './useRecorder'

// Leaflet-backed; lazy so its chunk (JS + CSS) stays out of the initial
// bundle and only loads for cards that show or edit a location.
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
  sync,
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
  // View-local only (#78): never persisted, never an event — the log carries
  // user data, not UI state. Collapses again on re-render of a fresh card.
  const [expanded, setExpanded] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)
  const audio = entry.attachments.find((a) => a.kind === 'audio')
  const playback = useAudioPlayback(audio?.file)
  // Per-card recorder for "+ audio" — entries can hold multiple clips.
  const rec = useRecorder()
  const vm = cardViewModel(entry, groupAttachments(entry.attachments))
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
    <Card className={motion.riseIn}>
      {/* Header: time + place grouped left; sync/duration/play pushed right.
          This is the collapsed card's "time" and "context". */}
      <div className="flex items-center gap-2">
        <div className={cx('flex min-w-0 flex-1 items-baseline gap-2', type_.body)}>
          {/* Tapping the time opens the native iOS wheel picker (B8); the
              Edit sheet is the second, discoverable path to the same field. */}
          <span className="relative shrink-0">
            <button
              onClick={() => {
                const el = timeInputRef.current
                if (!el) return
                if (typeof el.showPicker === 'function') el.showPicker()
                else el.focus()
              }}
              className={cx('rounded-md font-semibold tabular-nums', tone.textPrimary, tone.pressWash)}
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
          {vm.collapsedShowsLocation && (
            <span className={cx('truncate', type_.sub, tone.textMuted)}>
              {entry.location?.placeLabel ?? `near ${entry.location?.address}`}
            </span>
          )}
        </div>
        <span className="shrink-0">
          <LifecycleBadge lifecycle={lifecycle} />
        </span>
        {audio?.durationSec !== undefined && (
          <span className={cx('shrink-0 tabular-nums', type_.caption, tone.textFaint)}>
            {audio.durationSec}s
          </span>
        )}
        {audio && (
          <IconButton
            variant="accent"
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

      {/* Collapsed content: the entry's primary text representation only,
          clamped to two lines; tapping it expands the card. Audio-only
          entries have no separate content block — the header play button
          already represents the primary clip. */}
      {!expanded && vm.primaryText && (
        <PrimaryTextPreview
          file={vm.primaryText.file}
          transcript={vm.primaryText.derivedFrom !== undefined}
          onTap={() => setExpanded(true)}
        />
      )}

      {/* Expanded content: full attachment body + location preview, per #78. */}
      {expanded && (
        <>
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
        </>
      )}

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
        <>
          {/* Labelled actions — only reachable from the expanded state
              (#78): the design review's "six unlabeled icons are
              conceptually ambiguous" complaint. Every action still carries
              the same glyph as the main CTA/edit affordances, now beside a
              text label. */}
          {expanded && (
            <div className={cx('-mx-4 mt-3 flex flex-wrap items-center gap-1 border-t px-2 pt-2', tone.border)}>
              <Button variant="ghost" size="sm" onClick={() => setNoteOpen(true)}>
                <NoteIcon size={14} /> Add note
              </Button>
              <Button variant="ghost" size="sm" onClick={() => photoInputRef.current?.click()}>
                <PhotoIcon size={14} /> Add photo
              </Button>
              {rec.state === 'error' ? (
                <Button variant="ghost" size="sm" onClick={rec.resetError}>
                  mic unavailable
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => void handleAudioTap()}>
                  <AudioIcon size={14} /> Add audio
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setLocationOpen(true)}>
                {entry.location ? <PinIcon size={14} /> : <PlusIcon size={14} />} Location
              </Button>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditOpen(true)}>
                <SlidersIcon size={14} /> Edit
              </Button>
              <Button variant="dangerGhost" size="sm" onClick={onDelete}>
                <TrashIcon size={14} /> Delete
              </Button>
            </div>
          )}

          {/* The one overflow/expand affordance the collapsed card keeps —
              a real button with aria-expanded (#78 req. 7), never a
              hover/gesture-only trap. Shows a "+N" hint from the pure
              view-model when collapsed content hides attachments. */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? 'Show less' : 'Show more'}
            onClick={() => setExpanded((e) => !e)}
            className={cx(
              'mt-2 flex items-center gap-1 rounded-md px-1 py-0.5',
              type_.caption,
              tone.textFaint,
              tone.pressWash,
            )}
          >
            <span className={cx('inline-flex transition-transform', expanded && 'rotate-180')}>
              <ChevronDownIcon size={12} />
            </span>
            {expanded ? 'Show less' : vm.extraCount > 0 ? `Show more (+${vm.extraCount})` : 'Show more'}
          </button>
        </>
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

/**
 * The collapsed card's primary content: the entry's primary text (per
 * `cardViewModel`), clamped to two lines, tapping through to the expanded
 * state rather than the inline editor `AttachmentBody`'s `NoteText` opens —
 * editing lives behind expansion (#78 req. 3). Loads its text the same way
 * `NoteText` does (async `getBlob`, stale-guarded), so it renders nothing
 * until the blob resolves.
 */
function PrimaryTextPreview({
  file,
  transcript,
  onTap,
}: {
  file: string
  /** True for a machine transcript (reads as the entry's own voice); false for a user note. */
  transcript: boolean
  onTap: () => void
}) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void getBlob(file).then(async (blob) => {
      if (blob && !stale) setText(await blob.text())
    })
    return () => {
      stale = true
    }
  }, [file])
  if (text === null) return null
  return (
    <button type="button" onClick={onTap} className={cx('mt-2 block w-full text-left', motion.fadeIn)}>
      <span
        className={cx(
          'line-clamp-2 block whitespace-pre-wrap break-words',
          type_.bodyStrong,
          transcript ? tone.textPrimary : tone.textSecondary,
        )}
      >
        {text}
      </span>
    </button>
  )
}
