import { useEffect, useState } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
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

/**
 * Renders an entry's content beyond the primary clip (B7): note text inline
 * (tap to edit), extra audio clips as playback rows, photos as thumbnails
 * that expand to a viewer with removal. Machine transcripts (derivedFrom
 * set) are the spoken content of the entry, so they render first and as
 * primary text; user notes stay secondary, and machine photo captions render
 * secondary below their photos. Edited transcripts/captions keep their
 * derivedFrom link so they are never re-derived.
 */
export function AttachmentBody({ attachments, onEditText, onRemoveAttachment }: AttachmentBodyProps) {
  const [edit, setEdit] = useState<{ file: string; text: string; derivedFrom?: string } | null>(
    null,
  )
  const captions = attachments.filter(isCaption)
  const transcripts = attachments.filter(
    (a) => a.kind === 'text' && a.derivedFrom !== undefined && !isCaption(a),
  )
  const notes = attachments.filter((a) => a.kind === 'text' && a.derivedFrom === undefined)
  // The first clip plays from the card header; later ones render here.
  const extraAudio = attachments.filter((a) => a.kind === 'audio').slice(1)
  const photos = attachments.filter((a) => a.kind === 'photo')
  if (
    captions.length === 0 &&
    transcripts.length === 0 &&
    notes.length === 0 &&
    extraAudio.length === 0 &&
    photos.length === 0
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {transcripts.map((a) => (
        <NoteText key={a.file} attachment={a} primary onEdit={setEdit} />
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
        {text}
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
