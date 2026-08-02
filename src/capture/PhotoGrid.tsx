import { useEffect, useState } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
import { liveCaptions } from '../store/livetext'
import { cx, tone } from '../ui'
import { AUTHORSHIP_STYLE, EDIT_TITLE, StreamingText, useLiveText } from './AttachmentBody'
import type { PhotoGroup } from './attachmentGroups'
import { PhotoViewer } from './PhotoViewer'
import { TextSheet } from './TextSheet'

interface PhotoGridProps {
  /** Every photo on the entry, paired with its own captions, in capture
   *  order — the attachment timeline's photo groups (#102). */
  photoGroups: PhotoGroup[]
  /** Replace a caption's content (one amend: remove old + add new) — the
   *  same edit path `AttachmentBody`'s `NoteText` uses for other text. */
  onEditText: (oldFile: string, text: string, derivedFrom?: string) => void
  /** Hide a photo (and, transitively, its caption is orphaned rather than
   *  removed — matching the existing `EditEntrySheet`/fold semantics). */
  onRemoveAttachment: (file: string) => void
}

/**
 * An entry's photos as timeline rows (#102): one row per photo, a fixed-size
 * thumbnail on the left with its caption text horizontally aligned to its
 * right — so a photo's related text reads beside its asset, the way the rest
 * of the timeline aligns content to its node. Replaces the earlier 3-across
 * grid (caption stacked underneath). Always mounted — nothing photo-shaped is
 * hidden any more.
 *
 * Each row still carries the full previous feature set: tap the thumbnail for
 * the existing full-screen `PhotoViewer` (with its own "Remove photo" action),
 * tap a persisted caption to edit it inline (same `TextSheet` flow as
 * `AttachmentBody`'s `NoteText`), and a still-streaming caption
 * (`src/store/livetext.ts`) renders with the same `StreamingText` treatment as
 * a streaming transcript, keyed by the *photo's* file since that's the caption
 * runner's source key.
 */
export function PhotoGrid({ photoGroups, onEditText, onRemoveAttachment }: PhotoGridProps) {
  const liveC = useLiveText(liveCaptions)
  const [edit, setEdit] = useState<{ file: string; text: string; derivedFrom?: string } | null>(
    null,
  )

  if (photoGroups.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2">
      {photoGroups.map(({ photo, captions }) => (
        <PhotoTile
          key={photo.file}
          photo={photo}
          caption={captions[0]}
          liveCaption={captions.length === 0 ? liveC.get(photo.file) : undefined}
          onEditCaption={(file, text, derivedFrom) => setEdit({ file, text, derivedFrom })}
          onRemove={() => onRemoveAttachment(photo.file)}
        />
      ))}
      {edit && (
        <TextSheet
          title={EDIT_TITLE.derived}
          placeholder="Describe this photo…"
          cta="Save"
          initial={edit.text}
          onSave={(text) => onEditText(edit.file, text, edit.derivedFrom)}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}

function PhotoTile({
  photo,
  caption,
  liveCaption,
  onEditCaption,
  onRemove,
}: {
  photo: Attachment
  /** This photo's own (persisted) caption, if any — `photoGroups` pairs at
   *  most... in practice exactly zero or one per photo (see
   *  `attachmentGroups.ts`). */
  caption?: Attachment
  liveCaption?: string
  onEditCaption: (file: string, text: string, derivedFrom?: string) => void
  onRemove: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [captionText, setCaptionText] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)

  useEffect(() => {
    let objectUrl: string | null = null
    let stale = false
    void getBlob(photo.file).then((blob) => {
      if (blob && !stale) {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }
    })
    return () => {
      stale = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photo.file])

  useEffect(() => {
    if (!caption) {
      setCaptionText(null)
      return
    }
    let stale = false
    void getBlob(caption.file).then(async (blob) => {
      if (blob && !stale) setCaptionText(await blob.text())
    })
    return () => {
      stale = true
    }
  }, [caption])

  if (!url) return null

  return (
    // One timeline row: fixed-size thumbnail on the left, caption text aligned
    // to its right (top-aligned so a multi-line caption reads from the photo's
    // top edge). `items-start` + `min-w-0` keeps a long caption wrapping in its
    // own column rather than pushing the thumbnail.
    <div className="flex items-start gap-3">
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        aria-label="View photo"
        className={cx('block h-20 w-20 shrink-0 overflow-hidden rounded-lg border', tone.border)}
      >
        <img src={url} alt="" className="h-full w-full object-cover" />
      </button>
      {caption && captionText !== null ? (
        <button
          type="button"
          onClick={() => onEditCaption(caption.file, captionText, caption.derivedFrom)}
          aria-label={EDIT_TITLE.derived}
          className="min-w-0 flex-1 text-left"
        >
          <span className={cx('block', AUTHORSHIP_STYLE.derived)}>{captionText}</span>
        </button>
      ) : liveCaption ? (
        <span className="min-w-0 flex-1">
          <StreamingText text={liveCaption} authorship="derived" />
        </span>
      ) : null}
      {viewerOpen && (
        <PhotoViewer
          src={url}
          captionFile={caption?.file}
          onClose={() => setViewerOpen(false)}
          onRemove={() => {
            setViewerOpen(false)
            onRemove()
          }}
        />
      )}
    </div>
  )
}
