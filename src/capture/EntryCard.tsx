import { Suspense, lazy, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AmendPatch, Entry, GeoLocation } from '../contract/types'
import { localDateOf, localTimeOf, toLocalIso } from '../contract/time'
import { useAppStore } from '../store/appStore'
import type { SyncStatusRow } from '../store/db'
import {
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
import { PhotoGrid } from './PhotoGrid'
import { PlaceCard } from './PlaceCard'
import { locationName } from './placeCardModel'
import { reasonLabel, relativeDayLabel } from './related'
import { useAudioPlayback } from './useAudioPlayback'
import { useRecorder, type RecordingResult } from './useRecorder'
import { useRelated, type RelatedRow } from './useRelated'
import { Waveform } from './Waveform'

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
  // View-local only, never persisted, never an event — the log carries user
  // data, not UI state (#78, revised by #102). `menuOpen` is the single "+"
  // affordance's expand state (actions are what collapse now); `relatedOpen`
  // is the one piece of *content* still allowed to stay behind a reveal
  // (#102: "related memories can stay behind expansion"), kept separate from
  // the action menu so opening one never implies the other.
  const [menuOpen, setMenuOpen] = useState(false)
  const [relatedOpen, setRelatedOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  // The full-screen interactive map (#81): opened explicitly from the
  // PlaceCard row, never mounted alongside it — Leaflet loads only here.
  const [mapOpen, setMapOpen] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const timeInputRef = useRef<HTMLInputElement>(null)
  const audio = entry.attachments.find((a) => a.kind === 'audio')
  const playback = useAudioPlayback(audio?.file)
  // Per-card recorder for "+ audio" — entries can hold multiple clips.
  const rec = useRecorder()
  const vm = cardViewModel(entry, groupAttachments(entry.attachments))
  const lifecycle = entryLifecycle(sync, hasPendingEnrichment(entry))
  const navigate = useNavigate()
  // Candidates span the whole log, not just what this screen filtered to —
  // relatedness can span any date (#83: "six months ago"). The hook itself
  // gates all blob/tokenization work behind `relatedOpen` (#83 req. 5's cost
  // bound, previously tied to card expansion — now tied to this dedicated
  // reveal since card content is otherwise always visible, #102).
  const allEntries = useAppStore((s) => s.entries)
  const related = useRelated(entry, allEntries, relatedOpen)

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
      {/* Header: time + place grouped left; sync/duration/play pushed right. */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* Tapping the time opens the native iOS wheel picker (B8); the
              Edit sheet is the second, discoverable path to the same field.
              Time is metadata, not content (#85) — sans, tabular-nums. */}
          <span className="relative shrink-0">
            <button
              onClick={() => {
                const el = timeInputRef.current
                if (!el) return
                if (typeof el.showPicker === 'function') el.showPicker()
                else el.focus()
              }}
              className={cx(
                'rounded-md font-semibold tabular-nums',
                type_.sub,
                tone.textPrimary,
                tone.pressWash,
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
          {vm.collapsedShowsLocation && entry.location && (
            <span className={cx('truncate', type_.sub, tone.textMuted)}>
              {locationName(entry.location)}
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
        {/* Signature fingerprint (#86), "beside the play control": rendered
            here whenever the content below isn't *also* showing this same
            clip's fingerprint — i.e. whenever the entry has text content
            (`vm.primaryText`), since a text entry's content area shows text,
            not audio. An audio-only entry (no `vm.primaryText`) renders its
            fingerprint full-width in the content area instead (below) — the
            two are mutually exclusive, so the fingerprint is never drawn
            twice for the same clip, and never absent while the audio is
            visible (#86 req. 5), regardless of the "+" menu's state. */}
        {audio && vm.primaryText && (
          <Waveform file={audio.file} progress={playback.progress} className="w-14 shrink-0" />
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

      {/* Content — always visible (#102's core inversion: content is never
          what collapses, only actions/chrome do). An audio-only entry (no
          text at all) leads with its waveform fingerprint full-width, tap to
          toggle playback — the one case the header's compact fingerprint
          above skips, so this is never a second copy of the same clip. */}
      {!vm.primaryText && audio && (
        <button
          type="button"
          onClick={() => void playback.toggle()}
          aria-label={playback.playing ? 'Stop playback' : 'Play recording'}
          className="mt-2 block w-full"
        >
          <Waveform file={audio.file} progress={playback.progress} height={28} />
        </button>
      )}
      {/* Every note/transcript (the primary one and any others), every extra
          audio clip, and any orphan caption — unconditional, nothing here is
          "extra" any more. */}
      <AttachmentBody attachments={entry.attachments} onEditText={onEditText} />
      {/* Every photo, tight grid, capture order (#102) — replaces the old
          one-row-per-photo layout that only showed on expansion. */}
      <PhotoGrid
        photoGroups={vm.photoGroups}
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
        <div className={cx('-mx-4 mt-3 flex flex-wrap items-center gap-1 border-t px-2 pt-2', tone.border)}>
          {/* Related memories (#83 v1) stay behind their own quiet reveal
              (#102 explicitly allows this) — the one piece of content this
              card doesn't show unconditionally, since computing it is a
              full-log scan (#83 req. 5's cost bound). */}
          <button
            type="button"
            aria-expanded={relatedOpen}
            onClick={() => setRelatedOpen((o) => !o)}
            className={cx(
              'flex items-center gap-1 rounded-md px-1 py-0.5',
              type_.caption,
              tone.textFaint,
              tone.pressWash,
            )}
          >
            <span className={cx('inline-flex transition-transform', relatedOpen && 'rotate-180')}>
              <ChevronDownIcon size={12} />
            </span>
            Related
          </button>

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

      {/* Related memories (#83 v1): a minimum-score threshold already gated
          `related` server-side (relatedEntries) — an empty array means
          nothing genuinely relates, so no section renders even once
          `relatedOpen` reveals it. */}
      {related.length > 0 && (
        <RelatedRows rows={related} onOpen={(date) => navigate(`/day/${date}`)} />
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
    </Card>
  )
}

/**
 * Up to `RELATED_MAX_RESULTS` quiet related-memory rows (#83 v1): relative
 * day label + "why" + a first-line snippet, tapping through to the related
 * entry's day. The snippet renders in `type_.derived`/`tone.textDerived`
 * (#80) — this is the app's *inference* that another memory relates, not
 * the user's own words in this position, so it gets the same quiet
 * treatment as a photo caption or generated prose, never the authored/
 * spoken weight — while the meta line stays `type_.caption`/`tone.textFaint`
 * chrome.
 */
function RelatedRows({
  rows,
  onOpen,
}: {
  rows: RelatedRow[]
  onOpen: (date: string) => void
}) {
  const today = localDateOf(toLocalIso(new Date()))
  return (
    <div className={cx('-mx-4 mt-3 flex flex-col gap-1 border-t px-4 pt-2', tone.border)}>
      <span className={cx(type_.overline, tone.textFaint)}>Related</span>
      {rows.map((row) => {
        const why = reasonLabel(row.reasons, {
          placeLabel: row.entry.location?.placeLabel,
          sharedTerms: row.sharedTerms,
        })
        const meta = [relativeDayLabel(row.entry.capturedAt, today), why].filter(Boolean).join(' · ')
        return (
          <button
            key={row.entryId}
            type="button"
            onClick={() => onOpen(localDateOf(row.entry.capturedAt))}
            className={cx('block w-full text-left', tone.pressWash, 'rounded-md -mx-1 px-1 py-0.5')}
          >
            <span className={cx('block', type_.caption, tone.textFaint)}>{meta}</span>
            {row.snippet && (
              <span className={cx('line-clamp-1 block', type_.derived, tone.textDerived)}>
                {row.snippet}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
