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
   *  order — `cardViewModel(...).photoGroups` (#102). */
  photoGroups: PhotoGroup[]
  /** Replace a caption's content (one amend: remove old + add new) — the
   *  same edit path `AttachmentBody`'s `NoteText` uses for other text. */
  onEditText: (oldFile: string, text: string, derivedFrom?: string) => void
  /** Hide a photo (and, transitively, its caption is orphaned rather than
   *  removed — matching the existing `EditEntrySheet`/fold semantics). */
  onRemoveAttachment: (file: string) => void
}

/**
 * Tight thumbnail grid for an entry's photos (#102): replaces the old
 * one-64px-thumbnail-per-row-with-caption-beside layout with a 3-across
 * grid so photos read as content at a glance rather than hiding behind
 * expansion. Always mounted — nothing photo-shaped is hidden any more.
 *
 * Each tile still carries the full previous feature set, just laid out
 * more tightly: tap the thumbnail for the existing full-screen
 * `PhotoViewer` (with its own "Remove photo" action), tap a persisted
 * caption to edit it inline (same `TextSheet` flow as `AttachmentBody`'s
 * `NoteText`), and a still-streaming caption (`src/store/livetext.ts`)
 * renders with the same `StreamingText` treatment as a streaming
 * transcript, keyed by the *photo's* file since that's the caption
 * runner's source key.
 */
export function PhotoGrid({ photoGroups, onEditText, onRemoveAttachment }: PhotoGridProps) {
  const liveC = useLiveText(liveCaptions)
  const [edit, setEdit] = useState<{ file: string; text: string; derivedFrom?: string } | null>(
    null,
  )

  if (photoGroups.length === 0) return null

  return (
    <div className="mt-2 grid grid-cols-3 gap-1.5">
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
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        aria-label="View photo"
        className={cx('block aspect-square w-full overflow-hidden rounded-lg border', tone.border)}
      >
        <img src={url} alt="" className="h-full w-full object-cover" />
      </button>
      {caption && captionText !== null ? (
        <button
          type="button"
          onClick={() => onEditCaption(caption.file, captionText, caption.derivedFrom)}
          aria-label={EDIT_TITLE.derived}
          className="text-left"
        >
          <span className={cx('line-clamp-2 block', AUTHORSHIP_STYLE.derived)}>{captionText}</span>
        </button>
      ) : (
        liveCaption && <StreamingText text={liveCaption} authorship="derived" />
      )}
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
