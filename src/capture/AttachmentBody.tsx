import type React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
import { liveCaptions, liveTranscripts, type LiveTextStore } from '../store/livetext'
import { IconButton, cx, motion, tone, type_ } from '../ui'
import { isCaption, isPhotoFile } from '../vision/plan'
import { TextSheet } from './TextSheet'
import { useAudioPlayback } from './useAudioPlayback'

interface AttachmentBodyProps {
  attachments: Attachment[]
  /** Replace a text attachment's content (one amend: remove old + add new). */
  onEditText: (oldFile: string, text: string, derivedFrom?: string) => void
  /** Hide an attachment from the entry (amend patch.removeAttachments). */
  onRemoveAttachment: (file: string) => void
}

/** Subscribe to a live-text store; snapshots are immutable maps. */
function useLiveText(store: LiveTextStore): ReadonlyMap<string, string> {
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/**
 * Renders an entry's content beyond the primary clip (B7): note text inline
 * (tap to edit), extra audio clips as playback rows, photos as thumbnails
 * that expand to a viewer with removal. Machine transcripts (derivedFrom
 * set) are the spoken content of the entry, so they render first and as
 * primary text; user notes stay secondary, and machine photo captions render
 * secondary below their photos. Edited transcripts/captions keep their
 * derivedFrom link so they are never re-derived.
 *
 * While a transcript or caption is still streaming in from its service, the
 * partial text appears in the same position via the transient live-text
 * stores (`src/store/livetext.ts`), keyed by source file — shown only until
 * a persisted attachment derived from that file exists.
 */
export function AttachmentBody({ attachments, onEditText, onRemoveAttachment }: AttachmentBodyProps) {
  const [edit, setEdit] = useState<{ file: string; text: string; derivedFrom?: string } | null>(
    null,
  )
  const liveT = useLiveText(liveTranscripts)
  const liveC = useLiveText(liveCaptions)
  const captions = attachments.filter(isCaption)
  const transcripts = attachments.filter(
    (a) => a.kind === 'text' && a.derivedFrom !== undefined && !isCaption(a),
  )
  const notes = attachments.filter((a) => a.kind === 'text' && a.derivedFrom === undefined)
  const allAudio = attachments.filter((a) => a.kind === 'audio')
  // The first clip plays from the card header; later ones render here.
  const extraAudio = allAudio.slice(1)
  const photos = attachments.filter((a) => a.kind === 'photo')
  // Streaming machine text for sources with no persisted derived text yet.
  // Once the amend lands the stored attachment wins, live text is ignored.
  const derivedSources = new Set(
    attachments.filter((a) => a.kind === 'text' && a.derivedFrom !== undefined).map(
      (a) => a.derivedFrom,
    ),
  )
  const streaming = (live: ReadonlyMap<string, string>, sources: Attachment[]) =>
    sources
      .filter((a) => !derivedSources.has(a.file))
      .map((a) => ({ file: a.file, text: live.get(a.file) }))
      .filter((s): s is { file: string; text: string } => s.text !== undefined && s.text !== '')
  const streamingTranscripts = streaming(liveT, allAudio)
  const streamingCaptions = streaming(liveC, photos)
  if (
    captions.length === 0 &&
    transcripts.length === 0 &&
    notes.length === 0 &&
    extraAudio.length === 0 &&
    photos.length === 0 &&
    streamingTranscripts.length === 0
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {transcripts.map((a) => (
        <NoteText key={a.file} attachment={a} primary onEdit={setEdit} />
      ))}
      {streamingTranscripts.map((s) => (
        <StreamingText key={s.file} text={s.text} primary />
      ))}
      {notes.map((a) => (
        <NoteText key={a.file} attachment={a} onEdit={setEdit} />
      ))}
      {extraAudio.map((a) => (
        <AudioRow key={a.file} file={a.file} durationSec={a.durationSec} />
      ))}
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((a) => (
            <PhotoThumb key={a.file} file={a.file} onRemove={() => onRemoveAttachment(a.file)} />
          ))}
        </div>
      )}
      {captions.map((a) => (
        <NoteText key={a.file} attachment={a} onEdit={setEdit} />
      ))}
      {streamingCaptions.map((s) => (
        <StreamingText key={s.file} text={s.text} />
      ))}
      {edit && (
        <TextSheet
          title={
            edit.derivedFrom === undefined
              ? 'Edit note'
              : isPhotoFile(edit.derivedFrom)
                ? 'Edit caption'
                : 'Edit transcript'
          }
          placeholder="Type a note…"
          cta="Save"
          initial={edit.text}
          onSave={(text) => onEditText(edit.file, text, edit.derivedFrom)}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}

/**
 * Renders inline math ($...$) as styled text. A minimal no-dependency
 * approach per design-nit: "render $P(k)$ as *P(k)*".
 */
function renderWithMath(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let last = 0
  // Simple inline math: $content$ where content has no $ or newlines.
  // Avoids lookbehind for broader browser support.
  const mathRegex = /\$([^$\n]+)\$/g
  let match: RegExpExecArray | null
  while ((match = mathRegex.exec(text)) !== null) {
    // Skip $$ (display math delimiter — leave as-is)
    if (match.index > 0 && text[match.index - 1] === '$') continue
    if (match.index + match[0].length < text.length && text[match.index + match[0].length] === '$')
      continue
    if (match.index > last) {
      parts.push(text.slice(last, match.index))
    }
    parts.push(
      <em key={match.index} className="font-serif not-italic">
        {match[1]}
      </em>,
    )
    last = match.index + match[0].length
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts.length > 0 ? parts : [text]
}

/**
 * A transcript or caption still streaming in: rendered exactly like the
 * final NoteText (same tokens, same position) but read-only — there is
 * nothing to edit until the amend lands — with a pulsing cursor tick.
 */
function StreamingText({ text, primary = false }: { text: string; primary?: boolean }) {
  return (
    <span
      aria-live="polite"
      className={cx(
        'block whitespace-pre-wrap break-words text-left',
        motion.fadeIn,
        type_.body,
        primary ? tone.textPrimary : tone.textSecondary,
      )}
    >
      {renderWithMath(text)}
      <span
        aria-hidden="true"
        className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] animate-pulse rounded-full bg-current"
      />
    </span>
  )
}

function NoteText({
  attachment,
  primary = false,
  onEdit,
}: {
  attachment: Attachment
  primary?: boolean
  onEdit: (target: { file: string; text: string; derivedFrom?: string }) => void
}) {
  const { file, derivedFrom } = attachment
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
    <button
      onClick={() => onEdit({ file, text, derivedFrom })}
      aria-label={derivedFrom !== undefined ? 'Edit transcript' : 'Edit note'}
      className={cx('text-left', motion.fadeIn)}
    >
      <span
        className={cx(
          'block whitespace-pre-wrap break-words',
          type_.body,
          primary ? tone.textPrimary : tone.textSecondary,
        )}
      >
        {renderWithMath(text)}
      </span>
    </button>
  )
}

/** Playback row for an entry's second and later clips. */
function AudioRow({ file, durationSec }: { file: string; durationSec?: number }) {
  const playback = useAudioPlayback(file)
  return (
    <div className="flex items-center gap-2">
      <IconButton
        aria-label={playback.playing ? 'Stop playback' : 'Play recording'}
        onClick={() => void playback.toggle()}
        className="relative overflow-hidden"
      >
        {playback.playing && (
          <span
            className="absolute inset-y-0 left-0 bg-spruce/20 transition-[width] duration-200 ease-linear dark:bg-spruce-dark/25"
            style={{ width: `${playback.progress * 100}%` }}
          />
        )}
        <span className="relative">{playback.playing ? '■' : '▶'}</span>
      </IconButton>
      <span className={cx('tabular-nums', type_.caption, tone.textFaint)}>
        Recording{durationSec !== undefined ? ` · ${durationSec}s` : ''}
      </span>
    </div>
  )
}

function PhotoThumb({ file, onRemove }: { file: string; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let objectUrl: string | null = null
    let stale = false
    void getBlob(file).then((blob) => {
      if (blob && !stale) {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }
    })
    return () => {
      stale = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file])

  if (!url) return null
  return (
    <>
      <button
        onClick={() => setExpanded(true)}
        aria-label="View photo"
        className={motion.fadeIn}
      >
        <img
          src={url}
          alt=""
          className={cx('h-16 w-16 rounded-lg border object-cover', tone.border)}
        />
      </button>
      {expanded && (
        <div
          className={cx(
            'fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/85 p-4',
            motion.fadeIn,
          )}
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Photo"
        >
          <img
            src={url}
            alt=""
            className={cx('min-h-0 max-w-full flex-shrink rounded-lg object-contain', motion.scaleIn)}
          />
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(false)
              onRemove()
            }}
            className={cx('rounded-xl bg-white/15 px-5 py-2.5 font-medium text-white', type_.ui)}
          >
            Remove photo
          </button>
        </div>
      )}
    </>
  )
}
