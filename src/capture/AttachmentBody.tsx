import type React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
import { liveCaptions, liveTranscripts, type LiveTextStore } from '../store/livetext'
import { IconButton, cx, motion, tone, type_ } from '../ui'
import { isPhotoFile } from '../vision/plan'
import { groupAttachments } from './attachmentGroups'
import { PhotoViewer } from './PhotoViewer'
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
 * set) are the spoken content of the entry, so they render first and at the
 * main-text scale (`type_.bodyStrong`) alongside user notes; machine photo
 * captions are descriptive metadata, so each photo pairs with its caption in
 * one horizontal row (thumbnail left, smaller muted caption right). Edited
 * transcripts/captions keep their derivedFrom link so they are never
 * re-derived. Grouping/pairing itself is the pure `groupAttachments`.
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
  const { transcripts, notes, audio, photoGroups, orphanCaptions } = groupAttachments(attachments)
  // The first clip plays from the card header; later ones render here.
  const extraAudio = audio.slice(1)
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
  const streamingTranscripts = streaming(liveT, audio)
  const streamingCaptions = streaming(
    liveC,
    photoGroups.map((g) => g.photo),
  )
  if (
    transcripts.length === 0 &&
    notes.length === 0 &&
    extraAudio.length === 0 &&
    photoGroups.length === 0 &&
    orphanCaptions.length === 0 &&
    streamingTranscripts.length === 0
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {transcripts.map((a) => (
        <NoteText key={a.file} attachment={a} variant="transcript" onEdit={setEdit} />
      ))}
      {streamingTranscripts.map((s) => (
        <StreamingText key={s.file} text={s.text} variant="transcript" />
      ))}
      {notes.map((a) => (
        <NoteText key={a.file} attachment={a} variant="note" onEdit={setEdit} />
      ))}
      {extraAudio.map((a) => (
        <AudioRow key={a.file} file={a.file} durationSec={a.durationSec} />
      ))}
      {photoGroups.map(({ photo, captions }) => {
        const live = streamingCaptions.find((s) => s.file === photo.file)
        return (
          <div key={photo.file} className="flex items-start gap-3">
            <PhotoThumb
              file={photo.file}
              captionFile={captions[0]?.file}
              onRemove={() => onRemoveAttachment(photo.file)}
            />
            {(captions.length > 0 || live) && (
              <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                {captions.map((c) => (
                  <NoteText key={c.file} attachment={c} variant="caption" onEdit={setEdit} />
                ))}
                {live && <StreamingText text={live.text} variant="caption" />}
              </div>
            )}
          </div>
        )
      })}
      {orphanCaptions.map((a) => (
        <NoteText key={a.file} attachment={a} variant="caption" onEdit={setEdit} />
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
 * Type scale for entry text (design pass): transcripts are the entry's own
 * voice and lead the card; notes share the main-text scale but read as
 * secondary; photo captions are descriptive metadata — smaller, lighter.
 */
type TextVariant = 'transcript' | 'note' | 'caption'

const TEXT_STYLE: Record<TextVariant, string> = {
  transcript: cx(type_.bodyStrong, tone.textPrimary),
  note: cx(type_.bodyStrong, tone.textSecondary),
  caption: cx(type_.bodySmall, tone.textMuted),
}

/**
 * A transcript or caption still streaming in: rendered exactly like the
 * final NoteText (same tokens, same position) but read-only — there is
 * nothing to edit until the amend lands — with a pulsing cursor tick.
 */
function StreamingText({ text, variant }: { text: string; variant: TextVariant }) {
  return (
    <span
      aria-live="polite"
      className={cx(
        'block whitespace-pre-wrap break-words text-left',
        motion.fadeIn,
        TEXT_STYLE[variant],
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
  variant,
  onEdit,
}: {
  attachment: Attachment
  variant: TextVariant
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
        className={cx('block whitespace-pre-wrap break-words', TEXT_STYLE[variant])}
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
        variant="accent"
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

function PhotoThumb({
  file,
  captionFile,
  onRemove,
}: {
  file: string
  captionFile?: string
  onRemove: () => void
}) {
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
        className={cx('shrink-0', motion.fadeIn)}
      >
        <img
          src={url}
          alt=""
          className={cx('h-16 w-16 rounded-lg border object-cover', tone.border)}
        />
      </button>
      {expanded && (
        <PhotoViewer
          src={url}
          captionFile={captionFile}
          onClose={() => setExpanded(false)}
          onRemove={() => {
            setExpanded(false)
            onRemove()
          }}
        />
      )}
    </>
  )
}
