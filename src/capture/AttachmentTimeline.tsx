import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Attachment } from '../contract/types'
import { getBlob } from '../store/events'
import { liveCaptions, liveTranscripts } from '../store/livetext'
import { cx, MicIcon, tone, type_ } from '../ui'
import { authorship, type Authorship } from './authorship'
import { sortAttachmentsByLoggedAt } from './attachmentOrder'
import { EDIT_TITLE, AUTHORSHIP_STYLE, renderWithMath, StreamingText } from './AttachmentBody'
import { PhotoViewer } from './PhotoViewer'
import { TextSheet } from './TextSheet'
import { useAudioPlayback } from './useAudioPlayback'
import { Waveform } from './Waveform'
import { isCaption } from '../vision/plan'

interface AttachmentTimelineProps {
  attachments: Attachment[]
  attachmentLoggedAt?: Record<string, string>
  entryLoggedAt: string
  onEditText: (oldFile: string, text: string, derivedFrom?: string) => void
  onRemoveAttachment: (file: string) => void
}

type EditState = { file: string; text: string; derivedFrom?: string; authorship: Authorship }

function useLiveText(store: typeof liveTranscripts): ReadonlyMap<string, string> {
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

function attachmentTime(
  attachment: Attachment,
  attachmentLoggedAt: Record<string, string> | undefined,
  entryLoggedAt: string,
): string {
  return attachmentLoggedAt?.[attachment.file] ?? entryLoggedAt
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function AttachmentTimeline({
  attachments,
  attachmentLoggedAt,
  entryLoggedAt,
  onEditText,
  onRemoveAttachment,
}: AttachmentTimelineProps) {
  const liveT = useLiveText(liveTranscripts)
  const liveC = useLiveText(liveCaptions)
  const [edit, setEdit] = useState<EditState | null>(null)
  const ordered = sortAttachmentsByLoggedAt(attachments, attachmentLoggedAt, entryLoggedAt)
  const bySource = new Map<string, Attachment[]>()
  for (const attachment of attachments) {
    if (attachment.kind === 'text' && attachment.derivedFrom !== undefined) {
      const siblings = bySource.get(attachment.derivedFrom) ?? []
      siblings.push(attachment)
      bySource.set(attachment.derivedFrom, siblings)
    }
  }
  const files = new Set(attachments.map((attachment) => attachment.file))
  const rendered = new Set<string>()

  const rows = ordered.flatMap((attachment) => {
    if (rendered.has(attachment.file)) return []
    if (attachment.kind === 'text' && attachment.derivedFrom !== undefined) {
      if (files.has(attachment.derivedFrom)) return []
      rendered.add(attachment.file)
      return [
        <AttachmentSubRow key={attachment.file} timestamp={attachmentTime(attachment, attachmentLoggedAt, entryLoggedAt)}>
          <NoteText attachment={attachment} onEdit={setEdit} />
        </AttachmentSubRow>,
      ]
    }

    rendered.add(attachment.file)
    const derived = bySource.get(attachment.file) ?? []
    for (const sibling of derived) rendered.add(sibling.file)
    const timestamp = attachmentTime(attachment, attachmentLoggedAt, entryLoggedAt)
    if (attachment.kind === 'audio') {
      return [
        <AttachmentSubRow key={attachment.file} timestamp={timestamp}>
          <AudioRow
            attachment={attachment}
            transcripts={derived}
            liveTranscript={derived.length === 0 ? liveT.get(attachment.file) : undefined}
            onEdit={setEdit}
          />
        </AttachmentSubRow>,
      ]
    }
    if (attachment.kind === 'photo') {
      const caption = derived.find(isCaption)
      return [
        <AttachmentSubRow key={attachment.file} timestamp={timestamp}>
          <PhotoRow
            photo={attachment}
            caption={caption}
            liveCaption={caption === undefined ? liveC.get(attachment.file) : undefined}
            onEditCaption={(file, text, derivedFrom) =>
              setEdit({ file, text, derivedFrom, authorship: 'derived' })
            }
            onRemove={() => onRemoveAttachment(attachment.file)}
          />
        </AttachmentSubRow>,
      ]
    }
    return [
      <AttachmentSubRow key={attachment.file} timestamp={timestamp}>
        <NoteText attachment={attachment} onEdit={setEdit} />
      </AttachmentSubRow>,
    ]
  })

  if (rows.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-2">
      {rows}
      {edit && (
        <TextSheet
          title={EDIT_TITLE[edit.authorship]}
          placeholder={edit.authorship === 'derived' ? 'Describe this photo…' : 'Type a note…'}
          cta="Save"
          initial={edit.text}
          onSave={(text) => onEditText(edit.file, text, edit.derivedFrom)}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  )
}

function AttachmentSubRow({ timestamp, children }: { timestamp: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <time className={cx('w-12 shrink-0 pt-1 text-right', type_.caption, tone.textFaint)} dateTime={timestamp}>
        {timeLabel(timestamp)}
      </time>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function NoteText({
  attachment,
  onEdit,
}: {
  attachment: Attachment
  onEdit: (state: EditState) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const a = authorship(attachment)
  useEffect(() => {
    let stale = false
    void getBlob(attachment.file).then(async (blob) => {
      if (blob && !stale) setText(await blob.text())
    })
    return () => {
      stale = true
    }
  }, [attachment.file])
  if (text === null) return null
  return (
    <button
      type="button"
      onClick={() => onEdit({ file: attachment.file, text, derivedFrom: attachment.derivedFrom, authorship: a })}
      aria-label={EDIT_TITLE[a]}
      className={cx('text-left', 'whitespace-pre-wrap break-words', AUTHORSHIP_STYLE[a])}
    >
      {a === 'spoken' && <SpokenMark />}
      {renderWithMath(text)}
    </button>
  )
}

function SpokenMark() {
  return (
    <span aria-hidden="true" className={cx('mr-1 inline-flex -translate-y-px align-middle', tone.textFaint)}>
      <MicIcon size={11} />
    </span>
  )
}

function AudioRow({
  attachment,
  transcripts,
  liveTranscript,
  onEdit,
}: {
  attachment: Attachment
  transcripts: Attachment[]
  liveTranscript?: string
  onEdit: (state: EditState) => void
}) {
  const playback = useAudioPlayback(attachment.file)
  return (
    <div className="flex min-w-0 items-start gap-2">
      <button
        type="button"
        aria-label={playback.playing ? 'Stop playback' : 'Play recording'}
        onClick={() => void playback.toggle()}
        className="mt-1 shrink-0 rounded-md"
      >
        <Waveform file={attachment.file} progress={playback.progress} className="w-16" />
      </button>
      <div className="min-w-0 flex-1">
        {transcripts.length > 0 ? (
          transcripts.map((transcript) => (
            <NoteText key={transcript.file} attachment={transcript} onEdit={onEdit} />
          ))
        ) : liveTranscript ? (
          <StreamingText text={liveTranscript} authorship="spoken" />
        ) : (
          <span className={cx(type_.caption, tone.textFaint)}>
            Recording{attachment.durationSec !== undefined ? ` · ${attachment.durationSec}s` : ''}
          </span>
        )}
      </div>
    </div>
  )
}

function PhotoRow({
  photo,
  caption,
  liveCaption,
  onEditCaption,
  onRemove,
}: {
  photo: Attachment
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
    <div className="flex min-w-0 items-start gap-3">
      <button type="button" onClick={() => setViewerOpen(true)} aria-label="View photo" className="shrink-0">
        <img src={url} alt="" className={cx('h-20 w-20 rounded-lg border object-cover', tone.border)} />
      </button>
      {caption && captionText !== null ? (
        <button
          type="button"
          onClick={() => onEditCaption(caption.file, captionText, caption.derivedFrom)}
          aria-label={EDIT_TITLE.derived}
          className={cx('min-w-0 flex-1 text-left', AUTHORSHIP_STYLE.derived)}
        >
          {captionText}
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
