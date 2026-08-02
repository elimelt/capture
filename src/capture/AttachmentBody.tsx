import { useEffect, useState } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
import { cx, tone, type_ } from '../ui'

/**
 * Renders an entry's non-audio content (B7): note text inline, photos as
 * thumbnails that expand to a full-screen viewer. Without this the log is
 * write-only — you can't see what you saved. Machine transcripts
 * (derivedFrom set) are the spoken content of the entry, so they render
 * first and as primary text; user notes stay secondary.
 */
export function AttachmentBody({ attachments }: { attachments: Attachment[] }) {
  const transcripts = attachments.filter((a) => a.kind === 'text' && a.derivedFrom !== undefined)
  const notes = attachments.filter((a) => a.kind === 'text' && a.derivedFrom === undefined)
  const photos = attachments.filter((a) => a.kind === 'photo')
  if (transcripts.length === 0 && notes.length === 0 && photos.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2">
      {transcripts.map((a) => (
        <NoteText key={a.file} file={a.file} primary />
      ))}
      {notes.map((a) => (
        <NoteText key={a.file} file={a.file} />
      ))}
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((a) => (
            <PhotoThumb key={a.file} file={a.file} />
          ))}
        </div>
      )}
    </div>
  )
}

function NoteText({ file, primary = false }: { file: string; primary?: boolean }) {
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
    <p
      className={cx(
        'whitespace-pre-wrap break-words',
        type_.body,
        primary ? tone.textPrimary : tone.textSecondary,
      )}
    >
      {text}
    </p>
  )
}

function PhotoThumb({ file }: { file: string }) {
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
      <button onClick={() => setExpanded(true)} aria-label="View photo">
        <img
          src={url}
          alt=""
          className={cx('h-16 w-16 rounded-lg border object-cover', tone.border)}
        />
      </button>
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Photo"
        >
          <img src={url} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </>
  )
}
